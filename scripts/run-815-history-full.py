#!/usr/bin/env python3
"""고정 815 이력 파일을 전용 저장소에만 INSERT한다. 기본 실행은 읽기 전용.

청크마다 원본 지문을 확인하고 영속 시도표식을 먼저 저장한다. 불명확한 결과는
같은 청크를 다시 INSERT하지 않고 실제 행을 대조한다. 회원/결제/발송큐 수정 없음.
"""
from __future__ import annotations
import argparse
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
import urllib.error
import urllib.parse
import urllib.request
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('history_full_members',ROOT/'scripts/run-815-full-review.py')
members=importlib.util.module_from_spec(spec);sys.modules[spec.name]=members;spec.loader.exec_module(members)
p,common,pilot=members.p,members.common,members.pilot
PRIVATE=p.PRIVATE.parent/'history-full-review-19021-20260910'
MANIFEST_SHA='12cd9e036335846adf2f95fdd86c6c334d5271cc3a69dbb8e8861a6f13fd3c7c'
PREFIX='lotto815-hist-20260910-'
TABLE_KIND={'legacy_member_memos':'memo','legacy_member_sms':'sms','legacy_member_wins':'win'}
COMMON_FIELDS=set('source_site legacy_idx source_user_idx member_id source_insert_datetime source_update_datetime archive_sha256 prepared_record_sha256 import_batch'.split())
OPTIONAL={
 'legacy_member_memos':set('body source_status source_consult_status source_type source_team_open_yn source_author_idx source_updater_idx source_reserved_yn source_reservation_checked_yn source_reserve_datetime'.split()),
 'legacy_member_sms':set('contents_type source_type source_status source_result_yn source_result_code source_author_idx source_updater_idx body_policy body subject from_phone to_phone source_reserve_datetime'.split()),
 'legacy_member_wins':set('round_no source_status source_checked_yn source_pick_type source_pick_from source_pick_string numbers rank prize'.split()),
}
BIGINTS={'legacy_idx','source_user_idx','source_author_idx','source_updater_idx','prize'}

class Stop(ValueError):pass
def require(ok,code):
    if not ok:raise Stop(code)
def encoded(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(value):return hashlib.sha256(encoded(value)).hexdigest()
def file_digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()
def safe_file(path):
    require(not any(q.is_symlink() for q in (path,*path.parents)),'private_symlink')
    info=path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o600,'private_file_mode')
def read_private(path):
    safe_file(path)
    with path.open() as f:return json.load(f)
