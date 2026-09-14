#!/usr/bin/env python3
"""815 보상 003의 고정 16명/16결제/0원만 검증·원자 적재한다.

기본 읽기 전용. 준비된 불변 파일만 읽으며 후보 재선정·기존행 수정·상품 갱신·
문자 발송 기능이 없다. 응답 불명확 시 영속 시도표식으로 재호출을 차단한다.
"""
from __future__ import annotations

import argparse
from collections import Counter
import dataclasses
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('compensation_common', ROOT / 'scripts/run-reviewed-815-next-pilot.py')
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
pilot, loader = base.pilot, base.loader
BATCH = 'lotto815-20260910-compensation-003'
EXPECTED = (16, 16, 0)
PAYLOAD_SHA = '4c5838c12f81c5831052973c65d697510368bb09cc4946f30854f844757e0389'
ARCHIVE, ARCHIVE_SHA = pilot.ARCHIVE, pilot.ARCHIVE_SHA
PROJECT_URL = pilot.PROJECT_URL
FILTERS = [('meta->>source_site', 'eq.lotto815'), ('meta->>import_batch', 'eq.' + BATCH)]
PROTECTED_BATCHES = ('lotto815-20260909-pilot-001', 'lotto815-20260910-pilot-002-review')
PROTECTED_EXPECTED = (200, 155, 63_428_400)
DB_DEFAULTS = {
    'members': {'tendency': None, 'assigned_staff_id': None, 'team_id': None, 'win_history': None},
    'payments': {'pg_provider': None, 'staff_id': None},
}
REASONS = {
    'counts': '고정 16명·16결제·0원과 다릅니다.',
    'payload': '고정 원본 또는 전체 예정 행 지문이 다릅니다.',
    'metadata': '출처·동의·계약 원문·발송보류·미배정 조건이 다릅니다.',
    'duplicates': '식별자 중복 또는 회원·결제 연결이 다릅니다.',
    'conflict': '기존 회원·결제와 충돌합니다. 자동 병합하지 않습니다.',
    'products': '기존 상품이 고정 예정 상품과 다릅니다.',
    'rows': '저장된 전체 행이 고정 예정 행과 다릅니다.',
    'schema': '운영 테이블 컬럼과 고정 예정 행·명시적 기본값 컬럼이 다릅니다. 쓰기 전에 중단합니다.',
    'protected': '기존 001/002 배치가 예상 범위 또는 실행 전 상태와 다릅니다.',
    'hold': '엄격한 발송보류 상태를 확인하지 못했습니다.',
    'partial_batch': '부분 배치 또는 다른 내용의 배치입니다. 재삽입하지 않습니다.',
    'prior_attempt': '이 배치의 원자 호출 시도표식이 있습니다. 자동 재호출하지 않습니다.',
    'private_path': '비공개 복구 경로·파일·권한이 올바르지 않습니다.',
    'frozen_missing': '준비된 고정 명세가 없습니다. 새 대상을 선택하지 않습니다.',
    'locked': '같은 배치를 다른 실행이 사용 중입니다.',
    'write_mode': '허용되지 않은 쓰기 또는 실행 모드입니다.',
    'project': '승인된 Supabase 프로젝트가 아닙니다.',
    'atomic_response': '원자 호출 결과가 불명확합니다. 관측만 하고 재호출하지 않습니다.',
}


class Stop(Exception):
    def __init__(self, code):
        self.code = code if code in REASONS else 'rows'
        super().__init__(REASONS[self.code])


def require(condition, code):
    if not condition:
        raise Stop(code)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def payload(plan):
    return {'members': plan.members, 'payments': plan.payments, 'products': plan.products}


def payload_sha(plan):
    return hashlib.sha256(encoded(payload(plan)).encode()).hexdigest()


def canonical_phone(value):
    number = re.sub(r'\D', '', value or '')
    if number.startswith('0082'):
        number = number[4:]
        return number if number.startswith('0') else '0' + number
    if number.startswith('82'):
        number = number[2:]
        return number if number.startswith('0') else '0' + number
    return number


