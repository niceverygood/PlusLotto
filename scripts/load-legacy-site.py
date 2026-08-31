#!/usr/bin/env python3
"""레거시 사이트 덤프 → 플러스로또 Supabase 적재 (현장 8/31 — "일단 815부터 입력해주셔서
사용하도록 할수있는 방법은 가능한가요?").

왜 스크립트인가: 개발 세션에는 라이브 Supabase 접속 키가 없다. 키를 가진 쪽에서 직접 돌리는
것이 안전하고(키가 외부로 나가지 않는다) 빠르다.

★ 반드시 --dry-run 으로 먼저 돌려 보고서를 확인한 뒤 실제 적재한다.

사용법:
  # 1) 무엇이 들어갈지만 본다 (DB 접속 안 함)
  python3 scripts/load-legacy-site.py --site lotto815 --dir ./815 --dry-run

  # 2) 100건만 시범 적재
  python3 scripts/load-legacy-site.py --site lotto815 --dir ./815 \
      --url https://xxxx.supabase.co --key <service_role_key> --limit 100

  # 3) 전체
  python3 scripts/load-legacy-site.py --site lotto815 --dir ./815 --url ... --key ...

성질:
  · **재실행 안전** — 이미 들어간 회원은 meta.legacy_idx 로 알아보고 건너뛴다.
  · **전화번호 중복은 건너뛰고 보고**한다(덮어쓰지 않는다). 우리 DB 의 중복 가드와 같은 방침.
  · 담당 상담원은 meta.legacy_sales_idx 에 원본 번호를 보관만 한다. 상담원 대응표가 오면
    그때 일괄 배정하면 된다 — **대응표를 기다리느라 적재를 미룰 필요가 없다.**
  · 등급·이용기간·주당조합·결제액은 **회원별 실제값**을 쓴다. 등급에서 파생하지 않는다(D167).
"""
import argparse, gzip, json, os, re, sys, time, urllib.request, urllib.error, uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone

# ── 사이트별 등급 대응 (docs/MIGRATION_LEGACY_SITES.md §0.4, 현장 8/31 승인) ──────────
# 주당 조합 수(10/20)를 1차, 판매가를 2차 기준으로 잡았다. 우리 유료 3단에 맞춘다.
GRADE_BY_SITE = {
    'lotto815':  {'2': 'goldp', '3': 'vip', '4': 'royal'},                 # 패밀리/매니아/퍼스트
    'cplotto':   {'2': 'goldp', '3': 'goldp', '4': 'vip', '5': 'royal'},   # 골드/골드플러스/VIP/로얄
    'infolotto': {'2': 'goldp', '3': 'vip', '4': 'royal'},                 # 베이직/스마트/시그니쳐
}
STATUS_MAP = {'normal': 'active', 'standby': 'active', 'block': 'suspended',
              'remove': 'deleted', 'leave': 'withdrawn'}
