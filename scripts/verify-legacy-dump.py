#!/usr/bin/env python3
"""이관용 레거시 덤프 실물 검증 (현장 8/24 — 815 검증에서 만든 것).

왜 필요한가: `inspect-legacy-dump.sh` 는 **구조**(테이블·컬럼)만 본다. 815 를 실제로 파싱해
보니 구조는 맞는데 **값이 대응표와 달랐다** — 주당 조합 수·이용기간·판매가가 등급에서
파생되지 않고 회원마다 개별 조정돼 있었고, 유입 컬럼 4개 중 3개는 아예 비어 있었다.
그대로 믿고 이관했으면 991명의 조합 발송 갯수가 반토막 났을 것이다(D167).
→ 나머지 5개 사이트도 **적재 전에 반드시 이걸 돌려 값을 확인한다.**

★ 개인정보: 집계값만 출력한다. 이름·전화번호·메모 내용은 뽑지 않는다.
  (휴대폰은 "형식이 맞는 행이 몇 개인지"만 센다.)

사용법:
  python3 scripts/verify-legacy-dump.py <사이트키> <덤프파일...>
  예) python3 scripts/verify-legacy-dump.py lotto815 ~/dump/lotto815_*.sql.gz
"""
import collections
import datetime
import gzip
import re
import sys

# 업체 덤프는 값 안에 줄바꿈·괄호·쉼표가 들어있다(adminMemo, convBackup, userMemo.contents).
# 줄 단위로 자르면 깨지므로, 따옴표 상태를 추적하며 최상위 튜플만 잘라낸다.
def iter_rows(text):
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
    return v[1:-1] if len(v) >= 2 and v[0] == "'" else v


def load(path):
    """덤프 파일 하나를 dict 목록으로. 컬럼명은 업체가 넣어둔 `-- 컬럼:` 주석에서 읽는다."""
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8', errors='replace') as fh:
        text = fh.read()
    cols = None
    for line in text.split('\n', 40)[:40]:
        if line.startswith('-- 컬럼:'):
            cols = line.split(':', 1)[1].strip().split(',')
            break
    if cols is None:
        raise SystemExit(f'{path}: `-- 컬럼:` 주석이 없어 컬럼명을 알 수 없습니다')
    rows, bad = [], 0
    for r in iter_rows(text):
        if len(r) != len(cols):
            bad += 1
            continue
        rows.append(dict(zip(cols, (unquote(v) for v in r))))
    return rows, bad


def dist(rows, col, top=12):
    c = collections.Counter(r.get(col, '') for r in rows)
    body = ' / '.join(f"{v or '(빈)'}={n:,}" for v, n in c.most_common(top))
    more = f' … 외 {len(c) - top}종' if len(c) > top else ''
    return len(c), body + more


def as_date(v):
    v = (v or '')[:10]
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', v) or v.startswith('0000'):
        return None
    try:
        return datetime.date(*map(int, v.split('-')))
    except ValueError:
        return None


def report_user(rows):
    print(f'\n■ user — {len(rows):,}명')
    for col in ('levelNum', 'itemCode', 'statCode', 'statTmCode', 'statAdmCode',
                'itemOptionSlot', 'schedulePickSmsWeek', 'inflowFromCode',
                'inflowUniqCode', 'inflowTypeCode'):
        if col in rows[0]:
            k, body = dist(rows, col)
            print(f'  {col:20} {k:>4}종  {body}')

    # 등급에서 파생하면 안 되는 값인지 — 조합 수가 등급마다 하나뿐인지 본다(D167).
    pairs = collections.Counter((r.get('itemCode'), r.get('itemOptionSlot')) for r in rows)
    print(f'\n  등급×주당조합수 조합: {len(pairs)}가지')
    for (ic, slot), n in sorted(pairs.items(), key=lambda kv: -kv[1])[:8]:
        print(f'    {ic:10} slot={slot:<4} {n:>7,}')
    if len(pairs) > len(set(ic for ic, _ in pairs)):
        print('    ⚠️ 등급 하나에 조합수가 여럿이다 → 등급에서 파생하지 말고 회원별 실제값을 옮길 것')

    staff = collections.Counter(r.get('salesIdx', '0') for r in rows)
    print(f'\n  담당 상담원: {len(staff)}명 / 미배정 {staff.get("0", 0):,}명')

    ok = sum(1 for r in rows if re.fullmatch(r'01\d{8,9}', re.sub(r'\D', '', r.get('phone', ''))))
    print(f'  휴대폰 정상 형식: {ok:,} / {len(rows):,} ({100 * ok / len(rows):.1f}%)')

    today = datetime.date.today()
    ends = [d for d in (as_date(r.get('itemEndDateTime')) for r in rows) if d]
    if ends:
        exp = sum(1 for d in ends if d < today)
        soon = sum(1 for d in ends if today <= d <= today + datetime.timedelta(days=90))
        print(f'  종료일: 이미 만료 {exp:,}명 / 90일 내 만료 {soon:,}명 '
              f'({100 * soon / len(rows):.0f}%) / 유효 {len(rows) - exp:,}명')

    wd = collections.Counter(r.get('schedulePickSmsWeek', '') for r in rows)
    if len(wd) > 1:
        print('  ⚠️ 조합 발송요일이 흩어져 있다 → 기본값으로 일괄 입력하면 하루에 몰린다')


