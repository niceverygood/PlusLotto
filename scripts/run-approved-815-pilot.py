#!/usr/bin/env python3
"""승인된 815 시범 100명만 실행한다. 기본값은 읽기 전용이며 --apply만 INSERT한다.

대상/배치/원본/금액/식별자 지문을 변경하는 CLI 옵션은 없다. 중간 실패 배치는
자동 재실행하거나 삭제하지 않는다. 개인정보 포함 복구 자료는 저장소 밖의
0700 디렉터리/0600 파일에만 보관한다. stdout에는 집계만 출력한다.
"""
from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('approved_815_loader', ROOT / 'scripts/load-legacy-site.py')
assert SPEC and SPEC.loader
loader = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = loader
SPEC.loader.exec_module(loader)

PROJECT_URL = 'https://xmfdbmlpvvqqkhqemfay.supabase.co'
SMS_URL = 'https://lotto-plus.co.kr/api/send-sms'
ARCHIVE = Path('/Users/seungsoohan/Library/Containers/com.kakao.KakaoTalkMac/Data/Downloads/815korean_paid_all_20260831 (2).zip')
ARCHIVE_SHA = 'f818dd0fae1b62d2f67893995aeb83e3af698cb36e0a80352164f4429c0dc56d'
BATCH = 'lotto815-20260909-pilot-001'
FINGERPRINT = 'b743a3fae03d68cb849adff0f87640a1960745cb6d9aacc7fa1874f26b31ef59'
EXPECTED = (100, 39, 14_206_800)
BACKUP_ROOT = Path('/Users/seungsoohan/Documents/백업/Backups/PlusLotto/legacy-import-20260910')
FILTERS = [('meta->>source_site', 'eq.lotto815'), ('meta->>import_batch', f'eq.{BATCH}')]
DATE_FIELDS = frozenset({'registered_at', 'last_active_at', 'period_start', 'period_end', 'paid_at', 'created_at'})


class Refusal(Exception):
    """개인정보나 원격 오류 본문을 포함하지 않는 고정 오류만 사용한다."""


def require(condition, message):
    if not condition:
        raise Refusal(message)


def read_config(path):
    names = {'VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET'}
    result = {}
    for line in path.read_text().splitlines():
        key, sep, value = line.partition('=')
        key = key.strip()
        if sep and key in names:
            require(key not in result, '필수 환경변수 중복: 로컬 설정을 점검하세요.')
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            result[key] = value
    require(all(result.get(key) for key in names), '필수 로컬 환경변수가 없습니다.')
    require(result['VITE_SUPABASE_URL'].rstrip('/') == PROJECT_URL, '승인된 Supabase 프로젝트와 다릅니다.')
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Refusal('인증 요청의 리디렉션을 거부했습니다.')


