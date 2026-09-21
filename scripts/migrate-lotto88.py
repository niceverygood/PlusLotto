#!/usr/bin/env python3
"""88로또 운영 Supabase → 신전산(플러스로또) Supabase 이관.

앞선 815·인포·일행과 달리 원본이 SQL 덤프가 아니라 **같은 계열 스키마의 운영 중인 Supabase**다.
그래서 load-legacy-site.py(덤프 파서)를 쓸 수 없고, 등급·결제수단을 추정할 필요도 없다.
docs/LOTTO88_MIGRATION_PLAN.md 참조.

권장 순서:
  python3 scripts/migrate-lotto88.py --dry-run
  python3 scripts/migrate-lotto88.py --plan
  python3 scripts/migrate-lotto88.py --apply --batch-id lotto88-20261005
  # 전환일 2차(증분):
  python3 scripts/migrate-lotto88.py --apply --batch-id lotto88-20261005-delta --since 2026-09-28T00:00:00Z

환경변수 (이 스크립트는 값을 화면에 찍지 않는다):
  LOTTO88_SUPABASE_URL / LOTTO88_SERVICE_ROLE_KEY   원본(88로또) — 읽기만 한다
  VITE_SUPABASE_URL    / SUPABASE_SERVICE_ROLE_KEY  대상(신전산) — --apply 에서만 쓴다

개인정보: 출력은 **건수와 집계만**이다. 이름·전화번호·주소는 어떤 모드에서도 찍지 않는다.
검수용 목록이 필요하면 --sample-out 으로 파일에 따로 쓰고, 그 파일은 저장소 밖에 둔다.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter
from typing import Any, Iterable

SITE = 'lotto88'
BATCH_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
PAGE = 1000

# 원본에서 그대로 옮기는 회원 컬럼. 신전산 members 와 이름·의미가 같다.
MEMBER_COPY_FIELDS = (
    'name', 'nickname', 'phone', 'grade', 'status', 'tendency', 'consult_status',
    'inflow_code', 'inflow_type', 'memo', 'win_history', 'outcall_done',
    'registered_at', 'last_active_at', 'is_suspended', 'is_deleted', 'is_withdrawn',
)
# 담당자·팀은 옮기지 않는다 — 88로또 staff id 는 신전산에 없다. 원본 값은 meta 에 보존한다.
MEMBER_DROP_FIELDS = ('assigned_staff_id', 'team_id')

PAYMENT_COPY_FIELDS = (
    'amount', 'method', 'pg_provider', 'status', 'period_start', 'period_end',
    'depositor_name', 'paid_at', 'created_at',
)

SMS_COPY_FIELDS = ('template_key', 'phone', 'body', 'type', 'status', 'sent_at')


# ──────────────────────────────────────────────────────────────────────────────
# 순수 변환 — DB 없이 테스트 가능한 부분은 전부 여기에 둔다.
# ──────────────────────────────────────────────────────────────────────────────

def stable_id(kind: str, legacy_id: str) -> str:
    """원본 id → 신전산 id. 결정적이라 같은 행을 두 번 넣어도 같은 id 가 나온다(멱등).

    load-legacy-site.py 의 stable_id 와 같은 규약이되, 88로또 원본 id 는 정수가 아니라
    문자열이라 그대로 키에 넣는다.
    """
    prefix = {'member': 'mem', 'payment': 'pay', 'sms': 'sms'}[kind]
    uid = uuid.uuid5(uuid.NAMESPACE_URL, f'https://lotto-plus.co.kr/legacy/{kind}/{SITE}/{legacy_id}')
    return f'{prefix}_{uid}'


def member_row(src: dict[str, Any], batch_id: str) -> tuple[dict[str, Any] | None, str | None]:
    """88로또 회원 1건 → 신전산 회원 행. (행, 건너뛴 사유) 중 하나만 채워 돌려준다."""
    legacy_id = src.get('id')
    if not isinstance(legacy_id, str) or not legacy_id:
        return None, 'id 누락'
    if not src.get('phone'):
        return None, '전화번호 누락'

    src_meta = src.get('meta') if isinstance(src.get('meta'), dict) else {}

    # 원본 meta 를 통째로 가져간다 — weekly_recos·weekly_reco_day·weekly_reco_count·end_date 등
    # 발송 규칙이 전부 여기 들어 있고, 추정으로 다시 만들면 값이 어긋난다.
    meta: dict[str, Any] = dict(src_meta)

    # 이관 표식. 전환일까지는 발송 보류 상태로 둔다(legacyImportHold / sms_is_legacy_import_held).
    meta['source_site'] = SITE
    meta['import_batch'] = batch_id
    meta['reco_paused'] = True
    meta['reco_pause_reason'] = 'legacy_import_review'
    meta['legacy_id'] = legacy_id

    # ★ 원본의 발송 일시정지 여부를 따로 보존한다.
    #   위에서 reco_paused 를 무조건 True 로 덮어쓰기 때문에, 전환일에 일괄 해제하면
    #   "원래부터 정지였던 회원"까지 같이 켜져 발송돼 버린다. 전환 시 이 값으로 복원한다.
    meta['lotto88_reco_paused_at_import'] = bool(src_meta.get('reco_paused') is True)
    if src_meta.get('reco_pause_reason') is not None:
        meta['lotto88_reco_pause_reason_at_import'] = src_meta.get('reco_pause_reason')

    # 담당자·팀은 신전산에 대응 id 가 없다. 배정은 전환 후 현장이 다시 한다.
    for field in MEMBER_DROP_FIELDS:
        if src.get(field):
            meta[f'legacy_{field}'] = src.get(field)

    row: dict[str, Any] = {
        'id': stable_id('member', legacy_id),
        # 로그인 ID 는 사이트 안에서만 유일하므로 신전산에서 충돌할 수 있다. 접두사를 붙인다.
        'user_id': f'{SITE}_{src.get("user_id") or legacy_id}',
        'assigned_staff_id': None,
        'team_id': None,
        'meta': meta,
    }
    for field in MEMBER_COPY_FIELDS:
        row[field] = src.get(field)
    if not row.get('name'):
        row['name'] = ''
    return row, None


def payment_row(src: dict[str, Any], batch_id: str, member_ids: set[str]) -> tuple[dict[str, Any] | None, str | None]:
    legacy_id = src.get('id')
    if not isinstance(legacy_id, str) or not legacy_id:
        return None, 'id 누락'
    legacy_member = src.get('member_id')
    if not isinstance(legacy_member, str) or not legacy_member:
        return None, '회원 연결 누락'
    new_member_id = stable_id('member', legacy_member)
    if new_member_id not in member_ids:
        # 회원이 건너뛰어졌거나 원본에 없는 결제. 고아 행을 만들지 않는다.
        return None, '연결된 회원 없음'

    meta: dict[str, Any] = dict(src.get('meta') if isinstance(src.get('meta'), dict) else {})
    meta['source_site'] = SITE
    meta['import_batch'] = batch_id
    meta['legacy_id'] = legacy_id
    # 상품 id 는 사이트마다 다른 상품표를 가리킨다. 신전산 상품으로 임의 매핑하지 않고
    # 원본 값만 보존한다(815·인포와 같은 방식). 상품 대응은 현장 확인 후 별도 처리.
    if src.get('product_id'):
        meta['legacy_product_id'] = src.get('product_id')
    if src.get('staff_id'):
        meta['legacy_staff_id'] = src.get('staff_id')

    row: dict[str, Any] = {
        'id': stable_id('payment', legacy_id),
        'member_id': new_member_id,
        'product_id': None,
        'staff_id': None,
        # 신전산에만 있는 컬럼. 원본에 없으므로 비운다(차수 도입 이전 결제와 같은 취급).
        'round_label': None,
        'meta': meta,
    }
    for field in PAYMENT_COPY_FIELDS:
        row[field] = src.get(field)
    return row, None


def sms_row(src: dict[str, Any], batch_id: str, member_ids: set[str]) -> tuple[dict[str, Any] | None, str | None]:
    legacy_id = src.get('id')
    if not isinstance(legacy_id, str) or not legacy_id:
        return None, 'id 누락'
    legacy_member = src.get('member_id')
    new_member_id = stable_id('member', legacy_member) if isinstance(legacy_member, str) and legacy_member else None
    if new_member_id is not None and new_member_id not in member_ids:
        return None, '연결된 회원 없음'

    meta: dict[str, Any] = dict(src.get('meta') if isinstance(src.get('meta'), dict) else {})
    meta['source_site'] = SITE
    meta['import_batch'] = batch_id
    meta['legacy_id'] = legacy_id

    row: dict[str, Any] = {
        'id': stable_id('sms', legacy_id),
        'member_id': new_member_id,
        'meta': meta,
    }
    for field in SMS_COPY_FIELDS:
        row[field] = src.get(field)
    return row, None


def summarize(rows: Iterable[dict[str, Any]], key: str) -> dict[str, int]:
    """집계만 돌려준다 — 개인정보가 섞이지 않는 컬럼에만 쓴다."""
    return dict(Counter(str(row.get(key)) for row in rows))


def validate_batch_id(batch_id: str | None, *, required: bool) -> str:
    if not batch_id:
        if required:
            raise SystemExit('--apply 에는 --batch-id 가 필요하다. 없으면 나중에 되돌릴 수 없다.')
        return f'{SITE}-preview'
    if not BATCH_ID_RE.match(batch_id):
        raise SystemExit('--batch-id 는 영문/숫자/._- 만 쓸 수 있다(최대 64자).')
    return batch_id


# ──────────────────────────────────────────────────────────────────────────────
# Supabase REST — 읽기/쓰기
# ──────────────────────────────────────────────────────────────────────────────

class Rest:
    def __init__(self, url: str, key: str, label: str) -> None:
        self.base = url.rstrip('/') + '/rest/v1'
        self.key = key
        self.label = label

    def _request(self, method: str, path: str, *, body: bytes | None = None,
                 headers: dict[str, str] | None = None) -> tuple[int, bytes]:
        req = urllib.request.Request(f'{self.base}{path}', data=body, method=method)
        req.add_header('apikey', self.key)
        req.add_header('authorization', f'Bearer {self.key}')
        req.add_header('content-type', 'application/json')
        for name, value in (headers or {}).items():
            req.add_header(name, value)
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as err:
            detail = err.read().decode('utf-8', 'replace')[:400]
            # 응답 본문에 회원 값이 섞일 수 있어 그대로는 올리지 않는다.
            raise SystemExit(f'[{self.label}] {method} {path} 실패 ({err.code}). 응답 앞부분: {detail}') from None
        except urllib.error.URLError as err:
            raise SystemExit(f'[{self.label}] 접속 실패: {err.reason}') from None

    def select_all(self, table: str, columns: str, *, since: str | None = None,
                   since_column: str = 'updated_at') -> list[dict[str, Any]]:
        """커서(id 오름차순) 페이지네이션. offset 은 읽는 도중 행이 바뀌면 건너뜀/중복이 난다."""
        rows: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            params = [('select', columns), ('order', 'id.asc'), ('limit', str(PAGE))]
            if cursor is not None:
                params.append(('id', f'gt.{cursor}'))
            if since:
                params.append((since_column, f'gte.{since}'))
            query = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
            _, raw = self._request('GET', f'/{table}?{query}')
            page = json.loads(raw.decode('utf-8'))
            rows.extend(page)
            if len(page) < PAGE:
                return rows
            cursor = page[-1]['id']

    def existing_ids(self, table: str, ids: list[str]) -> set[str]:
        """대상 DB 에 이미 있는 id 만 돌려준다(멱등 판정)."""
        found: set[str] = set()
        for chunk in (ids[i:i + 200] for i in range(0, len(ids), 200)):
            quoted = ','.join(urllib.parse.quote(i, safe='') for i in chunk)
            _, raw = self._request('GET', f'/{table}?select=id&id=in.({quoted})')
            found.update(row['id'] for row in json.loads(raw.decode('utf-8')))
        return found

    def upsert(self, table: str, rows: list[dict[str, Any]], batch: int = 200) -> int:
        written = 0
        for chunk in (rows[i:i + batch] for i in range(0, len(rows), batch)):
            body = json.dumps(chunk, ensure_ascii=False).encode('utf-8')
            self._request('POST', f'/{table}', body=body,
                          headers={'prefer': 'resolution=merge-duplicates,return=minimal'})
            written += len(chunk)
            print(f'  {table}: {written}/{len(rows)}', flush=True)
        return written


def env(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def source_client() -> Rest:
    url, key = env('LOTTO88_SUPABASE_URL'), env('LOTTO88_SERVICE_ROLE_KEY')
    if not url or not key:
        raise SystemExit('LOTTO88_SUPABASE_URL / LOTTO88_SERVICE_ROLE_KEY 가 필요하다(원본, 읽기 전용).')
    return Rest(url, key, '88로또')


def target_client() -> Rest:
    url = env('VITE_SUPABASE_URL') or env('SUPABASE_URL')
    key = env('SUPABASE_SERVICE_ROLE_KEY')
    if not url or not key:
        raise SystemExit('VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요하다(대상 신전산).')
    return Rest(url, key, '신전산')


# ──────────────────────────────────────────────────────────────────────────────

def build(src_members: list[dict[str, Any]], src_payments: list[dict[str, Any]],
          src_sms: list[dict[str, Any]], batch_id: str) -> dict[str, Any]:
    members: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    for row in src_members:
        built, why = member_row(row, batch_id)
        if built is None:
            skipped[f'회원: {why}'] += 1
        else:
            members.append(built)
    member_ids = {row['id'] for row in members}

    payments: list[dict[str, Any]] = []
    for row in src_payments:
        built, why = payment_row(row, batch_id, member_ids)
        if built is None:
            skipped[f'결제: {why}'] += 1
        else:
            payments.append(built)

    sms: list[dict[str, Any]] = []
    for row in src_sms:
        built, why = sms_row(row, batch_id, member_ids)
        if built is None:
            skipped[f'문자: {why}'] += 1
        else:
            sms.append(built)

    return {'members': members, 'payments': payments, 'sms_sends': sms, 'skipped': dict(skipped)}


def report(built: dict[str, Any]) -> None:
    members = built['members']
    print(f'  회원   {len(members):>7,}건')
    print(f'  결제   {len(built["payments"]):>7,}건')
    print(f'  문자   {len(built["sms_sends"]):>7,}건')
    if members:
        grades = summarize(members, 'grade')
        print('  등급별: ' + ' · '.join(f'{k} {v:,}' for k, v in sorted(grades.items())))
        paused = sum(1 for m in members if m['meta'].get('lotto88_reco_paused_at_import'))
        print(f'  원본에서 이미 발송정지였던 회원: {paused:,}건 (전환일 활성화에서 제외해야 함)')
    if built['skipped']:
        print('  건너뜀:')
        for reason, count in sorted(built['skipped'].items()):
            print(f'    {reason}: {count:,}건')


def main() -> int:
    ap = argparse.ArgumentParser(description='88로또 → 신전산 이관')
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true', help='원본만 읽고 변환 결과를 센다. 대상 DB 접속 없음.')
    mode.add_argument('--plan', action='store_true', help='대상 DB 도 읽어 신규/기존을 나눈다. 쓰기 없음.')
    mode.add_argument('--apply', action='store_true', help='실제로 적재한다. --batch-id 필수.')
    ap.add_argument('--batch-id', help='적재 배치 식별자. meta.import_batch 로 저장되어 롤백 근거가 된다.')
    ap.add_argument('--since', help='이 시각(ISO) 이후 변경분만. 전환일 2차 증분 적재용.')
    args = ap.parse_args()

    batch_id = validate_batch_id(args.batch_id, required=bool(args.apply))

    src = source_client()
    print(f'[1/3] 88로또 원본 읽는 중{" (증분: " + args.since + " 이후)" if args.since else ""}…', flush=True)
    member_cols = ','.join(('id', 'user_id', 'meta', *MEMBER_COPY_FIELDS, *MEMBER_DROP_FIELDS))
    src_members = src.select_all('members', member_cols, since=args.since, since_column='registered_at')
    src_payments = src.select_all('payments', ','.join(('id', 'member_id', 'product_id', 'staff_id', *PAYMENT_COPY_FIELDS)),
                                  since=args.since, since_column='created_at')
    src_sms = src.select_all('sms_sends', ','.join(('id', 'member_id', *SMS_COPY_FIELDS)),
                             since=args.since, since_column='sent_at')
    print(f'  원본: 회원 {len(src_members):,} · 결제 {len(src_payments):,} · 문자 {len(src_sms):,}')

    print('[2/3] 변환…', flush=True)
    built = build(src_members, src_payments, src_sms, batch_id)
    report(built)

    if args.dry_run:
        print('\n--dry-run 이므로 대상 DB 에 접속하지 않았다. 다음은 --plan.')
        return 0

    tgt = target_client()
    print('[3/3] 대상 대조…', flush=True)
    plan: dict[str, list[dict[str, Any]]] = {}
    for table in ('members', 'payments', 'sms_sends'):
        rows = built[table]
        have = tgt.existing_ids(table, [row['id'] for row in rows]) if rows else set()
        fresh = [row for row in rows if row['id'] not in have]
        plan[table] = fresh
        print(f'  {table}: 신규 {len(fresh):,} · 이미 있음 {len(rows) - len(fresh):,}')

    if args.plan:
        print('\n--plan 이므로 쓰지 않았다. 적재하려면 --apply --batch-id <배치명>.')
        return 0

    print(f'\n[적재] batch={batch_id}', flush=True)
    # 회원 → 결제 → 문자 순서. 결제·문자가 회원을 참조하므로 순서를 바꾸면 실패한다.
    for table in ('members', 'payments', 'sms_sends'):
        rows = plan[table]
        if not rows:
            print(f'  {table}: 신규 없음')
            continue
        tgt.upsert(table, rows)
    print('\n완료. 이관 회원은 전부 발송 보류 상태다 — 전환일에 명시적으로 활성화해야 한다.')
    print('활성화 시 meta.lotto88_reco_paused_at_import=true 인 회원은 제외할 것(원본에서 이미 정지였음).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
