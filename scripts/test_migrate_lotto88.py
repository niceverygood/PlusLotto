#!/usr/bin/env python3
"""migrate-lotto88.py 의 DB 비접속 변환 단위 테스트.

이 이관은 되돌릴 수 없다 — 구전산이 10/13 에 종료되므로 그 뒤에는 원본이 없다
(docs/LOTTO88_MIGRATION_PLAN.md). 그래서 "무엇을 보존하는가"를 테스트로 못박는다.
"""

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('migrate-lotto88.py')
SPEC = importlib.util.spec_from_file_location('migrate_lotto88', SCRIPT)
assert SPEC and SPEC.loader
mig = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mig)

BATCH = 'lotto88-test'


def member(**over):
    base = {
        'id': 'm-001',
        'user_id': 'hong',
        'name': '홍길동',
        'phone': '01012345678',
        'grade': 'vip',
        'status': '정상',
        'registered_at': '2025-03-01T00:00:00Z',
        'is_suspended': False,
        'is_deleted': False,
        'is_withdrawn': False,
        'outcall_done': True,
        'meta': {},
    }
    base.update(over)
    return base


class StableId(unittest.TestCase):
    def test_같은_원본은_항상_같은_id(self):
        """두 번 돌려도 같은 id 라야 재실행이 중복 적재가 되지 않는다."""
        self.assertEqual(mig.stable_id('member', 'm-001'), mig.stable_id('member', 'm-001'))

    def test_다른_원본과_종류는_섞이지_않는다(self):
        ids = {
            mig.stable_id('member', 'm-001'),
            mig.stable_id('member', 'm-002'),
            mig.stable_id('payment', 'm-001'),
            mig.stable_id('sms', 'm-001'),
        }
        self.assertEqual(len(ids), 4)

    def test_접두사로_종류를_알_수_있다(self):
        self.assertTrue(mig.stable_id('member', 'x').startswith('mem_'))
        self.assertTrue(mig.stable_id('payment', 'x').startswith('pay_'))
        self.assertTrue(mig.stable_id('sms', 'x').startswith('sms_'))


class MemberConversion(unittest.TestCase):
    def test_발송_규칙이_원본_그대로_넘어간다(self):
        """weekly_* 는 발송량을 결정한다. 추정으로 다시 만들면 회원이 받는 조합 수가 바뀐다."""
        src = member(meta={
            'weekly_reco_day': 2, 'weekly_reco_count': 5, 'end_date': '2026-12-31',
            'weekly_recos': [{'round_no': 1242, 'sets': []}], 'homepage_pw': '5678',
        })
        row, why = mig.member_row(src, BATCH)
        self.assertIsNone(why)
        self.assertEqual(row['meta']['weekly_reco_day'], 2)
        self.assertEqual(row['meta']['weekly_reco_count'], 5)
        self.assertEqual(row['meta']['end_date'], '2026-12-31')
        self.assertEqual(row['meta']['weekly_recos'], [{'round_no': 1242, 'sets': []}])
        self.assertEqual(row['meta']['homepage_pw'], '5678')

    def test_이관_회원은_모두_발송_보류로_들어간다(self):
        row, _ = mig.member_row(member(), BATCH)
        self.assertIs(row['meta']['reco_paused'], True)
        self.assertEqual(row['meta']['reco_pause_reason'], 'legacy_import_review')
        self.assertEqual(row['meta']['source_site'], 'lotto88')
        self.assertEqual(row['meta']['import_batch'], BATCH)

    def test_원본에서_이미_정지였던_회원을_따로_표시한다(self):
        """★ 전환일에 일괄 활성화하면 원래 정지였던 회원까지 켜져 발송된다.
        보류 플래그를 덮어쓰기 전에 원본 값을 남겨야 복원할 수 있다."""
        paused = member(meta={'reco_paused': True, 'reco_pause_reason': 'operator_pause'})
        row, _ = mig.member_row(paused, BATCH)
        self.assertIs(row['meta']['lotto88_reco_paused_at_import'], True)
        self.assertEqual(row['meta']['lotto88_reco_pause_reason_at_import'], 'operator_pause')

        active, _ = mig.member_row(member(meta={}), BATCH)
        self.assertIs(active['meta']['lotto88_reco_paused_at_import'], False)
        self.assertNotIn('lotto88_reco_pause_reason_at_import', active['meta'])

    def test_담당자와_팀은_비우고_원본값은_보존한다(self):
        """88로또 staff id 는 신전산에 없다. 그대로 넣으면 없는 담당자를 가리킨다."""
        row, _ = mig.member_row(member(assigned_staff_id='s-88', team_id='t-88'), BATCH)
        self.assertIsNone(row['assigned_staff_id'])
        self.assertIsNone(row['team_id'])
        self.assertEqual(row['meta']['legacy_assigned_staff_id'], 's-88')
        self.assertEqual(row['meta']['legacy_team_id'], 't-88')

    def test_로그인ID_는_사이트_접두사를_붙여_충돌을_막는다(self):
        row, _ = mig.member_row(member(user_id='hong'), BATCH)
        self.assertEqual(row['user_id'], 'lotto88_hong')

    def test_원본_id_를_보존한다(self):
        """구전산이 사라진 뒤 대조할 유일한 열쇠다."""
        row, _ = mig.member_row(member(id='m-777'), BATCH)
        self.assertEqual(row['meta']['legacy_id'], 'm-777')

    def test_등급과_상태를_추정하지_않고_그대로_쓴다(self):
        row, _ = mig.member_row(member(grade='royal', status='정지'), BATCH)
        self.assertEqual(row['grade'], 'royal')
        self.assertEqual(row['status'], '정지')

    def test_id_나_전화번호가_없으면_건너뛴다(self):
        for bad, why in ((member(id=''), 'id 누락'), (member(phone=''), '전화번호 누락')):
            row, reason = mig.member_row(bad, BATCH)
            self.assertIsNone(row)
            self.assertEqual(reason, why)


