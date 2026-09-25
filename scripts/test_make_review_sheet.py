#!/usr/bin/env python3
"""make-review-sheet.py 판정 규칙 단위 테스트 (DB 비접속).

가장 중요한 회귀는 **이관 검수 보류(legacy_import_review)를 해제된 것으로 보는가**이다.
이게 깨지면 대조표 전원이 '일시정지'로 나와 표가 통째로 쓸모없어지는데, 화면상으로는
정상 동작처럼 보여서 눈치채기 어렵다.
"""

import csv
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('make-review-sheet.py')
SPEC = importlib.util.spec_from_file_location('make_review_sheet', SCRIPT)
sheet = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = sheet
SPEC.loader.exec_module(sheet)

TODAY = '2026-10-05'


def member(**over):
    """검수 보류가 걸린 평범한 이관 유료회원(화요일 발송)."""
    base = {
        'id': 'm1', 'user_id': 'u1', 'name': '홍길동', 'phone': '01012345678',
        'grade': 'goldp', 'status': 'active', 'assigned_staff_id': 's1',
        'is_suspended': False, 'is_deleted': False, 'is_withdrawn': False,
        'meta': {
            'source_site': 'lotto815', 'legacy_idx': 101,
            'reco_paused': True, 'reco_pause_reason': 'legacy_import_review',
            'weekly_reco_day': 2, 'weekly_reco_count': 5, 'end_date': '2026-12-31',
        },
    }
    meta = {**base['meta'], **over.pop('meta', {})}
    return {**base, **over, 'meta': meta}


class SendPlan(unittest.TestCase):
    def test_이관_보류는_해제된_것으로_보고_발송으로_센다(self):
        verdict, _, day = sheet.send_plan(member(), TODAY)
        self.assertEqual(verdict, '발송')
        self.assertEqual(day, '화요일')

    def test_운영자가_건_일시정지는_그대로_제외한다(self):
        verdict, reason, _ = sheet.send_plan(
            member(meta={'reco_pause_reason': '고객요청'}), TODAY)
        self.assertEqual(verdict, '제외')
        self.assertIn('일시정지', reason)

    def test_정지_삭제_탈퇴는_제외한다(self):
        for flag in ('is_suspended', 'is_deleted', 'is_withdrawn'):
            verdict, _, _ = sheet.send_plan(member(**{flag: True}), TODAY)
            self.assertEqual(verdict, '제외', flag)

    def test_종료일은_당일까지_이용_가능하고_그_전날이면_만료다(self):
        same, _, _ = sheet.send_plan(member(meta={'end_date': TODAY}), TODAY)
        self.assertEqual(same, '발송')
        past, reason, _ = sheet.send_plan(member(meta={'end_date': '2026-10-04'}), TODAY)
        self.assertEqual(past, '제외')
        self.assertIn('종료일', reason)

    def test_유료회원은_요일이_없으면_제외되고_무료는_기본_금요일이다(self):
        verdict, _, _ = sheet.send_plan(member(meta={'weekly_reco_day': None}), TODAY)
        self.assertEqual(verdict, '제외')
        free, _, day = sheet.send_plan(
            member(grade='free', meta={'weekly_reco_day': None}), TODAY)
        self.assertEqual((free, day), ('발급만', '금요일'))

    def test_발송갯수_0은_제외한다(self):
        verdict, reason, _ = sheet.send_plan(member(meta={'weekly_reco_count': 0}), TODAY)
        self.assertEqual(verdict, '제외')
        self.assertIn('0', reason)

    def test_무료등급은_발급만이고_누락이_아니다(self):
        verdict, _, _ = sheet.send_plan(member(grade='free'), TODAY)
        self.assertEqual(verdict, '발급만')

    def test_유료인데_연락처가_없으면_제외한다(self):
        verdict, reason, _ = sheet.send_plan(member(phone=''), TODAY)
        self.assertEqual(verdict, '제외')
        self.assertIn('번호', reason)


class Issues(unittest.TestCase):
    def test_정상_회원은_점검항목이_없다(self):
        self.assertEqual(sheet.issues(member(), '발송', TODAY), [])

    def test_이관_보류는_점검항목으로_세지_않는다(self):
        """전원이 달고 있는 값이라 점검표에 올리면 수만 줄 허위가 된다."""
        self.assertEqual(sheet.issues(member(), '발송', TODAY), [])

    def test_유료회원의_결측은_각각_잡아낸다(self):
        found = sheet.issues(member(phone='', meta={'end_date': None,
                                                    'weekly_reco_day': None}), '제외', TODAY)
        self.assertEqual(len(found), 3)
        self.assertTrue(any('번호' in x for x in found))
        self.assertTrue(any('종료일이 없음' in x for x in found))
        self.assertTrue(any('요일' in x for x in found))

    def test_담당자_미배정을_잡아낸다(self):
        found = sheet.issues(member(assigned_staff_id=None), '발송', TODAY)
        self.assertEqual(found, ['담당자 미배정'])


class Output(unittest.TestCase):
    def test_요약은_발송_발급만_제외를_빠짐없이_센다(self):
        members = [member(), member(grade='free'), member(is_suspended=True)]
        rows = sheet.summarize('lotto815', members, 2, 50000, TODAY)
        got = {r['항목']: r['값'] for r in rows}
        self.assertEqual(got['전체 회원 수'], 3)
        self.assertEqual(got['조합문자 발송 대상'], 1)
        self.assertEqual(got['조합 발급만(무료)'], 1)
        self.assertEqual(got['발송 제외'], 1)
        self.assertEqual(got['결제 건수'], 2)
        self.assertEqual(got['결제 금액 합계'], 50000)
        # 세 구분의 합은 항상 전체와 같아야 한다 — 어긋나면 어딘가 빠뜨린 것이다.
        self.assertEqual(got['조합문자 발송 대상'] + got['조합 발급만(무료)'] + got['발송 제외'],
                         got['전체 회원 수'])

    def test_CSV_는_엑셀이_읽도록_BOM_을_붙인다(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'x.csv'
            sheet.write_csv(path, [{'이름': '홍길동', '연락처': '010'}], ['이름', '연락처'])
            self.assertTrue(path.read_bytes().startswith(b'\xef\xbb\xbf'))
            with path.open(encoding='utf-8-sig') as handle:
                self.assertEqual(list(csv.DictReader(handle))[0]['이름'], '홍길동')

    def test_회원_행은_읽을_수_있는_등급명을_쓴다(self):
        row = sheet.member_row(member(), '발송', '사유', '화요일', {'s1': '김담당'})
        self.assertEqual(row['등급'], '골드플러스')
        self.assertEqual(row['담당자'], '김담당')
        self.assertEqual(row['구전산번호'], 101)


class ReadOnly(unittest.TestCase):
    def test_대조표_클라이언트는_쓰기를_거부한다(self):
        client = sheet.Supa('https://example.invalid', 'k', allow_writes=False)
        with self.assertRaises(RuntimeError):
            client._req('POST', 'members', [{'id': 'x'}])


if __name__ == '__main__':
    unittest.main(verbosity=2)
