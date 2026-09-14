#!/usr/bin/env python3
"""불변 815 전체 manifest만 순차 검증/적재한다. 기본은 읽기 전용이다.

--all은 고정 목록을 순서대로 처리한다. 부분/불명확 결과는 즉시 중단하며 다음
실행도 영속 시도표식이 있는 빈 배치를 재호출하지 않는다. 기존 회원·상품·설정·
담당배정·SMS는 수정하지 않는다. 원자 RPC와 보류 집계 RPC만 POST 허용한다.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import copy
import datetime as dt
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('full_815_preparer',ROOT/'scripts/prepare-815-full-review.py')
p=importlib.util.module_from_spec(spec);sys.modules[spec.name]=p;spec.loader.exec_module(p)
common,pilot,loader=p.common,p.pilot,p.loader
Stop,require=p.Stop,p.require
# 준비 완료 후 독립 검토한 manifest SHA만 고정한다. 미고정 상태에서는 어떤 원격 호출도 없다.
MANIFEST_SHA='956e8a89d8335b7ea36c3a72f65fa8ac699ac6be348ce79424474f8607e5a6a9'
PROJECT_URL=common.PROJECT_URL


def validate_rpc(status,value,descriptor):
    expected={'batch_id':descriptor['batch'],'members':descriptor['members'],'payments':descriptor['payments'],
              'amount':descriptor['amount'],'held_members':descriptor['members'],'atomic':True}
    if not (type(status) is int and status==200 and isinstance(value,dict) and p.encoded(value)==p.encoded(expected)):
        error=Stop('atomic_response')
        error.diagnostics=common.base.sanitized_rpc_error(status,value)
        raise error
    return expected


def verify_hold_result(status,value,batch,count):
    expected={'batch_id':batch,'members':count,'held_metadata_members':count,
              'held_rpc_members':count,'consent_review_members':count}
    require(type(status) is int and status==200 and isinstance(value,dict)
            and p.encoded(value)==p.encoded(expected),'hold_verification')
    return expected


class Client(common.base.Client):
    def __init__(self,config,manifest,allow_writes=False):
        super().__init__(config,allow_writes=allow_writes)
        require(p.digest(manifest)==MANIFEST_SHA,'manifest_sha')
        self.approved={d['batch']:copy.deepcopy(d) for d in manifest['batches']}
        self.attempted=set()

    def hold_batch(self,batch,count):
        require(self.url==PROJECT_URL and batch in self.approved
                and re.fullmatch(r'lotto815-[a-z0-9][a-z0-9-]{0,95}',batch) is not None,'hold_request')
        headers={'apikey':self.key,'Authorization':'Bearer '+self.key,'Content-Type':'application/json'}
        status,value=pilot.request_json(PROJECT_URL+'/rest/v1/rpc/admin_verify_815_batch_holds',headers,{'p_batch_id':batch})
        return verify_hold_result(status,value,batch,count)

    def apply_atomic(self,data,descriptor):
        batch=descriptor['batch']
        require(self.url==PROJECT_URL and self.allow_writes is True and batch not in self.attempted,'write_mode')
        require(batch in self.approved and p.encoded(descriptor)==p.encoded(self.approved[batch]),'unapproved_batch')
        p.validate_unit(data,descriptor)
        self.attempted.add(batch)
        body={'p_batch_id':batch,'p_members':data['members'],'p_payments':data['payments'],
              'p_expected_member_count':descriptor['members'],'p_expected_payment_count':descriptor['payments'],
              'p_expected_amount':descriptor['amount']}
        headers={'apikey':self.key,'Authorization':'Bearer '+self.key,'Content-Type':'application/json'}
        status,value=pilot.request_json(PROJECT_URL+'/rest/v1/rpc/admin_import_815_review_batch',headers,body)
        return validate_rpc(status,value,descriptor)

    def check_only(self,*unused):
        raise Stop('sms_http_forbidden')


def read_family(client):
    filters=[('meta->>source_site','eq.lotto815'),('meta->>import_batch','like.'+p.PREFIX+'*')]
    return {table:client.select_all(table,'*',filters) for table in ('members','payments')}


def batch_rows(client,batch):
    filters=[('meta->>source_site','eq.lotto815'),('meta->>import_batch','eq.'+batch)]
    return {table:client.select_all(table,'*',filters) for table in ('members','payments')}


def verify_unit_rows(actual,data,descriptor):
    counts=(len(actual['members']),len(actual['payments']),sum(r['amount'] for r in actual['payments']))
    if counts==(0,0,0):
        return 'empty'
    require(counts==(descriptor['members'],descriptor['payments'],descriptor['amount']),'partial_batch')
    for table in ('members','payments'):
        indexed={r['id']:r for r in actual[table]}
        require(len(indexed)==len(actual[table])==len(data[table]),'duplicate_actual_row')
        for row in data[table]:
            expected={**common.DB_DEFAULTS[table],**row}
            got=indexed.get(row['id'])
            require(isinstance(got,dict) and set(got)==set(expected)
                    and common.base.canonical(got,expected)==common.base.canonical(expected,expected),'whole_row_mismatch')
    return 'complete'


def verify_progress(actual,manifest,units):
    allowed={d['batch'] for d in manifest['batches']}
    grouped={table:defaultdict(list) for table in ('members','payments')}
    for table in ('members','payments'):
        for row in actual[table]:
            batch=(row.get('meta') or {}).get('import_batch')
            require(batch in allowed,'unexpected_family_batch')
            grouped[table][batch].append(row)
    states=[]
    for data,descriptor in zip(units,manifest['batches']):
        rows={table:grouped[table][descriptor['batch']] for table in grouped}
        states.append(verify_unit_rows(rows,data,descriptor))
    completed=0
    for state in states:
        if state=='empty':
            break
        completed+=1
    require(all(state=='empty' for state in states[completed:]),'completed_batches_out_of_order')
    return completed


def check_protected(client,manifest,baseline):
    require(p.digest(baseline)==manifest['protected_sha256'],'protected_baseline_sha')
    current=p.protected_snapshot(client)
    require(p.digest(current)==manifest['protected_sha256'],'protected_216_changed')
    return current


def check_all_products(client,units):
    products={row['id']:row for data in units for row in data['products']}
    if products:
        common.check_products(client,p.make_plan({'members':[],'payments':[],'products':list(products.values())}))


class Store:
    def __init__(self,root=p.PRIVATE):
        self.root=root
        for path in (root,*root.parents):
            require(not path.is_symlink(),'private_symlink')
        require(root.is_dir(),'manifest_missing')
        common.require_private(root,directory=True)
        self.fd=None;self.run=None

    def __enter__(self):
        fd=os.open(self.root/'execution.lock',os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600)
        try:
            info=os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid(),'private_lock')
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except Exception:
            os.close(fd)
            raise Stop('execution_locked') from None
        os.fchmod(fd,0o600);self.fd=fd
        self.run=self.root/(dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8])
        self.run.mkdir(mode=0o700)
        return self

    def __exit__(self,*unused):
        if self.fd is not None:
            fcntl.flock(self.fd,fcntl.LOCK_UN);os.close(self.fd);self.fd=None

    def load(self,expected_sha=None):
        expected_sha=MANIFEST_SHA if expected_sha is None else expected_sha
        require(re.fullmatch(r'[0-9a-f]{64}',expected_sha) is not None,'manifest_not_pinned')
        manifest=p.private_read(self.root/'manifest.json')
        require(p.digest(manifest)==expected_sha,'manifest_sha')
        units=[]
        for descriptor in manifest['batches']:
            require(descriptor['file']==f"batch-{descriptor['index']:03d}.json",'batch_path')
            units.append(p.private_read(self.root/descriptor['file']))
        p.validate_manifest(manifest,units)
        baseline=p.private_read(self.root/'protected-baseline.json')
        require(p.digest(baseline)==manifest['protected_sha256'],'protected_baseline_sha')
        return manifest,units,baseline

    def save(self,receipt):
        pilot.private_json(self.run/'receipt.json',receipt)

    def save_batch(self,index,value):
        pilot.private_json(self.run/f'batch-{index:03d}-receipt.json',value)

    def fence(self,index):
        p.batch_name(index)
        return self.root/f'batch-{index:03d}-attempt.json'

    def attempted(self,index):
        path=self.fence(index)
        return path.exists() or path.is_symlink()

    def mark_attempt(self,descriptor):
        require(not self.attempted(descriptor['index']),'prior_uncertain_attempt')
        p.private_write(self.fence(descriptor['index']),{'family':p.FAMILY,'batch':descriptor['batch'],
             'payload_sha256':descriptor['payload_sha256'],'manifest_sha256':MANIFEST_SHA,
             'at_utc':dt.datetime.now(dt.timezone.utc).isoformat(),'receipt_directory':str(self.run)})
        fd=os.open(self.root,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)


def run(client,store,manifest,units,baseline,*,apply=False,all_batches=False,batch_index=None,
        archive_verifier=common.verify_archive,state_reader=pilot.minimal_state):
    receipt={'family':p.FAMILY,'manifest_sha256':p.digest(manifest),'archive_sha256':p.ARCHIVE_SHA,
             'mode':'apply' if apply else 'read_only','stage':'initializing','writes_attempted':False,
             'atomic_calls':0,'sms_requests':0,'product_changes':0,'assignment_changes':0,
             'http_sms_endpoint_verification':'not_performed_domain_blocked','completed':[], 'stages':[]}
    current=None
    def step(stage,**updates):
        receipt.update(updates);receipt['stage']=stage
        receipt['stages'].append({'stage':stage,'at_utc':dt.datetime.now(dt.timezone.utc).isoformat()})
        store.save(receipt)
    try:
        require(client.allow_writes is apply,'write_mode')
        require(all_batches is True or type(batch_index) is int,'explicit_batch_required')
        if not all_batches:require(1<=batch_index<=len(units),'batch_index')
        step('verifying_archive_and_fixed_manifest')
        archive_verifier()
        p.validate_manifest(manifest,units)
        protected=check_protected(client,manifest,baseline)
        for data in units:p.verify_schema(protected,data)
        check_all_products(client,units)
        progress=verify_progress(read_family(client),manifest,units)
        receipt['initial_completed_batches']=progress
        # 완료된 모든 행과 보류 집계를 다시 확인한다. 신규 후보는 계산하지 않는다.
        for descriptor in manifest['batches'][:progress]:
            client.hold_batch(descriptor['batch'],descriptor['members'])
        if not all_batches and batch_index<=progress:
            step('already_complete_verified_noop',final_completed_batches=progress)
        elif progress==len(units):
            step('already_complete_verified_noop',final_completed_batches=progress)
        else:
            first=progress+1
            require(all_batches or batch_index==first,'batch_order')
            indices=list(range(first,len(units)+1)) if all_batches else [batch_index]
            for index in indices:require(not store.attempted(index),'prior_uncertain_attempt')
            step('reading_existing_conflicts')
            state=state_reader(client)
            for index in indices:common.check_conflicts(state,p.make_plan(units[index-1]))
            # 읽기 전용 보류 RPC가 없으면 INSERT 전에 중단한다.
            for index in indices:client.hold_batch(manifest['batches'][index-1]['batch'],0)
            step('ready_read_only',pending_batches=len(indices),pending_members=sum(manifest['batches'][i-1]['members'] for i in indices))
            if apply:
                for index in indices:
                    descriptor=manifest['batches'][index-1];data=units[index-1];current=descriptor
                    # 고정 파일을 직전에 다시 읽는다. 상태 충돌은 서버의 테이블 잠금 안에서도 검사한다.
                    fresh=p.private_read(store.root/descriptor['file'])
                    p.validate_unit(fresh,descriptor)
                    require(p.encoded(fresh)==p.encoded(data),'payload_changed')
                    check_protected(client,manifest,baseline)
                    require(verify_unit_rows(batch_rows(client,descriptor['batch']),data,descriptor)=='empty','batch_changed')
                    client.hold_batch(descriptor['batch'],0)
                    common.check_conflicts(state,p.make_plan(data))
                    check_all_products(client,[data])
                    before={'stage':'prepared_for_atomic','batch':descriptor['batch'],
                            'payload_sha256':descriptor['payload_sha256'],'manifest_sha256':p.digest(manifest),
                            'expected_members':descriptor['members'],'expected_payments':descriptor['payments'],
                            'expected_amount':descriptor['amount'],'protected_216_sha256':manifest['protected_sha256'],
                            'sms_requests':0,'http_sms_endpoint_verification':'not_performed_domain_blocked'}
                    store.save_batch(index,before)
                    store.mark_attempt(descriptor)
                    step('applying_atomic_batch',writes_attempted=True,current_batch=descriptor['batch'],atomic_calls=receipt['atomic_calls']+1)
                    started=time.monotonic()
                    result=client.apply_atomic(data,descriptor)
                    elapsed=time.monotonic()-started
                    validate_rpc(200,result,descriptor)
                    step('verifying_atomic_batch',last_rpc_seconds=round(elapsed,6))
                    actual=batch_rows(client,descriptor['batch'])
                    require(verify_unit_rows(actual,data,descriptor)=='complete','partial_batch')
                    hold=client.hold_batch(descriptor['batch'],descriptor['members'])
                    check_protected(client,manifest,baseline)
                    completed={**before,'stage':'complete_verified','atomic_result':result,'hold_result':hold,
                               'actual_rows_sha256':p.digest(p.canonical_snapshot(actual)),
                               'atomic_rpc_seconds':round(elapsed,6),'protected_216_unchanged':True}
                    store.save_batch(index,completed)
                    receipt['completed'].append({'batch':descriptor['batch'],'members':descriptor['members'],
                         'payments':descriptor['payments'],'amount':descriptor['amount'],'atomic_rpc_seconds':round(elapsed,6)})
                    step('batch_complete_verified',current_batch=descriptor['batch'])
                    print(json.dumps({'stage':'batch_complete_verified',**receipt['completed'][-1]},ensure_ascii=False),flush=True)
                    # 초기 상태에는 이번 실행의 확정 행만 추가한다. 외부 충돌은 다음 원자 RPC가 최신 상태로 거부한다.
                    for row in data['members']:
                        state.member_ids.add(row['id']);state.user_ids.add(row['user_id']);state.phones.add(row['phone'])
                        state.legacy_member_ids[('lotto815',row['meta']['legacy_idx'])]=row['id']
                    for row in data['payments']:
                        state.payment_ids.add(row['id']);state.legacy_payment_keys.add(('lotto815',row['meta']['legacy_idx']))
                step('verifying_completed_family')
                final_progress=verify_progress(read_family(client),manifest,units)
                require(final_progress==indices[-1],'unexpected_final_progress')
                check_protected(client,manifest,baseline)
                check_all_products(client,units)
                step('complete_verified',final_completed_batches=final_progress,
                     all_manifest_batches_complete=final_progress==len(units),protected_216_unchanged=True)
        print(json.dumps({'stage':receipt['stage'],'atomic_calls':receipt['atomic_calls'],
                          'initial_completed_batches':receipt.get('initial_completed_batches'),
                          'final_completed_batches':receipt.get('final_completed_batches'),
                          'all_manifest_batches_complete':receipt.get('all_manifest_batches_complete',False),
                          'receipt_directory':str(store.run)},ensure_ascii=False),flush=True)
        return 0
    except (Exception,SystemExit) as error:
        receipt['failed_stage']=receipt['stage'];receipt['stage']='stopped_recovery_required' if receipt['writes_attempted'] else 'stopped_without_customer_writes'
        receipt['reason_code']=error.code if isinstance(error,Stop) else 'verification_or_transport_error'
        if isinstance(error,Stop) and hasattr(error,'diagnostics'):receipt['rpc_error']=error.diagnostics
        if current is not None:
            try:
                observed=batch_rows(client,current['batch'])
                receipt['observed_current_batch']={'members':len(observed['members']),'payments':len(observed['payments']),
                                                   'amount':sum(r['amount'] for r in observed['payments'])}
            except (Exception,SystemExit):receipt['observed_current_batch_unavailable']=True
        try:store.save(receipt)
        except (Exception,SystemExit):receipt['receipt_write_failed']=True
        print(json.dumps({'stage':receipt['stage'],'reason_code':receipt['reason_code'],'atomic_calls':receipt['atomic_calls'],
                          'observed_current_batch':receipt.get('observed_current_batch'),'rpc_error':receipt.get('rpc_error'),
                          'receipt_directory':str(store.run)},ensure_ascii=False),flush=True)
        return 1


def execute(env_file,apply=False,all_batches=False,batch_index=None):
    try:
        with Store() as store:
            manifest,units,baseline=store.load()
            config=pilot.read_config(env_file)
            return run(Client(config,manifest,allow_writes=apply),store,manifest,units,baseline,
                       apply=apply,all_batches=all_batches,batch_index=batch_index)
    except (Exception,SystemExit) as error:
        print(json.dumps({'stage':'stopped_without_customer_writes','reason_code':error.code if isinstance(error,Stop) else 'initialization_failed'},ensure_ascii=False))
        return 1


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file',type=Path,default=ROOT/'.env.local')
    parser.add_argument('--apply',action='store_true')
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--all',dest='all_batches',action='store_true')
    group.add_argument('--batch',dest='batch_index',type=int)
    args=parser.parse_args()
    raise SystemExit(execute(args.env_file,args.apply,args.all_batches,args.batch_index))