class PaymentConversion(unittest.TestCase):
    def setUp(self):
        self.ids = {mig.stable_id('member', 'm-001')}

    def payment(self, **over):
        base = {'id': 'p-1', 'member_id': 'm-001', 'amount': 550000, 'method': 'pg',
                'status': '승인', 'paid_at': '2026-01-05T00:00:00Z'}
        base.update(over)
        return base

    def test_상품은_임의로_매핑하지_않고_원본만_보존한다(self):
        """상품표는 사이트마다 다르다. 신전산 상품으로 넘겨짚으면 금액·기간이 어긋난다."""
        row, why = mig.payment_row(self.payment(product_id='prod-88'), BATCH, self.ids)
        self.assertIsNone(why)
        self.assertIsNone(row['product_id'])
        self.assertEqual(row['meta']['legacy_product_id'], 'prod-88')

    def test_금액과_결제수단은_그대로_간다(self):
        row, _ = mig.payment_row(self.payment(amount=990000, method='무통장'), BATCH, self.ids)
        self.assertEqual(row['amount'], 990000)
        self.assertEqual(row['method'], '무통장')

    def test_회원이_없는_결제는_고아로_만들지_않는다(self):
        row, why = mig.payment_row(self.payment(member_id='m-없음'), BATCH, self.ids)
        self.assertIsNone(row)
        self.assertEqual(why, '연결된 회원 없음')

    def test_신전산에만_있는_컬럼은_비워_둔다(self):
        row, _ = mig.payment_row(self.payment(), BATCH, self.ids)
        self.assertIsNone(row['round_label'])

    def test_회원_id_가_이관_후_id_로_바뀐다(self):
        row, _ = mig.payment_row(self.payment(), BATCH, self.ids)
        self.assertEqual(row['member_id'], mig.stable_id('member', 'm-001'))


class SmsConversion(unittest.TestCase):
    def setUp(self):
        self.ids = {mig.stable_id('member', 'm-001')}

    def test_문자이력이_회원에_연결된_채_넘어간다(self):
        src = {'id': 's-1', 'member_id': 'm-001', 'type': 'recommend',
               'status': '발송완료', 'sent_at': '2026-09-15T00:00:00Z', 'body': '조합'}
        row, why = mig.sms_row(src, BATCH, self.ids)
        self.assertIsNone(why)
        self.assertEqual(row['member_id'], mig.stable_id('member', 'm-001'))
        self.assertEqual(row['type'], 'recommend')
        self.assertEqual(row['status'], '발송완료')

    def test_회원_없는_문자는_건너뛴다(self):
        row, why = mig.sms_row({'id': 's-2', 'member_id': 'm-없음'}, BATCH, self.ids)
        self.assertIsNone(row)
        self.assertEqual(why, '연결된 회원 없음')


class BatchId(unittest.TestCase):
    def test_apply_에는_배치_id_가_반드시_필요하다(self):
        """배치 id 가 없으면 무엇을 넣었는지 특정할 수 없어 되돌리지 못한다."""
        with self.assertRaises(SystemExit):
            mig.validate_batch_id(None, required=True)

    def test_이상한_배치_id_는_거부한다(self):
        for bad in ('has space', '../escape', 'x' * 65, '"; drop'):
            with self.assertRaises(SystemExit):
                mig.validate_batch_id(bad, required=True)

    def test_정상_배치_id_는_통과한다(self):
        self.assertEqual(mig.validate_batch_id('lotto88-20261005', required=True), 'lotto88-20261005')


