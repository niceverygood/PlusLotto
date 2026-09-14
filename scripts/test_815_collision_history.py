import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('collision_history_test',ROOT/'scripts/run-815-collision-history.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
class HistoryTests(unittest.TestCase):
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
