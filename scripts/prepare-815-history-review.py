#!/usr/bin/env python3
"""고정 216개 원본 회원의 과거 이력만 비공개 파일로 준비한다. 원격 기능 없음.

SQL은 실행하지 않는다. 기존 스트리밍 파서를 재사용하되 전체 행수·컬럼·원본키·
회원 참조를 검증한다. 미완료 파일은 .partial이며 전수 대조 후에만 이름을 확정한다.
본문은 MySQL 덤프 토큰 그대로 보관하며 아직 화면 표시용 디코딩/운영 이관이 아니다.
인증 문자와 미확인 문자 유형은 본문/제목/연락처를 복사하지 않는다.
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
import stat
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = Path('/Users/seungsoohan/Library/Containers/com.kakao.KakaoTalkMac/Data/Downloads/815korean_paid_all_20260831 (2).zip')
ARCHIVE_SHA = 'f818dd0fae1b62d2f67893995aeb83e3af698cb36e0a80352164f4429c0dc56d'
BACKUP = Path('/Users/seungsoohan/Documents/백업/Backups/PlusLotto/legacy-import-20260910')
FROZEN = (
    (BACKUP/'lotto815-20260909-pilot-001/20260909T213135Z-6a4b10f8/intended-rows.json', 100, None),
    (BACKUP/'lotto815-20260910-pilot-002-review/frozen-intended-rows.json', 100,
     'b52b3b07f9c4305e7b74345fc8b7d3611cf42db4c78ec2c16eb3c9b9d31fe0d2'),
    (BACKUP/'lotto815-20260910-compensation-003/frozen-intended-rows.json', 16,
     '4c5838c12f81c5831052973c65d697510368bb09cc4946f30854f844757e0389'),
)
BATCHES = ('lotto815-20260909-pilot-001','lotto815-20260910-pilot-002-review',
           'lotto815-20260910-compensation-003')
FIRST_IDENTITY_SHA = 'b743a3fae03d68cb849adff0f87640a1960745cb6d9aacc7fa1874f26b31ef59'
EXPECTED = {'userMemo': (271925, 22), 'pushSms': (2276481, 35), 'gameBettingNlotto': (500945, 20)}
FIELDS = {
    'userMemo': ('idx,userIdx,salesIdx,statCode,statTmCode,groupTeamOpenYN,typeCode,contents,'
                 'insertUserIdx,insertDateTime,updateUserIdx,updateDateTime,reservYN,reservCheckYN,reservDateTime').split(','),
    'pushSms': ('idx,userIdx,salesIdx,statCode,typeCode,contentsTypeCode,contentsCode,resultCode,resultYN,'
                'resultCountdown,insertUserIdx,insertDateTime,updateUserIdx,updateDateTime,reserveDateTime').split(','),
    'gameBettingNlotto': ('idx,num,userIdx,statCode,checkYN,pickTypeCode,pickFromCode,pickStr,grade,prize,'
                         'insertDateTime,updateDateTime').split(','),
}
TIME_FIELDS = {'userMemo': ('insertDateTime','updateDateTime','reservDateTime'),
               'pushSms': ('insertDateTime','updateDateTime','reserveDateTime'),
               'gameBettingNlotto': ('insertDateTime','updateDateTime')}
SAFE_SMS_TYPES = frozenset(('autoPick','adminPickSend','autoPickReSend','autoPickRecovery'))
CREDENTIAL_PATTERN = re.compile(r'비밀번호|비번|인증번호|인증코드|임시\s*번호|password|passwd|\botp\b|(?:api[_-]?key|access[_-]?token)\s*[:=]|[?&](?:token|key|auth)=', re.I)


class Stop(ValueError):
    pass


def require(ok, code):
    if not ok:
        raise Stop(code)


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


stream_parser = module('history_stream_parser', 'summarize-pushsms.py')
loader = module('history_source_loader', 'load-legacy-site.py')


def private_json(path, value):
    fd = os.open(path, os.O_CREAT|os.O_EXCL|os.O_WRONLY|getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
        stream.write('\n')


def private_read(path):
    require(not any(item.is_symlink() for item in (path, *path.parents)), 'symlink_path')
    fd = os.open(path, os.O_RDONLY|getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_uid == os.getuid() and info.st_size < 8*1024*1024, 'unsafe_private_file')
        return json.load(stream)


def validate_target_member(row, batch, targets):
    meta = row['meta']
    idx = meta['legacy_idx']
    require(type(idx) is int and idx > 0 and idx not in targets and meta['source_site'] == 'lotto815'
            and meta.get('import_batch') == batch
            and row['id'] == loader.stable_id('member','lotto815',idx), 'frozen_member_key_mismatch')
    targets[idx] = row['id']


def target_members():
    targets = {}
    fingerprints = []
    for batch, (path, count, expected_hash) in zip(BATCHES, FROZEN):
        require(path.relative_to(BACKUP).parts[0] == batch, 'frozen_batch_path_mismatch')
        saved = private_read(path)
        payload = saved.get('payload', saved)
        require(len(payload['members']) == count, 'frozen_count_mismatch')
        digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                          separators=(',', ':')).encode()).hexdigest()
        if expected_hash:
            require(digest == expected_hash, 'frozen_hash_mismatch')
            require(saved.get('payload_sha256') == digest and saved.get('batch') == batch
                    and saved.get('archive_sha256') == ARCHIVE_SHA, 'frozen_manifest_mismatch')
        else:
            receipt = private_read(path.parent/'receipt.json')
            identity = {'member_ids':[row['id'] for row in payload['members']],
                        'payments':[(row['id'],row['member_id'],row['amount']) for row in payload['payments']]}
            identity_sha = hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            require(identity_sha == FIRST_IDENTITY_SHA and receipt.get('stage') == 'complete_verified',
                    'first_completed_identity_mismatch')
        fingerprints.append({'batch':batch, 'members':count, 'payload_sha256':digest,
                             'authorized_identity_and_source_mapping_verified':True})
        for row in payload['members']:
            validate_target_member(row,batch,targets)
    require(len(targets) == 216 and len(set(targets.values())) == 216, 'frozen_union_mismatch')
    return targets, fingerprints


def plain(value):
    return stream_parser.unquote(value)


def integer(value):
    text = plain(value)
    require(re.fullmatch(r'[0-9]+', text) is not None, 'integer_invalid')
    return int(text)


def timestamp_state(value):
    text = plain(value)
    if text in ('', 'NULL'):
        return 'missing'
    if text == '0000-00-00 00:00:00':
        return 'zero_date'
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', text):
        return 'invalid'
    try:
        dt.datetime.strptime(text, '%Y-%m-%d %H:%M:%S')
    except ValueError:
        return 'invalid'
    return 'valid'


def sms_body_policy(row):
    kind = plain(row['contentsTypeCode'])
    if kind == 'userPwMofiy':
        return 'credential_type_omitted'
    if kind not in SAFE_SMS_TYPES and not re.fullmatch(r'nlottoWin\d+', kind):
        return 'unreviewed_type_omitted'
    if CREDENTIAL_PATTERN.search(plain(row.get('contents', '')) + '\n' + plain(row.get('subject', ''))):
        return 'credential_pattern_omitted'
    return 'body_preserved'


def history_record(table, row, uid, target_id):
    key = [integer(row['idx'])]
    if table == 'gameBettingNlotto':
        key.append(integer(row['num']))
    fields = list(FIELDS[table])
    body_policy = None
    if table == 'pushSms':
        body_policy = sms_body_policy(row)
        if body_policy == 'body_preserved':
            fields += ['from','to','subject','contents']
        else:
            fields = ['idx','userIdx','typeCode','contentsTypeCode',
                      'insertDateTime','updateDateTime','reserveDateTime']
    record = {'source_site':'lotto815', 'source_table':table, 'legacy_key':key,
              'source_user_idx':uid, 'target_member_id':target_id,
              'source_sql_values':{field:row[field] for field in fields},
              'source_values_encoding':'mysql_dump_tokens_not_decoded',
              'timestamp_states':{field:timestamp_state(row[field]) for field in TIME_FIELDS[table]},
              'historical_only':True}
    if body_policy:
        record['body_policy'] = body_policy
    return record


def process_table(table, stream, targets, source_users, output, expected=None, progress=False):
    expected_rows, expected_columns = expected or EXPECTED[table]
    seen = set()
    selected = Counter()
    dates = {field:Counter() for field in TIME_FIELDS[table]}
    ranges = {field:[None,None] for field in TIME_FIELDS[table]}
    errors, body, flags = Counter(), Counter(), Counter()
    total = staged = 0
    columns = None
    for cols, values in stream_parser.iter_rows(stream):
        total += 1
        if columns is None:
            columns = tuple(cols)
            needed = set(FIELDS[table]) | set(TIME_FIELDS[table])
            if table == 'pushSms': needed |= {'contents','subject','from','to'}
            require(len(cols) == expected_columns and len(set(cols)) == len(cols) and needed <= set(cols),
                    'schema_mismatch')
        require(tuple(cols) == columns, 'schema_changed')
        if len(values) != len(columns):
            errors['column_width'] += 1
            continue
        row = dict(zip(columns, values))
        try:
            uid, idx = integer(row['userIdx']), integer(row['idx'])
            key = (idx, integer(row['num'])) if table == 'gameBettingNlotto' else idx
            require(idx > 0 and uid > 0, 'nonpositive_key')
        except Stop:
            errors['invalid_source_key_or_reference'] += 1
            continue
        if key in seen: errors['duplicate_source_key'] += 1
        seen.add(key)
        if uid not in source_users: errors['orphan_source_member'] += 1
        if uid not in targets:
            continue
        record = history_record(table, row, uid, targets[uid])
        selected[uid] += 1
        staged += 1
        for field, state in record['timestamp_states'].items():
            dates[field][state] += 1
            if state == 'valid':
                value = plain(row[field])
                bounds = ranges[field]
                bounds[0] = value if bounds[0] is None else min(bounds[0], value)
                bounds[1] = value if bounds[1] is None else max(bounds[1], value)
        if table == 'pushSms':
            body[record['body_policy']] += 1
            kind = plain(row['contentsTypeCode'])
            flags['type:' + (kind if kind in SAFE_SMS_TYPES or kind in ('userPwMofiy','admin','adminSettinSend','thankCharge')
                             else 'nlottoWin' if re.fullmatch(r'nlottoWin\d+', kind) else 'other')] += 1
            result = plain(row['resultYN'])
            flags['resultYN:' + (result if result in ('Y','N','') else 'other')] += 1
        elif table == 'userMemo':
            flags['empty_contents'] += not bool(plain(row['contents']))
            flags['team_private'] += plain(row['groupTeamOpenYN']) == 'N'
            author = integer(row['insertUserIdx'])
            flags['author_missing_from_source_users'] += author not in source_users
        else:
            try:
                numbers = [int(value) for value in plain(row['pickStr']).strip('|').split('|')]
                require(len(numbers) == 6 and len(set(numbers)) == 6 and all(1 <= n <= 45 for n in numbers), 'invalid_numbers')
                require(1 <= integer(row['grade']) <= 5 and integer(row['num']) > 0, 'invalid_win')
                flags['prize_total'] += integer(row['prize'])
            except (Stop, ValueError):
                errors['selected_win_values_invalid'] += 1
        output.write(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n')
        if progress and total % 200000 == 0:
            print(json.dumps({'table':table,'scanned':total,'selected':staged}), flush=True)
    require(total == expected_rows, 'source_row_count_mismatch_or_incomplete_tuple')
    require(not errors, 'source_integrity_error')
    return ({'source_rows_scanned':total,'source_columns':len(columns or ()), 'source_unique_keys':len(seen),
             'selected_rows':staged, 'selected_members_with_history':len(selected),
             'selected_members_without_history':len(targets)-len(selected),
             'selected_member_row_max':max(selected.values(), default=0),
             'errors':dict(errors),'selected_timestamp_states':{k:dict(v) for k,v in dates.items()},
             'selected_timestamp_ranges':ranges,'body_policy':dict(body),'selected_flags':dict(flags)}, selected)


def main():
    digest = hashlib.sha256()
    with ARCHIVE.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024), b''): digest.update(block)
    require(digest.hexdigest() == ARCHIVE_SHA, 'archive_hash_mismatch')
    targets, fingerprints = target_members()
    users = loader.DumpSource('lotto815', archive=str(ARCHIVE)).load('user')
    user_ids = {int(row['idx']) for row in users}
    require(len(user_ids) == len(users) == 21809 and set(targets) <= user_ids, 'source_user_reference_mismatch')
    directory = BACKUP / ('history-review-216-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
    require(not any(path.is_symlink() for path in (BACKUP,*BACKUP.parents)), 'symlink_path')
    directory.mkdir(mode=0o700)
    counts = {idx:{'target_member_id':target, 'counts':{}} for idx,target in targets.items()}
    report = {'mode':'offline_private_staging','stage':'preparing','source_sha256':ARCHIVE_SHA,
              'fixed_source_members':216,'frozen_payloads':fingerprints,'db_reads':0,'db_writes':0,'sms_requests':0,
              'private_directory':str(directory),'tables':{},
              'limitations':['고정 216개 원본 대상 범위이며 216명 운영 이관 완료 증거가 아닙니다.',
                             '원시 SQL 토큰 보존이며 UI용 디코딩/운영 이력 적재는 하지 않았습니다.',
                             '문자 등록일을 실제 전달 성공 시각으로 확정하지 않습니다.',
                             '인증/미확인 유형 문자는 본문·제목·연락처를 복사하지 않습니다.',
                             '날짜/내용 검증은 선택된 대상 이력에 적용하며 전체 행에는 키/참조/컬럼 검증을 적용합니다.']}
    try:
        with zipfile.ZipFile(ARCHIVE) as archive:
            for table in EXPECTED:
                names = [name for name in archive.namelist() if name.endswith('/lotto815_' + table + '.sql.gz')]
                require(len(names) == 1, 'archive_table_missing_or_duplicate')
                partial = directory / (table + '.jsonl.partial')
                fd = os.open(partial, os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o600)
                with os.fdopen(fd,'w') as output, archive.open(names[0]) as zipped:
                    with gzip.GzipFile(fileobj=zipped) as raw, io.TextIOWrapper(raw, encoding='utf-8', errors='strict') as text:
                        result, per_member = process_table(table, text, targets, user_ids, output, progress=True)
                final = directory / (table + '.jsonl')
                partial.rename(final)
                result['file_bytes'] = final.stat().st_size
                result['file_sha256'] = hashlib.sha256(final.read_bytes()).hexdigest()
                report['tables'][table] = result
                for idx, record in counts.items(): record['counts'][table] = per_member[idx]
                print(json.dumps({'table':table,'verified_rows':result['selected_rows']}, ensure_ascii=False), flush=True)
        report['stage'] = 'prepared_offline_only'
        private_json(directory/'per-member-counts.json', counts)
    except (Stop, UnicodeError, gzip.BadGzipFile, zipfile.BadZipFile) as error:
        report['stage'] = 'incomplete'
        report['error_code'] = str(error) if isinstance(error, Stop) else 'archive_or_encoding_error'
        private_json(directory/'summary.json', report)
        print(json.dumps({'stage':'incomplete','private_directory':str(directory),'error_code':report['error_code']}), flush=True)
        return 1
    private_json(directory/'summary.json', report)
    print(json.dumps({'stage':report['stage'],'summary_path':str(directory/'summary.json')}, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Stop as error:
        print(json.dumps({'stage':'stopped','error_code':str(error)}))
        raise SystemExit(1)
