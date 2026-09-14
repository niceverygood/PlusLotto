#!/usr/bin/env python3
"""Prepare/apply only the frozen collision cohort's historical rows.

Reuses the verified streaming decoder, 500-row fences, exact row comparator,
and INSERT-only runner. New manifest, destination directory, and batch prefix
are separate from completed 19,021-member history. Requires applied members.
"""
from __future__ import annotations
import argparse
import importlib.util
from pathlib import Path
import re
import sys
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file);m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m
c=module('collision_history_members','run-815-collision-review.py')
p=module('collision_history_preparer','prepare-815-full-history-review.py')
r=module('collision_history_runner','run-815-history-full.py')
OUT=c.BACKUP/'history-collision-2666-20260914'
PREFIX='lotto815-hist-collision-20260914-'
EXPECTED={'legacy_member_memos':34966,'legacy_member_sms':196368,'legacy_member_wins':51268}

def frozen_targets(member_sha):
    c.require(re.fullmatch('[0-9a-f]{64}',member_sha or ''),'member_manifest_sha_required')
    manifest=c.read(c.PRIVATE/'manifest.json');c.require(c.digest(manifest)==member_sha,'member_manifest_sha')
    units=[c.read(c.PRIVATE/f'batch-{i:03d}.json') for i in range(1,len(manifest['batches'])+1)];c.verify_manifest(manifest,units)
    targets={row['meta']['legacy_idx']:row['id'] for u in units for row in u['members']}
    c.require(len(targets)==2666 and len(set(targets.values()))==2666,'target_count')
    return manifest,units,targets

def verify_applied(env_file,manifest,units):
    client=c.Client(env_file)
    for data,d in zip(units,manifest['batches']):
        c.require(c.verify_actual(client.batch(d['batch']),data,d)=='complete','members_not_complete');client.hold(d,d['members'])

def load_history_manifest(member_sha,history_sha):
    value=r.read_private(OUT/'manifest.json')
    r.require(r.digest(value)==history_sha,'history_manifest_sha')
    r.require(value['stage']=='prepared_offline_only' and value['held_records']['rows']==0 and value['format_version']==1 and value['source_archive_sha256']==c.ARCHIVE_SHA and value['target_manifest_sha256']==member_sha and value['target_member_count']==2666 and value['import_batch_prefix']==PREFIX,'manifest_scope')
    r.require(set(value['tables'])==set(EXPECTED),'manifest_tables')
    for table,d in value['tables'].items():
        r.require(d['file']==table+'.jsonl' and d['rows']==EXPECTED[table],'manifest_table_counts')
        path=OUT/d['file'];r.safe_file(path);r.require(path.stat().st_size==d['bytes'] and r.file_digest(path)==d['sha256'],'history_file_sha')
        offset=rows=0
        for i,chunk in enumerate(d['chunks'],1):
            r.require(chunk['index']==i and chunk['offset']==offset and type(chunk['rows'])is int and 1<=chunk['rows']<=500 and type(chunk['length'])is int and chunk['length']>0 and chunk['batch']==f'{PREFIX}{r.TABLE_KIND[table]}-{i:05d}' and re.fullmatch('[0-9a-f]{64}',chunk['sha256']),'chunk_manifest')
            offset+=chunk['length'];rows+=chunk['rows']
        r.require(offset==d['bytes'] and rows==d['rows'],'chunk_totals')
    return value

class ScopedClient(r.Client):
    def verify_members(self,targets):
        actual=self.base.select_all('members','id,meta',[('meta->>source_site','eq.lotto815'),('meta->>import_batch','like.'+c.FAMILY+'-*')])
        r.require(len(actual)==len(targets),'live_member_count');seen=set()
        for row in actual:
            m=row['meta'];key=str(m.get('legacy_idx'))
            r.require(key not in seen and targets.get(key)==row['id'] and m.get('reco_paused') is True and m.get('reco_pause_reason')=='legacy_import_review' and m.get('legacy_consent_review_required') is True,'member_identity_hold');seen.add(key)

def execute(env_file,member_sha,history_sha=None,prepare=False,apply=False,workers=4):
    manifest,units,targets=frozen_targets(member_sha)
    verify_applied(env_file,manifest,units)
    if prepare:
        c.require(not apply,'prepare_cannot_apply')
        p.OUT=OUT;p.BATCH_PREFIX=PREFIX;p.FULL_SHA=member_sha
        p.all_targets=lambda:(targets,{'collision_member_manifest_sha256':member_sha,'source_members':2666,'previous_19021_excluded':True})
        result=p.main()
        if result==0:
            h=c.read(OUT/'manifest.json');c.require({k:v['rows'] for k,v in h['tables'].items()}==EXPECTED,'history_source_count')
        return result
    c.require(re.fullmatch('[0-9a-f]{64}',history_sha or ''),'history_manifest_sha_required')
    r.PRIVATE=OUT;r.PREFIX=PREFIX;r.MANIFEST_SHA=history_sha
    r.target_members=lambda:{str(k):v for k,v in targets.items()}
    r.load_manifest=lambda:load_history_manifest(member_sha,history_sha)
    r.Client=ScopedClient
    return r.execute(env_file,apply,workers)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--env-file',type=Path,required=True);parser.add_argument('--member-manifest-sha',required=True);parser.add_argument('--history-manifest-sha');parser.add_argument('--prepare',action='store_true');parser.add_argument('--apply',action='store_true');parser.add_argument('--workers',type=int,default=4)
    args=parser.parse_args()
    try:raise SystemExit(execute(args.env_file,args.member_manifest_sha,args.history_manifest_sha,args.prepare,args.apply,args.workers))
    except (c.Stop,p.Stop,r.Stop) as error:print(c.encoded({'stage':'stopped','reason_code':str(error)}));raise SystemExit(1)
