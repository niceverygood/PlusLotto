#!/usr/bin/env python3
"""Prepare exact frozen 19,021-member legacy history locally; never contacts a service.

Keeps reviewed raw MySQL literals and decoded INSERT rows separately. A malformed
record is withheld by key/error code only. All target manifests/archive hashes,
source primary keys, references, and full table row counts are checked. Output is
private and incomplete files are never renamed to ready until table validation.
"""
from __future__ import annotations
from collections import Counter
import datetime as dt
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import zipfile
from legacy_815_history_payload import InvalidHistory, history_insert_payload

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fixed_815_history_preparer', ROOT/'scripts/prepare-815-history-review.py')
p = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = p
spec.loader.exec_module(p)
require, Stop = p.require, p.Stop
FULL = p.BACKUP/'lotto815-20260910-full-review'
FULL_SHA = '956e8a89d8335b7ea36c3a72f65fa8ac699ac6be348ce79424474f8607e5a6a9'
OUT = p.BACKUP/'history-full-review-19021-20260910'
BATCH_PREFIX = 'lotto815-hist-20260910-'
BATCH_KIND = {'userMemo':'memo','pushSms':'sms','gameBettingNlotto':'win'}
CHUNK_SIZE = 500


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def add_unit_targets(data, descriptor, targets):
    require(digest(data) == descriptor['payload_sha256'], 'target_unit_sha')
    require(set(data) == {'members','payments','products'}, 'target_unit_shape')
    require(len(data['members']) == descriptor['members'] and len(data['payments']) == descriptor['payments']
            and sum(r['amount'] for r in data['payments']) == descriptor['amount'], 'target_unit_counts')
    for row in data['members']:
        p.validate_target_member(row, descriptor['batch'], targets)


def all_targets():
    manifest = p.private_read(FULL/'manifest.json')
    require(digest(manifest) == FULL_SHA and manifest['archive_sha256'] == p.ARCHIVE_SHA
            and manifest['members'] == 18805 and len(manifest['batches']) == 76, 'full_manifest_identity')
    targets, protected = p.target_members()
    require(len(targets) == 216, 'protected_target_count')
    for index, descriptor in enumerate(manifest['batches'], 1):
        require(descriptor['index'] == index and descriptor['file'] == f'batch-{index:03d}.json'
                and descriptor['batch'] == f'lotto815-20260910-full-{index:03d}', 'target_batch_identity')
        add_unit_targets(p.private_read(FULL/descriptor['file']), descriptor, targets)
    require(len(targets) == 19021, 'full_target_count')
    return targets, protected


class PrivateJsonLines:
    def __init__(self, directory, name, *, chunks=False, batch_kind=None):
        self.final = directory/name
        self.partial = directory/(name+'.partial')
        require(not self.final.exists() and not self.final.is_symlink(), 'ready_output_exists')
        fd = os.open(self.partial, os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0), 0o600)
        self.stream = os.fdopen(fd,'wb')
        self.hash = hashlib.sha256()
        self.chunk_hash = hashlib.sha256()
        self.rows = self.size = self.chunk_rows = self.chunk_bytes = self.chunk_offset = 0
        self.chunks = []
        self.index_chunks = chunks
        self.batch_kind = batch_kind

    def current_batch(self):
        require(self.batch_kind in ('memo','sms','win'), 'chunk_batch_kind')
        return BATCH_PREFIX + self.batch_kind + f'-{len(self.chunks)+1:05d}'

    def write(self, value):
        line = encoded(value)+b'\n'
        self.stream.write(line)
        self.hash.update(line)
        self.rows += 1
        self.size += len(line)
        if self.index_chunks:
            self.chunk_hash.update(line)
            self.chunk_rows += 1
            self.chunk_bytes += len(line)
            if self.chunk_rows == CHUNK_SIZE:
                self.end_chunk()

    def end_chunk(self):
        if self.chunk_rows:
            self.chunks.append(dict(index=len(self.chunks)+1, offset=self.chunk_offset,
                length=self.chunk_bytes, rows=self.chunk_rows, sha256=self.chunk_hash.hexdigest(), batch=self.current_batch()))
            self.chunk_offset += self.chunk_bytes
            self.chunk_rows = self.chunk_bytes = 0
            self.chunk_hash = hashlib.sha256()

    def close(self):
        if not self.stream.closed:
            self.stream.flush()
            os.fsync(self.stream.fileno())
            self.stream.close()

    def finish(self):
        self.close()
        self.end_chunk()
        self.partial.rename(self.final)
        result = dict(file=self.final.name, rows=self.rows, bytes=self.size, sha256=self.hash.hexdigest())
        if self.index_chunks:
            result['chunks'] = self.chunks
        return result