def validate_plan(plan, expected_sha=None):
    require(payload_sha(plan) == (PAYLOAD_SHA if expected_sha is None else expected_sha), 'payload')
    require((len(plan.members), len(plan.payments), sum(row['amount'] for row in plan.payments)) == EXPECTED, 'counts')
    member_ids = {r['id'] for r in plan.members}
    for field in ('id', 'user_id', 'phone'):
        require(len({r[field] for r in plan.members}) == EXPECTED[0], 'duplicates')
    require(len({r['meta']['legacy_idx'] for r in plan.members}) == EXPECTED[0]
            and len({r['id'] for r in plan.payments}) == EXPECTED[1]
            and len({r['meta']['legacy_idx'] for r in plan.payments}) == EXPECTED[1]
            and Counter(r['member_id'] for r in plan.payments) == Counter({mid: 1 for mid in member_ids}), 'duplicates')
    for row in plan.members:
        meta = row['meta']
        require(type(meta.get('legacy_idx')) is int and meta['legacy_idx'] > 0
                and row['id'] == loader.stable_id('member', 'lotto815', meta['legacy_idx'])
                and isinstance(row.get('user_id'), str) and bool(row['user_id'])
                and re.fullmatch(r'01[0-9]{8,9}', row['phone']) is not None, 'metadata')
        require(meta.get('source_site') == 'lotto815' and meta.get('import_batch') == BATCH
                and meta.get('reco_paused') is True and meta.get('reco_pause_reason') == 'legacy_import_review'
                and meta.get('legacy_consent_review_required') is True
                and meta.get('legacy_agree_sms_yn') in ('Y', 'N')
                and meta.get('legacy_account_flags') == {k: 'N' for k in base.review.ACCOUNT_REVIEW_FIELDS}
                and all(isinstance(meta.get(k), str) for k in ('legacy_member_start_datetime', 'legacy_member_end_datetime'))
                and type(meta.get('weekly_reco_count')) is int and meta['weekly_reco_count'] >= 0
                and 'weekly_recos' not in meta and row.get('assigned_staff_id') is None and row.get('team_id') is None,
                'metadata')
        require(row.get('status') in ('active', 'suspended', 'deleted', 'withdrawn')
                and all(row.get(flag) is (row['status'] == status) for flag, status in
                    (('is_suspended', 'suspended'), ('is_deleted', 'deleted'), ('is_withdrawn', 'withdrawn'))), 'metadata')
    for row in plan.payments:
        meta = row['meta']
        require(type(meta.get('legacy_idx')) is int and meta['legacy_idx'] > 0
                and row['id'] == loader.stable_id('payment', 'lotto815', meta['legacy_idx'])
                and type(row.get('amount')) is int and row['amount'] == 0 and row.get('status') == 'approved'
                and row.get('staff_id') is None and meta.get('source_site') == 'lotto815'
                and meta.get('import_batch') == BATCH
                and isinstance(meta.get('legacy_item_status'), str)
                and isinstance(meta.get('legacy_installment_code'), str)
                and type(meta.get('legacy_payment_reco_count')) is int and meta['legacy_payment_reco_count'] >= 0,
                'metadata')
    product_ids = {p['product_id'] for p in plan.payments}
    require(len(plan.products) == len(product_ids) and {p['id'] for p in plan.products} == product_ids
            and product_ids <= {p['id'] for p in loader.PRODUCTS_BY_SITE['lotto815'].values()}, 'products')


class RpcFailure(Stop):
    def __init__(self, status, response):
        super().__init__('atomic_response')
        self.diagnostics = base.sanitized_rpc_error(status, response)


def validate_atomic_response(status, response):
    expected = {'batch_id': BATCH, 'members': 16, 'payments': 16, 'amount': 0, 'held_members': 16, 'atomic': True}
    if not (type(status) is int and status == 200 and isinstance(response, dict)
            and encoded(response) == encoded(expected)):
        raise RpcFailure(status, response)
    return response


def rpc_body(plan):
    return {'p_batch_id': BATCH, 'p_members': plan.members, 'p_payments': plan.payments,
            'p_expected_member_count': 16, 'p_expected_payment_count': 16, 'p_expected_amount': 0}


class Client(base.Client):
    def __init__(self, config, allow_writes=False):
        super().__init__(config, allow_writes=allow_writes)
        self.atomic_called = False

    def apply_atomic(self, plan):
        require(self.allow_writes is True and not self.atomic_called, 'write_mode')
        require(self.url == PROJECT_URL, 'project')
        validate_plan(plan)
        self.atomic_called = True
        headers = {'apikey': self.key, 'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'}
        status, response = pilot.request_json(PROJECT_URL + '/rest/v1/rpc/admin_import_815_review_batch', headers, rpc_body(plan))
        return validate_atomic_response(status, response)

    def check_only(self, *args):
        raise Stop('write_mode')


