#!/usr/bin/env python3
"""815 잔여 과거회원 기록 전체를 불변 하위배치로 준비한다. DB 쓰기는 없다.

무결제도 원본 상태/기간/등급으로 포함한다. 권한검토·기존고객충돌·원본오류는
기존 검토 규칙을 유지하며, 담당배정/문자/상품 갱신은 하지 않는다.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import legacy_815_vendor_policy as policy
import legacy_815_review as review
spec = importlib.util.spec_from_file_location('full_815_compensation_common', ROOT / 'scripts/run-815-compensation-review.py')
common = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = common
spec.loader.exec_module(common)
pilot, loader = common.pilot, common.loader
ARCHIVE, ARCHIVE_SHA = common.ARCHIVE, common.ARCHIVE_SHA
FAMILY = 'lotto815-20260910-full-review'
PREFIX = 'lotto815-20260910-full-'
PRIVATE = pilot.BACKUP_ROOT / FAMILY
PROTECTED_BATCHES = (*common.PROTECTED_BATCHES, common.BATCH)
PROTECTED_COUNTS = (216, 171, 63_428_400)
MAX_MEMBERS, MAX_PAYMENTS = 500, 10000


class Stop(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(ok, code):
    if not ok:
        raise Stop(code)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def payload(plan):
    return {'members': plan.members, 'payments': plan.payments, 'products': plan.products}


def make_plan(data):
    require(isinstance(data, dict) and set(data) == {'members', 'payments', 'products'}
            and all(isinstance(v, list) for v in data.values()), 'payload_shape')
    return loader.ImportPlan(data['members'], data['payments'], data['products'], Counter(), Counter(), Counter(), len(data['members']), 0)


def batch_name(index):
    require(type(index) is int and 1 <= index <= 999, 'batch_index')
    return PREFIX + f'{index:03d}'


def validate_unit(data, descriptor):
    """고정 파일 전체 SHA와 원자 RPC 계약을 함께 검증한다."""
    plan = make_plan(data)
    batch = descriptor['batch']
    require(batch == batch_name(descriptor['index']) and descriptor['file'] == f"batch-{descriptor['index']:03d}.json", 'batch_identity')
    require(digest(data) == descriptor['payload_sha256'], 'payload_sha')
    require((len(plan.members), len(plan.payments), sum(r['amount'] for r in plan.payments)) ==
            (descriptor['members'], descriptor['payments'], descriptor['amount']), 'unit_counts')
    require(1 <= len(plan.members) <= MAX_MEMBERS and len(plan.payments) <= MAX_PAYMENTS, 'rpc_size')
    for rows, kind in ((plan.members, 'member'), (plan.payments, 'payment')):
        require(len({r['id'] for r in rows}) == len(rows)
                and len({r['meta']['legacy_idx'] for r in rows}) == len(rows), 'duplicate_key')
        for row in rows:
            meta = row['meta']
            require(meta.get('source_site') == 'lotto815' and meta.get('import_batch') == batch
                    and type(meta.get('legacy_idx')) is int and meta['legacy_idx'] > 0
                    and row['id'] == loader.stable_id(kind, 'lotto815', meta['legacy_idx']), 'source_identity')
    member_ids = {r['id'] for r in plan.members}
    require(len({r['user_id'] for r in plan.members}) == len(plan.members)
            and len({r['phone'] for r in plan.members}) == len(plan.members), 'duplicate_identity')
    for row in plan.members:
        meta = row['meta']
        require(isinstance(row.get('user_id'), str) and bool(row['user_id'])
                and re.fullmatch(r'01[0-9]{8,9}', row['phone']) is not None
                and row.get('assigned_staff_id') is None and row.get('team_id') is None
                and meta.get('reco_paused') is True and meta.get('reco_pause_reason') == 'legacy_import_review'
                and meta.get('legacy_consent_review_required') is True and meta.get('legacy_agree_sms_yn') in ('Y', 'N')
                and meta.get('legacy_account_flags') == {k: 'N' for k in review.ACCOUNT_REVIEW_FIELDS}
                and type(meta.get('weekly_reco_count')) is int and meta['weekly_reco_count'] >= 0
                and 'weekly_recos' not in meta
                and all(isinstance(meta.get(k), str) for k in ('legacy_member_start_datetime', 'legacy_member_end_datetime')),
                'member_hold_metadata')
        require(row.get('status') in ('active', 'suspended', 'deleted', 'withdrawn')
                and all(row.get(flag) is (row['status'] == status) for flag, status in
                    (('is_suspended','suspended'),('is_deleted','deleted'),('is_withdrawn','withdrawn'))), 'member_status')
    for row in plan.payments:
        meta = row['meta']
        require(row['member_id'] in member_ids and type(row['amount']) is int and row['amount'] >= 0
                and row['status'] == 'approved' and row.get('staff_id') is None
                and isinstance(meta.get('legacy_item_status'), str)
                and isinstance(meta.get('legacy_installment_code'), str)
                and type(meta.get('legacy_payment_reco_count')) is int and meta['legacy_payment_reco_count'] >= 0,
                'payment_rpc_contract')
    needed = {r['product_id'] for r in plan.payments}
    require(len(plan.products) == len(needed) and {r['id'] for r in plan.products} == needed
            and needed <= {r['id'] for r in loader.PRODUCTS_BY_SITE['lotto815'].values()}, 'product_identity')
    return plan


def canonical_rows(rows):
    return [json.loads(common.base.canonical(row, row)) for row in sorted(rows, key=lambda r: r['id'])]


def canonical_snapshot(snapshot):
    return {table: canonical_rows(snapshot[table]) for table in ('members', 'payments')}


TABLE_COLUMNS = {
    'members': set('id user_id name nickname phone grade status tendency inflow_code inflow_type '
                   'assigned_staff_id team_id memo win_history outcall_done registered_at last_active_at '
                   'is_suspended is_deleted is_withdrawn meta consult_status'.split()),
    'payments': set('id member_id product_id amount method pg_provider status period_start period_end '
                    'depositor_name staff_id paid_at created_at meta'.split()),
}


def verify_schema(existing, data):
    for table in ('members','payments'):
        require(bool(existing[table]) and all(set(r) == TABLE_COLUMNS[table] for r in existing[table]), 'schema_columns')
        require(all(set(r) | set(common.DB_DEFAULTS[table]) == TABLE_COLUMNS[table] for r in data[table]), 'payload_columns')


def protected_snapshot(client):
    filters = [('meta->>source_site','eq.lotto815'), ('meta->>import_batch','in.(' + ','.join(PROTECTED_BATCHES) + ')')]
    value = {table: client.select_all(table, '*', filters) for table in ('members','payments')}
    require((len(value['members']), len(value['payments']), sum(r['amount'] for r in value['payments'])) == PROTECTED_COUNTS,
            'protected_counts')
    return canonical_snapshot(value)


def private_read(path, limit=64*1024*1024):
    for p in (path, *path.parents):
        require(not p.is_symlink(), 'private_symlink')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= limit, 'private_file')
        return json.load(stream)


def private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW',0), 0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())


def build_units(users, payments, state, batch_size=250):
    require(type(batch_size) is int and 1 <= batch_size <= MAX_MEMBERS, 'batch_size')
    require(bool(users), 'empty_source')
    adjusted = copy.deepcopy(state)
    adjusted.phones.update(common.canonical_phone(p) for p in state.phones)
    source_phones = Counter(common.canonical_phone(u.get('phone')) for u in users)
    canonical_duplicates = {p for p,c in source_phones.items() if c > 1 and re.fullmatch(r'01[0-9]{8,9}',p)}
    adjusted.phones.update(canonical_duplicates)
    full, report = review.build_review_plan(loader, users, payments, adjusted, FAMILY, limit=len(users))
    source_users = {loader.num(u['idx']): u for u in users}
    source_payments, mapped_payments = defaultdict(list), defaultdict(list)
    for row in payments:
        source_payments[loader.num(row['userIdx'])].append(row)
    for row in full.payments:
        mapped_payments[row['member_id']].append(row)
    cohorts, statuses = Counter(), Counter()
    enriched = []
    for row in sorted(full.members, key=lambda r:r['meta']['legacy_idx']):
        raw = source_users[row['meta']['legacy_idx']]
        raw_payments = source_payments[row['meta']['legacy_idx']]
        evidence = policy.payment_evidence(raw['idx'], raw_payments)
        cohorts[evidence.category] += 1
        statuses.update(r['statCode'] for r in raw_payments)
        member, detail = policy.enrich_new_review_payload(raw, raw_payments, row, mapped_payments[row['id']])
        require(all(p['status'] == 'approved' for p in detail), 'unapproved_payment_requires_rpc_review')
        require(len(detail) <= MAX_PAYMENTS, 'one_member_exceeds_rpc_payment_limit')
        enriched.append((member, detail))
    groups, current, payment_count = [], [], 0
    for pair in enriched:
        if current and (len(current) == batch_size or payment_count + len(pair[1]) > MAX_PAYMENTS):
            groups.append(current)
            current, payment_count = [], 0
        current.append(pair)
        payment_count += len(pair[1])
    if current:
        groups.append(current)
    units, descriptors = [], []
    for index, group in enumerate(groups, 1):
        members, mapped = [], []
        for member, detail in group:
            member = copy.deepcopy(member)
            member['meta']['import_batch'] = batch_name(index)
            members.append(member)
            for row in detail:
                row = copy.deepcopy(row)
                row['meta']['import_batch'] = batch_name(index)
                mapped.append(row)
        needed = {p['product_id'] for p in mapped}
        data = {'members': members, 'payments': mapped, 'products': [p for p in full.products if p['id'] in needed]}
        descriptor = {'index': index,'batch': batch_name(index), 'file': f'batch-{index:03d}.json',
                      'members': len(members),'payments': len(mapped),'amount': sum(p['amount'] for p in mapped),
                      'payload_sha256': digest(data)}
        validate_unit(data, descriptor)
        descriptors.append(descriptor)
        units.append(data)
    require(sum(len(u['members']) for u in units) == len(full.members)
            and sum(len(u['payments']) for u in units) == len(full.payments), 'partition_lost_rows')
    report.update({'cohorts':dict(sorted(cohorts.items())), 'raw_payment_statuses':dict(sorted(statuses.items())),
                   'source_canonical_duplicate_phone_groups':len(canonical_duplicates), 'sub_batches':len(units),
                   'source_member_rows':len(users), 'source_payment_rows':len(payments)})
    return units, descriptors, report


def validate_manifest(manifest, units):
    require(manifest.get('family') == FAMILY and manifest.get('archive_sha256') == ARCHIVE_SHA
            and manifest.get('max_members') == MAX_MEMBERS and manifest.get('max_payments') == MAX_PAYMENTS
            and manifest.get('protected_counts') == list(PROTECTED_COUNTS), 'manifest_contract')
    descriptors = manifest['batches']
    require(bool(descriptors) and len(descriptors) == len(units), 'manifest_empty')
    member_ids, payment_ids, member_keys, payment_keys, phones, logins = set(),set(),set(),set(),set(),set()
    for index,(descriptor,data) in enumerate(zip(descriptors,units),1):
        require(descriptor['index'] == index, 'manifest_order')
        plan = validate_unit(data,descriptor)
        for row in plan.members:
            key, phone, login = row['meta']['legacy_idx'], row['phone'], row['user_id']
            require(row['id'] not in member_ids and key not in member_keys and phone not in phones and login not in logins,
                    'cross_batch_member_duplicate')
            member_ids.add(row['id']);member_keys.add(key);phones.add(phone);logins.add(login)
        for row in plan.payments:
            key = row['meta']['legacy_idx']
            require(row['id'] not in payment_ids and key not in payment_keys, 'cross_batch_payment_duplicate')
            payment_ids.add(row['id']);payment_keys.add(key)
    require((len(member_ids),len(payment_ids),sum(d['amount'] for d in descriptors)) ==
            (manifest['members'],manifest['payments'],manifest['amount']), 'manifest_totals')


def prepare(env_file, batch_size=250):
    for p in (PRIVATE,*PRIVATE.parents):
        require(not p.is_symlink(), 'private_symlink')
    require(not PRIVATE.exists(), 'manifest_already_exists_no_reselection')
    common.verify_archive()
    source = loader.DumpSource('lotto815', archive=str(ARCHIVE))
    users,payments = source.load('user'),source.load('payment')
    client = common.Client(pilot.read_config(env_file),allow_writes=False)
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    state = pilot.minimal_state(client)
    protected = protected_snapshot(client)
    units,descriptors,report = build_units(users,payments,state,batch_size)
    all_products = {}
    for data in units:
        verify_schema(protected,data)
        common.check_conflicts(state,make_plan(data))
        all_products.update({p['id']:p for p in data['products']})
    if all_products:
        common.check_products(client,make_plan({'members':[],'payments':[],'products':list(all_products.values())}))
    manifest = {'family':FAMILY, 'archive_sha256':ARCHIVE_SHA, 'prepared_at_utc':dt.datetime.now(dt.timezone.utc).isoformat(),
                'snapshot_started_at_utc':started,'batch_size':batch_size,'max_members':MAX_MEMBERS,'max_payments':MAX_PAYMENTS,
                'members':sum(d['members'] for d in descriptors),'payments':sum(d['payments'] for d in descriptors),
                'amount':sum(d['amount'] for d in descriptors),'batches':descriptors,
                'protected_counts':list(PROTECTED_COUNTS),'protected_sha256':digest(protected),
                'all_held':True,'assigned_staff_changes':0,'sms_requests':0,'product_changes':0,
                'scope':'original_historical_members_including_no_payment_without_activation','report':report}
    validate_manifest(manifest,units)
    PRIVATE.mkdir(mode=0o700)
    private_write(PRIVATE/'protected-baseline.json',protected)
    for descriptor,data in zip(descriptors,units):
        private_write(PRIVATE/descriptor['file'],data)
    private_write(PRIVATE/'manifest.json',manifest)
    summary={'stage':'prepared_not_applied','manifest_sha256':digest(manifest),'members':manifest['members'],
             'payments':manifest['payments'],'amount':manifest['amount'],'sub_batches':len(units),
             'cohorts':report['cohorts'],'payment_statuses':report['raw_payment_statuses'],
             'database_writes':0,'private_directory':str(PRIVATE)}
    private_write(PRIVATE/'preparation-receipt.json',summary)
    print(json.dumps(summary,ensure_ascii=False))
    return 0


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file',type=Path,default=ROOT/'.env.local')
    parser.add_argument('--batch-size',type=int,choices=(100,250,500),default=250)
    args=parser.parse_args()
    try:
        raise SystemExit(prepare(args.env_file,args.batch_size))
    except Exception as error:
        print(json.dumps({'stage':'stopped_without_customer_writes', 'reason_code':error.code if isinstance(error,Stop) else 'preparation_failed_sanitized'},ensure_ascii=False))
        raise SystemExit(1)