class DecodeWriter:
    """Adapter for unchanged streaming source validator; records only reviewed output."""
    def __init__(self, targets, raw, typed, held):
        self.targets, self.raw, self.typed, self.held = targets, raw, typed, held
        self.ready_counts, self.held_counts = Counter(), Counter()
        self.error_codes, self.body_policies = Counter(), Counter()
        self.reclassified = 0

    def write(self, line):
        record = json.loads(line)
        try:
            table, payload = history_insert_payload(record, archive_sha256=p.ARCHIVE_SHA,
                import_batch=self.typed.current_batch(), expected_members=self.targets)
            if table == 'legacy_member_sms' and payload['body_policy'] != 'body_preserved':
                # Always strip withheld raw bodies, even if already labelled withheld upstream.
                if payload['body_policy'] != record['body_policy']:
                    self.reclassified += 1
                record['body_policy'] = payload['body_policy']
                record['source_sql_values'] = {k:v for k,v in record['source_sql_values'].items()
                    if k in ('idx','userIdx','typeCode','contentsTypeCode','insertDateTime','updateDateTime','reserveDateTime')}
                table, payload = history_insert_payload(record, archive_sha256=p.ARCHIVE_SHA,
                    import_batch=self.typed.current_batch(), expected_members=self.targets)
            if table == 'legacy_member_sms':
                self.body_policies[payload['body_policy']] += 1
            self.raw.write(record)
            self.typed.write(payload)
            self.ready_counts[record['source_user_idx']] += 1
        except InvalidHistory as error:
            # Raw unsafe/undecodable body remains solely in the original archive.
            self.held_counts[record['source_user_idx']] += 1
            self.error_codes[str(error)] += 1
            self.held.write(dict(source_site='lotto815',source_table=record['source_table'],
                legacy_key=record['legacy_key'],source_user_idx=record['source_user_idx'],
                target_member_id=record['target_member_id'],error_code=str(error)))