def verify_archive():
    digest = hashlib.sha256()
    with ARCHIVE.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    require(digest.hexdigest() == ARCHIVE_SHA, 'payload')


def classify_batch(value):
    counts = value.member_count, value.payment_count, value.payment_amount
    if counts == (0, 0, 0):
        return 'empty'
    require(counts == EXPECTED and not any((value.orphan_payments, value.null_product_payments,
            value.duplicate_member_keys, value.duplicate_payment_keys)), 'partial_batch')
    return 'complete'


def check_conflicts(state, plan):
    # 전화 국제표기를 포함한 읽기 사전 검사. 서버 RPC도 잠금 안에서 재검사해야 한다.
    phones = {canonical_phone(p) for p in state.phones}
    for row in plan.members:
        require(row['id'] not in state.member_ids and row['user_id'] not in state.user_ids
                and canonical_phone(row['phone']) not in phones
                and ('lotto815', row['meta']['legacy_idx']) not in state.legacy_member_ids, 'conflict')
    for row in plan.payments:
        require(row['id'] not in state.payment_ids
                and ('lotto815', row['meta']['legacy_idx']) not in state.legacy_payment_keys, 'conflict')


def check_products(client, plan):
    found = client.select_all('products', '*', [('id', 'in.(' + ','.join(p['id'] for p in plan.products) + ')')])
    actual = {row['id']: row for row in found}
    require(len(found) == len(actual) == len(plan.products)
            and all(base.canonical(actual.get(row['id'], {}), row) == base.canonical(row, row) for row in plan.products), 'products')


def verify_rows(client, plan):
    result = {}
    for table in ('members', 'payments'):
        found = client.select_all(table, '*', FILTERS)
        intended = getattr(plan, table)
        actual = {row['id']: row for row in found}
        require(len(found) == len(actual) == len(intended), 'rows')
        for row in intended:
            expected = {**DB_DEFAULTS[table], **row}
            got = actual.get(row['id'])
            # 기존 행에서 샘플링한 미지의 값을 정상으로 간주하지 않는다. 알 수 없는 새 컬럼도 중단.
            require(isinstance(got, dict) and set(got) == set(expected)
                    and base.canonical(got, expected) == base.canonical(expected, expected), 'rows')
        result[table] = sorted(found, key=lambda row: row['id'])
    return result


def verify_schema_columns(protected, plan):
    """운영에서 읽은 컬럼 이름만 검사한다. 기존 고객의 값을 기본값으로 복사하지 않는다."""
    for table in ('members', 'payments'):
        intended = getattr(plan, table)
        existing = protected.get(table)
        require(bool(intended) and isinstance(existing, list) and bool(existing), 'schema')
        expected_columns = set(DB_DEFAULTS[table]) | set(intended[0])
        require(all(set(row) | set(DB_DEFAULTS[table]) == expected_columns for row in intended)
                and all(isinstance(row, dict) and set(row) == expected_columns for row in existing), 'schema')


def verify_holds(client, plan, held=True):
    count = sum(client.hold_status(row['phone']) is held for row in plan.members)
    require(count == EXPECTED[0], 'hold')
    return count


def protected_snapshot(client):
    filters = [('meta->>source_site', 'eq.lotto815'), ('meta->>import_batch', 'in.(' + ','.join(PROTECTED_BATCHES) + ')')]
    result = {table: sorted(client.select_all(table, '*', filters), key=lambda row: row['id']) for table in ('members', 'payments')}
    require((len(result['members']), len(result['payments']), sum(row['amount'] for row in result['payments'])) == PROTECTED_EXPECTED,
            'protected')
    return result


def require_private(path, *, directory=False):
    require(not path.is_symlink(), 'private_path')
    info = path.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600)
            and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)), 'private_path')


