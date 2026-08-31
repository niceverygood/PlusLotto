#!/usr/bin/env python3
"""레거시 user/payment SQL 덤프를 플러스로또 Supabase로 안전하게 적재한다.

권장 순서:
  python3 scripts/load-legacy-site.py --site lotto815 --archive ./815.zip --dry-run
  python3 scripts/load-legacy-site.py --site lotto815 --archive ./815.zip --plan
  python3 scripts/load-legacy-site.py --site lotto815 --archive ./815.zip --apply

--plan은 DB를 읽기만 한다. --apply만 쓰기를 허용한다. URL/키는 각각
VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 환경변수를 기본으로 사용한다.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterable


ALLOWED_TABLES = frozenset({'user', 'payment'})
MAX_SQL_BYTES = 512 * 1024 * 1024
BATCH_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
DUMP_PREFIXES = {
    'lotto815': ('lotto815', '815korean'),
    'cplotto': ('cplotto',),
    'infolotto': ('infolotto',),
}
GRADE_BY_SITE = {
    'lotto815': {'1': 'free', '2': 'goldp', '3': 'vip', '4': 'royal'},
    'cplotto': {'1': 'free', '2': 'goldp', '3': 'goldp', '4': 'vip', '5': 'royal'},
    'infolotto': {'1': 'free', '2': 'goldp', '3': 'vip', '4': 'royal'},
}
STATUS_MAP = {
    'normal': 'active', 'standby': 'active', 'block': 'suspended',
    'remove': 'deleted', 'leave': 'withdrawn',
}
CONSULT_STATUS_MAP = {
    'new': '신규', 'none': '결번', 'absence': '부재', 'chance': '가망',
    'success': '승인', 'reserv': '통화예약', 'refuseStubborn': '도입거절',
    'refuse': '일반거절', 'etc': '기타', 'manageFree': '기타',
}
INFLOW_TYPE_MAP = {
    'new': '신규',
    '2dayAbsence': '하루전부재',
    '2dayRefusal': '하루전거절',
    '3day': '이틀전',
    'old': '구디비',
}
METHOD_MAP = {'officeCredit': 'manual', 'siteBank': 'bank', 'siteCredit': 'pg'}
PAYMENT_STATUS_MAP = {
    'success': 'approved', 'cancel': 'cancelled', 'fail': 'failed', 'standby': 'wait',
}
WEEKDAY = {'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6}
REGISTERED_FALLBACK_FIELDS = (
    'itemStartDateTime', 'groupAllocDateTime', 'salesAllocDateTime',
    'memoLastDateTime', 'loginDateTime', 'touchDateTime', 'updateDateTime',
)


def _product(product_id: str, name: str, price: int, months: int, grade: str) -> dict:
    return {
        'id': product_id, 'name': name, 'price': price, 'duration_months': months,
        # 이관 이력 표시용 상품이며 신규 결제 선택지에는 노출하지 않는다.
        'grade_granted': grade, 'is_active': False,
    }


# migration의 stable product seed ID와 반드시 같아야 한다.
PRODUCTS_BY_SITE = {
    'lotto815': {
        'family': _product('legacy_lotto815_family', '815로또 패밀리', 488_000, 18, 'goldp'),
        'mania': _product('legacy_lotto815_mania', '815로또 매니아', 7_880_000, 36, 'vip'),
        'first': _product('legacy_lotto815_first', '815로또 퍼스트', 11_880_000, 36, 'royal'),
    },
    'cplotto': {
        'gold': _product('legacy_cplotto_gold', '일행로또 골드', 176_000, 18, 'goldp'),
        'goldplus': _product('legacy_cplotto_goldplus', '일행로또 골드플러스', 198_000, 18, 'goldp'),
        'vipgold': _product('legacy_cplotto_vipgold', '일행로또 VIP', 1_485_000, 36, 'vip'),
        'first': _product('legacy_cplotto_first', '일행로또 로얄', 2_980_000, 36, 'royal'),
    },
    'infolotto': {
        'basic': _product('legacy_infolotto_basic', '인포로또 베이직', 431_900, 18, 'goldp'),
        'smart': _product('legacy_infolotto_smart', '인포로또 스마트', 3_800_000, 36, 'vip'),
        'signature': _product('legacy_infolotto_signature', '인포로또 시그니쳐', 0, 36, 'royal'),
    },
}


def iter_rows(text: str) -> Iterable[list[str]]:
    """값 내부 줄바꿈·괄호·쉼표가 있는 MySQL 튜플을 따옴표 상태로 자른다."""
    i, n = 0, len(text)
    while i < n:
        if text[i] != '(' or (i and text[i - 1] != '\n'):
            i += 1
            continue
        j, depth, in_quote, escaped = i + 1, 1, False, False
        current, values = [], []
        while j < n:
            char = text[j]
            if escaped:
                current.append(char)
                escaped = False
            elif in_quote:
                if char == '\\':
                    escaped = True
                    current.append(char)
                elif char == "'":
                    in_quote = False
                    current.append(char)
                else:
                    current.append(char)
            elif char == "'":
                in_quote = True
                current.append(char)
            elif char == '(':
                depth += 1
                current.append(char)
            elif char == ')':
                depth -= 1
                if depth == 0:
                    values.append(''.join(current))
                    break
                current.append(char)
            elif char == ',' and depth == 1:
                values.append(''.join(current))
                current = []
            else:
                current.append(char)
            j += 1
        if depth != 0:
            raise ValueError('SQL 튜플이 닫히지 않았습니다')
        yield [value.strip() for value in values]
        i = j + 1


def unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == "'":
        value = value[1:-1]
        return value.replace("\\'", "'").replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')
    return '' if value == 'NULL' else value


def parse_table(text: str, label: str) -> list[dict[str, str]]:
    columns = None
    for line in text.split('\n', 40)[:40]:
        if line.startswith('-- 컬럼:'):
            columns = line.split(':', 1)[1].strip().split(',')
            break
    if columns is None:
        raise ValueError(f'{label}: `-- 컬럼:` 주석이 없습니다')
    rows = []
    for number, raw in enumerate(iter_rows(text), start=1):
        if len(raw) != len(columns):
            raise ValueError(
                f'{label}: {number}번째 행 컬럼 수 불일치(예상 {len(columns)}, 실제 {len(raw)})'
            )
        rows.append(dict(zip(columns, (unquote(value) for value in raw))))
    return rows


def _read_limited(stream: BinaryIO, label: str) -> str:
    data = stream.read(MAX_SQL_BYTES + 1)
    if len(data) > MAX_SQL_BYTES:
        raise ValueError(f'{label}: SQL 해제 크기가 안전 한도를 넘습니다')
    try:
        return data.decode('utf-8', errors='strict')
    except UnicodeDecodeError as error:
        raise ValueError(f'{label}: UTF-8 SQL이 아닙니다') from error


class DumpSource:
    """디렉터리 또는 ZIP에서 정확히 알려진 user/payment 파일만 읽는다."""

    def __init__(self, site: str, directory: str | None = None, archive: str | None = None):
        if bool(directory) == bool(archive):
            raise ValueError('--dir 또는 --archive 중 하나만 지정해야 합니다')
        self.site = site
        self.directory = Path(directory).resolve() if directory else None
        self.archive = Path(archive).resolve() if archive else None

    def _names(self, table: str) -> set[str]:
        names = set()
        for prefix in DUMP_PREFIXES[self.site]:
            stem = f'{prefix}_{table}.sql'
            names.update((stem, f'{stem}.gz'))
        return names

    def load(self, table: str) -> list[dict[str, str]]:
        if table not in ALLOWED_TABLES:
            raise ValueError(f'허용되지 않은 테이블입니다: {table}')
        sql = self._from_zip(table) if self.archive else self._from_dir(table)
        return parse_table(sql, f'{self.site}/{table}')

    def _from_dir(self, table: str) -> str:
        assert self.directory is not None
        if not self.directory.is_dir():
            raise ValueError('--dir 경로가 디렉터리가 아닙니다')
        matches = []
        for entry in os.scandir(self.directory):
            if entry.name in self._names(table):
                if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                    raise ValueError(f'{self.site}/{table}: 일반 파일이 아닙니다')
                matches.append(Path(entry.path))
        if len(matches) != 1:
            raise ValueError(f'{self.site}/{table}: 알려진 SQL 파일이 정확히 1개여야 합니다')
        path = matches[0]
        opener = gzip.open if path.name.endswith('.gz') else open
        with opener(path, 'rb') as stream:
            return _read_limited(stream, f'{self.site}/{table}')

    def _from_zip(self, table: str) -> str:
        assert self.archive is not None
        if not zipfile.is_zipfile(self.archive):
            raise ValueError('--archive 경로가 유효한 ZIP이 아닙니다')
        with zipfile.ZipFile(self.archive) as archive:
            infos = archive.infolist()
            for info in infos:
                path = PurePosixPath(info.filename)
                if path.is_absolute() or '..' in path.parts or '\\' in info.filename:
                    raise ValueError('ZIP에 안전하지 않은 경로가 있습니다')
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError('ZIP에 심볼릭 링크가 있습니다')
            matches = [
                info for info in infos
                if not info.is_dir() and PurePosixPath(info.filename).name in self._names(table)
            ]
            if len(matches) != 1:
                raise ValueError(f'{self.site}/{table}: ZIP의 알려진 SQL 파일이 정확히 1개여야 합니다')
            info = matches[0]
            if info.flag_bits & 0x1:
                raise ValueError(f'{self.site}/{table}: 암호화된 ZIP 항목은 지원하지 않습니다')
            with archive.open(info) as raw:
                if info.filename.endswith('.gz'):
                    with gzip.GzipFile(fileobj=raw) as stream:
                        return _read_limited(stream, f'{self.site}/{table}')
                return _read_limited(raw, f'{self.site}/{table}')


def digits(value: str | None) -> str:
    return re.sub(r'\D', '', value or '')


def ts(value: str | None) -> str | None:
    value = (value or '').strip()
    if not value or value.startswith('0000'):
        return None
    return value.replace(' ', 'T') + '+09:00'


def num(value: object, default: int | None = None) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def stable_id(kind: str, site: str, legacy_idx: int) -> str:
    prefix = {'member': 'mem', 'payment': 'pay'}[kind]
    uid = uuid.uuid5(uuid.NAMESPACE_URL, f'https://lotto-plus.co.kr/legacy/{kind}/{site}/{legacy_idx}')
    return f'{prefix}_{uid}'


def default_batch_id(site: str) -> str:
    return f'{site}-20260831'


def member_registered_at(user: dict[str, str]) -> tuple[str, str | None]:
    """원 가입일을 우선하고, 구계정의 빈 가입일은 가장 이른 업무 시각으로 보완한다."""
    primary = ts(user.get('insertDateTimeOrg')) or ts(user.get('insertDateTime'))
    if primary:
        return primary, None
    candidates = [
        (value, field_name)
        for field_name in REGISTERED_FALLBACK_FIELDS
        if (value := ts(user.get(field_name))) is not None
    ]
    if not candidates:
        raise ValueError('가입일과 대체 업무 시각이 모두 비어 있습니다')
    return min(candidates, key=lambda pair: pair[0])


def fallback_login_id(site: str, legacy_idx: int, occupied: set[str]) -> str:
    base = f'legacy_{site}_{legacy_idx}'
    if base not in occupied:
        return base
    counter = 1
    while True:
        suffix = uuid.uuid5(uuid.NAMESPACE_URL, f'{site}:{legacy_idx}:login:{counter}').hex[:8]
        candidate = f'{base}_{suffix}'
        if candidate not in occupied:
            return candidate
        counter += 1


def build_member(
    user: dict[str, str],
    site: str,
    grade_map: dict[str, str],
    batch_id: str | None = None,
):
    legacy_idx = num(user.get('idx'))
    if legacy_idx is None:
        return None, '원본 회원 PK 오류'
    grade = grade_map.get(user.get('levelNum', ''))
    if not grade:
        return None, f"등급 미대응(levelNum={user.get('levelNum')})"
    phone = digits(user.get('phone'))
    if not re.fullmatch(r'01\d{8,9}', phone):
        return None, '휴대폰 형식 오류'
    legacy_status = user.get('statCode', '')
    status = STATUS_MAP.get(legacy_status, 'active')
    legacy_consult = user.get('statTmCode', '')
    legacy_inflow = user.get('statAdmCode', '')
    try:
        registered_at, registered_fallback = member_registered_at(user)
    except ValueError:
        return None, '가입일 대체값 없음'
    meta = {
        'source_site': site,
        'import_batch': batch_id or default_batch_id(site),
        # 레거시 대량 이관 직후 자동 조합발급/문자가 실행되지 않도록 기본 격리한다.
        # 운영자가 표본 검수 후 회원정보에서 명시적으로 해제해야 한다.
        'reco_paused': True,
        'reco_pause_reason': 'legacy_import_review',
        'legacy_idx': legacy_idx,
        'legacy_id': user.get('id') or None,
        'legacy_sales_idx': num(user.get('salesIdx')) or None,
        'legacy_stat_adm': legacy_inflow or None,
        'legacy_stat_tm': legacy_consult or None,
        'legacy_item_code': user.get('itemCode') or None,
        'legacy_level_num': num(user.get('levelNum')),
    }
    if registered_fallback:
        meta['registered_at_fallback'] = registered_fallback
    end_date = (user.get('itemEndDateTime') or '')[:10]
    if end_date and not end_date.startswith('0000'):
        meta['end_date'] = end_date
    day = WEEKDAY.get(user.get('schedulePickSmsWeek', ''))
    if day is not None:
        meta['weekly_reco_day'] = day
    slot = num(user.get('itemOptionSlot'))
    if slot:
        meta['weekly_reco_count'] = slot
    row = {
        'id': stable_id('member', site, legacy_idx),
        'user_id': user.get('id') or fallback_login_id(site, legacy_idx, set()),
        'name': user.get('name') or '',
        'nickname': user.get('nick') or None,
        'phone': phone,
        'grade': grade,
        'status': status,
        'consult_status': CONSULT_STATUS_MAP.get(legacy_consult, '기타'),
        'outcall_done': legacy_consult not in ('', 'new'),
        'inflow_code': user.get('inflowFromCode') or None,
        'inflow_type': INFLOW_TYPE_MAP.get(legacy_inflow),
        'memo': (user.get('adminMemo') or user.get('memoLastContents') or '') or None,
        'registered_at': registered_at,
        'last_active_at': ts(user.get('loginDateTime')),
        'is_suspended': status == 'suspended',
        'is_deleted': status == 'deleted',
        'is_withdrawn': status == 'withdrawn',
        'meta': meta,
    }
    return row, None


def product_for_payment(site: str, payment: dict[str, str]) -> dict | None:
    return PRODUCTS_BY_SITE[site].get(payment.get('itemCode', ''))


def build_payment(
    payment: dict[str, str],
    site: str,
    member_id: str,
    product_id: str,
    batch_id: str | None = None,
) -> dict:
    legacy_idx = num(payment.get('idx'))
    if legacy_idx is None:
        raise ValueError('원본 결제 PK 오류')
    legacy_status = payment.get('statCode', '')
    return {
        'id': stable_id('payment', site, legacy_idx),
        'member_id': member_id,
        'product_id': product_id,
        'amount': num(payment.get('itemWon'), 0),
        'method': METHOD_MAP.get(payment.get('payMethodCode', ''), 'manual'),
        'status': PAYMENT_STATUS_MAP.get(legacy_status, 'approved'),
        'period_start': ts(payment.get('itemStartDateTime')),
        'period_end': ts(payment.get('itemEndDateTime')),
        'depositor_name': payment.get('userBankName') or None,
        'paid_at': ts(payment.get('insertDateTime')),
        'created_at': ts(payment.get('insertDateTime')),
        'meta': {
            'source_site': site,
            'import_batch': batch_id or default_batch_id(site),
            'legacy_idx': legacy_idx,
            'legacy_item_code': payment.get('itemCode') or None,
            'legacy_sales_idx': num(payment.get('salesIdx')) or None,
            'legacy_exp_month': num(payment.get('itemExpMonth')),
            'legacy_status': legacy_status or None,
        },
    }


@dataclass
class ExistingState:
    legacy_member_ids: dict[tuple[str, int], str] = field(default_factory=dict)
    member_ids: set[str] = field(default_factory=set)
    phones: set[str] = field(default_factory=set)
    user_ids: set[str] = field(default_factory=set)
    legacy_payment_keys: set[tuple[str, int]] = field(default_factory=set)
    payment_ids: set[str] = field(default_factory=set)
    product_ids: set[str] = field(default_factory=set)


@dataclass
class ImportPlan:
    members: list[dict]
    payments: list[dict]
    products: list[dict]
    skipped_members: Counter
    member_conflicts: Counter
    skipped_payments: Counter
    selected_members: int
    new_product_count: int


@dataclass(frozen=True)
class BatchVerification:
    member_count: int
    payment_count: int
    payment_amount: int
    orphan_payments: int
    null_product_payments: int
    duplicate_member_keys: int
    duplicate_payment_keys: int


def build_import_plan(
    users: list[dict[str, str]],
    payments: list[dict[str, str]],
    site: str,
    existing: ExistingState | None = None,
    limit: int | None = None,
    batch_id: str | None = None,
) -> ImportPlan:
    existing = existing or ExistingState()
    skipped_members, member_conflicts, skipped_payments = Counter(), Counter(), Counter()
    candidates, dump_phones, duplicate_aliases = [], {}, {}
    for user in users:
        member, reason = build_member(user, site, GRADE_BY_SITE[site], batch_id)
        if member is None:
            skipped_members[reason] += 1
            continue
        if member['phone'] in dump_phones:
            skipped_members['덤프 내 전화번호 중복'] += 1
            duplicate_aliases[int(member['meta']['legacy_idx'])] = int(
                dump_phones[member['phone']]['meta']['legacy_idx']
            )
            continue
        dump_phones[member['phone']] = member
        candidates.append(member)
    if limit is not None:
        candidates = candidates[:limit]

    todo_members, idx_to_member = [], {}
    occupied_phones, occupied_user_ids = set(existing.phones), set(existing.user_ids)
    for member in candidates:
        legacy_idx = int(member['meta']['legacy_idx'])
        known_id = existing.legacy_member_ids.get((site, legacy_idx))
        if known_id:
            idx_to_member[legacy_idx] = known_id
            member_conflicts['이미 적재된 레거시 회원'] += 1
            continue
        if member['phone'] in occupied_phones:
            member_conflicts['기존 전화번호 충돌(건너뜀)'] += 1
            continue
        if member['user_id'] in occupied_user_ids:
            member['meta']['legacy_login_id'] = member['user_id']
            member['user_id'] = fallback_login_id(site, legacy_idx, occupied_user_ids)
            member_conflicts['로그인 아이디 충돌(대체 ID)'] += 1
        occupied_phones.add(member['phone'])
        occupied_user_ids.add(member['user_id'])
        idx_to_member[legacy_idx] = member['id']
        todo_members.append(member)

    # 중복 전화의 두 번째 원본 PK도 첫 회원 ID에 연결한다. 회원은 한 명만 만들되 양쪽의
    # 과거 결제는 모두 승계하므로 조용한 결제 누락이 생기지 않는다.
    for alias_idx, canonical_idx in duplicate_aliases.items():
        if canonical_idx in idx_to_member:
            idx_to_member[alias_idx] = idx_to_member[canonical_idx]
            member_conflicts['중복 전화 원본 PK를 첫 회원에 연결'] += 1

    todo_payments, needed_products = [], {}
    for payment in payments:
        user_idx = num(payment.get('userIdx'))
        if user_idx not in idx_to_member:
            skipped_payments['선택/적재 회원과 연결되지 않은 결제'] += 1
            continue
        legacy_idx = num(payment.get('idx'))
        if legacy_idx is None:
            skipped_payments['원본 결제 PK 오류'] += 1
            continue
        payment_id = stable_id('payment', site, legacy_idx)
        if (site, legacy_idx) in existing.legacy_payment_keys or payment_id in existing.payment_ids:
            skipped_payments['이미 적재된 레거시 결제'] += 1
            continue
        product = product_for_payment(site, payment)
        if product is None:
            skipped_payments['상품 코드 미대응'] += 1
            continue
        needed_products[product['id']] = product
        todo_payments.append(
            build_payment(payment, site, idx_to_member[user_idx], product['id'], batch_id)
        )

    products = [needed_products[key] for key in sorted(needed_products)]
    return ImportPlan(
        members=todo_members,
        payments=todo_payments,
        products=products,
        skipped_members=skipped_members,
        member_conflicts=member_conflicts,
        skipped_payments=skipped_payments,
        selected_members=len(candidates),
        new_product_count=sum(product['id'] not in existing.product_ids for product in products),
    )


class Supa:
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
                # details에는 실패 행 전체(PII)가 들어올 수 있어 버리고, DB code/message만 제한적으로 표시한다.
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

    def select_all(
        self,
        table: str,
        columns: str,
        filters: list[tuple[str, str]] | None = None,
    ) -> list[dict]:
        rows = []
        for offset in range(0, 10_000_000, 1000):
            # PostgREST offset pagination은 정렬이 없으면 동시 입력 시 페이지 경계가
            # 흔들릴 수 있다. 모든 대상 테이블의 PK인 id를 안정적인 순서로 고정한다.
            params = [
                ('select', columns),
                ('order', 'id.asc'),
                ('limit', '1000'),
                ('offset', str(offset)),
                *(filters or []),
            ]
            query = urllib.parse.urlencode(params, safe=',.*')
            page = self._req('GET', f'{table}?{query}')
            rows.extend(page)
            if len(page) < 1000:
                break
        return rows

    def insert(self, table: str, rows: list[dict]):
        return self._req('POST', table, rows, prefer='return=minimal')

    def upsert(self, table: str, rows: list[dict]):
        return self._req(
            'POST', f'{table}?on_conflict=id', rows,
            prefer='resolution=merge-duplicates,return=minimal',
        )


def read_existing_state(client: Supa) -> ExistingState:
    state = ExistingState()
    for member in client.select_all('members', 'id,user_id,phone,meta'):
        state.member_ids.add(member['id'])
        state.phones.add(digits(member.get('phone')))
        state.user_ids.add(member.get('user_id') or '')
        meta = member.get('meta') or {}
        legacy_idx = num(meta.get('legacy_idx'))
        if meta.get('source_site') and legacy_idx is not None:
            state.legacy_member_ids[(meta['source_site'], legacy_idx)] = member['id']
    for payment in client.select_all('payments', 'id,meta'):
        state.payment_ids.add(payment['id'])
        meta = payment.get('meta') or {}
        legacy_idx = num(meta.get('legacy_idx'))
        if meta.get('source_site') and legacy_idx is not None:
            state.legacy_payment_keys.add((meta['source_site'], legacy_idx))
    for product in client.select_all('products', 'id'):
        state.product_ids.add(product['id'])
    return state


def read_batch_verification(
    client: Supa,
    site: str,
    batch_id: str,
    preexisting_member_ids: set[str] | None = None,
) -> BatchVerification:
    filters = [
        ('meta->>source_site', f'eq.{site}'),
        ('meta->>import_batch', f'eq.{batch_id}'),
    ]
    members = client.select_all('members', 'id,meta', filters)
    payments = client.select_all('payments', 'id,member_id,product_id,amount,meta', filters)
    member_ids = set(preexisting_member_ids or ())
    member_ids.update(member['id'] for member in members)

    member_keys = Counter(
        num((member.get('meta') or {}).get('legacy_idx')) for member in members
    )
    payment_keys = Counter(
        num((payment.get('meta') or {}).get('legacy_idx')) for payment in payments
    )
    return BatchVerification(
        member_count=len(members),
        payment_count=len(payments),
        payment_amount=sum(num(payment.get('amount'), 0) or 0 for payment in payments),
        orphan_payments=sum(payment.get('member_id') not in member_ids for payment in payments),
        null_product_payments=sum(not payment.get('product_id') for payment in payments),
        duplicate_member_keys=sum(count - 1 for count in member_keys.values() if count > 1),
        duplicate_payment_keys=sum(count - 1 for count in payment_keys.values() if count > 1),
    )


def verify_applied_batch(
    before: BatchVerification,
    after: BatchVerification,
    plan: ImportPlan,
) -> None:
    expected_members = before.member_count + len(plan.members)
    expected_payments = before.payment_count + len(plan.payments)
    expected_amount = before.payment_amount + sum(row['amount'] for row in plan.payments)
    problems = []
    for label, actual, expected in (
        ('회원', after.member_count, expected_members),
        ('결제', after.payment_count, expected_payments),
        ('결제액', after.payment_amount, expected_amount),
    ):
        if actual != expected:
            problems.append(f'{label} 실제 {actual:,} / 예상 {expected:,}')
    for label, value in (
        ('고아 결제', after.orphan_payments),
        ('상품 미연결 결제', after.null_product_payments),
        ('회원 원본키 중복', after.duplicate_member_keys),
        ('결제 원본키 중복', after.duplicate_payment_keys),
    ):
        if value:
            problems.append(f'{label} {value:,}')
    if problems:
        raise SystemExit('적재 사후검증 실패: ' + ' · '.join(problems))
    print(
        '사후검증 통과 — '
        f'배치 회원 {after.member_count:,}명 · 결제 {after.payment_count:,}건 '
        f'· 결제액 {after.payment_amount:,}원 · 고아/상품미연결/중복 0건'
    )


def print_plan(plan: ImportPlan):
    by_grade = Counter(member['grade'] for member in plan.members)
    grades = ' · '.join(f'{key} {value:,}' for key, value in by_grade.most_common())
    print('■ 회원')
    print(f'  선택 {plan.selected_members:,}명 · 신규 적재 {len(plan.members):,}명' + (f' · {grades}' if grades else ''))
    for key, value in plan.skipped_members.most_common():
        print(f'  제외 {key}: {value:,}')
    for key, value in plan.member_conflicts.most_common():
        print(f'  {key}: {value:,}')
    print('\n■ 상품')
    print(f'  참조 {len(plan.products):,}종 · 신규 {plan.new_product_count:,}종 · 기존 갱신 {len(plan.products) - plan.new_product_count:,}종')
    print('\n■ 결제')
    print(f'  신규 적재 {len(plan.payments):,}건 · 합계 {sum(row["amount"] for row in plan.payments):,}원')
    for key, value in plan.skipped_payments.most_common():
        print(f'  제외 {key}: {value:,}')
    day = Counter(member['meta'].get('weekly_reco_day') for member in plan.members)
    named = sorted((key, value) for key, value in day.items() if key is not None)
    body = ' · '.join(f"{'일월화수목금토'[key]}요일 {value:,}" for key, value in named)
    if day.get(None):
        body += f' · 요일 미지정 {day[None]:,}'
    print('\n■ 조합 발송요일(신규 회원)')
    print(f'  {body}')


def insert_chunked(client: Supa, table: str, rows: list[dict], upsert: bool = False):
    action = client.upsert if upsert else client.insert
    for offset in range(0, len(rows), 200):
        action(table, rows[offset:offset + 200])
        print(f'  {table} {min(offset + 200, len(rows)):,}/{len(rows):,}')


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--site', required=True, choices=sorted(GRADE_BY_SITE))
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--dir', help='user/payment SQL(.gz)이 있는 디렉터리')
    source.add_argument('--archive', help='user/payment SQL.gz가 들어 있는 ZIP')
    parser.add_argument('--url', default=os.getenv('VITE_SUPABASE_URL'))
    parser.add_argument('--key', default=os.getenv('SUPABASE_SERVICE_ROLE_KEY'))
    parser.add_argument('--limit', type=int, help='시범 적재용 회원 상한')
    parser.add_argument('--batch-id', help='적재 묶음 식별자(기본: <site>-20260831)')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true', help='DB 연결 없이 변환만 확인')
    mode.add_argument('--plan', action='store_true', help='DB 읽기 전용 대조')
    mode.add_argument('--apply', action='store_true', help='명시적으로 실제 적재')
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit <= 0:
        parser.error('--limit은 양수여야 합니다')
    args.batch_id = args.batch_id or default_batch_id(args.site)
    if not BATCH_ID_RE.fullmatch(args.batch_id):
        parser.error('--batch-id는 영문/숫자로 시작하는 64자 이하 영문·숫자·._-만 허용합니다')
    if (args.plan or args.apply) and not (args.url and args.key):
        parser.error('--plan/--apply에는 URL과 service role key가 필요합니다(환경변수 권장)')
    return args


def main(argv=None):
    args = parse_args(argv)
    mode = '모의' if args.dry_run else ('계획/읽기 전용' if args.plan else '실제 적재')
    print(f'=== {args.site} 적재 ({mode}) ===')
    print(f'배치 ID: {args.batch_id}')
    source = DumpSource(args.site, directory=args.dir, archive=args.archive)
    users, payments = source.load('user'), source.load('payment')
    print(f'덤프 읽음 — 회원 {len(users):,} · 결제 {len(payments):,}\n')
    client, existing = None, ExistingState()
    if args.plan or args.apply:
        client = Supa(args.url, args.key, allow_writes=args.apply)
        print('기존 데이터 읽는 중…')
        existing = read_existing_state(client)
        print('  기존 데이터 대조 완료\n')
    plan = build_import_plan(users, payments, args.site, existing, args.limit, args.batch_id)
    print_plan(plan)
    if not args.apply:
        print('\n※ 쓰기 없이 종료했습니다. 출력에는 키와 개인정보가 포함되지 않습니다.')
        return
    assert client is not None
    before = read_batch_verification(client, args.site, args.batch_id, existing.member_ids)
    print('\n적재 시작…')
    insert_chunked(client, 'products', plan.products, upsert=True)
    insert_chunked(client, 'members', plan.members)
    insert_chunked(client, 'payments', plan.payments)
    print('\n배치 사후검증 중…')
    after = read_batch_verification(client, args.site, args.batch_id, existing.member_ids)
    verify_applied_batch(before, after, plan)
    print(f'완료 — 이번 실행 회원 {len(plan.members):,}명 · 결제 {len(plan.payments):,}건')
    print('담당자는 meta.legacy_sales_idx로 보존했습니다. 대응표 적용 전 assigned_staff_id는 비어 있습니다.')


if __name__ == '__main__':
    main()