FLAG_BY_STATUS = {'suspended': 'is_suspended', 'deleted': 'is_deleted', 'withdrawn': 'is_withdrawn'}
METHOD_MAP = {'officeCredit': 'manual', 'siteBank': 'bank', 'siteCredit': 'pg'}
WEEKDAY = {'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6}


# ── 덤프 파싱 (scripts/verify-legacy-dump.py 와 같은 스캐너) ───────────────────────────
def iter_rows(text):
    """값 안에 줄바꿈·괄호·쉼표가 들어 있어 줄 단위로는 못 자른다. 따옴표 상태를 추적한다."""
    i, n = 0, len(text)
    while i < n:
        if text[i] != '(' or (i and text[i - 1] != '\n'):
            i += 1
            continue
        j, depth, inq, esc, cur, out = i + 1, 1, False, False, [], []
        while j < n:
            ch = text[j]
            if esc:
                cur.append(ch); esc = False
            elif inq:
                if ch == '\\': esc = True; cur.append(ch)
                elif ch == "'": inq = False; cur.append(ch)
                else: cur.append(ch)
            elif ch == "'": inq = True; cur.append(ch)
            elif ch == '(': depth += 1; cur.append(ch)
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    out.append(''.join(cur)); break
                cur.append(ch)
            elif ch == ',' and depth == 1:
                out.append(''.join(cur)); cur = []
            else:
                cur.append(ch)
            j += 1
        yield [v.strip() for v in out]
        i = j + 1


def unquote(v):
    if len(v) >= 2 and v[0] == "'":
        v = v[1:-1]
        return v.replace("\\'", "'").replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')
    return '' if v == 'NULL' else v


def load_table(path):
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8', errors='replace') as fh:
        text = fh.read()
    cols = None
    for line in text.split('\n', 40)[:40]:
        if line.startswith('-- 컬럼:'):
            cols = line.split(':', 1)[1].strip().split(',')
            break
    if cols is None:
        raise SystemExit(f'{path}: `-- 컬럼:` 주석이 없습니다')
    out = []
    for r in iter_rows(text):
        if len(r) == len(cols):
            out.append(dict(zip(cols, (unquote(v) for v in r))))
    return out


# ── 값 변환 ───────────────────────────────────────────────────────────────────────
def digits(s):
    return re.sub(r'\D', '', s or '')


def ts(v):
    """'0000-00-00 00:00:00' 같은 MySQL 빈 날짜를 None 으로."""
    v = (v or '').strip()
    if not v or v.startswith('0000'):
        return None
    return v.replace(' ', 'T') + '+09:00'   # 저쪽은 KST 로 저장돼 있다


def num(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def build_member(u, site, grade_map):
    grade = grade_map.get(u.get('levelNum', ''))
    if not grade:
        return None, f"등급 미대응(levelNum={u.get('levelNum')})"
    phone = digits(u.get('phone'))
    if not re.fullmatch(r'01\d{8,9}', phone):
        return None, '휴대폰 형식 오류'
    status = STATUS_MAP.get(u.get('statCode', ''), 'active')
    meta = {
        'source_site': site,                       # 사이트별/전체 탭 (§0.2)
        'legacy_idx': num(u.get('idx')),
        'legacy_id': u.get('id') or None,
        'legacy_sales_idx': num(u.get('salesIdx')) or None,   # 대응표 오면 여기서 배정
        'legacy_stat_adm': u.get('statAdmCode') or None,      # DB 신선도 분류
        'legacy_item_code': u.get('itemCode') or None,
    }
    end_date = (u.get('itemEndDateTime') or '')[:10]
    if end_date and not end_date.startswith('0000'):
        meta['end_date'] = end_date                # 우리 만료 판정이 이 값을 본다(D155·D156)
    day = WEEKDAY.get(u.get('schedulePickSmsWeek', ''))
    if day is not None:
        meta['weekly_reco_day'] = day              # ★ 기본값으로 채우면 하루에 몰린다(D167)
    slot = num(u.get('itemOptionSlot'))
    if slot:
        meta['weekly_reco_count'] = slot           # ★ 등급에서 파생 금지(D167)
    row = {
        'id': f'mem_{uuid.uuid4()}',
        'user_id': u.get('id') or '',
        'name': u.get('name') or '',
        'nickname': u.get('nick') or None,
        'phone': phone,
        'grade': grade,
        'status': status,
        'inflow_code': u.get('inflowFromCode') or None,   # 자유 입력 문자열 — 그대로(D173)
        'memo': (u.get('adminMemo') or u.get('memoLastContents') or '') or None,
        'registered_at': ts(u.get('insertDateTimeOrg')) or ts(u.get('insertDateTime')) or None,
        'last_active_at': ts(u.get('loginDateTime')),
        'meta': meta,
    }
    flag = FLAG_BY_STATUS.get(status)
    if flag:
        row[flag] = True
    return row, None


def build_payment(p, member_id, product_id):
    return {
        'id': f'pay_{uuid.uuid4()}',
        'member_id': member_id,
        'product_id': product_id,
        'amount': num(p.get('itemWon'), 0),                  # 실제 결제액(대응표 정가 아님)
        'method': METHOD_MAP.get(p.get('payMethodCode', ''), 'manual'),
        'status': 'approved',                                # 덤프는 success 만 담겨 있다
        'period_start': ts(p.get('itemStartDateTime')),
        'period_end': ts(p.get('itemEndDateTime')),
        'depositor_name': p.get('userBankName') or None,
        'paid_at': ts(p.get('insertDateTime')),
        'created_at': ts(p.get('insertDateTime')),
        'meta': {'legacy_idx': num(p.get('idx')), 'legacy_item_code': p.get('itemCode') or None,
                 'legacy_sales_idx': num(p.get('salesIdx')) or None,
                 'legacy_exp_month': num(p.get('itemExpMonth'))},
    }


# ── Supabase REST ────────────────────────────────────────────────────────────────
class Supa:
    def __init__(self, url, key):
        self.url, self.key = url.rstrip('/'), key

    def _req(self, method, path, body=None, prefer=None):
        req = urllib.request.Request(f'{self.url}/rest/v1/{path}', method=method)
        req.add_header('apikey', self.key)
        req.add_header('Authorization', f'Bearer {self.key}')
        req.add_header('Content-Type', 'application/json')
        if prefer:
            req.add_header('Prefer', prefer)
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, data, timeout=120) as r:
                    raw = r.read()
                    return json.loads(raw) if raw else []
            except urllib.error.HTTPError as e:
                detail = e.read().decode('utf-8', 'replace')[:400]
                if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(2 ** attempt); continue
                raise SystemExit(f'Supabase 오류 {e.code}: {detail}')
            except urllib.error.URLError:
                if attempt < 2:
                    time.sleep(2 ** attempt); continue
                raise
        return []

    def select(self, table, query):
        return self._req('GET', f'{table}?{query}')

    def insert(self, table, rows):
        return self._req('POST', table, rows, prefer='return=minimal')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True, choices=sorted(GRADE_BY_SITE))
    ap.add_argument('--dir', required=True, help='덤프 파일이 있는 폴더')
    ap.add_argument('--url'); ap.add_argument('--key')
    ap.add_argument('--limit', type=int, help='시범 적재용 — 회원 N명만')
    ap.add_argument('--dry-run', action='store_true', help='DB 접속 없이 결과만 본다')
    a = ap.parse_args()
    if not a.dry_run and not (a.url and a.key):
        raise SystemExit('실제 적재에는 --url 과 --key 가 필요합니다 (--dry-run 으로 먼저 확인하세요)')

    def find(table):
        for f in sorted(os.listdir(a.dir)):
            if f.endswith(f'_{table}.sql.gz') or f.endswith(f'_{table}.sql'):
                return os.path.join(a.dir, f)
        raise SystemExit(f'{a.dir} 에서 {table} 파일을 찾지 못했습니다')

    print(f'=== {a.site} 적재{" (모의)" if a.dry_run else ""} ===')
    users = load_table(find('user'))
    pays = load_table(find('payment'))
    print(f'덤프 읽음 — 회원 {len(users):,} · 결제 {len(pays):,}\n')

    grade_map = GRADE_BY_SITE[a.site]
    rows, skipped = [], Counter()
    seen_phone = {}
    for u in users:
        row, why = build_member(u, a.site, grade_map)
        if not row:
            skipped[why] += 1; continue
        if row['phone'] in seen_phone:
            skipped['덤프 내 전화번호 중복'] += 1; continue
        seen_phone[row['phone']] = row['id']
        rows.append((u, row))
    if a.limit:
        rows = rows[:a.limit]
        print(f'※ --limit {a.limit} — 회원 {len(rows)}명만 처리합니다\n')

    # 기존 회원과의 충돌 확인
    existing_idx, existing_phone, existing_uid = set(), set(), set()
    sb = None
    if not a.dry_run:
        sb = Supa(a.url, a.key)
        print('기존 회원 조회 중…')
        for off in range(0, 10_000_000, 1000):
            got = sb.select('members', f'select=id,user_id,phone,meta&limit=1000&offset={off}')
            for m in got:
                existing_phone.add(digits(m.get('phone')))
                existing_uid.add(m.get('user_id'))
                li = (m.get('meta') or {}).get('legacy_idx')
                if li is not None:
                    existing_idx.add((( m.get('meta') or {}).get('source_site'), li))
            if len(got) < 1000:
                break
        print(f'  기존 회원 {len(existing_phone):,}명 확인\n')

    todo, conflict = [], Counter()
    for u, row in rows:
        if (a.site, row['meta']['legacy_idx']) in existing_idx:
            conflict['이미 적재됨(건너뜀)'] += 1; continue
        if row['phone'] in existing_phone:
            conflict['전화번호 중복(건너뜀 — 덮어쓰지 않음)'] += 1; continue
        if row['user_id'] in existing_uid:
            row['meta']['legacy_login_id'] = row['user_id']
            row['user_id'] = f"{a.site[:2]}{row['meta']['legacy_idx']}"
            conflict['로그인 아이디 충돌(새 아이디 부여)'] += 1
        todo.append(row)

    by_grade = Counter(r['grade'] for r in todo)
    print('■ 회원')
    print(f'  적재 대상 {len(todo):,}명   ' + ' · '.join(f'{k} {v:,}' for k, v in by_grade.most_common()))
    for k, v in skipped.most_common():
        print(f'  제외 {k}: {v:,}')
    for k, v in conflict.most_common():
        print(f'  {k}: {v:,}')

    idx_to_member = {r['meta']['legacy_idx']: r['id'] for r in todo}
    pay_rows = [build_payment(p, idx_to_member[num(p.get('userIdx'))], None)
                for p in pays if num(p.get('userIdx')) in idx_to_member]
    print(f'\n■ 결제\n  적재 대상 {len(pay_rows):,}건 · 합계 {sum(p["amount"] for p in pay_rows):,}원')

    day = Counter(r['meta'].get('weekly_reco_day') for r in todo)
    print('\n■ 조합 발송요일 (기본값으로 몰리지 않는지 확인)')
    named = sorted((k, v) for k, v in day.items() if k is not None)
    print('  ' + ' · '.join(f"{'일월화수목금토'[k]}요일 {v:,}" for k, v in named)
          + (f"  · 요일 미지정 {day[None]:,}" if day.get(None) else ''))

    if a.dry_run:
        print('\n※ 모의 실행이라 아무것도 넣지 않았습니다. 위 숫자가 맞으면 --url/--key 를 주고 다시 실행하세요.')
        return

    print('\n적재 시작…')
    for i in range(0, len(todo), 200):
        sb.insert('members', todo[i:i + 200])
        print(f'  회원 {min(i + 200, len(todo)):,}/{len(todo):,}')
    for i in range(0, len(pay_rows), 200):
        sb.insert('payments', pay_rows[i:i + 200])
        print(f'  결제 {min(i + 200, len(pay_rows)):,}/{len(pay_rows):,}')
    print(f'\n완료 — 회원 {len(todo):,}명 · 결제 {len(pay_rows):,}건')
    print('담당 상담원은 meta.legacy_sales_idx 에 원본 번호로 들어 있습니다.')
    print('상담원 대응표가 오면 그때 일괄 배정하면 됩니다.')


if __name__ == '__main__':
    main()
