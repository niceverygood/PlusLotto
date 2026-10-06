#!/usr/bin/env python3
"""Recommendation history consumer regression on cached PostgreSQL 17, --network none.

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
    '20261006093000_atomic_member_reset.sql',
    '20261006133000_manual_additional_reco.sql',
    '20261006140000_manual_reco_history_consumers.sql')]
CONTAINER = f'lotto-reco-consumers-test-{os.getpid()}'
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



def manual_fixture(round_no=1244, number_sets=None, member='a', request=None, timestamp=None):
    request = request or str(uuid.uuid4())
    payload = {'round_no': round_no, 'sets': number_sets or [[1,2,3,4,5,6]],
               'issued_at': timestamp or datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'manual_request_id': request}
    sql("INSERT INTO reco_issue_ledger(member_id,round_no,source_site,issue,should_send,phone,actor_id,mode,status,manual_request_id) "
        f"VALUES('{member}',{round_no},'lotto815'," + literal(payload) + ",false,'01000000000','admin','manual','not_requested','" + request + "');"
        f"UPDATE members SET meta=jsonb_set(meta,'{{weekly_recos}}'," + literal([payload]) + "||coalesce(meta->'weekly_recos','[]')) WHERE id='" + member + "';")
    return payload


def queue(round_no=1244):
    sql(f"INSERT INTO lotto_sync_jobs(round_no,status) VALUES({round_no},'pending') ON CONFLICT(round_no) DO NOTHING; "
        f"SET ROLE service_role; SELECT lotto_sync_private.snapshot({round_no},false);")


def batch():
    return value('SET ROLE service_role; SELECT public.lotto_sync_batch(100);')


def delete_query(payload, actor='admin', role='authenticated'):
    uid=UIDS.get(actor,'')
    return (f"SET request.jwt.claim.sub='{uid}'; SET ROLE {role}; SELECT public.admin_delete_member_reco('a',"
            +str(payload['round_no'])+",'"+payload['issued_at']+"');")


def reco_records():
    return [r for r in current_meta().get('win_records',[]) if r.get('source')=='reco']


def fresh_seed(history=None):
    seed(history)
    sql("UPDATE members SET win_history=NULL,meta=meta||'{\"win_records\":[]}' WHERE id='a';")

import datetime

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

    fresh_seed([issue(1244)])
    m1=manual_fixture(number_sets=[[1,2,3,4,5,7],[1,2,3,4,8,9]])
    m2=manual_fixture(number_sets=[[1,2,3,10,11,12]])
    queue()
    job=value("SELECT issue FROM lotto_sync_work WHERE kind='member'")
    assert len(job['issues'])==3,job
    got=batch(); assert got['ok'] and got['winners']==1,got
    records=reco_records(); assert len(records)==4,records
    assert sorted(r['rank'] for r in records)==[1,2,4,5],records
    assert len({r['combo_index'] for r in records})==4
    assert len({r['issue_id'] for r in records})==3
    before=records
    queue(); assert batch()['ok']; assert reco_records()==before
    passed('all same-round automatic and two manual issues counted; per-issue identity; recount idempotent')

    fresh_seed([issue(1244)])
    fake={'round_no':1244,'sets':[[1,2,3,4,5,6]],'issued_at':'2026-01-01T00:00:00Z','manual_request_id':str(uuid.uuid4())}
    sql("UPDATE members SET meta=jsonb_set(meta,'{weekly_recos}',"+literal([fake,issue(1244),issue(1244)])+") WHERE id='a';")
    queue(); assert batch()['ok']; assert len(reco_records())==1
    passed('unbacked manual identifiers excluded and identical legacy copies do not double count')

    fresh_seed([issue(1244)])
    queue(); value(reset_query())
    new=manual_fixture(number_sets=[[1,2,3,4,5,7]])
    got=batch(); assert got['ok'],got
    records=reco_records(); assert len(records)==1 and records[0]['rank']==2,records
    assert records[0]['issue_id']==new['manual_request_id']
    passed('queued pre-reset history stays excluded while new same-round manual issue is counted')

    fresh_seed([issue(1244)])
    manual=manual_fixture()
    sql("INSERT INTO sms_sends(id,member_id,type,status,sent_at,meta) VALUES('manual-receipt','a','recommend','발송완료','"+manual['issued_at']+"',"+literal({'round_no':1244,'manual_request_id':manual['manual_request_id']})+");")
    queue(); assert batch()['ok']
    before=snapshot(); result=value(delete_query(manual)); assert result=={'deleted_issues':1,'deleted_sms':0},result
    after=snapshot(); assert before['sms_sends']==after['sms_sends'] and before['reco_issue_ledger']==after['reco_issue_ledger']
    assert current_meta()['weekly_recos']==[issue(1244)]
    assert len(reco_records())==1
    assert after['member_reco_reset_archive'][-1]['issues']==[manual]
    denied("UPDATE members SET meta=jsonb_set(meta,'{weekly_recos}',"+literal([manual,issue(1244)])+") WHERE id='a';",'RECO_RESET_ALREADY_ISSUED')
    altered = {**manual, 'issued_at': '2030-01-01T00:00:00Z', 'sets': [[1,2,3,4,5,7]]}
    denied("UPDATE members SET meta=jsonb_set(meta,'{weekly_recos}',"+literal([altered,issue(1244)])+") WHERE id='a';",'RECO_RESET_ALREADY_ISSUED')
    queue(); assert batch()['ok']; assert len(reco_records())==1
    passed('single manual deletion preserves SMS/ledger, blocks stale restoration, retains other same-round issue and winnings')

    fresh_seed([issue(1244),{**issue(1244),'issued_at':'2021-01-01T00:00:00Z','sets':[[1,2,3,4,5,7]]}])
    before=snapshot(); result=value(delete_query(issue(1244)));assert result['deleted_sms']==0
    assert snapshot()['sms_sends']==before['sms_sends']
    ledger=value("SELECT to_jsonb(l) FROM reco_issue_ledger l WHERE manual_request_id IS NULL")
    assert ledger['status']=='not_requested' and ledger['issue']==issue(1244)
    assert len(current_meta()['weekly_recos'])==1
    assert len(reco_records())==1 and reco_records()[0]['rank']==2
    assert value("SELECT meta FROM logs WHERE action='reco.issue_delete'")['removed_issue']==issue(1244)
    queue();assert batch()['ok'];assert len(reco_records())==1
    passed('legacy deletion keeps remaining legacy issue and records full audit plus automatic tombstone without deleting SMS')

    fresh_seed([issue(1244)])
    for actor in ('rep','inactive','missing'):
        denied(delete_query(issue(1244),actor=actor),'ACTIVE_RECO_ADMIN_REQUIRED')
    for role in ('anon','service_role'):
        denied(delete_query(issue(1244),role=role))
    for actor in ('manager','leader'):
        fresh_seed([issue(1244)]); assert value(delete_query(issue(1244),actor=actor))['deleted_issues']==1
    passed('delete is active authorized staff only; rep/inactive/anon/service role denied')

    for status in ('claimed','unknown'):
        fresh_seed([issue(1244)])
        sql("INSERT INTO reco_issue_ledger(member_id,round_no,source_site,status,issue,should_send,mode) VALUES('a',1244,'lotto815','"+status+"','{}',true,'scheduled');")
        denied(delete_query(issue(1244)),'RECO_DELETE_DELIVERY_UNRESOLVED')
    for status in ('pending','claimed','unknown'):
        fresh_seed([issue(1244)])
        sql("INSERT INTO lotto_sync_jobs(round_no,status) VALUES(1244,'complete'); INSERT INTO lotto_sync_sms_outbox(round_no,member_id,rank,numbers,prize,status) VALUES(1244,'a',1,ARRAY[1,2,3,4,5,6],1000,'"+status+"');")
        denied(delete_query(issue(1244)),'RECO_DELETE_DELIVERY_UNRESOLVED')
    passed('unresolved recommendation or winner delivery blocks deletion without touching receipts')

    fresh_seed([issue(1244)])
    queue(); value(delete_query(issue(1244))); got=batch();assert got['ok'],got
    assert current_meta()['weekly_recos']==[] and reco_records()==[]
    assert not snapshot()['lotto_sync_sms_outbox']
    passed('delete after snapshot cannot recreate winning records or winner SMS')

    fresh_seed([issue(1244)])
    add_second([issue(1244)])
    sql("UPDATE members SET meta=meta||'{\"source_site\":\"infolotto\"}' WHERE id='b';")
    queue(); got=batch();assert got['ok'] and got['winners']==2
    assert len(value("SELECT meta->'win_records' FROM members WHERE id='a'"))==1
    assert len(value("SELECT meta->'win_records' FROM members WHERE id='b'"))==1
    passed('same-phone separate-site member contracts retain distinct winner records')

    fresh_seed([issue(1244)])
    queue()
    proc=asyncsql("BEGIN; SET application_name='consumer-delete';"+delete_query(issue(1244))+"SELECT pg_sleep(0.8); COMMIT;")
    wait_sleep('consumer-delete'); got=batch()
    proc.communicate(timeout=10); assert proc.returncode==0 and got['ok']
    assert reco_records()==[] and current_meta()['weekly_recos']==[]
    passed('concurrent delete and queued aggregation serialize without resurrecting history')
    REPORT['passed']=True
    if OPTIONS.report:
        schema = run(['docker','exec',CONTAINER,'pg_dump','-U','postgres','--schema-only','--no-owner','--no-privileges']).stdout
        schema_path = OPTIONS.report.parent / 'typegen-schema.sql'
        schema_path.write_text(schema)
        schema_path.chmod(0o600)
        REPORT['schema_sha256'] = hashlib.sha256(schema_path.read_bytes()).hexdigest()
finally:
    if OPTIONS.keep_container and REPORT['passed']:
        REPORT['synthetic_container'] = CONTAINER
    else:
        run(['docker','rm','-f',CONTAINER],check=False)
    if OPTIONS.report:
        OPTIONS.report.parent.mkdir(parents=True,exist_ok=True)
        OPTIONS.report.write_text(json.dumps(REPORT,ensure_ascii=False,indent=2)+'\n')
        OPTIONS.report.chmod(0o600)
    print(json.dumps(REPORT,ensure_ascii=False,indent=2))
