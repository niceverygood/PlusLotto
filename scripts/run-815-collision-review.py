#!/usr/bin/env python3
"""Frozen 815 collision-only preparation and atomic import; default read-only.

A ten-member pilot must complete before --all can write. Never aliases source
accounts, updates existing rows, sends messages, or retries ambiguous writes.
Customer payloads/before/after snapshots stay in owner-only private files.
Live operational edits are audited separately from the RPC's locked snapshot
proof. A lost proof requires recovery even when inserted rows are observable.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import copy
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid
import traceback

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import legacy_815_review as review
import legacy_815_vendor_policy as policy
spec=importlib.util.spec_from_file_location('collision_pilot',ROOT/'scripts/run-approved-815-pilot.py')
pilot=importlib.util.module_from_spec(spec);sys.modules[spec.name]=pilot;spec.loader.exec_module(pilot)
loader=pilot.loader
ARCHIVE, ARCHIVE_SHA = pilot.ARCHIVE, pilot.ARCHIVE_SHA
BACKUP = pilot.BACKUP_ROOT
EXCEPTIONS = BACKUP/'full-review-exceptions-20260910/20260910T120001Z-79506329-reviewed/member-exceptions.json'
EXCEPTIONS_SHA = '115f84b3ec658e14bdc2dd46ecb650771c7bbdc362f10984657c94c1b6320372'
FAMILY = 'lotto815-collision-20260914'
PRIVATE = BACKUP/FAMILY
EXPECTED = (2666,3246,1553360120)
DEFAULTS={'members':{'tendency':None,'assigned_staff_id':None,'team_id':None,'win_history':None},'payments':{'pg_provider':None,'staff_id':None}}
READ_TABLES={'members','payments','products','site_settings','sms_sends','bets','assignments'}

class Stop(ValueError): pass
def require(ok,code):
    if not ok: raise Stop(code)
def encoded(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def digest(value):return hashlib.sha256(encoded(value).encode()).hexdigest()
def file_sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)
    return h.hexdigest()
def safe_path(path,directory=False):
    require(not any(p.is_symlink() for p in (path,*path.parents)),'private_symlink')
    st=path.stat();require(st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==(0o700 if directory else 0o600),'private_mode')
    require(stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode),'private_type')
def read(path):
    safe_path(path)
    with path.open() as f:return json.load(f)
def save_new(path,value):
    require(not any(p.is_symlink() for p in (path.parent,*path.parent.parents)),'private_symlink')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    with os.fdopen(fd,'w') as f:f.write(encoded(value)+'\n');f.flush();os.fsync(f.fileno())
def replace_receipt(path,value):
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp');save_new(temp,value);os.replace(temp,path)
def sync_directory(path):
    fd=os.open(path,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
def canonical_phone(value):
    n=re.sub(r'\D','',value or '')
    if n.startswith('0082'):n=n[4:];return n if n.startswith('0') else '0'+n
    if n.startswith('82'):n=n[2:];return n if n.startswith('0') else '0'+n
    return n
def batch_name(i):
    require(type(i)is int and 1<=i<=999,'batch_index');return FAMILY+f'-{i:03d}'
def canonical(row, expected):
    value={key:row.get(key) for key in expected}
    for key in pilot.DATE_FIELDS & value.keys():
        raw=value[key]
        if raw:
            require(isinstance(raw,str),'timestamp_type')
            # Python 3.9 accepts only 3/6 fractional digits, PostgreSQL emits 1-6.
            normalized=re.sub(r'(\d{2}:\d{2}:\d{2}\.)(\d+)',lambda m:m[1]+m[2].ljust(6,'0')[:6],raw.replace('Z','+00:00'))
            parsed=dt.datetime.fromisoformat(normalized);require(parsed.tzinfo is not None,'timestamp_without_timezone')
            value[key]=parsed.astimezone(dt.timezone.utc).isoformat()
    return encoded(value)
def canonical_rows(rows):
    return [json.loads(canonical(r,r)) for r in sorted(rows,key=lambda r:r['id'])]
def snapshot_digest(snapshot):return digest({k:canonical_rows(v) for k,v in snapshot.items()})
def partitions(items,size=100):
    for i in range(0,len(items),size):yield items[i:i+size]

class Client(loader.Supa):
    def __init__(self,env_file,apply=False):
        config=pilot.read_config(env_file)
        super().__init__(pilot.PROJECT_URL,config['SUPABASE_SERVICE_ROLE_KEY'],apply)
        self.attempted=set()
    def _req(self,method,path,body=None,prefer=None):
        require(self.url==pilot.PROJECT_URL and method=='GET' and body is None and prefer is None and path.partition('?')[0] in READ_TABLES,'read_request_scope')
        status,value=pilot.request_json(self.url+'/rest/v1/'+path,{'apikey':self.key,'Authorization':'Bearer '+self.key})
        require(status==200 and isinstance(value,list),'read_request_failed');return value
    def rpc(self,name,body):
        require(name in ('admin_import_815_collision_batch','admin_verify_815_batch_holds'),'rpc_scope')
        if name=='admin_import_815_collision_batch':
            batch=body['p_batch_id'];require(self.allow_writes and batch not in self.attempted,'write_scope');self.attempted.add(batch)
        status,value=pilot.request_json(self.url+'/rest/v1/rpc/'+name,{'apikey':self.key,'Authorization':'Bearer '+self.key,'Content-Type':'application/json'},body)
        require(status==200 and isinstance(value,dict),'rpc_result_unconfirmed');return value
    def hold(self,d,count):
        value=self.rpc('admin_verify_815_batch_holds',{'p_batch_id':d['batch']})
        expected={'batch_id':d['batch'],'members':count,'held_metadata_members':count,'held_rpc_members':count,'consent_review_members':count}
        require(encoded(value)==encoded(expected),'hold_result');return value
    def apply_unit(self,data,d,protected):
        validate_unit(data,d)
        value=self.rpc('admin_import_815_collision_batch',{'p_batch_id':d['batch'],'p_members':data['members'],'p_payments':data['payments'],'p_expected_member_count':d['members'],'p_expected_payment_count':d['payments'],'p_expected_amount':d['amount']})
        verify_atomic_proof(value,d,protected);return value
    def member_identifiers(self):
        return self.select_all('members','id,user_id,phone,source_site:meta->>source_site,legacy_idx:meta->>legacy_idx,import_batch:meta->>import_batch')
    def identifiers(self):
        members=self.member_identifiers()
        payments=self.select_all('payments','id,source_site:meta->>source_site,legacy_idx:meta->>legacy_idx')
        return members,payments
    def by_ids(self,table,ids,column='id',columns='*'):
        require(all(isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9._-]{1,128}',value) for value in ids),'identifier_query_format')
        result=[]
        for group in partitions(sorted(set(ids)),100):result.extend(self.select_all(table,columns,[(column,'in.('+','.join(group)+')')]))
        require(len({r['id'] for r in result})==len(result),'query_duplicate');return result
    def batch(self,batch):
        return {t:self.select_all(t,'*',[('meta->>source_site','eq.lotto815'),('meta->>import_batch','eq.'+batch)]) for t in ('members','payments')}
    def protected(self,ids):
        result={'members':self.by_ids('members',ids),'payments':self.by_ids('payments',ids,'member_id')}
        require({r['id'] for r in result['members']}==set(ids),'protected_missing');return result
    def side_effects(self,ids):
        return {t:len(self.by_ids(t,ids,col,'id')) for t,col in (('sms_sends','member_id'),('bets','member_ref'),('assignments','member_id'))}

def selected_exceptions():
    require(file_sha(EXCEPTIONS)==EXCEPTIONS_SHA,'exceptions_hash')
    rows=read(EXCEPTIONS);selected=[r for r in rows if r['primary_reason']=='phone_collision']
    require((len(selected),sum(r['source_payment_count'] for r in selected),sum(r['source_payment_amount'] for r in selected))==EXPECTED,'exception_scope')
    require(all(not r['account_flags_y'] and not r['account_flags_unknown'] and not r['invalid_phone'] for r in selected),'exception_flags')
    require(Counter(r['subtype'] for r in selected)=={'existing_member_phone':2664,'source_internal_phone':2},'exception_subtypes')
    return selected

def validate_unit(data,d):
    require(set(data)=={'members','payments','products'} and digest(data)==d['payload_sha256'],'payload_hash')
    require(d['batch']==batch_name(d['index']) and d['file']==f"batch-{d['index']:03d}.json",'batch_identity')
    require((len(data['members']),len(data['payments']),sum(r['amount'] for r in data['payments']))==(d['members'],d['payments'],d['amount']),'unit_counts')
    require(1<=d['members']<=(10 if d['index']==1 else 250) and d['payments']<=10000,'batch_size')
    mids={r['id'] for r in data['members']}
    require(len(mids)==d['members'] and len({r['user_id'] for r in data['members']})==d['members'],'duplicate_member_identity')
    for table,kind in (('members','member'),('payments','payment')):
        require(len({r['id'] for r in data[table]})==len(data[table]) and len({r['meta']['legacy_idx'] for r in data[table]})==len(data[table]),'duplicate_source_key')
        for row in data[table]:
            m=row['meta'];idx=m.get('legacy_idx')
            require(type(idx)is int and idx>0 and row['id']==loader.stable_id(kind,'lotto815',idx) and m.get('source_site')=='lotto815' and m.get('import_batch')==d['batch'],'source_identity')
    for row in data['members']:
        m=row['meta']
        require(isinstance(row.get('user_id'),str) and bool(row['user_id']) and re.fullmatch(r'01[0-9]{8,9}',row['phone']) and row.get('assigned_staff_id') is None and row.get('team_id') is None,'member_identity')
        require(m.get('reco_paused') is True and m.get('reco_pause_reason')=='legacy_import_review' and m.get('legacy_consent_review_required') is True and m.get('legacy_agree_sms_yn') in ('Y','N') and m.get('legacy_account_flags')=={k:'N' for k in review.ACCOUNT_REVIEW_FIELDS} and 'weekly_recos' not in m,'member_guard')
        require(type(m.get('weekly_reco_count'))is int and m['weekly_reco_count']>=0 and all(isinstance(m.get(k),str) for k in ('legacy_member_start_datetime','legacy_member_end_datetime')),'source_contract')
        require(row['status'] in ('active','suspended','deleted','withdrawn') and all(row[f] is (row['status']==s) for f,s in (('is_suspended','suspended'),('is_deleted','deleted'),('is_withdrawn','withdrawn'))),'status_flags')
    for row in data['payments']:
        m=row['meta'];require(row['member_id'] in mids and type(row['amount'])is int and row['amount']>=0 and row['status']=='approved' and row.get('staff_id') is None and isinstance(m.get('legacy_item_status'),str) and isinstance(m.get('legacy_installment_code'),str) and type(m.get('legacy_payment_reco_count'))is int,'payment_guard')
    needed={r['product_id'] for r in data['payments']};require({r['id'] for r in data['products']}==needed and len(data['products'])==len(needed),'products')

def build_units(users,payments,selected,live_members,live_payments):
    source={int(r['idx']):r for r in users};require(len(source)==len(users)==21809,'source_users')
    paykeys={int(r['idx']) for r in payments};require(len(paykeys)==len(payments)==28072,'source_payments')
    picked={int(r['legacy_member_idx']):r for r in selected};require(len(picked)==2666 and set(picked)<=set(source),'selected_keys')
    grouped=defaultdict(list)
    for row in payments:grouped[int(row['userIdx'])].append(row)
    occupied={r['user_id'] for r in live_members};pairs=[]
    for idx in sorted(picked):
        raw=source[idx];require(not review.account_review_reasons(raw),'source_flags')
        member,error=loader.build_member(raw,'lotto815',loader.GRADE_BY_SITE['lotto815'],FAMILY)
        require(error is None and member is not None,'member_mapping')
        require(canonical_phone(member['phone'])==picked[idx]['canonical_phone'],'exception_phone_changed')
        if member['user_id'] in occupied:
            member['meta']['legacy_login_id']=member['user_id'];member['user_id']=loader.fallback_login_id('lotto815',idx,occupied)
        occupied.add(member['user_id']);review.enrich_review_metadata(member,raw)
        detail=[]
        for payment in grouped[idx]:
            product=loader.product_for_payment('lotto815',payment);require(product is not None,'product_mapping')
            detail.append(loader.build_payment(payment,'lotto815',member['id'],product['id'],FAMILY))
        member,detail=policy.enrich_new_review_payload(raw,grouped[idx],member,detail)
        require((len(detail),sum(r['amount'] for r in detail))==(picked[idx]['source_payment_count'],picked[idx]['source_payment_amount']),'exception_payment_changed')
        pairs.append((member,detail))
    groups=[pairs[:10],*partitions(pairs[10:],250)];units=[];descriptors=[]
    for i,group in enumerate(groups,1):
        data={'members':[],'payments':[],'products':[]}
        for member,detail in group:
            member=copy.deepcopy(member);member['meta']['import_batch']=batch_name(i);data['members'].append(member)
            for row in detail:row=copy.deepcopy(row);row['meta']['import_batch']=batch_name(i);data['payments'].append(row)
        needed={r['product_id'] for r in data['payments']};data['products']=[r for r in loader.PRODUCTS_BY_SITE['lotto815'].values() if r['id'] in needed]
        d={'index':i,'batch':batch_name(i),'file':f'batch-{i:03d}.json','members':len(data['members']),'payments':len(data['payments']),'amount':sum(r['amount'] for r in data['payments']),'payload_sha256':digest(data)}
        validate_unit(data,d);units.append(data);descriptors.append(d)
    verify_conflicts(units,live_members,live_payments)
    return units,descriptors

def verify_conflicts(units,members,payments):
    mids={r['id'] for r in members};logins={r['user_id'] for r in members};mkeys={(r.get('source_site'),str(r.get('legacy_idx'))) for r in members}
    pids={r['id'] for r in payments};pkeys={(r.get('source_site'),str(r.get('legacy_idx'))) for r in payments}
    for data in units:
        for r in data['members']:
            key=('lotto815',str(r['meta']['legacy_idx']));require(r['id'] not in mids and r['user_id'] not in logins and key not in mkeys,'live_member_identity_conflict');mids.add(r['id']);logins.add(r['user_id']);mkeys.add(key)
        for r in data['payments']:
            key=('lotto815',str(r['meta']['legacy_idx']));require(r['id'] not in pids and key not in pkeys,'live_payment_identity_conflict');pids.add(r['id']);pkeys.add(key)

def verify_manifest(manifest,units):
    require(manifest['family']==FAMILY and manifest['archive_sha256']==ARCHIVE_SHA and manifest['exceptions_sha256']==EXCEPTIONS_SHA and (manifest['members'],manifest['payments'],manifest['amount'])==EXPECTED,'manifest_scope')
    require(len(units)==len(manifest['batches'])==12,'manifest_batches')
    for i,(data,d) in enumerate(zip(units,manifest['batches']),1):
        require(d['index']==i,'manifest_order');validate_unit(data,d)
    selected={int(r['legacy_member_idx']) for r in selected_exceptions()}
    rows=[r for data in units for r in data['members']];pays=[r for data in units for r in data['payments']]
    require({r['meta']['legacy_idx'] for r in rows}==selected and len(rows)==2666 and len(pays)==3246 and sum(r['amount'] for r in pays)==1553360120,'manifest_partition')
    verify_conflicts(units,[],[])

def verify_actual(actual,data,d):
    if not actual['members'] and not actual['payments']:return 'empty'
    require((len(actual['members']),len(actual['payments']))==(d['members'],d['payments']),'partial_batch')
    for table in ('members','payments'):
        indexed={r['id']:r for r in actual[table]};require(len(indexed)==len(actual[table]),'actual_duplicate')
        for row in data[table]:
            expected={**DEFAULTS[table],**row};got=indexed.get(row['id'])
            require(isinstance(got,dict) and set(got)==set(expected) and canonical(got,expected)==canonical(expected,expected),'whole_row_mismatch')
    return 'complete'

def operating_site(row):
    meta=row.get('meta') or {};require(isinstance(meta,dict),'protected_source')
    value=meta.get('source_site') if 'meta' in row else row.get('source_site')
    require(value is None or isinstance(value,str),'protected_source')
    return (value or '').strip() or 'pluslotto'

def protected_identity(rows):
    result={}
    for row in rows:
        require(isinstance(row.get('id'),str) and row['id'] not in result and isinstance(row.get('phone'),str),'protected_identity')
        normalized=canonical_phone(row['phone']);require(re.fullmatch(r'0[1-9][0-9]{7,9}',normalized),'protected_phone')
        result[row['id']]=(normalized,operating_site(row))
    return result

def check_protected(client,manifest,baseline):
    require(snapshot_digest(baseline)==manifest['protected_sha256'],'baseline_hash')
    original=protected_identity(baseline['members'])
    require(set(original)==set(manifest['protected_member_ids']) and all(site=='pluslotto' for _,site in original.values()),'baseline_identity')
    current=client.protected(manifest['protected_member_ids'])
    require(protected_identity(current['members'])==original,'protected_identity_changed')
    require(all(row['member_id'] in original for row in current['payments']),'protected_payment_scope')
    return current

def verify_collision_peers(live,manifest,baseline,units):
    phones={canonical_phone(row['phone']) for unit in units for row in unit['members']}
    planned={row['id']:row for unit in units for row in unit['members']}
    require(len({row['id'] for row in live})==len(live),'live_member_duplicate')
    for row in live:
        if row['id'] in planned:
            expected=planned[row['id']]
            require(canonical_phone(row['phone'])==canonical_phone(expected['phone']) and operating_site(row)=='lotto815' and row.get('import_batch')==expected['meta']['import_batch'],'planned_peer_identity_changed')
    peers=[row for row in live if canonical_phone(row['phone']) in phones and row['id'] not in planned]
    require(protected_identity(peers)==protected_identity(baseline['members']) and {row['id'] for row in peers}==set(manifest['protected_member_ids']),'collision_peers_changed')

def snapshot_diff(before,after):
    result={}
    for table in ('members','payments'):
        old={row['id']:row for row in canonical_rows(before[table])};new={row['id']:row for row in canonical_rows(after[table])}
        require(len(old)==len(before[table]) and len(new)==len(after[table]),'snapshot_duplicate')
        result[table]={'added':[new[key] for key in sorted(new.keys()-old.keys())],
                      'removed':[old[key] for key in sorted(old.keys()-new.keys())],
                      'changed':[{'id':key,'fields':sorted(field for field in old[key].keys()|new[key].keys() if (field not in old[key] or field not in new[key] or old[key][field]!=new[key][field])),
                                  'before':old[key],'after':new[key]} for key in sorted(old.keys()&new.keys()) if old[key]!=new[key]]}
    return result

def diff_counts(delta):
    return {table:{kind:len(rows) for kind,rows in changes.items()} for table,changes in delta.items()}

def record_existing_audit(run,index,baseline,before,after,proof,peer_before,peer_after):
    deltas={'baseline_to_before':snapshot_diff(baseline,before),'baseline_to_after':snapshot_diff(baseline,after),'before_to_after':snapshot_diff(before,after)}
    save_new(run/f'batch-{index:03d}-existing-diff.json',deltas)
    return {'scope':'separate_read_observations_outside_atomic_rpc',
            'baseline_sha256':snapshot_digest(baseline),'before_sha256':snapshot_digest(before),'after_sha256':snapshot_digest(after),
            'outside_snapshot_rows_unchanged':snapshot_digest(before)==snapshot_digest(after),
            'changes':{name:diff_counts(delta) for name,delta in deltas.items()},
            'rpc_protected_payments':proof['protected_payments'],
            'observed_peer_payments_before':len(peer_before['payments']),'observed_peer_payments_after':len(peer_after['payments']),
            'rpc_payment_count_matches_before_observation':proof['protected_payments']==len(peer_before['payments']),
            'rpc_payment_count_matches_after_observation':proof['protected_payments']==len(peer_after['payments'])}

def verify_atomic_proof(value,d,protected):
    expected={'batch_id':d['batch'],'members':d['members'],'payments':d['payments'],'amount':d['amount'],'held_members':d['members'],'atomic':True}
    extra={'protected_members','protected_payments','existing_full_rows_unchanged'}
    require(isinstance(value,dict) and set(value)==set(expected)|extra,'atomic_proof_shape')
    require(encoded({key:value[key] for key in expected})==encoded(expected),'atomic_result')
    require(type(protected.get('members'))is int and protected['members']>=0 and type(protected.get('payments'))is int and protected['payments']>=0,'protected_counts')
    require(type(value['protected_members'])is int and value['protected_members']==protected['members'],'atomic_protected_member_count')
    # Payment counts are observed under DB locks. Legitimate payment edits can
    # precede/follow those locks; outside observations are recorded, not equated.
    require(type(value['protected_payments'])is int and value['protected_payments']>=0,'atomic_protected_payment_count')
    require(value['existing_full_rows_unchanged'] is True,'atomic_protected_rows_changed')

def load_completed_proof(fence,manifest_sha,d):
    require(fence.get('proof_version')==1 and isinstance(fence.get('protected_before_counts'),dict),'completed_atomic_proof_missing')
    directory=Path(fence.get('receipt_directory',''))
    require(directory.parent==PRIVATE and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}',directory.name),'completed_receipt_scope')
    safe_path(directory,directory=True)
    proof_path=directory/f"batch-{d['index']:03d}-atomic-proof.json"
    require(proof_path.exists(),'completed_atomic_proof_missing')
    proof=read(proof_path)
    require(set(proof)=={'manifest_sha256','payload_sha256','batch','scope','result'} and proof['manifest_sha256']==manifest_sha and proof['payload_sha256']==d['payload_sha256'] and proof['batch']==d['batch'] and proof['scope']=='existing_phone_peers_during_locked_atomic_rpc','completed_atomic_proof_mismatch')
    verify_atomic_proof(proof['result'],d,fence['protected_before_counts'])
    return proof

def check_products(client,units,expected=None):
    needed={r['id']:r for u in units for r in u['products']}
    actual=client.by_ids('products',list(needed))
    require({r['id'] for r in actual}==set(needed),'missing_product')
    require(all(canonical(r,needed[r['id']])==canonical(needed[r['id']],needed[r['id']]) for r in actual),'product_changed')
    if expected is not None:require(canonical_rows(actual)==canonical_rows(expected),'product_full_rows_changed')
    return actual

def prepare(env_file):
    require(not PRIVATE.exists() and not PRIVATE.is_symlink(),'manifest_exists_no_reselection');require(file_sha(ARCHIVE)==ARCHIVE_SHA,'archive_hash')
    selected=selected_exceptions();client=Client(env_file);print(encoded({'stage':'reading_identifiers'}),flush=True);live_members,live_payments=client.identifiers();print(encoded({'stage':'reading_verified_source','existing_members':len(live_members),'existing_payments':len(live_payments)}),flush=True)
    source=loader.DumpSource('lotto815',archive=str(ARCHIVE));users,payments=source.load('user'),source.load('payment')
    units,ds=build_units(users,payments,selected,live_members,live_payments);print(encoded({'stage':'reading_protected_rows','prepared_members':sum(len(u['members']) for u in units)}),flush=True)
    phones={canonical_phone(r['phone']) for u in units for r in u['members']}
    affected=[r for r in live_members if canonical_phone(r['phone']) in phones]
    require(all(r.get('source_site') in (None,'','pluslotto') for r in affected),'unexpected_existing_collision_site')
    ids=sorted(r['id'] for r in affected);baseline=client.protected(ids);products=check_products(client,units)
    settings=client.select_all('site_settings','*')
    manifest={'family':FAMILY,'archive_sha256':ARCHIVE_SHA,'exceptions_sha256':EXCEPTIONS_SHA,'prepared_at_utc':dt.datetime.now(dt.timezone.utc).isoformat(),'members':2666,'payments':3246,'amount':1553360120,'batches':ds,'protected_member_ids':ids,'protected_sha256':snapshot_digest(baseline),'products_sha256':digest(canonical_rows(products)),'settings_sha256':digest(canonical_rows(settings)),'side_effects_expected':{'sms_sends':0,'bets':0,'assignments':0}}
    verify_manifest(manifest,units)
    require(not any(p.is_symlink() for p in (PRIVATE.parent,*PRIVATE.parent.parents)),'private_symlink');PRIVATE.mkdir(mode=0o700)
    save_new(PRIVATE/'protected-baseline.json',baseline);save_new(PRIVATE/'products-baseline.json',products);save_new(PRIVATE/'settings-baseline.json',settings)
    for data,d in zip(units,ds):save_new(PRIVATE/d['file'],data)
    save_new(PRIVATE/'manifest.json',manifest)
    print(encoded({'stage':'prepared_not_applied','manifest_sha256':digest(manifest),'private_directory':str(PRIVATE),'members':2666,'payments':3246,'amount':1553360120,'batches':len(ds),'protected_members':len(ids),'protected_payments':len(baseline['payments']),'sms_requests':0}))

def execute(env_file,manifest_sha,apply=False,all_batches=False,index=None):
    safe_path(PRIVATE,directory=True);require(re.fullmatch('[0-9a-f]{64}',manifest_sha or ''),'manifest_sha_required')
    fd=os.open(PRIVATE/'execution.lock',os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600);run=None;receipt={'stage':'initializing','writes_attempted':0,'sms_requests':0}
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        manifest=read(PRIVATE/'manifest.json');require(digest(manifest)==manifest_sha,'manifest_hash')
        units=[read(PRIVATE/f'batch-{i:03d}.json') for i in range(1,len(manifest['batches'])+1)];verify_manifest(manifest,units)
        require(file_sha(ARCHIVE)==ARCHIVE_SHA,'archive_hash')
        run=PRIVATE/(dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]);run.mkdir(mode=0o700)
        def step(stage,**more):receipt.update(stage=stage,manifest_sha256=manifest_sha,**more);replace_receipt(run/'receipt.json',receipt)
        client=Client(env_file,apply);baseline=read(PRIVATE/'protected-baseline.json');preflight=check_protected(client,manifest,baseline)
        save_new(run/'preflight-existing.json',preflight)
        preflight_diff=snapshot_diff(baseline,preflight);save_new(run/'preflight-existing-diff.json',preflight_diff)
        receipt.update(existing_preservation_scope='existing_phone_peers_during_locked_atomic_rpc',baseline_to_preflight_changes=diff_counts(preflight_diff))
        check_products(client,units,read(PRIVATE/'products-baseline.json'))
        require(digest(canonical_rows(client.select_all('site_settings','*')))==manifest['settings_sha256'],'settings_changed')
        states=[verify_actual(client.batch(d['batch']),u,d) for u,d in zip(units,manifest['batches'])]
        progress=states.index('empty') if 'empty' in states else len(states);require(all(v=='empty' for v in states[progress:]),'batch_order')
        for data,d in zip(units[:progress],manifest['batches'][:progress]):
            fence=read(PRIVATE/f"batch-{d['index']:03d}-attempt.json")
            require(fence.get('manifest_sha256')==manifest_sha and fence.get('payload_sha256')==d['payload_sha256'] and fence.get('batch')==d['batch'],'completed_fence_mismatch')
            load_completed_proof(fence,manifest_sha,d)
            client.hold(d,d['members'])
            require(client.side_effects([row['id'] for row in data['members']])==manifest['side_effects_expected'],'completed_side_effects')
        if apply and all_batches:require(progress>=1,'pilot_must_complete_before_all')
        if index is not None:require(1<=index<=len(units) and index<=progress+1,'batch_order')
        chosen=list(range(progress+1,len(units)+1)) if all_batches else ([index] if index and index>progress else [])
        live_members=client.member_identifiers();verify_collision_peers(live_members,manifest,baseline,units)
        if not chosen:step('already_complete_verified_noop',completed_batches=progress);return 0
        live_members,live_payments=client.identifiers();verify_conflicts([units[i-1] for i in chosen],live_members,live_payments)
        # New phone peers cannot silently appear between preparation and apply.
        verify_collision_peers(live_members,manifest,baseline,units)
        for i in chosen:
            fence=PRIVATE/f'batch-{i:03d}-attempt.json';require(not fence.exists() and not fence.is_symlink(),'uncertain_prior_attempt')
            d=manifest['batches'][i-1];client.hold(d,0)
        step('ready_read_only',completed_batches=progress,pending_batches=len(chosen))
        if not apply:return 0
        for i in chosen:
            d=manifest['batches'][i-1];data=read(PRIVATE/d['file']);validate_unit(data,d)
            require(verify_actual(client.batch(d['batch']),data,d)=='empty','batch_changed')
            before=check_protected(client,manifest,baseline);save_new(run/f'batch-{i:03d}-existing-before.json',before)
            live_members=client.member_identifiers();verify_collision_peers(live_members,manifest,baseline,units)
            batch_phones={canonical_phone(row['phone']) for row in data['members']}
            peer_ids=sorted(row['id'] for row in live_members if canonical_phone(row['phone']) in batch_phones)
            require(not set(peer_ids)&{row['id'] for row in data['members']},'batch_peer_identity')
            peer_before=client.protected(peer_ids)
            require(all(canonical_phone(row['phone']) in batch_phones for row in peer_before['members']),'batch_peer_phone_changed')
            save_new(run/f'batch-{i:03d}-phone-peers-before.json',peer_before)
            protected_counts={table:len(rows) for table,rows in peer_before.items()}
            ids=[r['id'] for r in data['members']];require(client.side_effects(ids)==manifest['side_effects_expected'],'preexisting_side_effects')
            save_new(PRIVATE/f'batch-{i:03d}-attempt.json',{'manifest_sha256':manifest_sha,'payload_sha256':d['payload_sha256'],'batch':d['batch'],'receipt_directory':str(run),'proof_version':1,'protected_before_counts':protected_counts})
            sync_directory(run);sync_directory(PRIVATE)
            step('applying_atomic',writes_attempted=receipt['writes_attempted']+1,current_batch=d['batch'])
            result=client.apply_unit(data,d,protected_counts);verify_atomic_proof(result,d,protected_counts)
            save_new(run/f'batch-{i:03d}-atomic-proof.json',{'manifest_sha256':manifest_sha,'payload_sha256':d['payload_sha256'],'batch':d['batch'],'scope':'existing_phone_peers_during_locked_atomic_rpc','result':result})
            sync_directory(run)
            actual=client.batch(d['batch']);require(verify_actual(actual,data,d)=='complete','partial_batch');client.hold(d,d['members'])
            effects=client.side_effects(ids);require(effects==manifest['side_effects_expected'],'unexpected_side_effects')
            after=check_protected(client,manifest,baseline);save_new(run/f'batch-{i:03d}-existing-after.json',after)
            verify_collision_peers(client.member_identifiers(),manifest,baseline,units)
            peer_after=client.protected(peer_ids);save_new(run/f'batch-{i:03d}-phone-peers-after.json',peer_after)
            require(protected_identity(peer_after['members'])==protected_identity(peer_before['members']),'batch_peer_identity_changed')
            audit=record_existing_audit(run,i,baseline,before,after,result,peer_before,peer_after)
            save_new(run/f'batch-{i:03d}-inserted.json',actual)
            save_new(run/f'batch-{i:03d}-verified.json',{'stage':'complete_verified','atomic_result':result,'atomic_proof_scope':'existing_phone_peers_during_locked_atomic_rpc','actual_sha256':snapshot_digest(actual),'existing_rows_audit':audit,'side_effects':effects,'manifest_sha256':manifest_sha})
            sync_directory(run)
            step('batch_complete_verified',completed_batches=i);print(encoded({'stage':'batch_complete_verified','batch':d['batch'],'members':d['members'],'payments':d['payments']}),flush=True)
        check_products(client,units,read(PRIVATE/'products-baseline.json'));require(digest(canonical_rows(client.select_all('site_settings','*')))==manifest['settings_sha256'],'settings_changed')
        step('complete_verified',all_batches_complete=chosen[-1]==len(units));return 0
    except (Exception,SystemExit) as error:
        reason=str(error) if isinstance(error,Stop) else 'verification_or_transport_error'
        recovery=bool(receipt['writes_attempted']) or reason in ('uncertain_prior_attempt','completed_atomic_proof_missing','completed_atomic_proof_mismatch','completed_receipt_scope')
        receipt.update(failed_stage=receipt['stage'],stage='stopped_recovery_required' if recovery else 'stopped_without_writes',reason_code=reason,recovery_required=recovery)
        if run:replace_receipt(run/'receipt.json',receipt)
        print(encoded({k:receipt[k] for k in ('stage','failed_stage','reason_code','writes_attempted')}));return 1
    finally:
        if run:print(encoded({'stage':receipt['stage'],'receipt_directory':str(run),'completed_batches':receipt.get('completed_batches'),'writes_attempted':receipt['writes_attempted'],'sms_requests':0}),flush=True)
        fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--env-file',type=Path,required=True)
    modes=parser.add_mutually_exclusive_group(required=True);modes.add_argument('--prepare',action='store_true');modes.add_argument('--all',action='store_true');modes.add_argument('--batch',type=int)
    parser.add_argument('--apply',action='store_true');parser.add_argument('--manifest-sha')
    args=parser.parse_args()
    if args.prepare:
        require(not args.apply,'prepare_cannot_apply')
        try:prepare(args.env_file)
        except (Exception,SystemExit) as error:
            print(encoded({'stage':'stopped_without_writes','reason_code':str(error) if isinstance(error,(Stop,policy.PreservationError)) else 'preparation_error','error_type':type(error).__name__,'code_locations':[{'file':Path(f.filename).name,'line':f.lineno} for f in traceback.extract_tb(error.__traceback__)[-4:]]}));raise SystemExit(1)
    else:raise SystemExit(execute(args.env_file,args.manifest_sha,args.apply,args.all,args.batch))
