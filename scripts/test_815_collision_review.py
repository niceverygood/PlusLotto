import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('collision_test_subject',ROOT/'scripts/run-815-collision-review.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)

def fixture():
    rows=[]
    for idx,status in ((1,'deleted'),(2,'withdrawn')):
        rows.append({'id':m.loader.stable_id('member','lotto815',idx),'user_id':f'legacy-{idx}','phone':'01000000000','status':status,'is_suspended':False,'is_deleted':status=='deleted','is_withdrawn':status=='withdrawn','meta':{'legacy_idx':idx,'source_site':'lotto815','import_batch':m.batch_name(1),'reco_paused':True,'reco_pause_reason':'legacy_import_review','legacy_consent_review_required':True,'legacy_agree_sms_yn':'N','legacy_account_flags':{k:'N' for k in m.review.ACCOUNT_REVIEW_FIELDS},'weekly_reco_count':0,'legacy_member_start_datetime':'0000-00-00 00:00:00','legacy_member_end_datetime':'0000-00-00 00:00:00'}})
    data={'members':rows,'payments':[],'products':[]}
    return data,descriptor(data)
def descriptor(data):return {'index':1,'batch':m.batch_name(1),'file':'batch-001.json','members':len(data['members']),'payments':len(data['payments']),'amount':sum(r['amount'] for r in data['payments']),'payload_sha256':m.digest(data)}

class CollisionTests(unittest.TestCase):
    def test_two_inactive_source_keys_are_preserved_on_same_phone(self):
        data,d=fixture();m.validate_unit(data,d)
        self.assertEqual(len({r['id'] for r in data['members']}),2)
    def test_same_user_or_source_id_rejected(self):
        for field in ('id','user_id'):
            data,d=fixture();data['members'][1][field]=data['members'][0][field]
            with self.assertRaises(m.Stop):m.validate_unit(data,descriptor(data))
    def test_operator_flags_or_hold_removal_rejected(self):
        for field,value in [('reco_paused',False),('legacy_consent_review_required',False),('legacy_account_flags',{})]:
            data,d=fixture();data['members'][0]['meta'][field]=value
            with self.assertRaises(m.Stop):m.validate_unit(data,descriptor(data))
    def test_source_reuse_rejected_but_phone_allowed(self):
        data,d=fixture();peer={'id':'native-1','user_id':'native-login','phone':'01000000000','source_site':None,'legacy_idx':None}
        m.verify_conflicts([data],[peer],[])
        peer['source_site']='lotto815';peer['legacy_idx']='1'
        with self.assertRaisesRegex(m.Stop,'identity_conflict'):m.verify_conflicts([data],[peer],[])
    def test_cross_batch_source_duplicates_rejected(self):
        data,d=fixture()
        with self.assertRaises(m.Stop):m.verify_conflicts([data,data],[],[])
    def test_partial_batch_and_full_row_change_rejected(self):
        data,d=fixture();actual={'members':[{**m.DEFAULTS['members'],**r} for r in data['members']],'payments':[]}
        self.assertEqual(m.verify_actual(actual,data,d),'complete')
        actual['members'][0]['meta']=dict(actual['members'][0]['meta'],weekly_recos=[])
        with self.assertRaises(m.Stop):m.verify_actual(actual,data,d)
        with self.assertRaises(m.Stop):m.verify_actual({'members':actual['members'][:1],'payments':[]},data,d)
    def test_member_payment_links_rejected(self):
        data,d=fixture();data['payments']=[{'id':m.loader.stable_id('payment','lotto815',1),'member_id':'other','amount':1,'status':'approved','product_id':'x','meta':{'legacy_idx':1,'source_site':'lotto815','import_batch':m.batch_name(1)}}]
        with self.assertRaises(m.Stop):m.validate_unit(data,descriptor(data))
    def test_pilot_size_limit(self):
        data,d=fixture();data['members']*=6
        with self.assertRaises(m.Stop):m.validate_unit(data,descriptor(data))
    def test_private_create_never_overwrites_fence(self):
        with tempfile.TemporaryDirectory() as dirname:
            path=Path(dirname).resolve()/'attempt.json';m.save_new(path,{'attempt':1})
            with self.assertRaises(FileExistsError):m.save_new(path,{'attempt':2})
            self.assertEqual(m.read(path),{'attempt':1})
    def test_write_rpc_disabled_by_default_and_retry_fenced(self):
        client=object.__new__(m.Client);client.url=m.pilot.PROJECT_URL;client.key='test';client.allow_writes=False;client.attempted=set()
        with patch.object(m.pilot,'request_json') as http:
            with self.assertRaises(m.Stop):client.rpc('admin_import_815_collision_batch',{'p_batch_id':'unit'})
            http.assert_not_called()
            client.allow_writes=True;http.side_effect=TimeoutError()
            with self.assertRaises(TimeoutError):client.rpc('admin_import_815_collision_batch',{'p_batch_id':'unit'})
            with self.assertRaises(m.Stop):client.rpc('admin_import_815_collision_batch',{'p_batch_id':'unit'})
            self.assertEqual(http.call_count,1)
    def test_generic_insert_and_sms_rpc_forbidden(self):
        client=object.__new__(m.Client);client.url=m.pilot.PROJECT_URL
        with self.assertRaises(m.Stop):client._req('POST','members',[])
        with self.assertRaises(m.Stop):client.rpc('send_sms',{})
    def test_ambiguous_rpc_is_observed_and_never_replayed(self):
        for committed in (True,False):
            with self.subTest(committed=committed),tempfile.TemporaryDirectory() as dirname:
                root=Path(dirname).resolve();data,d=fixture();baseline={'members':[],'payments':[]}
                manifest={'batches':[d],'protected_member_ids':[],'protected_sha256':m.snapshot_digest(baseline),'settings_sha256':m.digest([]),'side_effects_expected':{'sms_sends':0,'bets':0,'assignments':0}}
                for name,value in [('manifest.json',manifest),('batch-001.json',data),('protected-baseline.json',baseline),('products-baseline.json',[])]:m.save_new(root/name,value)
                state={'calls':0,'actual':copy.deepcopy(baseline)}
                class FakeClient:
                    def __init__(self,*args):pass
                    def protected(self,*args):return copy.deepcopy(baseline)
                    def by_ids(self,*args):return []
                    def select_all(self,*args):return []
                    def batch(self,*args):return state['actual']
                    def hold(self,*args):return {}
                    def identifiers(self):return [],[]
                    def side_effects(self,*args):return manifest['side_effects_expected']
                    def apply_unit(self,data,descriptor):
                        state['calls']+=1
                        if committed:state['actual']={'members':[{**m.DEFAULTS['members'],**r} for r in data['members']],'payments':[]}
                        raise TimeoutError()
                with patch.object(m,'PRIVATE',root),patch.object(m,'Client',FakeClient),patch.object(m,'verify_manifest'),patch.object(m,'file_sha',return_value=m.ARCHIVE_SHA):
                    self.assertEqual(m.execute(None,m.digest(manifest),True,False,1),1)
                    self.assertEqual(m.execute(None,m.digest(manifest),True,False,1),0 if committed else 1)
                self.assertEqual(state['calls'],1)
    def test_all_apply_requires_completed_pilot(self):
        with tempfile.TemporaryDirectory() as dirname:
            root=Path(dirname).resolve();data,d=fixture();baseline={'members':[],'payments':[]}
            manifest={'batches':[d],'protected_member_ids':[],'protected_sha256':m.snapshot_digest(baseline),'settings_sha256':m.digest([]),'side_effects_expected':{'sms_sends':0,'bets':0,'assignments':0}}
            for name,value in [('manifest.json',manifest),('batch-001.json',data),('protected-baseline.json',baseline),('products-baseline.json',[])]:m.save_new(root/name,value)
            class FakeClient:
                def __init__(self,*args):pass
                def protected(self,*args):return baseline
                def by_ids(self,*args):return []
                def select_all(self,*args):return []
                def batch(self,*args):return baseline
            with patch.object(m,'PRIVATE',root),patch.object(m,'Client',FakeClient),patch.object(m,'verify_manifest'),patch.object(m,'file_sha',return_value=m.ARCHIVE_SHA):
                self.assertEqual(m.execute(None,m.digest(manifest),True,True),1)
            receipts=[m.read(p) for p in root.glob('*/receipt.json')]
            self.assertEqual(receipts[0]['reason_code'],'pilot_must_complete_before_all')
            self.assertEqual(receipts[0]['writes_attempted'],0)
    def test_postgres_fractional_timestamps_compared_exactly(self):
        actual={'created_at':'2026-09-14T00:00:00.12345+00:00'}
        expected={'created_at':'2026-09-14T09:00:00.123450+09:00'}
        self.assertEqual(m.canonical(actual,expected),m.canonical(expected,expected))
        changed={'created_at':'2026-09-14T00:00:00.12346+00:00'}
        self.assertNotEqual(m.canonical(changed,expected),m.canonical(expected,expected))
    def test_international_phone_equivalence(self):
        self.assertEqual({m.canonical_phone(p) for p in ('01000000000','+82 10 0000 0000','0082 10 0000 0000','8201000000000')},{'01000000000'})

if __name__=='__main__':unittest.main()