def save_new(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    with os.fdopen(fd,'wb') as f:f.write(encoded(value)+b'\n');f.flush();os.fsync(f.fileno())
def save_receipt(path,value):
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    save_new(temp,value);os.replace(temp,path)
def fsync_dir(path):
    fd=os.open(path,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)

def load_manifest():
    require(re.fullmatch(r'[0-9a-f]{64}',MANIFEST_SHA) is not None,'manifest_not_pinned')
    value=read_private(PRIVATE/'manifest.json')
    require(digest(value)==MANIFEST_SHA,'manifest_sha')
    require(value['stage']=='prepared_offline_only' and value['held_records']['rows']==0
            and value['format_version']==1 and value['source_archive_sha256']==p.ARCHIVE_SHA
            and value['target_manifest_sha256']==members.MANIFEST_SHA and value['target_member_count']==19021,'manifest_scope')
    require(set(value['tables'])==set(TABLE_KIND),'manifest_tables')
    for table,descriptor in value['tables'].items():
        require(descriptor['file']==table+'.jsonl','manifest_file')
        path=PRIVATE/descriptor['file'];safe_file(path)
        require(path.stat().st_size==descriptor['bytes'] and file_digest(path)==descriptor['sha256'],'payload_file_sha')
        offset=rows=0
        for index,chunk in enumerate(descriptor['chunks'],1):
            require(chunk['index']==index and chunk['offset']==offset and type(chunk['rows']) is int
                    and 1<=chunk['rows']<=500 and type(chunk['length']) is int and chunk['length']>0
                    and chunk['batch']==f'{PREFIX}{TABLE_KIND[table]}-{index:05d}'
                    and re.fullmatch(r'[0-9a-f]{64}',chunk['sha256']) is not None,'chunk_manifest')
            offset+=chunk['length'];rows+=chunk['rows']
        require(offset==descriptor['bytes'] and rows==descriptor['rows'],'chunk_totals')
    return value

def target_members():
    manifest=read_private(p.PRIVATE/'manifest.json')
    require(digest(manifest)==members.MANIFEST_SHA,'member_manifest_sha')
    targets={}
    protected=read_private(p.PRIVATE/'protected-baseline.json')
    require(p.digest(protected)==manifest['protected_sha256'],'protected_sha')
    for row in protected['members']:
        targets[str(row['meta']['legacy_idx'])]=row['id']
    for descriptor in manifest['batches']:
        data=read_private(p.PRIVATE/descriptor['file']);p.validate_unit(data,descriptor)
        for row in data['members']:
            key=str(row['meta']['legacy_idx'])
            require(key not in targets,'duplicate_member_source');targets[key]=row['id']
    require(len(targets)==19021 and len(set(targets.values()))==19021,'target_count')
    return targets

def chunk_rows(table,descriptor,chunk,targets):
    path=PRIVATE/descriptor['file'];safe_file(path)
    with path.open('rb') as f:f.seek(chunk['offset']);raw=f.read(chunk['length'])
    require(hashlib.sha256(raw).hexdigest()==chunk['sha256'] and raw.endswith(b'\n'),'chunk_sha')
    rows=[json.loads(line) for line in raw.splitlines()]
    require(len(rows)==chunk['rows'],'chunk_rows')
    keys=set()
    for row in rows:
        require(COMMON_FIELDS<=row.keys() and row.keys()<=COMMON_FIELDS|OPTIONAL[table],'payload_fields')
        require(row['source_site']=='lotto815' and row['archive_sha256']==p.ARCHIVE_SHA
                and row['import_batch']==chunk['batch'] and row['member_id']==targets.get(str(row['source_user_idx']))
                and re.fullmatch(r'[0-9a-f]{64}',row['prepared_record_sha256']) is not None,'payload_provenance')
        key=row_key(table,row);require(key not in keys,'duplicate_chunk_key');keys.add(key)
    return rows

def exact_integer(value):
    require(type(value) is int or (isinstance(value,str) and re.fullmatch(r'[0-9]+',value)),'integer_type')
    number=int(value);require(0<=number<=9223372036854775807,'integer_range');return number
def row_key(table,row):
    key=(exact_integer(row['legacy_idx']),)
    return key+(exact_integer(row['round_no']),) if table=='legacy_member_wins' else key
def source_time(raw):
    if raw is None or re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}',raw) is None:return None
    try:return dt.datetime.strptime(raw,'%Y-%m-%d %H:%M:%S').isoformat()
    except ValueError:return None
def verify_rows(table,actual,expected):
    require(len(actual)==len(expected),'actual_count')
    indexed={row_key(table,r):r for r in actual}
    require(len(indexed)==len(actual),'actual_duplicate_key')
    for source in expected:
        row=indexed.get(row_key(table,source));require(isinstance(row,dict),'actual_key')
        normalized={key:None for key in OPTIONAL[table]};normalized.update(source)
        require(set(row)==set(normalized)|{'occurred_at','imported_at'},'actual_columns')
        for key,value in normalized.items():
            if key in BIGINTS and value is not None:
                require(exact_integer(row[key])==exact_integer(value),'actual_integer')
            else:require(type(row[key]) is type(value) and row[key]==value,'actual_value')
        require(row['occurred_at']==source_time(source['source_insert_datetime']),'actual_generated_datetime')
        require(isinstance(row['imported_at'],str),'actual_imported_at')
        # Python 3.9 fromisoformat은 5자리 등 PostgreSQL 가변 소수초를 처리하지 못한다.
        value=row['imported_at'].replace('Z','+00:00')
        parsed=dt.datetime.strptime(value,'%Y-%m-%dT%H:%M:%S.%f%z' if '.' in value else '%Y-%m-%dT%H:%M:%S%z')
        require(parsed.tzinfo is not None,'actual_imported_at')
    return digest([{k:r.get(k) for k in sorted(COMMON_FIELDS|OPTIONAL[table])} for r in sorted(actual,key=lambda r:row_key(table,r))])