def request_json(url, headers, body=None):
    """재시도하지 않는다. 특히 INSERT 응답 불명확 시 중복 실행하지 않는다."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method='POST' if data is not None else 'GET')
    try:
        response = urllib.request.build_opener(NoRedirect).open(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    except urllib.error.URLError:
        raise Refusal('네트워크 확인 실패. 응답이 불명확한 쓰기는 재실행하지 않습니다.') from None
    with response:
        raw = response.read(8 * 1024 * 1024 + 1)
        require(len(raw) <= 8 * 1024 * 1024, '응답 크기가 점검 한도를 초과했습니다.')
        try:
            return response.code, json.loads(raw) if raw else None
        except (ValueError, UnicodeDecodeError):
            raise Refusal('서버 응답이 JSON이 아닙니다.') from None


class Client(loader.Supa):
    def __init__(self, config, allow_writes=False):
        super().__init__(PROJECT_URL, config['SUPABASE_SERVICE_ROLE_KEY'], allow_writes)
        self.cron_secret = config['CRON_SECRET']

    def _req(self, method, path, body=None, prefer=None):
        require(method == 'GET' or (self.allow_writes and method == 'POST' and path in {'members', 'payments'}),
                '허용되지 않은 DB 변경을 거부했습니다.')
        headers = {'apikey': self.key, 'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'}
        if prefer:
            headers['Prefer'] = prefer
        code, value = request_json(self.url + '/rest/v1/' + path, headers, body)
        require(200 <= code < 300, 'Supabase 요청 실패. 복구 집계를 확인하세요.')
        return value or []

    def hold_status(self, phone):
        # 읽기 전용 SQL RPC만 예외적으로 POST 허용. 고객/설정 변경은 없다.
        headers = {'apikey': self.key, 'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'}
        code, value = request_json(self.url + '/rest/v1/rpc/sms_is_legacy_import_held', headers, {'p_phone': phone})
        require(code == 200 and type(value) is bool, '서버 문자 보류 RPC 확인 실패.')
        return value

    def check_only(self, phone, held):
        # msg_body를 절대로 넣지 않는다. 구버전 API도 필수 본문 누락으로 실패한다.
        code, value = request_json(SMS_URL, {'Content-Type': 'application/json', 'x-internal-secret': self.cron_secret},
                                   {'dest_phone': phone, 'check_only': True})
        expected = (423, 'LEGACY_IMPORT_HOLD', False) if held else (200, 'CHECK_ONLY', True)
        require(isinstance(value, dict) and (code, value.get('code')) == expected[:2] and value.get('ok') is expected[2],
                '운영 check_only 보류 확인 실패. 문자는 요청하지 않았습니다.')


def minimal_state(client, omit_batch=False):
    state = loader.ExistingState()
    for row in client.select_all('members', 'id,user_id,phone,source_site:meta->>source_site,legacy_idx:meta->>legacy_idx,import_batch:meta->>import_batch'):
        if omit_batch and row.get('source_site') == 'lotto815' and row.get('import_batch') == BATCH:
            continue
        state.member_ids.add(row['id'])
        state.phones.add(loader.digits(row.get('phone')))
        state.user_ids.add(row.get('user_id') or '')
        idx = loader.num(row.get('legacy_idx'))
        if row.get('source_site') and idx is not None:
            state.legacy_member_ids[(row['source_site'], idx)] = row['id']
    for row in client.select_all('payments', 'id,source_site:meta->>source_site,legacy_idx:meta->>legacy_idx,import_batch:meta->>import_batch'):
        if omit_batch and row.get('source_site') == 'lotto815' and row.get('import_batch') == BATCH:
            continue
        state.payment_ids.add(row['id'])
        idx = loader.num(row.get('legacy_idx'))
        if row.get('source_site') and idx is not None:
            state.legacy_payment_keys.add((row['source_site'], idx))
    state.product_ids.update(row['id'] for row in client.select_all('products', 'id'))
    return state


def fingerprint(plan):
    payload = {'member_ids': [r['id'] for r in plan.members],
               'payments': [(r['id'], r['member_id'], r['amount']) for r in plan.payments]}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def check_plan(plan):
    require((len(plan.members), len(plan.payments), sum(r['amount'] for r in plan.payments)) == EXPECTED,
            '승인된 회원/결제/금액과 현재 계획이 다릅니다.')
    require(fingerprint(plan) == FINGERPRINT, '승인된 대상 식별자 지문과 다릅니다.')
    require(all(r['meta'].get('source_site') == 'lotto815' and r['meta'].get('reco_paused') is True and r['meta'].get('reco_pause_reason') == 'legacy_import_review'
                and r['meta'].get('import_batch') == BATCH and not r.get('assigned_staff_id') for r in plan.members),
            '시범 회원의 문자 보류 또는 배치 설정이 다릅니다.')


def classify_batch(verification):
    counts = (verification.member_count, verification.payment_count, verification.payment_amount)
    if counts == (0, 0, 0):
        return 'empty'
    require(counts == EXPECTED, '부분 적재 또는 예상과 다른 배치가 있습니다. 자동 재실행을 거부합니다.')
    require(not any((verification.orphan_payments, verification.null_product_payments,
                     verification.duplicate_member_keys, verification.duplicate_payment_keys)),
            '기존 배치 연결/중복 검증 실패.')
    return 'complete'


def canonical(row, expected):
    result = {}
    for key in expected:
        value = row.get(key)
        if key in DATE_FIELDS and value:
            value = dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(dt.timezone.utc).isoformat()
        result[key] = value
    return json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def verify_rows(client, plan):
    for table, intended in [('members', plan.members), ('payments', plan.payments)]:
        columns = sorted({key for row in intended for key in row})
        if table == 'members':
            columns.extend(['assigned_staff_id', 'team_id'])
        found = client.select_all(table, ','.join(columns), FILTERS)
        actual = {row['id']: row for row in found}
        require(len(found) == len(intended) and len(actual) == len(intended), '실제 배치 행 수가 다릅니다.')
        for row in intended:
            got = actual.get(row['id'])
            require(got is not None and canonical(got, row) == canonical(row, row), '실제 배치 내용이 승인된 원본 변환과 다릅니다.')
            if table == 'members':
                require(got.get('assigned_staff_id') is None and got.get('team_id') is None, '시범 회원에 예상하지 않은 담당 배정이 있습니다.')


def check_products(client, plan):
    fields = 'id,name,price,duration_months,grade_granted,is_active'
    products = client.select_all('products', fields, [('id', 'in.(' + ','.join(p['id'] for p in plan.products) + ')')])
    found = {p['id']: p for p in products}
    require(len(found) == 3 and all(canonical(found.get(p['id'], {}), p) == canonical(p, p) for p in plan.products),
            '기존 3개 상품 설정이 승인 계획과 다릅니다. 상품을 갱신하지 않습니다.')


def private_run_dir(root=BACKUP_ROOT):
    for path in [root, *root.parents]:
        require(not path.is_symlink(), '복구 디렉터리의 심볼릭 링크를 거부했습니다.')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    batch_dir = root / BATCH
    require(not batch_dir.is_symlink(), '배치 디렉터리의 심볼릭 링크를 거부했습니다.')
    batch_dir.mkdir(mode=0o700, exist_ok=True)
    os.chmod(batch_dir, 0o700)
    run = batch_dir / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
    run.mkdir(mode=0o700)
    return run


def private_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(temporary, flags, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)


def verify_holds(client, plan):
    held = sum(client.hold_status(r['phone']) is True for r in plan.members)
    require(held == 100, '시범 회원 전체의 서버 문자 보류가 확인되지 않았습니다.')
    for row in (plan.members[0], plan.members[-1]):
        client.check_only(row['phone'], held=True)
    return held


def execute(apply=False):
    try:
        run_dir = private_run_dir()
    except (Exception, SystemExit) as error:
        reason = str(error) if isinstance(error, Refusal) else '복구 디렉터리 준비 실패. 경로와 접근 권한을 확인하세요.'
        print(json.dumps({'stage': 'stopped_without_customer_writes', 'reason': reason}, ensure_ascii=False))
        return 1
    receipt = {'batch': BATCH, 'mode': 'apply' if apply else 'read_only', 'stage': 'initializing',
               'expected_members': 100, 'expected_payments': 39, 'expected_amount': 14206800,
               'archive_sha256': ARCHIVE_SHA, 'fingerprint_sha256': FINGERPRINT,
               'sms_requested': False, 'writes_attempted': False}
    client = None
    baseline = None
    try:
        config = read_config(ROOT / '.env.local')
        client = Client(config, allow_writes=apply)
        digest = hashlib.sha256()
        with ARCHIVE.open('rb') as stream:
            for part in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(part)
        require(digest.hexdigest() == ARCHIVE_SHA, '승인된 ZIP 원본과 SHA-256이 다릅니다.')
        source = loader.DumpSource('lotto815', archive=str(ARCHIVE))
        users, payments = source.load('user'), source.load('payment')
        before = loader.read_batch_verification(client, 'lotto815', BATCH)
        state_kind = classify_batch(before)
        state = minimal_state(client, omit_batch=(state_kind == 'complete'))
        baseline = {'members': len(state.member_ids), 'payments': len(state.payment_ids), 'batch': dataclasses.asdict(before)}
        receipt['baseline'] = baseline
        plan = loader.build_import_plan(users, payments, 'lotto815', state, limit=104, batch_id=BATCH)
        check_plan(plan)
        check_products(client, plan)
        private_json(run_dir / 'intended-rows.json', {'members': plan.members, 'payments': plan.payments, 'products': plan.products})
        private_json(run_dir / 'expected-receipt.json', receipt)
        receipt['stage'] = 'plan_verified'
        if state_kind == 'complete':
            verify_rows(client, plan)
            receipt['held_members'] = verify_holds(client, plan)
            receipt['stage'] = 'already_complete_verified_noop'
        else:
            require(client.hold_status(plan.members[0]['phone']) is False, '신규 시범 후보가 이미 서버에서 보류 중입니다.')
            client.check_only(plan.members[0]['phone'], held=False)
            receipt['check_only_clear_confirmed'] = True
            receipt['stage'] = 'ready_read_only'
            if apply:
                # 마지막 대조도 최소 필드 GET만 한다. 동시 작성자의 추가가 보이면 중단한다.
                require(classify_batch(loader.read_batch_verification(client, 'lotto815', BATCH)) == 'empty',
                        '실행 직전 배치가 달라졌습니다.')
                refreshed = loader.build_import_plan(users, payments, 'lotto815', minimal_state(client), limit=104, batch_id=BATCH)
                check_plan(refreshed)
                require(canonical({'rows': refreshed.members}, {'rows': plan.members}) == canonical({'rows': plan.members}, {'rows': plan.members})
                        and canonical({'rows': refreshed.payments}, {'rows': plan.payments}) == canonical({'rows': plan.payments}, {'rows': plan.payments}),
                        '실행 직전 변환 데이터가 변경되었습니다.')
                check_products(client, plan)
                receipt['writes_attempted'] = True
                receipt['stage'] = 'inserting_members'
                private_json(run_dir / 'receipt.json', receipt)
                client.insert('members', plan.members)
                receipt['stage'] = 'members_inserted_verifying_hold'
                private_json(run_dir / 'receipt.json', receipt)
                # 결제 승인/알림 처리 전에도 전원 보류를 먼저 확인한다.
                receipt['held_members'] = verify_holds(client, plan)
                receipt['stage'] = 'inserting_payments'
                private_json(run_dir / 'receipt.json', receipt)
                client.insert('payments', plan.payments)
                after = loader.read_batch_verification(client, 'lotto815', BATCH, state.member_ids)
                loader.verify_applied_batch(before, after, plan)
                verify_rows(client, plan)
                receipt['held_members'] = verify_holds(client, plan)
                receipt['after'] = dataclasses.asdict(after)
                receipt['stage'] = 'complete_verified'
        private_json(run_dir / 'receipt.json', receipt)
        print(json.dumps({'stage': receipt['stage'], 'members': 100, 'payments': 39, 'amount': 14206800,
                          'writes_attempted': receipt['writes_attempted'], 'receipt_directory': str(run_dir)}, ensure_ascii=False))
        return 0
    except (Exception, SystemExit) as error:
        receipt['failed_stage'] = receipt['stage']
        receipt['stage'] = 'stopped_recovery_required' if receipt['writes_attempted'] else 'stopped_without_customer_writes'
        # 불명확한 INSERT도 재시도하지 않고 실제 배치 집계만 읽어 복구 근거를 남긴다.
        if client is not None:
            try:
                receipt['observed_batch'] = dataclasses.asdict(loader.read_batch_verification(client, 'lotto815', BATCH))
            except (Exception, SystemExit):
                receipt['observed_batch_unavailable'] = True
        receipt['reason'] = str(error) if isinstance(error, Refusal) else '점검 또는 적재 실패. 비밀/개인정보 보호를 위해 원격 오류 본문은 생략했습니다.'
        private_json(run_dir / 'receipt.json', receipt)
        print(json.dumps({'stage': receipt['stage'], 'reason': receipt['reason'], 'observed_batch': receipt.get('observed_batch'),
                          'receipt_directory': str(run_dir)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='승인된 시범 100명과 39개 결제만 실제 INSERT')
    args = parser.parse_args()
    raise SystemExit(execute(apply=args.apply))
