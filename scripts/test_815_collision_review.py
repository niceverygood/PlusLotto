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
def atomic_result(d,members=0,payments=0):
    return {'batch_id':d['batch'],'members':d['members'],'payments':d['payments'],'amount':d['amount'],'held_members':d['members'],'atomic':True,'protected_members':members,'protected_payments':payments,'existing_full_rows_unchanged':True}
def native_snapshot():
    return {'members':[{'id':'native-1','user_id':'native-user','phone':'01000000000','memo':'original','meta':{}}],
            'payments':[{'id':'native-pay-1','member_id':'native-1','amount':100,'status':'approved'}]}
def identities(snapshot):
    return [{'id':row['id'],'user_id':row['user_id'],'phone':row['phone'],'source_site':row.get('meta',{}).get('source_site'),'legacy_idx':str(row['meta']['legacy_idx']) if row.get('meta',{}).get('legacy_idx') is not None else None,'import_batch':row.get('meta',{}).get('import_batch')} for row in snapshot['members']]

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
    def test_scoped_phone_peer_rpc_is_one_read_call_without_write_permission(self):
        data,_=fixture();client=object.__new__(m.Client);client.url=m.pilot.PROJECT_URL;client.key='synthetic';client.allow_writes=False;client.attempted=set()
        client.configure_peer_scope([data]);response=identities(native_snapshot())+identities({'members':[data['members'][0]]})
        with patch.object(m.pilot,'request_json',return_value=(200,response)) as http,patch.object(client,'select_all') as full_scan:
            self.assertEqual(client.member_identifiers(),response)
        self.assertEqual(http.call_count,1);full_scan.assert_not_called()
        url,headers,body=http.call_args.args
        self.assertEqual(url,m.pilot.PROJECT_URL+'/rest/v1/rpc/'+m.PHONE_PEER_RPC)
        self.assertEqual(set(headers),{'apikey','Authorization','Content-Type'})
        self.assertEqual(body,{'p_phones':['01000000000'],'p_member_ids':sorted(row['id'] for row in data['members'])})
        self.assertEqual(client.attempted,set())
    def test_global_conflict_inventory_still_scans_members_and_payments_once(self):
        client=object.__new__(m.Client)
        with patch.object(client,'select_all',side_effect=[['all-members'],['all-payments']]) as full_scan,patch.object(client,'rpc') as rpc:
            self.assertEqual(client.identifiers(),(['all-members'],['all-payments']))
        self.assertEqual([call.args[0] for call in full_scan.call_args_list],['members','payments']);rpc.assert_not_called()
    def test_scope_requires_frozen_domestic_phones_and_member_ids_and_cannot_change(self):
        data,_=fixture();client=object.__new__(m.Client)
        with self.assertRaisesRegex(m.Stop,'scope_unset'):client.member_identifiers()
        client.configure_peer_scope([data])
        with self.assertRaisesRegex(m.Stop,'already_configured'):client.configure_peer_scope([data])
        for field,value in [('phone','+821000000000'),('phone',None),('id','arbitrary-id')]:
            changed=copy.deepcopy(data);changed['members'][0][field]=value
            with self.subTest(field=field,value=value),self.assertRaises(m.Stop):m.frozen_peer_scope([changed])
        client.url=m.pilot.PROJECT_URL;client.key='synthetic';client.allow_writes=False
        changed={'p_phones':['01000000001'],'p_member_ids':list(client.peer_scope[1])}
        with patch.object(m.pilot,'request_json') as http,self.assertRaisesRegex(m.Stop,'scope_changed'):client.rpc(m.PHONE_PEER_RPC,changed)
        http.assert_not_called()
    def test_phone_peer_arrays_over_2666_or_malformed_reject_before_network(self):
        data,_=fixture();client=object.__new__(m.Client);client.url=m.pilot.PROJECT_URL;client.configure_peer_scope([data])
        valid={'p_phones':list(client.peer_scope[0]),'p_member_ids':list(client.peer_scope[1])}
        candidates=[dict(valid,p_phones=[f'010{i:08d}' for i in range(2667)]),
                    dict(valid,p_member_ids=[m.loader.stable_id('member','lotto815',i+1) for i in range(2667)]),
                    dict(valid,p_phones=[]),dict(valid,p_member_ids=[]),dict(valid,p_phones=[None]),
                    dict(valid,p_member_ids=[['nested']]),dict(valid,p_phones=['01000000000','01000000000']),dict(valid,extra=True)]
        for body in candidates:
            with self.subTest(body_keys=sorted(body)),patch.object(m.pilot,'request_json') as http,self.assertRaises(m.Stop):client.rpc(m.PHONE_PEER_RPC,body)
            http.assert_not_called()
        oversized={'members':[dict(data['members'][0],id=m.loader.stable_id('member','lotto815',i+1)) for i in range(2667)]}
        with self.assertRaisesRegex(m.Stop,'query_limit'):m.frozen_peer_scope([oversized])
        exact_limit={'p_phones':[f'010{i:08d}' for i in range(2666)],'p_member_ids':[m.loader.stable_id('member','lotto815',i+1) for i in range(2666)]}
        m.validate_peer_query(exact_limit)
    def test_peer_response_strict_columns_types_unique_ids_and_scope(self):
        data,_=fixture();scope=m.frozen_peer_scope([data]);native=identities(native_snapshot())[0]
        m.validate_peer_identifiers([native],scope)
        candidates=[{},[native,native],[dict(native,extra=None)],[{key:value for key,value in native.items() if key!='legacy_idx'}],
                    [dict(native,id='')],[dict(native,user_id=None)],[dict(native,phone=None)],[dict(native,phone='invalid')],
                    [dict(native,source_site={'forged':True})],[dict(native,source_site='unknown-site')],
                    [dict(native,legacy_idx=123)],[dict(native,import_batch=[])],[dict(native,phone='01000000001')]]
        for rows in candidates:
            with self.subTest(rows=rows),self.assertRaises(m.Stop):m.validate_peer_identifiers(rows,scope)
    def test_planned_member_with_moved_phone_is_returned_and_rejected_by_identity_check(self):
        data,_=fixture();baseline=native_snapshot();manifest={'protected_member_ids':['native-1']};scope=m.frozen_peer_scope([data])
        moved=identities({'members':[data['members'][0]]})[0];moved['phone']='01000000001'
        rows=identities(baseline)+[moved]
        self.assertEqual(m.validate_peer_identifiers(rows,scope),rows)
        with self.assertRaisesRegex(m.Stop,'planned_peer_identity_changed'):m.verify_collision_peers(rows,manifest,baseline,[data])
    def test_peer_rpc_failure_never_falls_back_to_global_scan_or_retry(self):
        data,_=fixture();client=object.__new__(m.Client);client.url=m.pilot.PROJECT_URL;client.key='synthetic';client.configure_peer_scope([data])
        for result in ((503,{}),(200,{}),(200,[{'id':'partial'}])):
            with self.subTest(result=result),patch.object(m.pilot,'request_json',return_value=result) as http,patch.object(client,'select_all') as scan,self.assertRaises(m.Stop):client.member_identifiers()
            self.assertEqual(http.call_count,1);scan.assert_not_called()
    def test_ambiguous_rpc_without_durable_proof_never_completes_or_replays(self):
        for committed in (True,False):
            with self.subTest(committed=committed),tempfile.TemporaryDirectory() as dirname:
                root=Path(dirname).resolve();data,d=fixture();baseline={'members':[],'payments':[]}
                manifest={'batches':[d],'protected_member_ids':[],'protected_sha256':m.snapshot_digest(baseline),'settings_sha256':m.digest([]),'side_effects_expected':{'sms_sends':0,'bets':0,'assignments':0}}
                for name,value in [('manifest.json',manifest),('batch-001.json',data),('protected-baseline.json',baseline),('products-baseline.json',[]),('settings-baseline.json',[])]:m.save_new(root/name,value)
                state={'calls':0,'actual':copy.deepcopy(baseline)}
                class FakeClient:
                    def __init__(self,*args):pass
                    def configure_peer_scope(self,units):m.frozen_peer_scope(units)
                    def protected(self,*args):return copy.deepcopy(baseline)
                    def by_ids(self,*args):return []
                    def select_all(self,*args):return []
                    def batch(self,*args):return state['actual']
                    def hold(self,*args):return {}
                    def identifiers(self):return [],[]
                    def member_identifiers(self):return identities(state['actual'])
                    def side_effects(self,*args):return manifest['side_effects_expected']
                    def apply_unit(self,data,descriptor,protected):
                        state['calls']+=1
                        if committed:state['actual']={'members':[{**m.DEFAULTS['members'],**r} for r in data['members']],'payments':[]}
                        raise TimeoutError()
                with patch.object(m,'PRIVATE',root),patch.object(m,'Client',FakeClient),patch.object(m,'verify_manifest'),patch.object(m,'file_sha',return_value=m.ARCHIVE_SHA):
                    self.assertEqual(m.execute(None,m.digest(manifest),True,False,1),1)
                    self.assertEqual(m.execute(None,m.digest(manifest),True,False,1),1)
                self.assertEqual(state['calls'],1)
                receipts=[m.read(path) for path in root.glob('*/receipt.json')]
                self.assertIn('completed_atomic_proof_missing' if committed else 'uncertain_prior_attempt',{row.get('reason_code') for row in receipts})
    def test_all_apply_requires_completed_pilot(self):
        with tempfile.TemporaryDirectory() as dirname:
            root=Path(dirname).resolve();data,d=fixture();baseline={'members':[],'payments':[]}
            manifest={'batches':[d],'protected_member_ids':[],'protected_sha256':m.snapshot_digest(baseline),'settings_sha256':m.digest([]),'side_effects_expected':{'sms_sends':0,'bets':0,'assignments':0}}
            for name,value in [('manifest.json',manifest),('batch-001.json',data),('protected-baseline.json',baseline),('products-baseline.json',[]),('settings-baseline.json',[])]:m.save_new(root/name,value)
            class FakeClient:
                def __init__(self,*args):pass
                def configure_peer_scope(self,units):m.frozen_peer_scope(units)
                def protected(self,*args):return baseline
                def by_ids(self,*args):return []
                def select_all(self,*args):return []
                def batch(self,*args):return baseline
            with patch.object(m,'PRIVATE',root),patch.object(m,'Client',FakeClient),patch.object(m,'verify_manifest'),patch.object(m,'file_sha',return_value=m.ARCHIVE_SHA):
                self.assertEqual(m.execute(None,m.digest(manifest),True,True),1)
            receipts=[m.read(p) for p in root.glob('*/receipt.json')]
            self.assertEqual(receipts[0]['reason_code'],'pilot_must_complete_before_all')
            self.assertEqual(receipts[0]['writes_attempted'],0)
    def test_operational_drift_is_audited_without_claiming_global_preservation(self):
        with tempfile.TemporaryDirectory() as dirname:
            root=Path(dirname).resolve();data,d=fixture();baseline=native_snapshot()
            manifest={'batches':[d],'protected_member_ids':['native-1'],'protected_sha256':m.snapshot_digest(baseline),'settings_sha256':m.digest([]),'side_effects_expected':{'sms_sends':0,'bets':0,'assignments':0}}
            original_manifest=copy.deepcopy(manifest);original_data=copy.deepcopy(data)
            for name,value in [('manifest.json',manifest),('batch-001.json',data),('protected-baseline.json',baseline),('products-baseline.json',[]),('settings-baseline.json',[])]:m.save_new(root/name,value)
            state={'calls':0,'inventory_calls':0,'peer_calls':0,'native':copy.deepcopy(baseline),'actual':{'members':[],'payments':[]}}
            state['native']['members'][0]['memo']='legitimate operation before import'
            class FakeClient:
                def __init__(self,*args):pass
                def configure_peer_scope(self,units):m.frozen_peer_scope(units)
                def protected(self,ids):
                    return {'members':[copy.deepcopy(row) for row in state['native']['members'] if row['id'] in ids],
                            'payments':[copy.deepcopy(row) for row in state['native']['payments'] if row['member_id'] in ids]}
                def by_ids(self,*args):return []
                def select_all(self,*args):return []
                def batch(self,*args):return copy.deepcopy(state['actual'])
                def hold(self,*args):return {}
                def identifiers(self):
                    state['inventory_calls']+=1
                    return identities(state['native'])+identities(state['actual']),[]
                def member_identifiers(self):
                    state['peer_calls']+=1
                    return identities(state['native'])+identities(state['actual'])
                def side_effects(self,*args):return manifest['side_effects_expected']
                def apply_unit(self,data,descriptor,protected):
                    self_outer.assertEqual(protected,{'members':1,'payments':1})
                    state['calls']+=1
                    state['actual']={'members':[{**m.DEFAULTS['members'],**row} for row in data['members']],'payments':[]}
                    # This edit is outside the proof's DB transaction in this fixture.
                    state['native']['members'][0]['memo']='legitimate operation after import'
                    state['native']['payments'].append({'id':'native-pay-2','member_id':'native-1','amount':200,'status':'approved'})
                    return atomic_result(descriptor,1,1)
            self_outer=self
            with patch.object(m,'PRIVATE',root),patch.object(m,'Client',FakeClient),patch.object(m,'verify_manifest'),patch.object(m,'file_sha',return_value=m.ARCHIVE_SHA):
                self.assertEqual(m.execute(None,m.digest(manifest),True,False,1),0)
                self.assertEqual(m.execute(None,m.digest(manifest),True,False,1),0)
            self.assertEqual(state['calls'],1)
            self.assertEqual(state['inventory_calls'],1)
            self.assertEqual(state['peer_calls'],3) # Before/after one write, then one completed no-op check.
            verified=m.read(next(root.glob('*/batch-001-verified.json')))
            self.assertNotIn('existing_full_rows_unchanged',verified)
            self.assertEqual(verified['atomic_proof_scope'],'existing_phone_peers_during_locked_atomic_rpc')
            audit=verified['existing_rows_audit']
            self.assertFalse(audit['outside_snapshot_rows_unchanged'])
            self.assertEqual(audit['changes']['baseline_to_before']['members']['changed'],1)
            self.assertEqual(audit['changes']['before_to_after']['members']['changed'],1)
            self.assertEqual(audit['changes']['before_to_after']['payments']['added'],1)
            self.assertTrue(audit['rpc_payment_count_matches_before_observation'])
            self.assertFalse(audit['rpc_payment_count_matches_after_observation'])
            delta=m.read(next(root.glob('*/batch-001-existing-diff.json')))
            self.assertEqual(delta['before_to_after']['members']['changed'][0]['before']['memo'],'legitimate operation before import')
            self.assertEqual(delta['before_to_after']['members']['changed'][0]['after']['memo'],'legitimate operation after import')
            self.assertEqual(m.read(root/'manifest.json'),original_manifest)
            self.assertEqual(m.read(root/'batch-001.json'),original_data)
            self.assertEqual(m.read(root/'protected-baseline.json'),baseline)
    def test_atomic_proof_missing_false_wrong_types_and_member_counts_rejected(self):
        _,d=fixture();valid=atomic_result(d,1,2)
        candidates=[]
        for key in ('protected_members','protected_payments','existing_full_rows_unchanged'):
            changed=dict(valid);changed.pop(key);candidates.append(changed)
        candidates.append({key:value for key,value in valid.items() if key not in ('protected_members','protected_payments','existing_full_rows_unchanged')})
        for key,values in [('protected_members',[True,'1',1.0,0,2,-1]),('protected_payments',[True,'2',2.0,-1]),('existing_full_rows_unchanged',[False,1,'true',None])]:
            for value in values:candidates.append(dict(valid,**{key:value}))
        for candidate in candidates:
            with self.subTest(candidate=candidate),self.assertRaises(m.Stop):m.verify_atomic_proof(candidate,d,{'members':1,'payments':2})
        m.verify_atomic_proof(valid,d,{'members':1,'payments':2})
        # Outside observations are not the transaction-time payment count.
        m.verify_atomic_proof(dict(valid,protected_payments=3),d,{'members':1,'payments':2})
    def test_apply_unit_rejects_old_or_false_rpc_proof(self):
        data,d=fixture();client=object.__new__(m.Client)
        for response in (dict(atomic_result(d),existing_full_rows_unchanged=False),{key:value for key,value in atomic_result(d).items() if key not in ('protected_members','protected_payments','existing_full_rows_unchanged')}):
            with patch.object(client,'rpc',return_value=response),self.assertRaises(m.Stop):client.apply_unit(data,d,{'members':0,'payments':0})
    def test_protected_identity_changes_stop_but_nonidentity_drift_is_allowed(self):
        baseline=native_snapshot();manifest={'protected_member_ids':['native-1'],'protected_sha256':m.snapshot_digest(baseline)}
        class Client:
            def protected(self,*args):return copy.deepcopy(current)
        current=copy.deepcopy(baseline);current['members'][0]['memo']='updated';current['payments'][0]['amount']=200
        self.assertEqual(m.check_protected(Client(),manifest,baseline),current)
        for change in ('id','phone','source','missing'):
            current=copy.deepcopy(baseline)
            if change=='id':current['members'][0]['id']='other'
            elif change=='phone':current['members'][0]['phone']='01000000001'
            elif change=='source':current['members'][0]['meta']['source_site']='lotto815'
            else:current['members']=[]
            with self.subTest(change=change),self.assertRaises(m.Stop):m.check_protected(Client(),manifest,baseline)
        current=copy.deepcopy(baseline);corrupt=copy.deepcopy(baseline);corrupt['members'][0]['memo']='changed frozen data'
        with self.assertRaisesRegex(m.Stop,'baseline_hash'):m.check_protected(Client(),manifest,corrupt)
    def test_collision_membership_rejects_new_swapped_or_relocated_peers(self):
        data,_=fixture();baseline=native_snapshot();manifest={'protected_member_ids':['native-1']}
        live=identities(baseline);m.verify_collision_peers(live,manifest,baseline,[data])
        for changed in ([],[dict(live[0],id='replacement')],[*live,dict(live[0],id='extra')],[dict(live[0],phone='01000000001')],[dict(live[0],source_site='lotto815')]):
            with self.subTest(changed=changed),self.assertRaises(m.Stop):m.verify_collision_peers(changed,manifest,baseline,[data])
    def test_existing_planned815_same_phone_is_included_in_atomic_peer_count(self):
        data,d=fixture();baseline=native_snapshot();manifest={'protected_member_ids':['native-1']}
        prior=copy.deepcopy(data['members'][0]);later=copy.deepcopy(data['members'][1]);later['meta']['import_batch']=m.batch_name(2)
        units=[{'members':[prior]},{'members':[later]}]
        live=identities(baseline)+identities({'members':[prior]})
        m.verify_collision_peers(live,manifest,baseline,units)
        phones={m.canonical_phone(later['phone'])}
        peers=[row['id'] for row in live if m.canonical_phone(row['phone']) in phones]
        self.assertEqual(set(peers),{'native-1',prior['id']})
        m.verify_atomic_proof(atomic_result(d,2,1),d,{'members':len(peers),'payments':1})
        with self.assertRaises(m.Stop):m.verify_atomic_proof(atomic_result(d,1,1),d,{'members':len(peers),'payments':1})
        for key,value in [('phone','01000000001'),('source_site','pluslotto'),('import_batch',m.batch_name(2))]:
            changed=copy.deepcopy(live);changed[-1][key]=value
            with self.subTest(key=key),self.assertRaises(m.Stop):m.verify_collision_peers(changed,manifest,baseline,units)
    def test_replay_requires_same_persisted_proof_and_immutable_fence_scope(self):
        with tempfile.TemporaryDirectory() as dirname:
            root=Path(dirname).resolve();run=root/'20260914T000000Z-1234abcd';run.mkdir(mode=0o700)
            _,d=fixture();fence={'proof_version':1,'protected_before_counts':{'members':1,'payments':1},'receipt_directory':str(run)}
            proof={'manifest_sha256':'fixed','payload_sha256':d['payload_sha256'],'batch':d['batch'],'scope':'existing_phone_peers_during_locked_atomic_rpc','result':atomic_result(d,1,1)}
            m.save_new(run/'batch-001-atomic-proof.json',proof)
            with patch.object(m,'PRIVATE',root):
                self.assertEqual(m.load_completed_proof(fence,'fixed',d),proof)
                with self.assertRaises(m.Stop):m.load_completed_proof(fence,'other',d)
                with self.assertRaises(m.Stop):m.load_completed_proof(dict(fence,protected_before_counts={'members':2,'payments':1}),'fixed',d)
                with self.assertRaises(m.Stop):m.load_completed_proof(dict(fence,receipt_directory=str(root.parent)),'fixed',d)
    def test_settings_runtime_cursor_can_advance_but_configuration_and_baseline_cannot_change(self):
        baseline=[{'id':1,'auto_assign_cursor':12,'auto_assign_enabled':True,'weekly_schedule':'monday'}]
        manifest={'settings_sha256':m.digest(m.canonical_rows(baseline))}
        current=[dict(baseline[0],auto_assign_cursor=15)]
        self.assertEqual(m.verify_settings(current,baseline,manifest),current)
        for change in ({'auto_assign_enabled':False},{'weekly_schedule':'tuesday'},{'extra':1},{'id':2}):
            with self.subTest(change=change),self.assertRaisesRegex(m.Stop,'settings_changed'):
                m.verify_settings([dict(current[0],**change)],baseline,manifest)
        with self.assertRaisesRegex(m.Stop,'settings_baseline_hash'):
            m.verify_settings(current,current,manifest)

    def test_postgres_fractional_timestamps_compared_exactly(self):
        actual={'created_at':'2026-09-14T00:00:00.12345+00:00'}
        expected={'created_at':'2026-09-14T09:00:00.123450+09:00'}
        self.assertEqual(m.canonical(actual,expected),m.canonical(expected,expected))
        changed={'created_at':'2026-09-14T00:00:00.12346+00:00'}
        self.assertNotEqual(m.canonical(changed,expected),m.canonical(expected,expected))
    def test_international_phone_equivalence(self):
        self.assertEqual({m.canonical_phone(p) for p in ('01000000000','+82 10 0000 0000','0082 10 0000 0000','8201000000000')},{'01000000000'})

if __name__=='__main__':unittest.main()