class Client:
    def __init__(self,config,apply=False):
        base=common.base.Client(config,allow_writes=False)
        require(base.url==common.PROJECT_URL,'project_url')
        self.key=base.key;self.base=base;self.apply=apply
    def request(self,table,query,rows=None,count=False):
        require(table in TABLE_KIND,'table_not_allowed')
        require(rows is None or (self.apply is True and 1<=len(rows)<=500),'write_not_allowed')
        url=common.PROJECT_URL+'/rest/v1/'+table+'?'+urllib.parse.urlencode(query)
        headers={'apikey':self.key,'Authorization':'Bearer '+self.key,'Accept':'application/json'}
        if rows is not None:headers.update({'Content-Type':'application/json','Prefer':'return=representation'})
        elif count:headers['Prefer']='count=exact'
        req=urllib.request.Request(url,data=encoded(rows) if rows is not None else None,headers=headers,method='POST' if rows is not None else 'GET')
        try:
            with urllib.request.urlopen(req,timeout=60) as response:
                require(response.status in ((201,) if rows is not None else (200,206)),'http_status')
                value=json.load(response);require(isinstance(value,list),'http_shape')
                total=None
                if count:
                    match=re.fullmatch(r'(?:[0-9]+-[0-9]+|\*)/([0-9]+)',response.headers.get('Content-Range',''))
                    require(match is not None,'exact_count_missing');total=int(match.group(1))
                return value,total
        except urllib.error.HTTPError as error:
            raise Stop('http_'+str(error.code)) from None
    def batch(self,table,batch):
        value,total=self.request(table,[('select','*'),('import_batch','eq.'+batch),('limit','501')],count=True)
        require(total==len(value) and total<=500,'batch_count');return value
    def count(self,table):
        _,total=self.request(table,[('select','legacy_idx'),('import_batch','like.'+PREFIX+'*'),('limit','1')],count=True)
        return total
    def insert(self,table,rows):
        # PostgREST 일괄 INSERT는 모든 객체의 키가 같아야 한다. 생략 필드의 DB 기본값은 NULL이다.
        require(table in TABLE_KIND,'table_not_allowed')
        normalized=[{**{key:None for key in OPTIONAL[table]},**row} for row in rows]
        return self.request(table,[('select','*')],rows=normalized)[0]
    def verify_members(self,targets):
        actual=self.base.select_all('members','id,meta',[('meta->>source_site','eq.lotto815')])
        require(len(actual)==len(targets),'live_member_count')
        seen=set()
        for row in actual:
            meta=row['meta'];key=str(meta.get('legacy_idx'))
            require(key not in seen and targets.get(key)==row['id'] and meta.get('reco_paused') is True
                    and meta.get('reco_pause_reason')=='legacy_import_review'
                    and meta.get('legacy_consent_review_required') is True,'live_member_identity_or_hold')
            seen.add(key)

