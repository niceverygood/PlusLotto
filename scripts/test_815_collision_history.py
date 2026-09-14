import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('collision_history_test',ROOT/'scripts/run-815-collision-history.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
class HistoryTests(unittest.TestCase):
    def test_count_uses_both_index_bounds_and_exact_family_like_read_only(self):
        client=object.__new__(m.ScopedClient)
        for table in m.EXPECTED:
            with self.subTest(table=table),patch.object(client,'request',return_value=([{'legacy_idx':1}],123)) as request:
                self.assertEqual(client.count(table),123)
            self.assertEqual(request.call_args.args,(table,[('select','legacy_idx'),
                ('import_batch','gte.lotto815-hist-collision-20260914'),
                ('import_batch','lt.lotto815-hist-collision-20260915'),
                ('import_batch','like.lotto815-hist-collision-20260914-*'),('limit','1')]))
            self.assertEqual(request.call_args.kwargs,{'count':True})
    def test_count_requires_exact_nonnegative_integer_and_limit_shape(self):
        client=object.__new__(m.ScopedClient)
        for rows,total in (([],None),([],False),([],0.0),([],"0"),([],-1),([],1),([{'legacy_idx':1}],0)):
            with self.subTest(total=total),patch.object(client,'request',return_value=(rows,total)),self.assertRaises(m.r.Stop):client.count('legacy_member_sms')
        with patch.object(client,'request',return_value=([],0)):self.assertEqual(client.count('legacy_member_sms'),0)
        with patch.object(client,'request') as request,self.assertRaises(m.r.Stop):client.count('members')
        request.assert_not_called()
    def test_count_keeps_unexpected_suffixes_and_sites_in_same_like_family(self):
        client=object.__new__(m.ScopedClient)
        batches=[m.PREFIX+'sms-00001',m.PREFIX+'unexpected-extra',m.PREFIX,
                 'lotto815-hist-collision-20260914other',
                 'lotto815-hist-collision-20260913-sms-00001',
                 'lotto815-hist-collision-20260915-sms-00001','lotto815-hist-20260910-sms-00001']
        def request(table,query,**kwargs):
            predicates=[value for key,value in query if key=='import_batch']
            lower=next(value[4:] for value in predicates if value.startswith('gte.'))
            upper=next(value[3:] for value in predicates if value.startswith('lt.'))
            like=next(value[5:-1] for value in predicates if value.startswith('like.') and value.endswith('*'))
            matches=[batch for batch in batches if lower<=batch<upper and batch.startswith(like)]
            self.assertFalse(any(key=='source_site' for key,_ in query))
            self.assertEqual(kwargs,{'count':True})
            return ([{'legacy_idx':1}] if matches else []),len(matches)
        with patch.object(client,'request',side_effect=request):self.assertEqual(client.count('legacy_member_sms'),3)
    def test_cohort_counts_exclude_original19021(self):
        self.assertEqual(sum(m.EXPECTED.values()),282602)
        self.assertNotEqual(m.PREFIX,'lotto815-hist-20260910-')
    def test_member_read_is_collision_scope_only(self):
        calls=[]
        class Base:
            def select_all(self,table,columns,filters):
                calls.append((table,filters));return [{'id':'member1','meta':{'legacy_idx':1,'reco_paused':True,'reco_pause_reason':'legacy_import_review','legacy_consent_review_required':True}}]
        client=object.__new__(m.ScopedClient);client.base=Base();client.verify_members({'1':'member1'})
        self.assertIn(('meta->>import_batch','like.lotto815-collision-20260914-*'),calls[0][1])
    def test_scope_rejects_wrong_member_key_or_missing_hold(self):
        class Base:
            def select_all(self,*args):return [{'id':'other','meta':{'legacy_idx':1,'reco_paused':False}}]
        client=object.__new__(m.ScopedClient);client.base=Base()
        with self.assertRaises(m.r.Stop):client.verify_members({'1':'member1'})
    def test_preparation_cannot_start_before_complete_member_batches(self):
        class Client:
            def __init__(self,*args):pass
            def batch(self,*args):return {'members':[],'payments':[]}
        with patch.object(m.c,'Client',Client),patch.object(m.c,'verify_actual',return_value='empty'):
            with self.assertRaisesRegex(m.c.Stop,'members_not_complete'):m.verify_applied(None,{'batches':[{'batch':'test'}]},[{}])
    def test_completed_history_prefix_never_reused(self):
        v={'stage':'prepared_offline_only','held_records':{'rows':0},'format_version':1,'source_archive_sha256':m.c.ARCHIVE_SHA,'target_manifest_sha256':'x','target_member_count':2666,'import_batch_prefix':'lotto815-hist-20260910-','tables':{}}
        with patch.object(m.r,'read_private',return_value=v):
            with self.assertRaisesRegex(m.r.Stop,'manifest_scope'):m.load_history_manifest('x',m.r.digest(v))
if __name__=='__main__':unittest.main()
