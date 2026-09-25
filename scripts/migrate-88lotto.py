#!/usr/bin/env python3
"""88로또(형제 전산) 회원·결제를 플러스로또 Supabase로 옮긴다.

815·인포·일행과 다른 점 — 업체 SQL 덤프가 아니라 **스키마가 같은 우리 전산**에서 읽는다.
등급·상태·결제수단 enum 이 양쪽 동일해서 값을 추측할 일이 없다(D194 §2). 대신 세 가지가 어렵다.

  1. **옮기는 동안에도 88 쪽 화요일 발송이 돌아간다.** 그래서 한 번에 끝내지 않고
     이관(1차) → 변경분(2차) 두 번 돌린다. 2차는 1차 이후 바뀐 회원만 갱신한다.
  2. **양쪽 모두의 회원인 사람이 있다.** 같은 번호의 members INSERT 는 트리거가 막는다
     (`enforce_member_admin_ops`, service_role 도 동일 적용). 200행 묶음 하나가 통째로
     실패하므로 **넣기 전에 골라내고 현장 판단으로 넘긴다.** 자동 병합하지 않는다.
  3. **담당자·팀·상품 id 가 88 쪽 값이다.** 그대로 넣으면 FK 가 깨진다. 담당자는 login_id,
     팀은 이름으로 맞추고, 못 맞춘 건 비워 두고 건수를 보고한다.

권장 순서(둘 다 --plan 을 먼저 본다):
  python3 scripts/migrate-88lotto.py --plan            # 1차 대조, 쓰기 없음
  python3 scripts/migrate-88lotto.py --apply           # 1차 이관
  python3 scripts/migrate-88lotto.py --plan            # 2차 변경분 대조
  python3 scripts/migrate-88lotto.py --apply           # 2차 변경분 반영

--plan 은 양쪽 DB 를 읽기만 한다. 원본(88) 접속은 어느 모드에서도 **구조적으로 읽기 전용**이다.
URL/키는 환경변수로만 받는다(명령행에 키를 쓰면 셸 기록에 남는다).
  원본: LOTTO88_SUPABASE_URL · LOTTO88_SERVICE_ROLE_KEY
  대상: VITE_SUPABASE_URL   · SUPABASE_SERVICE_ROLE_KEY

⚠️ 이관된 회원은 전원 조합발송 보류(`reco_pause_reason='legacy_import_review'`)로 들어간다.
   검수 후 운영자가 해제해야 문자가 나간다. 2차 실행은 **대상 쪽 보류 상태를 건드리지 않는다**
   — 이미 해제한 회원을 다시 잠그거나, 미검수 회원의 잠금을 푸는 사고를 막는다.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Iterable

SOURCE_SITE = 'lotto88'
IMPORT_HOLD = 'legacy_import_review'
BATCH_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')

# 2차 실행에서 원본을 따라 덮어쓰는 회원 컬럼. 여기 없는 컬럼(담당자·상담상태·메모 등)은
# 이관 후 플러스로또에서 운영진이 손댔을 수 있어 건드리지 않는다.
MEMBER_SYNC_COLUMNS = (
    'name', 'nickname', 'phone', 'grade', 'status',
    'is_suspended', 'is_deleted', 'is_withdrawn',
)
# 2차 실행에서 따라가는 meta 키. reco_paused/reco_pause_reason 은 일부러 뺐다(위 ⚠️).
META_SYNC_KEYS = ('end_date', 'weekly_reco_day', 'weekly_reco_count')

GRADES = frozenset({'simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss'})
STATUSES = frozenset({'active', 'suspended', 'deleted', 'withdrawn'})
PAYMENT_METHODS = frozenset({'bank', 'manual', 'pg'})
PAYMENT_STATUSES = frozenset({'wait', 'approved', 'failed', 'cancelled'})


class Supa:
    """PostgREST 최소 클라이언트. allow_writes=False 면 GET 외에는 예외를 던진다."""

    def __init__(self, url: str, key: str, allow_writes: bool):
        self.url, self.key, self.allow_writes = url.rstrip('/'), key, allow_writes

    def _req(self, method: str, path: str, body=None, prefer: str | None = None):
        if method != 'GET' and not self.allow_writes:
            raise RuntimeError('읽기 전용 모드에서는 Supabase 쓰기를 실행할 수 없습니다')
        request = urllib.request.Request(f'{self.url}/rest/v1/{path}', method=method)
        request.add_header('apikey', self.key)
        request.add_header('Authorization', f'Bearer {self.key}')
        request.add_header('Content-Type', 'application/json')
        if prefer:
            request.add_header('Prefer', prefer)
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, data, timeout=120) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else []
            except urllib.error.HTTPError as error:
                if error.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                # details 에 실패 행 전체(PII)가 들어올 수 있어 버리고 code/message 만 남긴다.
                db_code, message = 'unknown', '요청이 거부됐습니다'
                try:
                    payload = json.loads(error.read().decode('utf-8', 'replace'))
                    db_code = str(payload.get('code') or db_code)
                    message = str(payload.get('message') or message)
                except (json.JSONDecodeError, AttributeError):
                    pass
                message = re.sub(r'\b\d{6,}\b', '<redacted>', message)[:240]
                raise SystemExit(
                    f'Supabase 요청 실패(HTTP {error.code}, DB {db_code}): {message}'
                ) from error
            except urllib.error.URLError as error:
                if attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                raise SystemExit('Supabase 네트워크 요청에 실패했습니다') from error
        return []

    def select_all(self, table: str, columns: str,
                   filters: list[tuple[str, str]] | None = None) -> list[dict]:
        rows: list[dict] = []
        for offset in range(0, 10_000_000, 1000):
            # 정렬이 없으면 동시 입력 시 페이지 경계가 흔들린다. 모든 대상 테이블의 PK 로 고정한다.
            params = [
                ('select', columns), ('order', 'id.asc'),
                ('limit', '1000'), ('offset', str(offset)), *(filters or []),
            ]
            page = self._req('GET', f'{table}?{urllib.parse.urlencode(params, safe=",.*")}')
            rows.extend(page)
            if len(page) < 1000:
                break
        return rows

    def insert(self, table: str, rows: list[dict]):
        return self._req('POST', table, rows, prefer='return=minimal')

    def upsert(self, table: str, rows: list[dict]):
        return self._req('POST', table, rows,
                         prefer='resolution=merge-duplicates,return=minimal')

    def patch(self, table: str, row_id: str, patch: dict):
        query = urllib.parse.urlencode([('id', f'eq.{row_id}')], safe=',.*')
        return self._req('PATCH', f'{table}?{query}', patch, prefer='return=minimal')


def digits(value) -> str:
    return re.sub(r'\D', '', str(value or ''))


def stable_id(kind: str, legacy_id: str) -> str:
    """88 쪽 id 에서 항상 같은 플러스로또 id 를 만든다 — 재실행해도 중복 생성되지 않는다."""
    prefix = {'member': 'mem', 'payment': 'pay', 'product': 'prd'}[kind]
    uid = uuid.uuid5(uuid.NAMESPACE_URL, f'https://lotto-plus.co.kr/legacy/{kind}/{SOURCE_SITE}/{legacy_id}')
    return f'{prefix}_{uid}'


def default_batch_id() -> str:
    return f'{SOURCE_SITE}-20261012'


def build_member(src: dict, batch_id: str, staff_map: dict[str, str],
                 team_map: dict[str, str]) -> tuple[dict | None, str | None]:
    """88 members 행 → 플러스로또 members 행. 넣을 수 없으면 (None, 사유)."""
    legacy_id = str(src.get('id') or '').strip()
    if not legacy_id:
        return None, '원본 회원 id 없음'
    phone = digits(src.get('phone'))
    if not re.fullmatch(r'01\d{8,9}', phone):
        # 88 쪽은 우리 전산이라 형식이 깨질 일이 드물다. 나오면 원본을 고쳐야 한다.
        return None, '휴대폰 형식 오류'
    grade = src.get('grade') or 'free'
    if grade not in GRADES:
        return None, f'등급 미대응({grade})'
    status = src.get('status') or 'active'
    if status not in STATUSES:
        return None, f'상태 미대응({status})'

    src_meta = src.get('meta') if isinstance(src.get('meta'), dict) else {}
    meta = {
        'source_site': SOURCE_SITE,
        'import_batch': batch_id,
        # 이관 직후 자동 조합발급/문자가 나가지 않도록 격리한다. 운영자가 검수 후 해제한다.
        'reco_paused': True,
        'reco_pause_reason': IMPORT_HOLD,
        'legacy_id': legacy_id,
        'legacy_user_id': src.get('user_id') or None,
    }
    for key in META_SYNC_KEYS:
        if src_meta.get(key) is not None:
            meta[key] = src_meta[key]

    row = {
        'id': stable_id('member', legacy_id),
        # 로그인 아이디는 88 쪽 값을 그대로 쓴다. 양쪽 다 쓰는 사람은 아래 전화번호 충돌에서
        # 먼저 걸러지므로, 여기까지 온 값이 겹칠 일은 사실상 없다(유니크 제약도 없다).
        'user_id': src.get('user_id') or f'legacy_{SOURCE_SITE}_{legacy_id}',
        'name': src.get('name') or '',
        'nickname': src.get('nickname') or None,
        'phone': phone,
        'grade': grade,
        'status': status,
        'tendency': src.get('tendency') or None,
        'consult_status': src.get('consult_status') or None,
        'outcall_done': bool(src.get('outcall_done')),
        'inflow_code': src.get('inflow_code') or None,
        'inflow_type': src.get('inflow_type') or None,
        'assigned_staff_id': staff_map.get(str(src.get('assigned_staff_id') or '')),
        'team_id': team_map.get(str(src.get('team_id') or '')),
        'memo': src.get('memo') or None,
        'win_history': src.get('win_history') or None,
        'registered_at': src.get('registered_at'),
        'last_active_at': src.get('last_active_at'),
        'is_suspended': bool(src.get('is_suspended')),
        'is_deleted': bool(src.get('is_deleted')),
        'is_withdrawn': bool(src.get('is_withdrawn')),
        'meta': meta,
    }
    if not row['registered_at']:
        return None, '가입일시 없음'
    if row['consult_status'] is None:
        row.pop('consult_status')
    return row, None


def build_product(src: dict) -> dict:
    legacy_id = str(src.get('id') or '')
    return {
        'id': stable_id('product', legacy_id),
        'name': src.get('name') or f'88로또 상품 {legacy_id}',
        'price': int(src.get('price') or 0),
        'duration_months': int(src.get('duration_months') or 1),
        'grade_granted': src.get('grade_granted') if src.get('grade_granted') in GRADES else 'free',
        # 이관 이력 표시용이며 신규 결제 선택지에는 노출하지 않는다.
        'is_active': False,
    }


def build_payment(src: dict, member_id: str, product_id: str | None,
                  batch_id: str, staff_map: dict[str, str]) -> tuple[dict | None, str | None]:
    legacy_id = str(src.get('id') or '').strip()
    if not legacy_id:
        return None, '원본 결제 id 없음'
    method = src.get('method')
    if method not in PAYMENT_METHODS:
        return None, f'결제수단 미대응({method})'
    status = src.get('status')
    if status not in PAYMENT_STATUSES:
        return None, f'결제상태 미대응({status})'
    return {
        'id': stable_id('payment', legacy_id),
        'member_id': member_id,
        'product_id': product_id,
        'amount': int(src.get('amount') or 0),
        'method': method,
        'pg_provider': src.get('pg_provider') or None,
        'status': status,
        'period_start': src.get('period_start'),
        'period_end': src.get('period_end'),
        'depositor_name': src.get('depositor_name') or None,
        'staff_id': staff_map.get(str(src.get('staff_id') or '')),
        'paid_at': src.get('paid_at'),
    }, None


def member_changes(existing: dict, incoming: dict) -> dict:
    """2차 실행에서 실제로 바뀐 것만 고른다. 없으면 빈 dict."""
    patch: dict = {}
    for column in MEMBER_SYNC_COLUMNS:
        if existing.get(column) != incoming.get(column):
            patch[column] = incoming.get(column)
    old_meta = existing.get('meta') if isinstance(existing.get('meta'), dict) else {}
    new_meta = incoming.get('meta') or {}
    meta_patch = {key: new_meta[key] for key in META_SYNC_KEYS
                  if key in new_meta and old_meta.get(key) != new_meta[key]}
    if meta_patch:
        # 대상 meta 를 통째로 바꾸지 않고 병합한다 — 보류 해제 상태와 운영 중 붙은 키를 지키려면
        # 이 병합이 반드시 필요하다. 덮어쓰면 검수 해제가 되돌아간다.
        patch['meta'] = {**old_meta, **meta_patch}
    return patch


class Plan:
    def __init__(self):
        self.new_members: list[dict] = []
        self.updates: list[tuple[str, dict]] = []   # (대상 member id, patch)
        self.unchanged = 0
        self.collisions: list[dict] = []            # 번호가 이미 있는 회원 — 현장 판단
        self.skipped: list[tuple[str, str]] = []    # (88 id, 사유)
        self.products: list[dict] = []
        self.new_payments: list[dict] = []
        self.skipped_payments: list[tuple[str, str]] = []
        self.unmapped_staff = 0
        self.unmapped_team = 0


def build_plan(src_members: Iterable[dict], src_payments: Iterable[dict],
               src_products: Iterable[dict], dest_members: Iterable[dict],
               dest_payment_ids: set[str], staff_map: dict[str, str],
               team_map: dict[str, str], batch_id: str,
               limit: int | None = None) -> Plan:
    plan = Plan()

    imported: dict[str, dict] = {}   # 88 id → 이미 이관된 대상 회원 행
    phone_owner: dict[str, str] = {} # 번호 → 대상 회원 id
    for member in dest_members:
        meta = member.get('meta') if isinstance(member.get('meta'), dict) else {}
        phone = digits(member.get('phone'))
        if phone:
            phone_owner.setdefault(phone, member['id'])
        if meta.get('source_site') == SOURCE_SITE and meta.get('legacy_id'):
            imported[str(meta['legacy_id'])] = member

    member_ids: dict[str, str] = {}
    taken_phones: dict[str, str] = {}  # 이번 원본 안에서의 번호 중복도 잡는다
    for src in src_members:
        if limit is not None and len(plan.new_members) >= limit:
            break
        row, reason = build_member(src, batch_id, staff_map, team_map)
        if row is None:
            plan.skipped.append((str(src.get('id') or '?'), reason or '알 수 없음'))
            continue
        legacy_id = str(src['id'])
        if src.get('assigned_staff_id') and row['assigned_staff_id'] is None:
            plan.unmapped_staff += 1
        if src.get('team_id') and row['team_id'] is None:
            plan.unmapped_team += 1

        already = imported.get(legacy_id)
        if already is not None:
            member_ids[legacy_id] = already['id']
            patch = member_changes(already, row)
            if patch:
                plan.updates.append((already['id'], patch))
            else:
                plan.unchanged += 1
            continue

        owner = phone_owner.get(row['phone'])
        if owner is not None:
            # 이미 플러스로또에 같은 번호가 있다. INSERT 는 트리거가 거부하고 묶음 전체가
            # 실패하므로 시도하지 않는다. 합칠지 말지는 사람이 정한다.
            plan.collisions.append({'legacy_id': legacy_id, 'existing_member_id': owner})
            continue
        if row['phone'] in taken_phones:
            plan.collisions.append({'legacy_id': legacy_id,
                                    'existing_member_id': taken_phones[row['phone']]})
            continue

        taken_phones[row['phone']] = row['id']
        member_ids[legacy_id] = row['id']
        plan.new_members.append(row)

    product_ids: dict[str, str] = {}
    for src in src_products:
        built = build_product(src)
        product_ids[str(src.get('id') or '')] = built['id']
        plan.products.append(built)

    for src in src_payments:
        legacy_member = str(src.get('member_id') or '')
        member_id = member_ids.get(legacy_member)
        if member_id is None:
            # 회원이 충돌/제외로 안 들어갔으면 결제도 넣지 않는다. 고아 결제를 만들지 않는다.
            plan.skipped_payments.append((str(src.get('id') or '?'), '대상 회원 없음'))
            continue
        row, reason = build_payment(src, member_id,
                                    product_ids.get(str(src.get('product_id') or '')),
                                    batch_id, staff_map)
        if row is None:
            plan.skipped_payments.append((str(src.get('id') or '?'), reason or '알 수 없음'))
            continue
        if row['id'] in dest_payment_ids:
            continue
        if src.get('staff_id') and row['staff_id'] is None:
            plan.unmapped_staff += 1
        plan.new_payments.append(row)

    return plan


def print_plan(plan: Plan) -> None:
    print('--- 이관 계획 ---')
    print(f'  신규 회원      {len(plan.new_members):,}명')
    print(f'  변경분 갱신    {len(plan.updates):,}명')
    print(f'  변동 없음      {plan.unchanged:,}명')
    print(f'  번호 충돌      {len(plan.collisions):,}명  ← 넣지 않는다. 현장 판단 필요')
    print(f'  제외           {len(plan.skipped):,}명')
    print(f'  상품           {len(plan.products):,}건')
    print(f'  신규 결제      {len(plan.new_payments):,}건')
    print(f'  결제 제외      {len(plan.skipped_payments):,}건')
    if plan.unmapped_staff:
        print(f'  ⚠ 담당자 미매칭 {plan.unmapped_staff:,}건 — 비워 두고 넣는다')
    if plan.unmapped_team:
        print(f'  ⚠ 팀 미매칭     {plan.unmapped_team:,}건 — 비워 두고 넣는다')
    if plan.skipped:
        print('  제외 사유:')
        counts: dict[str, int] = {}
        for _, reason in plan.skipped:
            counts[reason] = counts.get(reason, 0) + 1
        for reason, count in sorted(counts.items(), key=lambda item: -item[1]):
            print(f'    - {reason}: {count:,}명')
    if plan.new_members:
        print(f'\n  신규 회원은 전원 조합발송 보류({IMPORT_HOLD})로 들어간다.')
        print('  검수 후 운영자가 해제해야 문자가 나간다.')


def insert_chunked(client: Supa, table: str, rows: list[dict], upsert: bool = False) -> None:
    action = client.upsert if upsert else client.insert
    for offset in range(0, len(rows), 200):
        action(table, rows[offset:offset + 200])
        print(f'  {table} {min(offset + 200, len(rows)):,}/{len(rows):,}')


def build_staff_map(src_staff: Iterable[dict], dest_staff: Iterable[dict]) -> dict[str, str]:
    """88 staff.id → 플러스로또 staff.id. login_id 로 맞추고, 없으면 이름으로 맞춘다."""
    by_login = {str(row.get('login_id') or '').strip().lower(): row['id']
                for row in dest_staff if row.get('login_id')}
    by_name: dict[str, str] = {}
    seen_names: set[str] = set()
    for row in dest_staff:
        name = str(row.get('name') or '').strip()
        if not name:
            continue
        if name in seen_names:
            # 동명이인은 이름으로 맞출 수 없다. 후보에서 빼고 미매칭으로 남긴다.
            by_name.pop(name, None)
            continue
        seen_names.add(name)
        by_name[name] = row['id']
    mapping: dict[str, str] = {}
    for row in src_staff:
        login = str(row.get('login_id') or '').strip().lower()
        name = str(row.get('name') or '').strip()
        target = by_login.get(login) or by_name.get(name)
        if target:
            mapping[str(row['id'])] = target
    return mapping


def build_team_map(src_teams: Iterable[dict], dest_teams: Iterable[dict]) -> dict[str, str]:
    by_name: dict[str, str] = {}
    seen: set[str] = set()
    for row in dest_teams:
        name = str(row.get('name') or '').strip()
        if not name:
            continue
        if name in seen:
            by_name.pop(name, None)
            continue
        seen.add(name)
        by_name[name] = row['id']
    return {str(row['id']): by_name[str(row.get('name') or '').strip()]
            for row in src_teams if str(row.get('name') or '').strip() in by_name}


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-url', default=os.getenv('LOTTO88_SUPABASE_URL'))
    parser.add_argument('--source-key', default=os.getenv('LOTTO88_SERVICE_ROLE_KEY'),
                        help=argparse.SUPPRESS)
    parser.add_argument('--url', default=os.getenv('VITE_SUPABASE_URL'))
    parser.add_argument('--key', default=os.getenv('SUPABASE_SERVICE_ROLE_KEY'),
                        help=argparse.SUPPRESS)
    parser.add_argument('--limit', type=int, help='시범 이관용 신규 회원 상한')
    parser.add_argument('--batch-id', help=f'적재 묶음 식별자(기본: {default_batch_id()})')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', action='store_true', help='양쪽 읽기 전용 대조')
    mode.add_argument('--apply', action='store_true', help='명시적으로 실제 이관')
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit <= 0:
        parser.error('--limit은 양수여야 합니다')
    args.batch_id = args.batch_id or default_batch_id()
    if not BATCH_ID_RE.fullmatch(args.batch_id):
        parser.error('--batch-id는 영문/숫자로 시작하는 64자 이하 영문·숫자·._-만 허용합니다')
    if not (args.source_url and args.source_key):
        parser.error('원본(88) URL·키가 필요합니다 — LOTTO88_SUPABASE_URL / LOTTO88_SERVICE_ROLE_KEY')
    if not (args.url and args.key):
        parser.error('대상 URL·키가 필요합니다 — VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
    return args


def main(argv=None):
    args = parse_args(argv)
    print(f"=== 88로또 → 플러스로또 이관 ({'실제 이관' if args.apply else '계획/읽기 전용'}) ===")
    print(f'배치 ID: {args.batch_id}')

    # 원본은 어느 모드에서도 쓰기를 열지 않는다. 88 전산은 계속 돌아가야 한다.
    source = Supa(args.source_url, args.source_key, allow_writes=False)
    dest = Supa(args.url, args.key, allow_writes=args.apply)

    print('원본(88) 읽는 중…')
    src_members = source.select_all('members', '*')
    src_payments = source.select_all('payments', '*')
    src_products = source.select_all('products', '*')
    src_staff = source.select_all('staff', 'id,login_id,name')
    src_teams = source.select_all('teams', 'id,name')
    print(f'  회원 {len(src_members):,} · 결제 {len(src_payments):,} · 상품 {len(src_products):,}')

    print('대상(플러스로또) 읽는 중…')
    dest_members = dest.select_all('members', 'id,phone,name,nickname,grade,status,'
                                              'is_suspended,is_deleted,is_withdrawn,meta')
    dest_payments = dest.select_all('payments', 'id')
    dest_staff = dest.select_all('staff', 'id,login_id,name')
    dest_teams = dest.select_all('teams', 'id,name')
    print(f'  기존 회원 {len(dest_members):,}명\n')

    staff_map = build_staff_map(src_staff, dest_staff)
    team_map = build_team_map(src_teams, dest_teams)
    plan = build_plan(src_members, src_payments, src_products, dest_members,
                      {row['id'] for row in dest_payments}, staff_map, team_map,
                      args.batch_id, args.limit)
    print_plan(plan)

    if not args.apply:
        print('\n※ 쓰기 없이 종료했습니다. 출력에는 키와 개인정보가 포함되지 않습니다.')
        return

    print('\n이관 시작…')
    if plan.products:
        insert_chunked(dest, 'products', plan.products, upsert=True)
    if plan.new_members:
        insert_chunked(dest, 'members', plan.new_members)
    for member_id, patch in plan.updates:
        dest.patch('members', member_id, patch)
    if plan.updates:
        print(f'  members 변경분 {len(plan.updates):,}건 반영')
    if plan.new_payments:
        insert_chunked(dest, 'payments', plan.new_payments)

    print(f'\n완료 — 신규 {len(plan.new_members):,}명 · 갱신 {len(plan.updates):,}명 '
          f'· 결제 {len(plan.new_payments):,}건')
    if plan.collisions:
        print(f'⚠ 번호 충돌 {len(plan.collisions):,}명은 넣지 않았다. 현장 판단이 필요하다.')


if __name__ == '__main__':
    main()