def main():
    archive_hash = hashlib.sha256()
    with p.ARCHIVE.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):
            archive_hash.update(block)
    require(archive_hash.hexdigest() == p.ARCHIVE_SHA, 'archive_hash')
    targets, protected = all_targets()
    users = p.loader.DumpSource('lotto815',archive=str(p.ARCHIVE)).load('user')
    source_ids = {int(r['idx']) for r in users}
    require(len(source_ids) == len(users) == 21809 and set(targets) <= source_ids, 'source_target_reference')
    del users
    require(not any(path.is_symlink() for path in (OUT,*OUT.parents)), 'output_symlink')
    require(not OUT.exists(), 'output_exists')
    require(shutil.disk_usage(p.BACKUP).free > 10*1024**3, 'output_disk_space')
    OUT.mkdir(mode=0o700)
    counts = {idx:dict(target_member_id=target,tables={}) for idx,target in targets.items()}
    manifest = dict(format_version=1,stage='preparing',source_archive_sha256=p.ARCHIVE_SHA,
        target_manifest_sha256=FULL_SHA,target_member_count=len(targets),protected_targets=protected,
        import_batch_prefix=BATCH_PREFIX,prepared_at_utc=dt.datetime.now(dt.timezone.utc).isoformat(),
        tables={},counts_file='per-member-counts.json',held_file='held-records.jsonl',
        db_reads=0,db_writes=0,sms_requests=0,
        limitations=['Offline payload preparation; target members and histories require separate production verification.',
            'Dates are original wall time; insert timestamps do not prove SMS delivery.',
            'Credential or unreviewed SMS body/subject/contacts are withheld; no universal secret-removal guarantee.',
            'Raw file preserves selected allowed SQL literals only; complete source archive remains authoritative.'])
    held = PrivateJsonLines(OUT,'held-records.jsonl')
    opened = [held]
    try:
        with zipfile.ZipFile(p.ARCHIVE) as archive:
            for source_table in p.EXPECTED:
                names=[name for name in archive.namelist() if name.endswith('/lotto815_'+source_table+'.sql.gz')]
                require(len(names)==1,'source_table_archive')
                from legacy_815_history_payload import TABLES
                destination=TABLES[source_table]
                raw=PrivateJsonLines(OUT,source_table+'.raw.jsonl')
                typed=PrivateJsonLines(OUT,destination+'.jsonl',chunks=True,batch_kind=BATCH_KIND[source_table])
                opened.extend([raw,typed])
                writer=DecodeWriter(targets,raw,typed,held)
                with archive.open(names[0]) as zipped, gzip.GzipFile(fileobj=zipped) as unpacked:
                    with io.TextIOWrapper(unpacked,encoding='utf-8',errors='strict') as text:
                        summary, selected=p.process_table(source_table,text,targets,source_ids,writer,progress=True)
                require(sum(writer.ready_counts.values())+sum(writer.held_counts.values())==summary['selected_rows'], 'decoded_count')
                result=typed.finish()
                result.update(source_table=source_table,raw=raw.finish(),source_summary=summary,
                    held_rows=sum(writer.held_counts.values()),held_errors=dict(writer.error_codes),
                    final_sms_body_policy=dict(writer.body_policies),post_decode_reclassified=writer.reclassified)
                manifest['tables'][destination]=result
                for idx in targets:
                    require(selected[idx] == writer.ready_counts[idx]+writer.held_counts[idx], 'member_decoded_count')
                    counts[idx]['tables'][destination]=dict(source=selected[idx],ready=writer.ready_counts[idx],held=writer.held_counts[idx])
                print(json.dumps({'table':destination,'ready_rows':result['rows'],'held_rows':result['held_rows'],
                    'payload_bytes':result['bytes']},ensure_ascii=False),flush=True)
        manifest['held_records']=held.finish()
        p.private_json(OUT/manifest['counts_file'], counts)
        with (OUT/manifest['counts_file']).open('rb') as stream:
            count_hash=hashlib.sha256()
            for block in iter(lambda:stream.read(1024*1024),b''): count_hash.update(block)
            manifest['counts_sha256']=count_hash.hexdigest()
        manifest['stage']='prepared_offline_with_held_records' if manifest['held_records']['rows'] else 'prepared_offline_only'
        manifest['total_payload_rows']=sum(t['rows'] for t in manifest['tables'].values())
        manifest['total_payload_bytes']=sum(t['bytes'] for t in manifest['tables'].values())
        p.private_json(OUT/'manifest.json',manifest)
        print(json.dumps({'stage':manifest['stage'],'manifest_path':str(OUT/'manifest.json'),
            'manifest_sha256':digest(manifest),'target_members':len(targets),
            'total_payload_rows':manifest['total_payload_rows'],'total_payload_bytes':manifest['total_payload_bytes'],
            'held_rows':manifest['held_records']['rows']},ensure_ascii=False),flush=True)
        return 0
    except (Stop,UnicodeError,gzip.BadGzipFile,zipfile.BadZipFile) as error:
        manifest['stage']='incomplete'
        manifest['error_code']=str(error) if isinstance(error,Stop) else 'source_encoding_or_archive'
        p.private_json(OUT/'incomplete.json',manifest)
        print(json.dumps({'stage':'incomplete','error_code':manifest['error_code']}),flush=True)
        return 1
    finally:
        for output in opened:
            output.close()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Stop as error:
        print(json.dumps({'stage':'stopped','error_code':str(error)}),flush=True)
        raise SystemExit(1)
