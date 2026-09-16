"""Synthetic source records only; no filesystem fixtures, DB, or network calls."""
import copy
import unittest
import uuid

from legacy_815_history_payload import InvalidHistory, history_insert_payload, stable_member_id


class HistoryPayloadTests(unittest.TestCase):
    def record(self, site='cplotto', table='userMemo'):
        values = {'idx': '10', 'userIdx': '1', 'insertDateTime': "'2026-08-01 09:00:00'",
                  'updateDateTime': 'NULL'}
        key = [10]
        if table == 'userMemo':
            values.update(contents="'synthetic memo'", groupTeamOpenYN="'N'")
        elif table == 'pushSms':
            values.update(contentsTypeCode="'autoPick'", contents="'synthetic recommendation'",
                          subject="'numbers'", **{'from': "'01011112222'", 'to': "'01033334444'"})
        else:
            key.append(1200)
            values.update(num='1200', pickStr="'1|2|3|4|5|6'", grade='5', prize='5000')
        return {'source_site': site, 'source_table': table, 'historical_only': True,
                'source_values_encoding': 'mysql_dump_tokens_not_decoded', 'source_sql_values': values,
                'source_user_idx': 1, 'target_member_id': stable_member_id(1, site),
                'legacy_key': key, 'body_policy': 'body_preserved'}

    def convert(self, record, expected=None):
        return history_insert_payload(record, archive_sha256='a' * 64, import_batch='synthetic-cplotto',
                                      expected_members=expected or {1: record['target_member_id']})

    def test_same_source_key_is_independent_across_sites_and_815_default_is_unchanged(self):
        original = 'mem_' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'https://lotto-plus.co.kr/legacy/member/lotto815/1'))
        self.assertEqual(stable_member_id(1), original)
        self.assertNotEqual(stable_member_id(1, 'cplotto'), original)
        for table in ('userMemo', 'pushSms', 'gameBettingNlotto'):
            for site in ('lotto815', 'cplotto'):
                record = self.record(site, table)
                before = copy.deepcopy(record)
                _, row = self.convert(record)
                self.assertEqual(row['source_site'], site)
                self.assertEqual(row['member_id'], stable_member_id(1, site))
                self.assertEqual(row['source_user_idx'], '1')
                self.assertEqual(row['legacy_idx'], '10')
                self.assertEqual(record, before)

    def test_wrong_source_or_target_cannot_relabel_815_history_as_cplotto(self):
        record = self.record()
        for site in ('pluslotto', 'infolotto', '', None, []):
            wrong = dict(record, source_site=site)
            with self.subTest(site=site), self.assertRaises(InvalidHistory):
                self.convert(wrong)
        for wrong in (dict(record, target_member_id=stable_member_id(1)),
                      dict(record, source_user_idx=2), dict(record, legacy_key=[11])):
            with self.assertRaises(InvalidHistory):
                self.convert(wrong)
        with self.assertRaises(InvalidHistory):
            self.convert(record, {1: stable_member_id(1)})
        with self.assertRaises(InvalidHistory):
            stable_member_id(1, 'infolotto')

    def test_cplotto_credential_and_unreviewed_sms_bodies_are_still_omitted(self):
        cases = [('userPwMofiy', 'text', 'credential_type_omitted'),
                 ('admin', 'text', 'unreviewed_type_omitted'),
                 ('thankCharge', 'text', 'unreviewed_type_omitted'),
                 ('autoPick', 'password = secret', 'credential_pattern_omitted')]
        for contents_type, body, policy in cases:
            record = self.record(table='pushSms')
            record['source_sql_values'].update(contentsTypeCode=repr(contents_type), contents=repr(body))
            _, row = self.convert(record)
            self.assertEqual(row['body_policy'], policy)
            for field in ('body', 'subject', 'from_phone', 'to_phone'):
                self.assertNotIn(field, row)

    def test_removed_wins_keep_original_status_and_composite_key(self):
        record = self.record(table='gameBettingNlotto')
        record['source_sql_values']['statCode'] = "'remove'"
        _, row = self.convert(record)
        self.assertEqual((row['source_status'], row['round_no'], row['rank'], row['prize']),
                         ('remove', 1200, 5, '5000'))
        self.assertEqual(row['numbers'], [1, 2, 3, 4, 5, 6])


if __name__ == '__main__':
    unittest.main()
