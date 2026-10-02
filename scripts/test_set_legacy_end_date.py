#!/usr/bin/env python3
"""set-legacy-end-date.py 규칙 단위 테스트 (DB 비접속).

가장 중요한 회귀는 **종료일을 앞당기는 회원을 기본으로 건드리지 않는가**이다. 이미 낸 이용기간을
줄이면 조합발송이 조기에 끊기고, 회원이 알려주기 전까지 드러나지 않는다.
두 번째는 **결제 시각을 한국 날짜로 바꿔 계산하는가**이다. UTC 그대로 쓰면 자정 전후 결제가
하루씩 어긋난다.
"""

import csv
import importlib.util
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

SCRIPT = Path(__file__).with_name('set-legacy-end-date.py')
SPEC = importlib.util.spec_from_file_location('set_legacy_end_date', SCRIPT)
tool = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = tool
SPEC.loader.exec_module(tool)


def member(member_id='m1', end_date='2027-02-01', **meta):
    return {'id': member_id, 'name': '홍길동', 'grade': 'goldp',
            'meta': {'source_site': 'lotto815', 'legacy_idx': 7, 'reco_paused': False,
                     'weekly_reco_day': 2, 'end_date': end_date, **meta}}


def paid(member_id='m1', at='2025-06-10T03:00:00+00:00', status='approved'):
    return {'member_id': member_id, 'paid_at': at, 'status': status}


class Shorten(unittest.TestCase):
    def test_종료일이_앞당겨지는_회원은_기본으로_반영하지_않는다(self):
        rows = tool.build_changes([member(end_date='2029-01-01')], [paid()], 27, 'latest')
        self.assertEqual(rows[0]['kind'], tool.SHORTEN)
        self.assertFalse(tool.should_apply(rows[0], allow_shorten=False))
        self.assertTrue(tool.should_apply(rows[0], allow_shorten=True))

    def test_요약은_단축을_반영대상에서_뺀다(self):
        rows = tool.build_changes(
            [member('a', '2029-01-01'), member('b', '2026-01-01'), member('c', None)],
            [paid('a'), paid('b'), paid('c')], 27, 'latest')
        counts = tool.summarize(rows, allow_shorten=False)
        self.assertEqual((counts[tool.SHORTEN], counts[tool.EXTEND], counts[tool.NEW]), (1, 1, 1))
        self.assertEqual(counts['반영대상'], 2)


class Dates(unittest.TestCase):
    def test_결제_시각은_한국_날짜로_바꾼다(self):
        # UTC 3/31 15:30 = 한국 4/1 00:30 — UTC 날짜로 계산하면 하루 빨라진다.
        self.assertEqual(tool.kst_date('2025-03-31T15:30:00+00:00'), date(2025, 4, 1))
        self.assertEqual(tool.kst_date('2025-03-31T15:30:00Z'), date(2025, 4, 1))
        self.assertEqual(tool.kst_date('2025-03-31T14:59:59+00:00'), date(2025, 3, 31))

    def test_27개월은_말일을_넘지_않는다(self):
        self.assertEqual(tool.add_months(date(2025, 6, 10), 27), date(2027, 9, 10))
        self.assertEqual(tool.add_months(date(2025, 11, 30), 27), date(2028, 2, 29))  # 윤년 말일
        self.assertEqual(tool.add_months(date(2024, 11, 30), 27), date(2027, 2, 28))
        self.assertEqual(tool.add_months(date(2025, 1, 31), 1), date(2025, 2, 28))

    def test_기준일은_가장_최근_승인_결제다(self):
        payments = [paid(at='2024-01-05T00:00:00Z'), paid(at='2025-06-10T00:00:00Z'),
                    paid(at='2026-01-01T00:00:00Z', status='cancelled')]
        self.assertEqual(tool.basis_dates(payments, 'latest')['m1'], date(2025, 6, 10))
        self.assertEqual(tool.basis_dates(payments, 'first')['m1'], date(2024, 1, 5))

    def test_승인_결제가_없으면_건드리지_않는다(self):
        rows = tool.build_changes([member()], [paid(status='failed')], 27, 'latest')
        self.assertEqual(rows[0]['kind'], tool.NO_PAYMENT)
        self.assertFalse(tool.should_apply(rows[0], allow_shorten=True))


class Meta(unittest.TestCase):
    def test_다른_meta_키는_지키고_이전_종료일을_남긴다(self):
        out = tool.patched_meta(member(), date(2027, 9, 10), 'rule')
        self.assertEqual(out['end_date'], '2027-09-10')
        self.assertEqual(out['end_date_before'], '2027-02-01')
        self.assertFalse(out['reco_paused'])
        self.assertEqual(out['weekly_reco_day'], 2)

    def test_두_번_돌려도_최초_종료일을_잃지_않는다(self):
        once = tool.patched_meta(member(), date(2027, 9, 10), 'rule')
        twice = tool.patched_meta({'meta': once}, date(2027, 10, 1), 'rule')
        self.assertEqual(twice['end_date_before'], '2027-02-01')

    def test_같은_규칙을_다시_돌리면_변경이_없다(self):
        rows = tool.build_changes([member(end_date='2027-09-10')], [paid()], 27, 'latest')
        self.assertEqual(rows[0]['kind'], tool.SAME)


class Output(unittest.TestCase):
    def test_변경안_CSV_는_엑셀이_읽고_반영_여부를_표시한다(self):
        rows = tool.build_changes([member('a', '2029-01-01'), member('b', '2026-01-01')],
                                  [paid('a'), paid('b')], 27, 'latest')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'out.csv'
            tool.write_csv(path, rows, allow_shorten=False)
            self.assertTrue(path.read_bytes().startswith(b'\xef\xbb\xbf'))
            with path.open(encoding='utf-8-sig') as handle:
                got = {r['회원ID']: r for r in csv.DictReader(handle)}
        self.assertEqual((got['a']['구분'], got['a']['반영']), (tool.SHORTEN, ''))
        self.assertEqual((got['b']['구분'], got['b']['반영'], got['b']['등급']), (tool.EXTEND, 'O', '실버'))


class ReadOnly(unittest.TestCase):
    def test_변경안_모드는_쓰기를_거부한다(self):
        with self.assertRaises(RuntimeError):
            tool.Supa('https://example.invalid', 'k', allow_writes=False)._req('PATCH', 'members', {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