class BuildAll(unittest.TestCase):
    def test_건너뛴_사유가_집계로_남는다(self):
        built = mig.build(
            [member(id='m-001'), member(id='', phone='0102'), member(id='m-003', phone='')],
            [{'id': 'p-1', 'member_id': 'm-001'}, {'id': 'p-2', 'member_id': '없음'}],
            [{'id': 's-1', 'member_id': 'm-001'}],
            BATCH,
        )
        self.assertEqual(len(built['members']), 1)
        self.assertEqual(len(built['payments']), 1)
        self.assertEqual(len(built['sms_sends']), 1)
        self.assertEqual(built['skipped']['회원: id 누락'], 1)
        self.assertEqual(built['skipped']['회원: 전화번호 누락'], 1)
        self.assertEqual(built['skipped']['결제: 연결된 회원 없음'], 1)

    def test_집계는_개인정보_컬럼을_쓰지_않는다(self):
        built = mig.build([member(grade='vip'), member(id='m-2', grade='free')], [], [], BATCH)
        self.assertEqual(mig.summarize(built['members'], 'grade'), {'vip': 1, 'free': 1})


class WeekdayCheck(unittest.TestCase):
    """이관 후 문자가 나가느냐를 가르는 값. 옮기기 전에 --dry-run 으로 반드시 본다."""

    def build(self, srcs):
        return mig.build(srcs, [], [], BATCH)['members']

    def test_유료회원_요일_미설정을_센다(self):
        """신전산은 발송요일 없는 유료회원을 발송 대상에서 제외한다.
        그대로 옮기면 이관 후 영영 문자를 못 받고, 구전산이 사라지면 원인도 못 찾는다."""
        members = self.build([
            member(id='a', grade='vip', meta={'weekly_reco_day': 2}),
            member(id='b', grade='vip', meta={}),
            member(id='c', grade='royal', meta={'weekly_reco_day': None}),
            member(id='d', grade='free', meta={}),
        ])
        dist, missing_paid = mig.weekday_report(members)
        self.assertEqual(missing_paid, 2, '유료 2명이 요일 미설정이어야 한다')
        self.assertEqual(dist['화(2)'], 1)
        self.assertEqual(dist['미설정'], 3)

    def test_전원_요일이_있으면_경고하지_않는다(self):
        members = self.build([
            member(id='a', grade='vip', meta={'weekly_reco_day': 2}),
            member(id='b', grade='goldp', meta={'weekly_reco_day': 2}),
        ])
        _, missing_paid = mig.weekday_report(members)
        self.assertEqual(missing_paid, 0)

    def test_무료회원_미설정은_경고_대상이_아니다(self):
        """무료는 기본 금요일로 폴백되므로 발송이 끊기지 않는다."""
        members = self.build([member(id='f', grade='free', meta={})])
        _, missing_paid = mig.weekday_report(members)
        self.assertEqual(missing_paid, 0)

    def test_요일값은_요일이름과_함께_보여준다(self):
        members = self.build([member(id='a', grade='vip', meta={'weekly_reco_day': 5})])
        dist, _ = mig.weekday_report(members)
        self.assertIn('금(5)', dist)

    def test_잘못된_요일값은_미설정으로_센다(self):
        members = self.build([
            member(id='a', grade='vip', meta={'weekly_reco_day': 9}),
            member(id='b', grade='vip', meta={'weekly_reco_day': '2'}),
        ])
        dist, missing_paid = mig.weekday_report(members)
        self.assertEqual(dist['미설정'], 2)
        self.assertEqual(missing_paid, 2)

    def test_미설정이_있으면_report_가_경고를_찍는다(self):
        import io
        from contextlib import redirect_stdout

        built = mig.build([member(grade='vip', meta={})], [], [], BATCH)
        out = io.StringIO()
        with redirect_stdout(out):
            mig.report(built)
        self.assertIn('발송요일이 없다', out.getvalue())
        self.assertIn('임의로 채우지 말 것', out.getvalue())


class NoPiiInOutput(unittest.TestCase):
    """출력은 건수·집계만이어야 한다. 이름·전화번호가 화면이나 로그에 찍히면 안 된다."""

    def test_report_는_이름과_전화번호를_찍지_않는다(self):
        import io
        from contextlib import redirect_stdout

        built = mig.build([member(name='홍길동', phone='01012345678')], [], [], BATCH)
        out = io.StringIO()
        with redirect_stdout(out):
            mig.report(built)
        printed = out.getvalue()
        self.assertNotIn('홍길동', printed)
        self.assertNotIn('01012345678', printed)
        self.assertIn('회원', printed)

    def test_스크립트가_회원_컬럼을_그대로_출력하지_않는다(self):
        source = SCRIPT.read_text(encoding='utf-8')
        # print 문에 name/phone 을 직접 끼워 넣는 코드가 없어야 한다.
        for banned in ("print(f'{row['name']", "print(row['phone']", "print(row)"):
            self.assertNotIn(banned, source)


if __name__ == '__main__':
    unittest.main(verbosity=2)
