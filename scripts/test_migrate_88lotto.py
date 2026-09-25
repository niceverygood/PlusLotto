#!/usr/bin/env python3
"""migrate-88lotto.py 판정 규칙 단위 테스트 (DB 비접속).

가장 중요한 회귀는 **2차 실행이 조합발송 보류 상태를 건드리지 않는가**이다.
이게 깨지면 둘 중 하나가 조용히 일어난다 — 검수를 마치고 해제한 회원이 다시 잠겨
문자가 끊기거나, 아직 검수하지 않은 회원의 잠금이 풀려 문자가 나간다. 둘 다 화면상
정상으로 보이고, 회원이 알려주기 전까지 드러나지 않는다.

두 번째는 **번호 충돌을 INSERT 로 시도하지 않는가**이다. members INSERT 는 같은 번호가
있으면 트리거가 거부하고 200행 묶음이 통째로 실패한다 — 이관 당일에 처음 겪으면 안 된다.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('migrate-88lotto.py')
SPEC = importlib.util.spec_from_file_location('migrate_88lotto', SCRIPT)
tool = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = tool
SPEC.loader.exec_module(tool)

BATCH = 'lotto88-20261012'


def src_member(**over):
    """88 쪽의 평범한 유료회원(화요일 발송)."""
    base = {
        'id': '88-aaa', 'user_id': 'kim88', 'name': '김팔팔', 'nickname': None,
        'phone': '01012345678', 'grade': 'goldp', 'status': 'active',
        'assigned_staff_id': 's88', 'team_id': 't88',
        'is_suspended': False, 'is_deleted': False, 'is_withdrawn': False,
        'registered_at': '2026-01-02T00:00:00Z', 'last_active_at': None,
        'meta': {'weekly_reco_day': 2, 'weekly_reco_count': 5, 'end_date': '2026-12-31'},
    }
    meta = {**base['meta'], **over.pop('meta', {})}
    return {**base, **over, 'meta': meta}


def dest_imported(**over):
    """1차 이관으로 플러스로또에 이미 들어간 같은 회원."""
    row, _ = tool.build_member(src_member(), BATCH, {}, {})
    assert row is not None
    meta = {**row['meta'], **over.pop('meta', {})}
    return {**row, **over, 'meta': meta}


class BuildMember(unittest.TestCase):
    def test_이관_회원은_조합발송_보류로_들어간다(self):
        row, _ = tool.build_member(src_member(), BATCH, {}, {})
        self.assertTrue(row['meta']['reco_paused'])
        self.assertEqual(row['meta']['reco_pause_reason'], tool.IMPORT_HOLD)
        self.assertEqual(row['meta']['source_site'], 'lotto88')

    def test_발송요일과_갯수는_원본_그대로_옮긴다(self):
        row, _ = tool.build_member(src_member(), BATCH, {}, {})
        self.assertEqual(row['meta']['weekly_reco_day'], 2)
        self.assertEqual(row['meta']['weekly_reco_count'], 5)
        self.assertEqual(row['meta']['end_date'], '2026-12-31')

    def test_같은_원본_id는_항상_같은_대상_id가_된다(self):
        first, _ = tool.build_member(src_member(), BATCH, {}, {})
        second, _ = tool.build_member(src_member(name='이름만 바뀜'), BATCH, {}, {})
        self.assertEqual(first['id'], second['id'])

    def test_담당자와_팀은_맞춘_것만_넣고_못_맞추면_비운다(self):
        mapped, _ = tool.build_member(src_member(), BATCH, {'s88': 'staff_1'}, {'t88': 'team_1'})
        self.assertEqual(mapped['assigned_staff_id'], 'staff_1')
        self.assertEqual(mapped['team_id'], 'team_1')
        unmapped, _ = tool.build_member(src_member(), BATCH, {}, {})
        self.assertIsNone(unmapped['assigned_staff_id'])
        self.assertIsNone(unmapped['team_id'])

    def test_등급_상태_번호_가입일이_이상하면_제외한다(self):
        for over, word in (({'grade': 'platinum'}, '등급'), ({'status': 'zombie'}, '상태'),
                           ({'phone': '02-123-4567'}, '휴대폰'), ({'registered_at': None}, '가입일시')):
            row, reason = tool.build_member(src_member(**over), BATCH, {}, {})
            self.assertIsNone(row, over)
            self.assertIn(word, reason)


class DeltaSync(unittest.TestCase):
    def test_2차는_보류_해제를_되돌리지_않는다(self):
        """검수를 마치고 해제한 회원이 2차 실행으로 다시 잠기면 문자가 조용히 끊긴다."""
        released = dest_imported(meta={'reco_paused': False, 'reco_pause_reason': None})
        incoming, _ = tool.build_member(src_member(grade='vip'), BATCH, {}, {})
        patch = tool.member_changes(released, incoming)
        self.assertEqual(patch['grade'], 'vip')
        self.assertNotIn('meta', patch)  # 등급만 바뀌었으니 meta 는 건드릴 이유가 없다

    def test_meta_를_바꿔야_할_때도_보류_상태는_대상_값을_지킨다(self):
        released = dest_imported(meta={'reco_paused': False, 'reco_pause_reason': None})
        incoming, _ = tool.build_member(src_member(meta={'weekly_reco_day': 4}), BATCH, {}, {})
        patch = tool.member_changes(released, incoming)
        self.assertEqual(patch['meta']['weekly_reco_day'], 4)
        self.assertFalse(patch['meta']['reco_paused'])
        self.assertIsNone(patch['meta']['reco_pause_reason'])

    def test_변동이_없으면_갱신하지_않는다(self):
        self.assertEqual(tool.member_changes(dest_imported(), dest_imported()), {})

    def test_담당자_상담상태_메모는_따라가지_않는다(self):
        """이관 후 플러스로또에서 운영진이 손댄 값을 88 쪽 값으로 되돌리면 안 된다."""
        for column in ('assigned_staff_id', 'consult_status', 'memo', 'team_id', 'inflow_code'):
            self.assertNotIn(column, tool.MEMBER_SYNC_COLUMNS)

    def test_정지_탈퇴_전환은_따라간다(self):
        incoming, _ = tool.build_member(src_member(status='withdrawn', is_withdrawn=True), BATCH, {}, {})
        patch = tool.member_changes(dest_imported(), incoming)
        self.assertEqual(patch['status'], 'withdrawn')
        self.assertTrue(patch['is_withdrawn'])


class PhoneCollision(unittest.TestCase):
    def test_이미_있는_번호는_넣지_않고_충돌로_보고한다(self):
        existing = [{'id': 'mem_old', 'phone': '010-1234-5678', 'meta': {}}]
        plan = tool.build_plan([src_member()], [], [], existing, set(), {}, {}, BATCH)
        self.assertEqual(plan.new_members, [])
        self.assertEqual(len(plan.collisions), 1)
        self.assertEqual(plan.collisions[0]['existing_member_id'], 'mem_old')

    def test_원본_안에서_번호가_겹쳐도_한_명만_넣는다(self):
        pair = [src_member(id='88-a'), src_member(id='88-b')]
        plan = tool.build_plan(pair, [], [], [], set(), {}, {}, BATCH)
        self.assertEqual(len(plan.new_members), 1)
        self.assertEqual(len(plan.collisions), 1)

    def test_이미_이관된_회원은_번호_충돌로_잘못_세지_않는다(self):
        """자기 자신이 대상에 있다고 충돌 처리하면 2차 실행이 통째로 막힌다."""
        plan = tool.build_plan([src_member()], [], [], [dest_imported()], set(), {}, {}, BATCH)
        self.assertEqual(plan.collisions, [])
        self.assertEqual(plan.unchanged, 1)


class Payments(unittest.TestCase):
    def _payment(self, **over):
        base = {'id': 'pay-1', 'member_id': '88-aaa', 'product_id': 'prod-1', 'amount': 198000,
                'method': 'bank', 'status': 'approved', 'paid_at': '2026-02-01T00:00:00Z'}
        return {**base, **over}

    def test_결제는_회원과_상품에_연결되어_들어간다(self):
        plan = tool.build_plan([src_member()], [self._payment()],
                               [{'id': 'prod-1', 'name': '88 골드', 'price': 198000,
                                 'duration_months': 18, 'grade_granted': 'goldp'}],
                               [], set(), {}, {}, BATCH)
        self.assertEqual(len(plan.new_payments), 1)
        self.assertEqual(plan.new_payments[0]['member_id'], plan.new_members[0]['id'])
        self.assertEqual(plan.new_payments[0]['product_id'], plan.products[0]['id'])

    def test_회원이_안_들어가면_결제도_넣지_않는다(self):
        """고아 결제는 FK 로 막히거나, 막히지 않으면 매출이 엉뚱하게 잡힌다."""
        existing = [{'id': 'mem_old', 'phone': '01012345678', 'meta': {}}]
        plan = tool.build_plan([src_member()], [self._payment()], [], existing, set(), {}, {}, BATCH)
        self.assertEqual(plan.new_payments, [])
        self.assertEqual(len(plan.skipped_payments), 1)

    def test_이미_옮긴_결제는_다시_넣지_않는다(self):
        already = tool.stable_id('payment', 'pay-1')
        plan = tool.build_plan([src_member()], [self._payment()], [], [], {already}, {}, {}, BATCH)
        self.assertEqual(plan.new_payments, [])

    def test_이관_상품은_신규_결제_선택지에_노출하지_않는다(self):
        built = tool.build_product({'id': 'prod-1', 'name': '88 골드', 'price': 1,
                                    'duration_months': 18, 'grade_granted': 'goldp'})
        self.assertFalse(built['is_active'])


class StaffMapping(unittest.TestCase):
    def test_로그인아이디로_맞추고_없으면_이름으로_맞춘다(self):
        mapping = tool.build_staff_map(
            [{'id': 's1', 'login_id': 'kim', 'name': '김담당'},
             {'id': 's2', 'login_id': 'none', 'name': '박담당'}],
            [{'id': 'p1', 'login_id': 'KIM', 'name': '다른이름'},
             {'id': 'p2', 'login_id': 'park', 'name': '박담당'}])
        self.assertEqual(mapping, {'s1': 'p1', 's2': 'p2'})

    def test_동명이인은_이름으로_맞추지_않는다(self):
        """엉뚱한 담당자에게 회원이 붙으면 매출 귀속까지 틀어진다. 비워 두는 편이 낫다."""
        mapping = tool.build_staff_map(
            [{'id': 's1', 'login_id': 'x', 'name': '김담당'}],
            [{'id': 'p1', 'login_id': 'a', 'name': '김담당'},
             {'id': 'p2', 'login_id': 'b', 'name': '김담당'}])
        self.assertEqual(mapping, {})


class ReadOnly(unittest.TestCase):
    def test_원본_클라이언트는_쓰기를_거부한다(self):
        client = tool.Supa('https://example.invalid', 'k', allow_writes=False)
        with self.assertRaises(RuntimeError):
            client._req('POST', 'members', [{'id': 'x'}])


if __name__ == '__main__':
    unittest.main(verbosity=2)