class Store:
    def __init__(self, root=pilot.BACKUP_ROOT):
        self.batch = root / BATCH
        for path in (self.batch, *self.batch.parents):
            require(not path.is_symlink(), 'private_path')
        require(self.batch.is_dir(), 'frozen_missing')
        require_private(self.batch, directory=True)
        self.frozen = self.batch / 'frozen-intended-rows.json'
        self.fence = self.batch / 'atomic-attempt.json'
        self.lock_fd = None
        self.run = None

    def __enter__(self):
        fd = os.open(self.batch / 'run.lock', os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            require(stat.S_ISREG(os.fstat(fd).st_mode) and os.fstat(fd).st_uid == os.getuid(), 'private_path')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError):
            os.close(fd)
            raise Stop('locked') from None
        except Exception:
            os.close(fd)
            raise
        self.lock_fd = fd
        os.fchmod(fd, 0o600)
        self.run = self.batch / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
        self.run.mkdir(mode=0o700)
        return self

    def __exit__(self, *unused):
        if self.lock_fd is not None:
            fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
            os.close(self.lock_fd)
            self.lock_fd = None

    def write(self, name, value):
        require(self.run is not None and Path(name).name == name, 'private_path')
        pilot.private_json(self.run / name, value)

    def save(self, receipt):
        self.write('receipt.json', receipt)

    def load_frozen(self, validator):
        require(self.frozen.exists(), 'frozen_missing')
        require_private(self.frozen)
        fd = os.open(self.frozen, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
                    and info.st_uid == os.getuid() and info.st_size < 8 * 1024 * 1024, 'private_path')
            saved = json.load(stream)
        require(saved.get('batch') == BATCH and saved.get('archive_sha256') == ARCHIVE_SHA, 'payload')
        data = saved['payload']
        require(isinstance(data, dict) and set(data) == {'members', 'payments', 'products'}
                and all(isinstance(value, list) for value in data.values()), 'payload')
        plan = loader.ImportPlan(data['members'], data['payments'], data['products'], Counter(), Counter(), Counter(), 16, 0)
        require(saved.get('payload_sha256') == payload_sha(plan), 'payload')
        validator(plan)
        return plan

    def attempt_exists(self):
        return self.fence.exists() or self.fence.is_symlink()

    def protected_before_attempt(self):
        if not self.attempt_exists():
            return None
        require_private(self.fence)
        with self.fence.open() as stream:
            attempt = json.load(stream)
        require(attempt.get('batch') == BATCH and attempt.get('payload_sha256') == PAYLOAD_SHA, 'private_path')
        directory = Path(attempt['receipt_directory'])
        require(directory.parent == self.batch
                and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}', directory.name) is not None, 'private_path')
        require_private(directory, directory=True)
        snapshot = directory / 'protected-pilots-before.json'
        require_private(snapshot)
        with snapshot.open() as stream:
            return json.load(stream)

    def mark_attempt(self):
        require(not self.attempt_exists(), 'prior_attempt')
        fd = os.open(self.fence, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump({'batch': BATCH, 'payload_sha256': PAYLOAD_SHA,
                       'at_utc': dt.datetime.now(dt.timezone.utc).isoformat(), 'receipt_directory': str(self.run)}, out)
            out.flush()
            os.fsync(out.fileno())
        fd = os.open(self.batch, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def run(client, store, apply=False, *, archive_verifier=verify_archive, validator=validate_plan,
        state_reader=pilot.minimal_state, protected_reader=protected_snapshot):
    """주입점은 합성 테스트 전용. CLI에는 apply 이외의 범위/지문 옵션이 없다."""
    receipt = {'batch': BATCH, 'mode': 'apply' if apply else 'read_only', 'stage': 'initializing',
               'expected_members': 16, 'expected_payments': 16, 'expected_amount': 0,
               'archive_sha256': ARCHIVE_SHA, 'payload_sha256': PAYLOAD_SHA,
               'writes_attempted': False, 'sms_requests': 0, 'global_settings_mutations': 0,
               'http_sms_endpoint_verification': 'not_performed_domain_blocked',
               'hold_verification_method': 'supabase_read_only_rpc', 'stages': []}

    def step(stage, **updates):
        receipt.update(updates)
        receipt['stage'] = stage
        receipt['stages'].append({'stage': stage, 'at_utc': dt.datetime.now(dt.timezone.utc).isoformat()})
        store.save(receipt)

    try:
        require(client.allow_writes is apply, 'write_mode')
        step('verifying_frozen_source')
        archive_verifier()
        plan = store.load_frozen(validator)
        # Backup is an exact copy for this run; the prepared frozen file is never rewritten.
        store.write('intended-rows.json', payload(plan))
        before = loader.read_batch_verification(client, 'lotto815', BATCH)
        receipt['before'] = dataclasses.asdict(before)
        kind = classify_batch(before)
        if kind == 'complete':
            step('verifying_existing_complete_batch')
            check_products(client, plan)
            verified = verify_rows(client, plan)
            store.write('verified-rows.json', verified)
            receipt['held_members'] = verify_holds(client, plan)
            # 불명확한 응답 뒤 완료를 확인할 때도 최초 호출 전 기존 200행과 비교한다.
            prior_protected = store.protected_before_attempt()
            current_protected = protected_reader(client)
            verify_schema_columns(current_protected, plan)
            store.write('protected-pilots-after.json', current_protected)
            if prior_protected is not None:
                require(encoded(current_protected) == encoded(prior_protected), 'protected')
            receipt['protected_baseline_available'] = prior_protected is not None
            receipt['protected_pilots_unchanged'] = prior_protected is not None
            step('already_complete_verified_noop', after=dataclasses.asdict(before))
        else:
            require(not store.attempt_exists(), 'prior_attempt')
            step('checking_existing_conflicts')
            state = state_reader(client)
            check_conflicts(state, plan)
            check_products(client, plan)
            protected = protected_reader(client)
            verify_schema_columns(protected, plan)
            store.write('protected-pilots-before.json', protected)
            verify_holds(client, plan, held=False)
            step('ready_read_only', protected_members=200, protected_payments=155)
            if apply:
                step('refreshing_before_atomic')
                require(encoded(payload(store.load_frozen(validator))) == encoded(payload(plan)), 'payload')
                check_conflicts(state_reader(client), plan)
                check_products(client, plan)
                require(classify_batch(loader.read_batch_verification(client, 'lotto815', BATCH)) == 'empty', 'partial_batch')
                refreshed_protected = protected_reader(client)
                verify_schema_columns(refreshed_protected, plan)
                require(encoded(refreshed_protected) == encoded(protected), 'protected')
                verify_holds(client, plan, held=False)
                store.mark_attempt()
                step('applying_atomic_batch', writes_attempted=True)
                result = client.apply_atomic(plan)
                validate_atomic_response(200, result)
                step('verifying_atomic_batch', atomic_result=result)
                after = loader.read_batch_verification(client, 'lotto815', BATCH)
                require(classify_batch(after) == 'complete', 'partial_batch')
                verified = verify_rows(client, plan)
                store.write('verified-rows.json', verified)
                receipt['held_members'] = verify_holds(client, plan)
                after_protected = protected_reader(client)
                store.write('protected-pilots-after.json', after_protected)
                require(encoded(after_protected) == encoded(protected), 'protected')
                check_products(client, plan)
                step('complete_verified', after=dataclasses.asdict(after), protected_pilots_unchanged=True)
        print(json.dumps({'stage': receipt['stage'], 'members': 16, 'payments': 16, 'amount': 0,
                          'writes_attempted': receipt['writes_attempted'], 'sms_requests': 0,
                          'receipt_directory': str(store.run)}, ensure_ascii=False))
        return 0
    except (Exception, SystemExit) as error:
        receipt['failed_stage'] = receipt['stage']
        receipt['stage'] = 'stopped_recovery_required' if receipt['writes_attempted'] else 'stopped_without_customer_writes'
        receipt['reason_code'] = error.code if isinstance(error, Stop) else 'verification_or_transport_error'
        receipt['reason'] = str(error) if isinstance(error, Stop) else '검증 또는 통신 오류. 원격 본문과 비밀은 기록하지 않았습니다.'
        if isinstance(error, RpcFailure):
            receipt['rpc_error'] = error.diagnostics
        try:
            receipt['observed_batch'] = dataclasses.asdict(loader.read_batch_verification(client, 'lotto815', BATCH))
        except (Exception, SystemExit):
            receipt['observed_batch_unavailable'] = True
        try:
            store.save(receipt)
        except (Exception, SystemExit):
            receipt['receipt_write_failed'] = True
        print(json.dumps({'stage': receipt['stage'], 'reason_code': receipt['reason_code'],
                          'observed_batch': receipt.get('observed_batch'), 'rpc_error': receipt.get('rpc_error'),
                          'receipt_directory': str(store.run)}, ensure_ascii=False))
        return 1


def execute(apply=False, env_file=ROOT / ".env.local"):
    try:
        config = pilot.read_config(env_file)
        with Store() as store:
            return run(Client(config, allow_writes=apply), store, apply=apply)
    except (Exception, SystemExit) as error:
        print(json.dumps({'stage': 'stopped_without_customer_writes',
                          'reason_code': error.code if isinstance(error, Stop) else 'initialization_failed'}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='고정 보상 16명·16결제·0원만 원자 적재')
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env.local')
    args = parser.parse_args()
    raise SystemExit(execute(apply=args.apply, env_file=args.env_file))