def report_payment(rows):
    print(f'\n■ payment — {len(rows):,}건')
    for col in ('statCode', 'payMethodCode', 'itemCode', 'itemStatCode', 'itemExpMonth'):
        if col in rows[0]:
            k, body = dist(rows, col, 8)
            print(f'  {col:20} {k:>4}종  {body}')
    won = collections.Counter(r.get('itemWon', '0') for r in rows)
    total = sum(int(r.get('itemWon') or 0) for r in rows)
    print(f'  결제액 최빈: ' + ' / '.join(f'{int(v):,}원×{n:,}' for v, n in won.most_common(4)))
    print(f'  총 매출: {total:,}원 (건당 평균 {total // max(len(rows), 1):,}원)')
    for col in ('salesIdx', 'salesRealIdx'):
        if col in rows[0]:
            c = collections.Counter(r.get(col, '0') for r in rows)
            note = '  ← 전부 0이라 쓸 수 없다' if len(c) == 1 and '0' in c else ''
            print(f'  {col:20} 서로 다른 값 {len(c)}개 / 0(미지정) {c.get("0", 0):,}건{note}')
    per = collections.Counter(r.get('userIdx') for r in rows)
    multi = sum(1 for n in per.values() if n > 1)
    print(f'  2건 이상 결제한 회원: {multi:,}명 (최다 {max(per.values())}건) '
          f'→ 종료일은 최근 결제 기준으로 잡을 것')


def report_betting(rows):
    print(f'\n■ gameBettingNlotto — {len(rows):,}건 (당첨분만)')
    g = collections.Counter(r.get('grade') for r in rows)
    print('  ' + ' / '.join(f'{k}등 {g[k]:,}' for k in sorted(g)))
    print(f'  당첨금 합계: {sum(int(r.get("prize") or 0) for r in rows):,}원')
    high = {r.get('userIdx') for r in rows if r.get('grade') in ('1', '2', '3')}
    print(f'  1~3등 당첨 회원: {len(high):,}명 → 당첨자 세그먼트 대상')


def report_memo(rows):
    print(f'\n■ userMemo — {len(rows):,}건')
    k, body = dist(rows, 'statTmCode')
    print(f'  상담상태 {k}종  {body}')
    per = collections.Counter(r.get('userIdx') for r in rows)
    print(f'  회원당 평균 {len(rows) / max(len(per), 1):.1f}건 / 최다 {max(per.values()):,}건')


REPORTS = {
    'user': report_user,
    'payment': report_payment,
    'gameBettingNlotto': report_betting,
    'userMemo': report_memo,
}


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    site, paths = argv[1], argv[2:]
    print(f'=== {site} 실물 검증 ===')
    for path in sorted(paths):
        table = next((t for t in REPORTS if f'_{t}.sql' in path), None)
        if table is None:
            print(f'\n(건너뜀 — 표 종류를 알 수 없음: {path})')
            continue
        rows, bad = load(path)
        if not rows:
            print(f'\n■ {table} — 행 없음')
            continue
        REPORTS[table](rows)
        if bad:
            print(f'  ⚠️ 컬럼 수가 맞지 않아 건너뛴 행: {bad:,}')
    print('\n※ 집계값만 출력했습니다. 개인정보는 포함돼 있지 않습니다.')


if __name__ == '__main__':
    main(sys.argv)
