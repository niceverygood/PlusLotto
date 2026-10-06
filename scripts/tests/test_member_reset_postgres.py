#!/usr/bin/env python3
"""Atomic member reset regression on cached PostgreSQL 17, --network none.

Only synthetic fixtures are used. No ports, production env files, credentials,
provider requests or SMS. Run with optional --report /private/result.json.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = [ROOT / 'supabase/migrations' / name for name in (
    '20261003135703_durable_lotto_sync.sql',
    '20261005103000_atomic_reco_issue.sql',
    '20261006093000_atomic_member_reset.sql')]
CONTAINER = f'lotto-member-reset-test-{os.getpid()}'
UIDS = {name: f'10000000-0000-0000-0000-{index:012d}' for index, name in enumerate(
    ('admin', 'admin2', 'manager', 'leader', 'rep', 'inactive'), 1)}
REPORT = {'passed': False, 'network': 'none', 'production_access': False,
          'provider_calls': 0, 'checks': [], 'test_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'migration_sha256': {
              p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in MIGRATIONS}}
PARSER = argparse.ArgumentParser()
PARSER.add_argument('--report', type=Path)
PARSER.add_argument('--keep-container', action='store_true', help='Keep isolated synthetic DB for local schema generation; caller must remove it')
OPTIONS = PARSER.parse_args()


def run(args, data=None, check=True):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=50)
    if check and result.returncode:
        raise RuntimeError(result.stderr[-3500:])
    return result


def sql(query, check=True):
    return run(['docker', 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-v',
                'ON_ERROR_STOP=1', '-U', 'postgres'], query, check)


def value(query):
    return json.loads(sql(query).stdout.strip().splitlines()[-1])


def literal(obj):
    return "'" + json.dumps(obj, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def arr(ids):
    return 'ARRAY[' + ','.join("'" + str(mid).replace("'", "''") + "'" for mid in ids) + ']::text[]'


def reset_query(ids=('a',), operation=None, actor='admin', role='authenticated'):
    operation = operation or str(uuid.uuid4())
    uid = UIDS.get(actor, '')
    return (f"SET request.jwt.claim.sub='{uid}'; SET ROLE {role}; SELECT public.admin_reset_members("
            + arr(ids) + f",'{operation}'::uuid);")


def issue(round_no):
    return {'round_no': round_no, 'sets': [[1, 2, 3, 4, 5, 6]], 'issued_at': '2020-01-01T00:00:00Z'}


def seed(history=None):
    if history is None:
        history = [issue(1244)]
    sql('TRUNCATE public.members,public.reco_issue_ledger,public.sms_sends,public.payments,'
        'public.assignments,public.logs,public.member_reco_reset_archive,public.member_reset_receipts,'
        'public.lotto_sync_sms_outbox,public.lotto_sync_work,public.lotto_sync_jobs CASCADE;')
    payload = {'source_site': 'lotto815', 'legacy_idx': 42, 'weekly_reco_count': 1,
               'weekly_recos': history, 'end_date': '2099-12-31', 'unrelated': {'keep': [1, None]},
               'win_sms_rounds': [1230], 'win_records': [{'round_no': 1244, 'rank': 1}],
               'memos': [{'body': 'synthetic memo', 'author': 'rep', 'consult_status': 'keep'}],
               'reset_memos': [{'body': 'older archived memo'}]}
    sql("INSERT INTO public.members(id,user_id,name,phone,grade,status,memo,assigned_staff_id,team_id,win_history,meta) "
        "VALUES('a','synthetic-a','synthetic','01000000000','vip','active','fallback','rep','team','1244회 1등',"
        + literal(payload) + "); UPDATE public.members SET meta=meta||jsonb_build_object('weekly_reco_day',"
        "extract(dow FROM now() AT TIME ZONE 'Asia/Seoul')::int);"
        "INSERT INTO public.payments(id,member_id,amount,method,status) VALUES('pay','a',100,'bank','approved');"
        "INSERT INTO public.sms_sends(id,member_id,phone,body,type,status,sent_at) "
        "VALUES('prior-sms','a','01000000000','synthetic','recommend','발송완료',now());")


def add_second(history=None):
    patch = {} if history is None else {'weekly_recos': history}
    sql("INSERT INTO public.members(id,user_id,name,phone,grade,status,meta) "
        "SELECT 'b','synthetic-b',name,phone,grade,status,meta||" + literal(patch) + " FROM members WHERE id='a';")


def snapshot():
    tables = ('members', 'reco_issue_ledger', 'sms_sends', 'payments', 'assignments', 'logs',
              'member_reco_reset_archive', 'member_reset_receipts', 'lotto_sync_sms_outbox',
              'lotto_sync_jobs', 'lotto_sync_work')
    fields = [f"'{table}',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM public.{table} t)" for table in tables]
    return value('SELECT jsonb_build_object(' + ','.join(fields) + ');')


def current_meta(mid='a'):
    return value(f"SELECT meta FROM public.members WHERE id='{mid}'")


def claim_query(round_no=1245, expected=None, grade='vip'):
    if expected is None:
        expected = current_meta()
    return ("SET ROLE service_role; SELECT public.reco_issue_claim('a'," + str(round_no) + ','
            + literal(expected) + ',' + literal(issue(round_no))
            + ",'lotto815',(now() AT TIME ZONE 'Asia/Seoul')::date,"
            "extract(dow FROM now() AT TIME ZONE 'Asia/Seoul')::int,'scheduled',true,NULL,NULL,"
            + f"'{grade}','01000000000');")


def denied(query, fragment=None):
    before = snapshot()
    got = sql(query, False)
    assert got.returncode != 0, got.stdout
    if fragment:
        assert fragment in got.stderr, got.stderr
    assert snapshot() == before, 'denied reset mutated synthetic rows'


def passed(name):
    REPORT['checks'].append({'name': name, 'passed': True})
    print(json.dumps({'passed': name}), flush=True)


def asyncsql(query):
    process = subprocess.Popen(['docker', 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-v',
                                'ON_ERROR_STOP=1', '-U', 'postgres'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    process.stdin.write(query)
    process.stdin.close()
    process.stdin = None
    return process


def wait_sleep(name):
    for _ in range(100):
        if sql(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND wait_event='PgSleep'").stdout.strip() == '1':
            return
        time.sleep(.025)
    raise AssertionError('concurrent transaction did not reach sleep')


try:
    run(['docker', 'run', '--rm', '--pull', 'never', '-d', '--name', CONTAINER,
         '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw',
         '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine'])
    for _ in range(100):
        logs = run(['docker', 'logs', CONTAINER], check=False)
        if ('PostgreSQL init process complete' in logs.stdout + logs.stderr
                and run(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'postgres'], check=False).returncode == 0):
            break
        time.sleep(.1)
    else:
        raise RuntimeError('isolated PostgreSQL startup timed out')
    REPORT['postgres_version'] = sql('SHOW server_version').stdout.strip()
    sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;"
        "CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);"
        "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;")
    sql((ROOT / 'supabase/migrations/0001_schema.sql').read_text())
    sql((ROOT / 'supabase/migrations/0004_settings_missing_columns.sql').read_text())
    sql("ALTER TABLE public.sms_sends ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';"
        "ALTER TABLE public.members ADD COLUMN consult_status text;"
        "ALTER TABLE public.site_settings ADD COLUMN win_sms jsonb;"
        "GRANT USAGE ON SCHEMA public,auth TO service_role,authenticated,anon;"
        "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;")
    for migration in MIGRATIONS:
        sql(migration.read_text())
    sql("INSERT INTO public.teams(id,name) VALUES('team','synthetic');")
    for name, uid in UIDS.items():
        role = name if name in ('admin', 'manager', 'leader', 'rep') else 'admin'
        sql(f"INSERT INTO auth.users VALUES('{uid}'); INSERT INTO public.staff(id,login_id,name,role,auth_user_id,team_id,is_active) "
            f"VALUES('{name}','{name}','synthetic','{role}','{uid}','team',{str(name != 'inactive').lower()});")
    sql("INSERT INTO public.site_settings(id,sms,weekly_free_reco,win_sms,win_messages) VALUES(1,"
        "'{\"oneshot_enabled\":true,\"sender_no\":\"0200000000\",\"by_site\":{\"lotto815\":{\"sender_no\":\"0200000001\"}}}',"
        "'{\"enabled\":true,\"paid_sms\":true,\"set_count\":1}',"
        "'{\"enabled\":true,\"paid\":true,\"free\":true,\"ranks\":[1,2,3,4,5]}','[{\"rank\":1,\"body\":\"synthetic\"}]');"
        "INSERT INTO public.lotto_rounds(round_no,draw_date,numbers,bonus,prize_1,prize_2,prize_3,total_sales) "
        "VALUES(1244,'2026-10-03',ARRAY[1,2,3,4,5,6],7,1000,100,10,10000);")

    seed()
    for role in ('anon', 'service_role'):
        denied(reset_query(role=role))
    for actor in ('missing', 'manager', 'leader', 'rep', 'inactive'):
        denied(reset_query(actor=actor), 'ACTIVE_ADMIN_REQUIRED')
    for role in ('anon', 'authenticated'):
        assert sql(f'SET ROLE {role}; SELECT * FROM public.member_reco_reset_archive;', False).returncode != 0
        assert sql(f'SET ROLE {role}; SELECT * FROM public.member_reset_receipts;', False).returncode != 0
    for table in ('member_reco_reset_archive', 'member_reset_receipts'):
        for action in (f'DELETE FROM public.{table}', f"UPDATE public.{table} SET operation_id=gen_random_uuid()"):
            assert sql('SET ROLE service_role;' + action, False).returncode != 0
    passed('active auth.uid admin only; archive/receipt direct access and service mutation denied')

    for ids in ([], ['a', 'a'], ['a', 'missing'], [''], ['x' * 257], [f'id-{i}' for i in range(501)]):
        denied(reset_query(ids))
    denied(reset_query().replace("ARRAY['a']::text[]", 'NULL::text[]'), 'INVALID_MEMBER_SCOPE')
    passed('exact nonempty unique max500 member scope validated; missing member rolls entire bulk back')

    seed([issue(1243), issue(1244), issue(1246)])
    add_second()
    before = snapshot()
    operation = str(uuid.uuid4())
    result = value(reset_query(['b', 'a'], operation))
    assert result == {'member_ids': ['a', 'b'], 'repeated': False}, result
    after = snapshot()
    for table in ('reco_issue_ledger', 'sms_sends', 'payments'):
        assert after[table] == before[table], table
    assert len(after['member_reco_reset_archive']) == len(after['assignments']) == 2
    assert len(after['logs']) == len(after['member_reset_receipts']) == 1
    for old, new in zip(before['members'], after['members']):
        assert new['grade'] == 'free' and new['assigned_staff_id'] is None and new['team_id'] is None
        assert new['win_history'] is None and new['memo'] is None
        assert new['meta']['weekly_recos'] == new['meta']['win_records'] == new['meta']['memos'] == []
        for key in ('source_site', 'legacy_idx', 'weekly_reco_count', 'weekly_reco_day', 'win_sms_rounds', 'unrelated'):
            assert new['meta'][key] == old['meta'][key], key
        assert new['meta']['reset_memos'][0] == old['meta']['reset_memos'][0]
        assert new['meta']['reset_memos'][-1]['reset_by'] == 'admin'
    assert value(reset_query(['a', 'b'], operation))['repeated'] is True
    assert snapshot() == after
    denied(reset_query(['a'], operation), 'RESET_OPERATION_SCOPE_CHANGED')
    denied(reset_query(['a', 'b'], operation, actor='admin2'), 'RESET_OPERATION_SCOPE_CHANGED')
    passed('bulk archive/reset/audit commit together; exact idempotent operation; source/history and financial/SMS rows preserved')
    sql("UPDATE members SET grade='vip' WHERE id='a';")
    for round_no in (1243, 1244, 1246):
        old = snapshot()
        result = value(claim_query(round_no))
        assert result['claimed'] is False and result['reason'] == 'ALREADY_ISSUED', result
        assert snapshot() == old
    result = value(claim_query(1245))
    assert result['claimed'] is True, result
    passed('all legacy archived rounds prevent reissue without ledger; genuinely new next round can claim')

    seed()
    sql("UPDATE members SET meta=meta||'{\"reco_paused\":true,\"reco_pause_reason\":\"legacy_import_review\"}' WHERE id='a';")
    value(reset_query())
    assert current_meta()['reco_paused'] is True and current_meta()['reco_pause_reason'] == 'legacy_import_review'
    passed('reset preserves an explicit legacy delivery hold and pause reason')

    for status in ('claimed', 'unknown', 'accepted', 'rejected', 'not_requested'):
        seed()
        sql("INSERT INTO reco_issue_ledger(member_id,round_no,source_site,status,issue,should_send,mode) "
            f"VALUES('a',1245,'lotto815','{status}','{{}}',true,'scheduled');")
        if status in ('claimed', 'unknown'):
            denied(reset_query(), 'RESET_DELIVERY_UNRESOLVED')
        else:
            old = snapshot()
            value(reset_query())
            now = snapshot()
            for table in ('reco_issue_ledger', 'sms_sends', 'payments'):
                assert now[table] == old[table]
    passed('unresolved issuance prevents reset; final ledger statuses and SMS/payment records never erased')

    for status in ('pending', 'claimed', 'unknown', 'accepted', 'failed', 'skipped'):
        seed()
        sql("INSERT INTO lotto_sync_jobs(round_no,status,total,done) VALUES(1244,'complete',0,0);"
            "INSERT INTO lotto_sync_sms_outbox(round_no,member_id,rank,numbers,prize,status) "
            f"VALUES(1244,'a',1,ARRAY[1,2,3,4,5,6],1000,'{status}');")
        if status in ('pending', 'claimed', 'unknown'):
            denied(reset_query(), 'RESET_DELIVERY_UNRESOLVED')
        else:
            before = snapshot()['lotto_sync_sms_outbox']
            value(reset_query())
            assert snapshot()['lotto_sync_sms_outbox'] == before
    passed('pending/claimed/unknown winner delivery blocks reset; final outbox entries are immutable')

    for bad in (None, {}, [None], [{'round_no': 0}], [{'round_no': 'x'}], [{'round_no': 2147483648}]):
        seed()
        add_second(bad if bad is not None else [])
        if bad is None:
            sql("UPDATE members SET meta=meta||'{\"weekly_recos\":null}' WHERE id='b';")
        denied(reset_query(['a', 'b']), 'INVALID_RECO_HISTORY')
    passed('malformed legacy history on later member rolls back earlier archived/reset member')

    for target in ('assignments', 'logs'):
        seed()
        add_second()
        sql("CREATE FUNCTION synthetic_reset_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_RESET_FAILURE'; END $$;"
            f'CREATE TRIGGER synthetic_reset_fail BEFORE INSERT ON public.{target} FOR EACH ROW EXECUTE FUNCTION synthetic_reset_fail();')
        denied(reset_query(['a', 'b']), 'SYNTHETIC_RESET_FAILURE')
        sql(f'DROP TRIGGER synthetic_reset_fail ON public.{target}; DROP FUNCTION synthetic_reset_fail();')
    passed('assignment or audit insert failure rolls archive, all members and receipt back atomically')

    seed()
    value(reset_query())
    denied("UPDATE members SET meta=meta||" + literal({'weekly_recos': [issue(1244)]}) + " WHERE id='a';", 'RECO_RESET_ALREADY_ISSUED')
    sql("UPDATE members SET meta=meta||'{\"ordinary_field\":\"preserved\"}' WHERE id='a';")
    sql("UPDATE members SET meta=meta||" + literal({'weekly_recos': [issue(1245)]}) + " WHERE id='a';")
    assert current_meta()['weekly_recos'][0]['round_no'] == 1245
    sql("DELETE FROM members WHERE id='a';")
    denied("INSERT INTO members(id,user_id,name,meta) VALUES('a','new-synthetic','synthetic'," + literal({'weekly_recos': [issue(1244)]}) + ');', 'RECO_RESET_ALREADY_ISSUED')
    passed('direct old-client UPDATE and member-ID-reuse INSERT cannot restore archived round; ordinary/new-round updates work')

    seed()
    sql("INSERT INTO lotto_sync_jobs(round_no,queue_sms) VALUES(1244,true); SELECT lotto_sync_private.snapshot(1244,true);")
    assert len(snapshot()['lotto_sync_work']) == 1
    value(reset_query())
    result = value('SET ROLE service_role; SELECT public.lotto_sync_batch(100);')
    assert result['ok'] is True and result['status'] == 'complete' and result['processed'] == 1 and result['winners'] == 0, result
    assert current_meta()['win_records'] == [] and current_meta()['weekly_recos'] == []
    assert snapshot()['members'][0]['win_history'] is None and snapshot()['lotto_sync_sms_outbox'] == []
    sql("SET ROLE authenticated; SET request.jwt.claim.sub='" + UIDS['admin'] + "'; SELECT public.lotto_sync_request_recount(1244);")
    assert snapshot()['lotto_sync_work'] == []
    passed('pre-reset winner snapshot is completed without resurrecting wins/outbox; later recount finds no active issue')

    seed()
    stale = current_meta()
    a = asyncsql("SET application_name='reset_first'; BEGIN;" + reset_query() + 'SELECT pg_sleep(1.2); COMMIT;')
    wait_sleep('reset_first')
    b = asyncsql(claim_query(expected=stale))
    ao, ae = a.communicate(timeout=12)
    bo, be = b.communicate(timeout=12)
    assert a.returncode == b.returncode == 0 and 'MEMBER_CHANGED' in bo, (ae, be, bo)
    assert snapshot()['reco_issue_ledger'] == [] and len(snapshot()['member_reco_reset_archive']) == 1
    passed('two sessions reset commits first: waiting stale issuance fails without ledger or SMS intent')

    seed()
    a = asyncsql("SET application_name='claim_first'; BEGIN;" + claim_query() + 'SELECT pg_sleep(1.2); COMMIT;')
    wait_sleep('claim_first')
    b = asyncsql(reset_query())
    ao, ae = a.communicate(timeout=12)
    bo, be = b.communicate(timeout=12)
    assert a.returncode == 0 and b.returncode != 0 and 'RESET_DELIVERY_UNRESOLVED' in be, (ae, be)
    assert snapshot()['member_reco_reset_archive'] == [] and len(snapshot()['reco_issue_ledger']) == 1
    assert len(snapshot()['sms_sends']) == 2
    passed('two sessions issuance claims first: reset refuses unresolved delivery without partial clear')

    seed()
    add_second()
    operation = str(uuid.uuid4())
    a = asyncsql("SET application_name='same_reset'; BEGIN;" + reset_query(['b', 'a'], operation) + 'SELECT pg_sleep(1.2); COMMIT;')
    wait_sleep('same_reset')
    b = asyncsql(reset_query(['a', 'b'], operation))
    ao, ae = a.communicate(timeout=12)
    bo, be = b.communicate(timeout=12)
    assert a.returncode == b.returncode == 0 and '"repeated": true' in bo, (ae, be, bo)
    assert len(snapshot()['member_reco_reset_archive']) == len(snapshot()['assignments']) == 2
    assert len(snapshot()['member_reset_receipts']) == len(snapshot()['logs']) == 1
    passed('concurrent same-operation reverse ID order returns one receipt without duplicate reset/log/archive')

    for migration in MIGRATIONS:
        assert hashlib.sha256(migration.read_bytes()).hexdigest() == REPORT['migration_sha256'][migration.name], 'migration changed during regression'
    assert hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == REPORT['test_sha256'], 'test changed during regression'
    REPORT['passed'] = True
except Exception as error:
    REPORT['error'] = str(error)
    raise
finally:
    if OPTIONS.keep_container:
        REPORT['container_removed'] = False
        REPORT['retained_synthetic_container'] = CONTAINER
    else:
        cleanup = run(['docker', 'rm', '-f', CONTAINER], check=False)
        REPORT['container_removed'] = cleanup.returncode == 0
    if OPTIONS.report:
        OPTIONS.report.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        OPTIONS.report.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        OPTIONS.report.chmod(0o600)
    print(json.dumps(REPORT, ensure_ascii=False), flush=True)