def execute(env_file,apply=False,workers=4):
    receipt={'mode':'apply' if apply else 'read_only','stage':'initializing','writes_attempted':0,'inserted_rows':0,'verified_existing_rows':0,'sms_requests':0,'member_changes':0,'payment_changes':0}
    run=None;lock=None
    try:
        require(type(workers) is int and 1<=workers<=4,'worker_limit')
        manifest=load_manifest();targets=target_members()
        lock=os.open(PRIVATE/'execution.lock',os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600)
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        run=PRIVATE/(dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]);run.mkdir(mode=0o700)
        receipt.update(manifest_sha256=MANIFEST_SHA,archive_sha256=p.ARCHIVE_SHA,target_members=len(targets))
        receipt_lock=threading.RLock();stop=threading.Event()
        def step(stage):
            with receipt_lock:
                receipt.update(stage=stage,at_utc=dt.datetime.now(dt.timezone.utc).isoformat());save_receipt(run/'receipt.json',receipt)
        step('verifying_source_and_members');common.verify_archive()
        client=Client(pilot.read_config(env_file),apply=apply);client.verify_members(targets)
        for table,descriptor in manifest['tables'].items():
            require(client.count(table)<=descriptor['rows'],'unexpected_history_count')
        if not apply:
            for table,descriptor in manifest['tables'].items():
                for chunk in descriptor['chunks']:chunk_rows(table,descriptor,chunk,targets)
            step('ready_read_only')
        else:
            def process_chunk(table,descriptor,chunk):
                # 청크 원본키는 겹치지 않는다. 최대 네 요청만 허용하며 첫 오류 뒤 신규 시작은 막는다.
                if stop.is_set():return
                expected=chunk_rows(table,descriptor,chunk,targets)
                actual=client.batch(table,chunk['batch'])
                fence=PRIVATE/(chunk['batch']+'-attempt.json')
                if actual:
                    require(fence.exists(),'untracked_existing_chunk')
                    previous=read_private(fence)
                    require(previous.get('manifest_sha256')==MANIFEST_SHA and previous.get('sha256')==chunk['sha256'],'fence_manifest')
                    actual_sha=verify_rows(table,actual,expected)
                    with receipt_lock:receipt['verified_existing_rows']+=len(expected)
                else:
                    if stop.is_set():return
                    require(not fence.exists() and not fence.is_symlink(),'uncertain_empty_chunk_no_retry')
                    save_new(fence,dict(manifest_sha256=MANIFEST_SHA,table=table,batch=chunk['batch'],sha256=chunk['sha256'],rows=chunk['rows'],receipt_directory=str(run)))
                    fsync_dir(PRIVATE)
                    with receipt_lock:receipt['writes_attempted']+=1;step('inserting_chunks')
                    actual=client.insert(table,expected);verify_rows(table,actual,expected)
                    actual=client.batch(table,chunk['batch']);actual_sha=verify_rows(table,actual,expected)
                    with receipt_lock:receipt['inserted_rows']+=len(expected)
                save_new(run/(chunk['batch']+'-verified.json'),dict(table=table,batch=chunk['batch'],rows=len(expected),actual_sha256=actual_sha,stage='complete_verified'))
                with receipt_lock:
                    receipt['completed_chunks']=receipt.get('completed_chunks',0)+1;step('chunk_complete_verified')
                    if receipt['completed_chunks']%25==0:
                        print(json.dumps(dict(stage=receipt['stage'],table=table,completed_chunks=receipt['completed_chunks'],inserted_rows=receipt['inserted_rows'],verified_existing_rows=receipt['verified_existing_rows'])),flush=True)
            for table,descriptor in manifest['tables'].items():
                receipt.update(table=table);step('verifying_table')
                pending={};queue=iter(descriptor['chunks']);errors=[]
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    def submit_next():
                        chunk=next(queue,None)
                        if chunk is not None:pending[pool.submit(process_chunk,table,descriptor,chunk)]=chunk
                    for _ in range(workers):submit_next()
                    while pending:
                        done,_=wait(pending,return_when=FIRST_COMPLETED)
                        for future in done:
                            chunk=pending.pop(future)
                            try:future.result()
                            except (Exception,SystemExit) as error:
                                stop.set();errors.append({'batch':chunk['batch'],'code':str(error) if isinstance(error,Stop) else 'verification_or_transport_error'})
                        if not stop.is_set():
                            for _ in done:submit_next()
                if errors:
                    receipt['chunk_errors']=errors;raise Stop('chunk_verification_failed')
                require(client.count(table)==descriptor['rows'],'final_table_count')
            client.verify_members(targets);step('complete_verified')
        print(json.dumps(dict(stage=receipt['stage'],inserted_rows=receipt['inserted_rows'],verified_existing_rows=receipt['verified_existing_rows'],receipt_directory=str(run))),flush=True)
        return 0
    except (Exception,SystemExit) as error:
        receipt.update(failed_stage=receipt['stage'],stage='stopped_recovery_required' if receipt['writes_attempted'] else 'stopped_without_history_writes',reason_code=str(error) if isinstance(error,Stop) else 'verification_or_transport_error')
        if run is not None:save_receipt(run/'receipt.json',receipt)
        print(json.dumps({key:receipt[key] for key in ('stage','failed_stage','reason_code','writes_attempted','inserted_rows')}),flush=True);return 1
    finally:
        if lock is not None:fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--env-file',type=Path,required=True);parser.add_argument('--apply',action='store_true');parser.add_argument('--workers',type=int,default=4)
    args=parser.parse_args();raise SystemExit(execute(args.env_file,args.apply,args.workers))
