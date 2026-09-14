#!/usr/bin/env python3
"""검토된 815 후속 100명 전용. --apply만 원자 이관 RPC를 허용한다.

고정 대상·원본·금액·전체 행 지문을 다시 확인한다. 완료 배치는 불변 복구
파일과 실제 행만 대조하고 새 후보를 선택하지 않는다. 부분 배치는 중단한다.
문자 HTTP 경로와 GitHub에는 연결하지 않으며, Supabase 보류 RPC만 사용한다.
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


def import_local(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


pilot = import_local('reviewed_815_common', 'run-approved-815-pilot.py')
review = import_local('reviewed_815_rules', 'legacy_815_review.py')
loader = pilot.loader
PROJECT_URL = pilot.PROJECT_URL
ARCHIVE, ARCHIVE_SHA = pilot.ARCHIVE, pilot.ARCHIVE_SHA
BATCH = 'lotto815-20260910-pilot-002-review'
EXPECTED = (100, 116, 49_221_600)
IDENTITY_SHA = '1666402a582530f465fd35ef9770089f50cf211d78c7a62b195e07a5f54c9822'
PAYLOAD_SHA = 'b52b3b07f9c4305e7b74345fc8b7d3611cf42db4c78ec2c16eb3c9b9d31fe0d2'
BACKUP_ROOT = pilot.BACKUP_ROOT
FILTERS = [('meta->>source_site', 'eq.lotto815'), ('meta->>import_batch', f'eq.{BATCH}')]
REASONS = {
    'counts': '승인된 회원 수·결제 수·금액이 다릅니다.',
    'identity': '승인된 대상 식별자 지문이 다릅니다.',
    'payload': '승인된 전체 변환 행 지문이 다릅니다.',
    'hold': '모든 대상의 엄격한 문자 보류 상태를 확인하지 못했습니다.',
    'metadata': '출처·보류·수신동의·계정 검토 메타 또는 미배정 상태가 다릅니다.',
    'duplicates': '대상 식별자·원본키·전화번호 중복 또는 결제 연결 오류입니다.',
    'partial_batch': '부분 적재 또는 다른 내용의 배치입니다. 자동 재삽입하지 않습니다.',
    'batch_changed': '실행 직전 배치가 달라졌습니다.',
    'rows': '실제 저장 행이 승인된 변환 내용과 다릅니다.',
    'archive': '승인 원본 ZIP의 SHA-256이 다릅니다.',
    'private_path': '복구 경로·파일 형식 또는 권한을 확인해야 합니다.',
    'frozen_missing': '완료 배치의 불변 복구 파일이 없습니다. 새 대상을 선택하지 않습니다.',
    'frozen_changed': '기존 불변 복구 파일이 현재 승인 계획과 다릅니다.',
    'locked': '동일 배치의 다른 실행이 진행 중입니다.',
    'write_mode': '읽기 전용/실행 모드가 일치하지 않습니다.',
    'http_forbidden': '문자 HTTP 경로 요청은 이 실행기에서 허용하지 않습니다.',
    'project': '승인된 Supabase 프로젝트와 다릅니다.',
    'atomic_response': '원자 이관 응답을 확정하지 못했습니다. 실제 배치를 조회하고 재시도하지 않습니다.',
}
RPC_ERROR_MESSAGES = {
    'Invalid 815 review batch envelope': 'invalid_envelope',
    '815 review batch count mismatch': 'envelope_count_mismatch',
    '815 review batch already exists; verify without reinserting': 'batch_exists',
    '815 member source, role, consent or hold validation failed': 'member_validation',
    'Duplicate 815 member id in payload': 'duplicate_member_id',
    'Duplicate 815 phone in payload': 'duplicate_phone',
    'Duplicate 815 source member key in payload': 'duplicate_source_member_key',
    'Duplicate 815 login id in payload': 'duplicate_login_id',
    '815 candidate conflicts with an existing member': 'existing_member_conflict',
    '815 payment source, link or amount validation failed': 'payment_validation',
    '815 payment id count or amount mismatch': 'payment_count_or_amount_mismatch',
    'Duplicate 815 payment source key in payload': 'duplicate_source_payment_key',
    '815 candidate conflicts with an existing payment': 'existing_payment_conflict',
    '815 member insert count mismatch; transaction rolled back': 'member_insert_count_rollback',
    '815 payment insert count mismatch; transaction rolled back': 'payment_insert_count_rollback',
    '815 inserted hold or assignment state mismatch; transaction rolled back': 'hold_or_assignment_rollback',
    'canceling statement due to statement timeout': 'statement_timeout',
    'canceling statement due to lock timeout': 'lock_timeout',
    'permission denied for function admin_import_815_review_batch': 'rpc_permission_denied',
}
DATABASE_ERROR_CATEGORIES = {
    '57014': 'statement_canceled', '55P03': 'lock_unavailable', '40P01': 'deadlock', '40001': 'serialization_failure',
    '42501': 'permission_denied', '23505': 'unique_conflict', '23503': 'foreign_key_conflict',
    '23502': 'required_column_missing', '23514': 'check_constraint', '22P02': 'invalid_text_representation',
    '42883': 'undefined_function', '42703': 'undefined_column', '42P01': 'undefined_table',
    'PGRST202': 'rpc_schema_cache_miss', 'PGRST203': 'rpc_overload_ambiguous',
    'PGRST102': 'request_body_invalid', 'PGRST301': 'authentication_failed',
}


class Stop(pilot.Refusal):
    def __init__(self, code):
        self.code = code if code in REASONS else 'rows'
        super().__init__(REASONS[self.code])


def sanitized_rpc_error(http_status, result):
    """원격 message/details/hint/context/행은 저장하지 않는다. 고정 분류만 반환."""
    status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
    body = result if isinstance(result, dict) else {}
    raw_code = body.get('code')
    code = raw_code if isinstance(raw_code, str) and re.fullmatch(r'(?:[A-Z0-9]{5}|PGRST[0-9]{3})', raw_code) else None
    message = body.get('message')
    category = RPC_ERROR_MESSAGES.get(message) if isinstance(message, str) else None
    if category is None:
        category = DATABASE_ERROR_CATEGORIES.get(code, 'invalid_success_response' if status == 200 else 'unclassified_remote_error')
    return {'http_status': status, 'database_code': code, 'error_category': category}


class RpcFailure(Stop):
    def __init__(self, http_status, result):
        super().__init__('atomic_response')
        self.diagnostics = sanitized_rpc_error(http_status, result)


def validate_atomic_response(code, result):
    if not (code == 200 and isinstance(result, dict) and result.get('atomic') is True
            and result.get('batch_id') == BATCH
            and all(type(result.get(key)) is int for key in ('members', 'payments', 'amount', 'held_members'))
            and (result.get('members'), result.get('payments'), result.get('amount'), result.get('held_members')) == (*EXPECTED, EXPECTED[0])):
        raise RpcFailure(code, result)
    return result


def require(condition, code):
    if not condition:
        raise Stop(code)


class Client(pilot.Client):
    def _req(self, method, path, body=None, prefer=None):
        require(self.url == PROJECT_URL, 'project')
        # 공통 전송기는 body가 있으면 POST하므로 GET 표기만 검사하면 안 된다.
        require(method == 'GET' and body is None and prefer is None
                and path.partition('?')[0] in {'members', 'payments', 'products'}, 'write_mode')
        return super()._req(method, path, body, prefer)

    def hold_status(self, phone):
        require(self.url == PROJECT_URL, 'project')
        return super().hold_status(phone)

    def check_only(self, phone, held):
        # 공통 실행기의 HTTP 검사도 상속 호출할 수 없도록 명시적으로 차단한다.
        raise Stop('http_forbidden')

    def apply_atomic(self, plan):
        # 회원·결제 직접 POST는 금지한다. 승인된 원자 RPC 한 번만 호출한다.
        require(self.allow_writes is True, 'write_mode')
        require(self.url == PROJECT_URL, 'project')
        validate_plan(plan)
        headers = {'apikey': self.key, 'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'}
        code, result = pilot.request_json(self.url + '/rest/v1/rpc/admin_import_815_review_batch', headers, rpc_body(plan))
        return validate_atomic_response(code, result)


def payload(plan):
    return {'members': plan.members, 'payments': plan.payments, 'products': plan.products}


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def payload_sha(plan):
    return hashlib.sha256(encoded(payload(plan)).encode()).hexdigest()


def rpc_body(plan):
    return {'p_batch_id': BATCH, 'p_members': plan.members, 'p_payments': plan.payments,
            'p_expected_member_count': EXPECTED[0], 'p_expected_payment_count': EXPECTED[1], 'p_expected_amount': EXPECTED[2]}


def validate_plan(plan, identity_sha=IDENTITY_SHA, full_payload_sha=PAYLOAD_SHA):
    require((len(plan.members), len(plan.payments), sum(row['amount'] for row in plan.payments)) == EXPECTED, 'counts')
    require(pilot.fingerprint(plan) == identity_sha, 'identity')
    require(payload_sha(plan) == full_payload_sha, 'payload')
    member_ids = {row['id'] for row in plan.members}
    require(len(member_ids) == EXPECTED[0]
            and len({row['phone'] for row in plan.members}) == EXPECTED[0]
            and len({row['meta']['legacy_idx'] for row in plan.members}) == EXPECTED[0]
            and len({row['id'] for row in plan.payments}) == EXPECTED[1]
            and len({row['meta']['legacy_idx'] for row in plan.payments}) == EXPECTED[1]
            and all(row['member_id'] in member_ids for row in plan.payments), 'duplicates')
    for row in plan.members:
        meta = row.get('meta') or {}
        require(meta.get('source_site') == 'lotto815' and meta.get('import_batch') == BATCH
                and meta.get('reco_paused') is True and meta.get('reco_pause_reason') == 'legacy_import_review'
                and meta.get('legacy_consent_review_required') is True
                and meta.get('legacy_agree_sms_yn') in ('Y', 'N')
                and meta.get('legacy_account_flags') == {field: 'N' for field in review.ACCOUNT_REVIEW_FIELDS}
                and row.get('assigned_staff_id') is None and row.get('team_id') is None, 'metadata')
    require(all(row.get('meta', {}).get('source_site') == 'lotto815'
                and row.get('meta', {}).get('import_batch') == BATCH and row.get('staff_id') is None
                for row in plan.payments), 'metadata')


def classify_batch(verification):
    counts = (verification.member_count, verification.payment_count, verification.payment_amount)
    if counts == (0, 0, 0):
        return 'empty'
    require(counts == EXPECTED and not any((verification.orphan_payments, verification.null_product_payments,
            verification.duplicate_member_keys, verification.duplicate_payment_keys)), 'partial_batch')
    return 'complete'


def canonical(row, expected):
    result = {}
    for key in expected:
        value = row.get(key)
        if key in pilot.DATE_FIELDS and value:
            value = re.sub(r'(\d{2}:\d{2}:\d{2}\.)(\d+)',
                           lambda match: match.group(1) + match.group(2).ljust(6, '0')[:6],
                           value.replace('Z', '+00:00'))
            parsed = dt.datetime.fromisoformat(value)
            require(parsed.tzinfo is not None, 'rows')
            value = parsed.astimezone(dt.timezone.utc).isoformat()
        result[key] = value
    return encoded(result)


def verify_rows(client, plan, tables=('members', 'payments')):
    for table in tables:
        intended = getattr(plan, table)
        columns = sorted({key for row in intended for key in row})
        assignment_columns = ['assigned_staff_id', 'team_id'] if table == 'members' else ['staff_id']
        columns.extend(key for key in assignment_columns if key not in columns)
        found = client.select_all(table, ','.join(columns), FILTERS)
        actual = {row['id']: row for row in found}
        require(len(found) == len(actual) == len(intended), 'rows')
        for row in intended:
            got = actual.get(row['id'])
            require(got is not None and canonical(got, row) == canonical(row, row)
                    and all(got.get(key) is None for key in assignment_columns), 'rows')


def verify_holds(client, plan, held=True):
    matching = sum(client.hold_status(row['phone']) is held for row in plan.members)
    require(matching == EXPECTED[0], 'hold')
    return matching


def verify_archive():
    digest = hashlib.sha256()
    with ARCHIVE.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(part)
    require(digest.hexdigest() == ARCHIVE_SHA, 'archive')


def load_source():
    source = loader.DumpSource('lotto815', archive=str(ARCHIVE))
    return source.load('user'), source.load('payment')


class Store:
    """배치 잠금·불변 예정 행·실행별 영수증. 비밀 환경변수는 저장하지 않는다."""
    def __init__(self, root=BACKUP_ROOT):
        for path in (root, *root.parents):
            require(not path.is_symlink(), 'private_path')
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)
        self.batch = root / BATCH
        require(not self.batch.is_symlink(), 'private_path')
        self.batch.mkdir(exist_ok=True, mode=0o700)
        os.chmod(self.batch, 0o700)
        self.frozen = self.batch / 'frozen-intended-rows.json'
        self.lock_fd = None
        self.run = None

    def __enter__(self):
        fd = os.open(self.batch / 'run.lock', os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            require(stat.S_ISREG(os.fstat(fd).st_mode), 'private_path')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError):
            os.close(fd)
            raise Stop('locked') from None
        self.lock_fd = fd
        os.fchmod(fd, 0o600)
        self.run = self.batch / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
        self.run.mkdir(mode=0o700)
        return self

    def __exit__(self, exc_type, exc, traceback):
        if self.lock_fd is not None:
            fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
            os.close(self.lock_fd)
            self.lock_fd = None

    def save(self, receipt):
        require(self.run is not None, 'private_path')
        pilot.private_json(self.run / 'receipt.json', receipt)

    def load_frozen(self, validator):
        require(self.frozen.exists(), 'frozen_missing')
        fd = os.open(self.frozen, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd) as stream:
            metadata = os.fstat(stream.fileno())
            require(stat.S_ISREG(metadata.st_mode) and stat.S_IMODE(metadata.st_mode) == 0o600
                    and metadata.st_uid == os.getuid() and metadata.st_size <= 8 * 1024 * 1024, 'private_path')
            saved = json.load(stream)
        require(saved.get('batch') == BATCH and saved.get('archive_sha256') == ARCHIVE_SHA, 'frozen_changed')
        rows = saved['payload']
        require(set(rows) == {'members', 'payments', 'products'} and all(isinstance(rows[key], list) for key in rows), 'frozen_changed')
        plan = loader.ImportPlan(rows['members'], rows['payments'], rows['products'], Counter(), Counter(), Counter(), EXPECTED[0], 0)
        require(saved.get('payload_sha256') == payload_sha(plan), 'frozen_changed')
        validator(plan)
        return plan

    def freeze(self, plan, validator):
        validator(plan)
        if self.frozen.exists() or self.frozen.is_symlink():
            require(encoded(payload(self.load_frozen(validator))) == encoded(payload(plan)), 'frozen_changed')
            return
        temporary = self.batch / ('frozen-' + uuid.uuid4().hex + '.tmp')
        pilot.private_json(temporary, {'batch': BATCH, 'archive_sha256': ARCHIVE_SHA,
                           'payload_sha256': payload_sha(plan), 'payload': payload(plan)})
        try:
            # link는 기존 파일을 덮어쓰지 않고 완성된 파일만 원자적으로 게시한다.
            os.link(temporary, self.frozen)
        finally:
            temporary.unlink(missing_ok=True)


def run(client, store, apply=False, *, archive_verifier=verify_archive, source_reader=load_source,
        state_reader=pilot.minimal_state, plan_builder=review.build_review_plan, validator=validate_plan):
    """기본 실행 경로는 고정. 주입 인자는 합성 데이터 테스트용이며 CLI로 노출하지 않는다."""
    receipt = {'batch': BATCH, 'mode': 'apply' if apply else 'read_only', 'stage': 'initializing',
               'expected_members': EXPECTED[0], 'expected_payments': EXPECTED[1], 'expected_amount': EXPECTED[2],
               'archive_sha256': ARCHIVE_SHA, 'identity_sha256': IDENTITY_SHA, 'payload_sha256': PAYLOAD_SHA,
               'writes_attempted': False, 'sms_requests': 0, 'http_sms_endpoint_verification': 'not_performed_domain_blocked',
               'hold_verification_method': 'supabase_read_only_rpc', 'global_settings_mutations': 0, 'stages': []}

    def step(stage, **updates):
        receipt.update(updates)
        receipt['stage'] = stage
        receipt['stages'].append({'stage': stage, 'at_utc': dt.datetime.now(dt.timezone.utc).isoformat()})
        store.save(receipt)

    try:
        step('verifying_archive')
        require(client.allow_writes is apply, 'write_mode')
        archive_verifier()
        step('reading_batch')
        before = loader.read_batch_verification(client, 'lotto815', BATCH)
        receipt['before'] = dataclasses.asdict(before)
        kind = classify_batch(before)
        if kind == 'complete':
            step('verifying_completed_frozen_batch')
            # 완료 시 원본 재선정/다음 100명 계산을 절대 호출하지 않는다.
            plan = store.load_frozen(validator)
            pilot.check_products(client, plan)
            verify_rows(client, plan)
            receipt['held_members'] = verify_holds(client, plan)
            step('already_complete_verified_noop', after=dataclasses.asdict(before))
        else:
            step('planning_fixed_candidates')
            users, payments = source_reader()
            state = state_reader(client)
            plan, summary = plan_builder(loader, users, payments, state, BATCH, EXPECTED[0])
            validator(plan)
            pilot.check_products(client, plan)
            store.freeze(plan, validator)
            step('frozen_plan_verified', baseline_members=len(state.member_ids), baseline_payments=len(state.payment_ids))
            verify_holds(client, plan, held=False)
            step('ready_read_only', clear_candidates=EXPECTED[0])
            if apply:
                step('refreshing_before_insert')
                refreshed, unused_summary = plan_builder(loader, users, payments, state_reader(client), BATCH, EXPECTED[0])
                validator(refreshed)
                require(encoded(payload(refreshed)) == encoded(payload(plan)), 'payload')
                pilot.check_products(client, plan)
                require(classify_batch(loader.read_batch_verification(client, 'lotto815', BATCH)) == 'empty', 'batch_changed')
                step('applying_atomic_batch', writes_attempted=True)
                atomic = client.apply_atomic(plan)
                step('verifying_complete_batch', atomic_result={key: atomic[key] for key in
                     ('batch_id', 'members', 'payments', 'amount', 'held_members', 'atomic')})
                after = loader.read_batch_verification(client, 'lotto815', BATCH, state.member_ids)
                require(classify_batch(after) == 'complete', 'partial_batch')
                loader.verify_applied_batch(before, after, plan)
                verify_rows(client, plan)
                receipt['held_members'] = verify_holds(client, plan)
                step('complete_verified', after=dataclasses.asdict(after))
        print(json.dumps({'stage': receipt['stage'], 'members': EXPECTED[0], 'payments': EXPECTED[1], 'amount': EXPECTED[2],
                          'writes_attempted': receipt['writes_attempted'], 'sms_requests': 0,
                          'http_sms_endpoint_verification': receipt['http_sms_endpoint_verification'],
                          'receipt_directory': str(store.run)}, ensure_ascii=False))
        return 0
    except (Exception, SystemExit) as error:
        receipt['failed_stage'] = receipt['stage']
        receipt['stage'] = 'stopped_recovery_required' if receipt['writes_attempted'] else 'stopped_without_customer_writes'
        receipt['reason_code'] = error.code if isinstance(error, Stop) else 'verification_or_transport_error'
        receipt['reason'] = REASONS[error.code] if isinstance(error, Stop) else '검증 또는 통신 오류. 원격 본문·개인정보·비밀은 기록하지 않았습니다.'
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
        print(json.dumps({'stage': receipt['stage'], 'reason_code': receipt['reason_code'], 'reason': receipt['reason'],
                          'observed_batch': receipt.get('observed_batch'), 'receipt_directory': str(store.run),
                          'rpc_error': receipt.get('rpc_error'),
                          'receipt_write_failed': receipt.get('receipt_write_failed', False)}, ensure_ascii=False))
        return 1


def execute(apply=False):
    try:
        config = pilot.read_config(ROOT / '.env.local')
        with Store() as store:
            return run(Client(config, allow_writes=apply), store, apply=apply)
    except (Exception, SystemExit) as error:
        code = error.code if isinstance(error, Stop) else 'initialization_failed'
        print(json.dumps({'stage': 'stopped_without_customer_writes', 'reason_code': code,
                          'reason': REASONS[code] if code in REASONS else '실행 초기화 실패. 로컬 설정과 복구 경로를 확인하세요.'}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='고정 승인 대상 100명·결제 116건만 실제 INSERT')
    args = parser.parse_args()
    raise SystemExit(execute(apply=args.apply))
