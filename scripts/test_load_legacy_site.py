#!/usr/bin/env python3
"""load-legacy-site.py의 DB 비접속 안전성/재개 단위 테스트."""

import gzip
import importlib.util
import io
import os
import sys
import tempfile
import unittest
import urllib.parse
import zipfile
from contextlib import redirect_stderr
from pathlib import Path


SCRIPT = Path(__file__).with_name('load-legacy-site.py')
SPEC = importlib.util.spec_from_file_location('load_legacy_site', SCRIPT)
loader = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = loader
SPEC.loader.exec_module(loader)


def user(idx='101', level='2', phone='01012345678', login='legacy-user', consult='new'):
    return {
        'idx': idx, 'levelNum': level, 'phone': phone, 'id': login, 'name': '테스트',
        'nick': '', 'statCode': 'normal', 'statTmCode': consult, 'salesIdx': '7',
        'statAdmCode': 'new', 'itemCode': 'family' if level in ('1', '2') else 'mania',
        'itemEndDateTime': '2027-01-01 00:00:00', 'schedulePickSmsWeek': 'wed',
        'itemOptionSlot': '10', 'inflowFromCode': 'sample', 'adminMemo': '',
        'memoLastContents': '', 'insertDateTimeOrg': '2024-01-01 09:00:00',
        'insertDateTime': '2024-01-01 09:00:00', 'loginDateTime': '2026-08-31 09:00:00',
    }


def payment(idx='501', user_idx='101', item='family'):
    return {
        'idx': idx, 'userIdx': user_idx, 'itemCode': item, 'itemWon': '488000',
        'payMethodCode': 'officeCredit', 'statCode': 'success',
        'itemStartDateTime': '2024-01-01 00:00:00',
        'itemEndDateTime': '2025-07-01 00:00:00', 'userBankName': '',
        'insertDateTime': '2024-01-01 09:00:00', 'salesIdx': '7', 'itemExpMonth': '18',
    }


class LegacyLoaderTest(unittest.TestCase):
    def test_level_one_consult_batch_and_deterministic_member_id(self):
        first, reason = loader.build_member(
            user(level='1', consult='absence'), 'lotto815', loader.GRADE_BY_SITE['lotto815'], 'batch-safe_1'
        )
        second, _ = loader.build_member(
            user(level='1', consult='absence'), 'lotto815', loader.GRADE_BY_SITE['lotto815'], 'batch-safe_1'
        )
        self.assertIsNone(reason)
        self.assertEqual(first['grade'], 'free')
        self.assertEqual(first['consult_status'], '부재')
        self.assertTrue(first['outcall_done'])
        self.assertEqual(first['inflow_type'], '신규')
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(first['meta']['source_site'], 'lotto815')
        self.assertEqual(first['meta']['legacy_idx'], 101)
        self.assertEqual(first['meta']['import_batch'], 'batch-safe_1')

    def test_new_consult_is_not_outcalled_and_blank_inflow_stays_null(self):
        row = user(consult='new')
        row['statAdmCode'] = ''
        member, reason = loader.build_member(row, 'lotto815', loader.GRADE_BY_SITE['lotto815'])
        self.assertIsNone(reason)
        self.assertFalse(member['outcall_done'])
        self.assertIsNone(member['inflow_type'])

    def test_missing_join_date_uses_earliest_operational_timestamp(self):
        row = user()
        row['insertDateTimeOrg'] = ''
        row['insertDateTime'] = ''
        row['itemStartDateTime'] = '2025-01-02 09:00:00'
        row['groupAllocDateTime'] = '2024-12-03 08:00:00'
        member, reason = loader.build_member(
            row, 'lotto815', loader.GRADE_BY_SITE['lotto815'], 'batch-safe_1'
        )
        self.assertIsNone(reason)
        self.assertEqual(member['registered_at'], '2024-12-03T08:00:00+09:00')
        self.assertEqual(member['meta']['registered_at_fallback'], 'groupAllocDateTime')

    def test_payment_has_stable_product_id_and_legacy_meta(self):
        product = loader.product_for_payment('lotto815', payment())
        self.assertEqual(product['id'], 'legacy_lotto815_family')
        first = loader.build_payment(payment(), 'lotto815', 'mem_existing', product['id'], 'lotto815-20260831')
        second = loader.build_payment(payment(), 'lotto815', 'mem_existing', product['id'], 'lotto815-20260831')
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(first['product_id'], product['id'])
        self.assertEqual(first['meta']['source_site'], 'lotto815')
        self.assertEqual(first['meta']['legacy_idx'], 501)
        self.assertEqual(first['meta']['import_batch'], 'lotto815-20260831')
        self.assertFalse(product['is_active'])

    def test_duplicate_phone_alias_preserves_both_users_payments(self):
        plan = loader.build_import_plan(
            [user('101', phone='01011112222'), user('102', phone='01011112222')],
            [payment('501', '101'), payment('502', '102')],
            'lotto815',
        )
        self.assertEqual(len(plan.members), 1)
        self.assertEqual(len(plan.payments), 2)
        self.assertEqual(plan.payments[0]['member_id'], plan.payments[1]['member_id'])
        self.assertEqual(plan.member_conflicts['중복 전화 원본 PK를 첫 회원에 연결'], 1)

    def test_existing_member_resumes_payments_and_existing_payment_is_skipped(self):
        state = loader.ExistingState(
            legacy_member_ids={('lotto815', 101): 'mem_existing'},
            payment_ids={loader.stable_id('payment', 'lotto815', 501)},
            legacy_payment_keys={('lotto815', 501)},
        )
        plan = loader.build_import_plan(
            [user()], [payment('501'), payment('502')], 'lotto815', state,
        )
        self.assertEqual(plan.members, [])
        self.assertEqual(len(plan.payments), 1)
        self.assertEqual(plan.payments[0]['member_id'], 'mem_existing')
        self.assertEqual(plan.skipped_payments['이미 적재된 레거시 결제'], 1)

    def test_phone_skip_and_login_collision_use_count_only_and_replacement(self):
        state = loader.ExistingState(phones={'01012345678'}, user_ids={'taken'})
        plan = loader.build_import_plan(
            [user('101', phone='01012345678'), user('102', phone='01099998888', login='taken')],
            [payment('501', '101'), payment('502', '102')], 'lotto815', state,
        )
        self.assertEqual(len(plan.members), 1)
        self.assertTrue(plan.members[0]['user_id'].startswith('legacy_lotto815_102'))
        self.assertEqual(plan.member_conflicts['기존 전화번호 충돌(건너뜀)'], 1)
        self.assertEqual(plan.member_conflicts['로그인 아이디 충돌(대체 ID)'], 1)
        self.assertEqual(len(plan.payments), 1)

    def test_archive_reads_known_nested_files_and_ignores_other_payloads(self):
        user_sql = "-- 컬럼: idx,name\nINSERT INTO `user` VALUES\n('1','홍길동');\n"
        payment_sql = "-- 컬럼: idx,userIdx\nINSERT INTO `payment` VALUES\n('2','1');\n"
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / 'dump.zip'
            with zipfile.ZipFile(archive_path, 'w') as archive:
                # 이전 업체가 사용한 815korean stem도 정확한 별칭으로 허용한다.
                archive.writestr('safe/815korean_user.sql.gz', gzip.compress(user_sql.encode()))
                archive.writestr('safe/815korean_payment.sql.gz', gzip.compress(payment_sql.encode()))
                archive.writestr('safe/lotto815_pushSms.sql.gz', b'must-not-be-read')
            source = loader.DumpSource('lotto815', archive=str(archive_path))
            self.assertEqual(source.load('user'), [{'idx': '1', 'name': '홍길동'}])
            self.assertEqual(source.load('payment'), [{'idx': '2', 'userIdx': '1'}])

    def test_archive_rejects_unsafe_paths(self):
        sql = "-- 컬럼: idx\nINSERT INTO `user` VALUES\n('1');\n"
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / 'unsafe.zip'
            with zipfile.ZipFile(archive_path, 'w') as archive:
                archive.writestr('../escape.txt', b'x')
                archive.writestr('lotto815_user.sql.gz', gzip.compress(sql.encode()))
                archive.writestr('lotto815_payment.sql.gz', gzip.compress(sql.encode()))
            with self.assertRaisesRegex(ValueError, '안전하지 않은 경로'):
                loader.DumpSource('lotto815', archive=str(archive_path)).load('user')

    def test_read_only_client_blocks_writes_before_network(self):
        client = loader.Supa('https://example.invalid', 'secret-not-printed', allow_writes=False)
        with self.assertRaisesRegex(RuntimeError, '읽기 전용'):
            client.insert('members', [{'id': 'x'}])
        with self.assertRaisesRegex(RuntimeError, '읽기 전용'):
            client.upsert('products', [{'id': 'x'}])

    def test_select_all_uses_stable_id_order_and_encoded_filters(self):
        client = loader.Supa('https://example.invalid', 'hidden', allow_writes=False)
        paths = []

        def fake_req(method, path, body=None, prefer=None):
            paths.append(path)
            return []

        client._req = fake_req
        client.select_all(
            'members', 'id,meta',
            [('meta->>source_site', 'eq.lotto815'), ('meta->>import_batch', 'eq.batch-safe_1')],
        )
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(paths[0]).query)
        self.assertEqual(query['order'], ['id.asc'])
        self.assertEqual(query['offset'], ['0'])
        self.assertEqual(query['meta->>source_site'], ['eq.lotto815'])
        self.assertEqual(query['meta->>import_batch'], ['eq.batch-safe_1'])

    def test_batch_verification_detects_silent_insert_mismatch(self):
        empty = loader.BatchVerification(0, 0, 0, 0, 0, 0, 0)
        plan = loader.build_import_plan([user()], [payment()], 'lotto815')
        with self.assertRaisesRegex(SystemExit, '회원 실제 0 / 예상 1'):
            loader.verify_applied_batch(empty, empty, plan)

    def test_batch_verification_counts_integrity_issues(self):
        class FakeClient:
            def select_all(self, table, columns, filters=None):
                if table == 'members':
                    return [
                        {'id': 'm1', 'meta': {'legacy_idx': 101}},
                        {'id': 'm2', 'meta': {'legacy_idx': 101}},
                    ]
                return [
                    {
                        'id': 'p1', 'member_id': 'm1', 'product_id': 'product', 'amount': 100,
                        'meta': {'legacy_idx': 501},
                    },
                    {
                        'id': 'p2', 'member_id': 'missing', 'product_id': None, 'amount': 200,
                        'meta': {'legacy_idx': 501},
                    },
                ]

        result = loader.read_batch_verification(FakeClient(), 'lotto815', 'batch-safe_1')
        self.assertEqual(result.member_count, 2)
        self.assertEqual(result.payment_count, 2)
        self.assertEqual(result.payment_amount, 300)
        self.assertEqual(result.orphan_payments, 1)
        self.assertEqual(result.null_product_payments, 1)
        self.assertEqual(result.duplicate_member_keys, 1)
        self.assertEqual(result.duplicate_payment_keys, 1)

    def test_batch_id_validation_and_env_defaults(self):
        old_url, old_key = os.environ.get('VITE_SUPABASE_URL'), os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
        try:
            os.environ['VITE_SUPABASE_URL'] = 'https://example.invalid'
            os.environ['SUPABASE_SERVICE_ROLE_KEY'] = 'hidden'
            args = loader.parse_args(['--site', 'lotto815', '--dir', '.', '--plan'])
            self.assertEqual(args.batch_id, 'lotto815-20260831')
            self.assertEqual(args.url, 'https://example.invalid')
            self.assertEqual(args.key, 'hidden')
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                loader.parse_args([
                    '--site', 'lotto815', '--dir', '.', '--dry-run', '--batch-id', '../unsafe'
                ])
        finally:
            if old_url is None:
                os.environ.pop('VITE_SUPABASE_URL', None)
            else:
                os.environ['VITE_SUPABASE_URL'] = old_url
            if old_key is None:
                os.environ.pop('SUPABASE_SERVICE_ROLE_KEY', None)
            else:
                os.environ['SUPABASE_SERVICE_ROLE_KEY'] = old_key


if __name__ == '__main__':
    unittest.main()
