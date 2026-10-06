#!/usr/bin/env python3
"""Additional manual issuance regression on cached PostgreSQL 17, --network none.

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
    '20261006133000_manual_additional_reco.sql')]
CONTAINER = f'lotto-manual-addition-test-{os.getpid()}'
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
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=150)
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
    sql('TRUNCATE public.reco_manual_operations,public.members,public.reco_issue_ledger,public.sms_sends,public.payments,'
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


def manual_query(op=None, expected=None, sets=None, also_sms=True, actor='admin', mid='a', count=1):
    op=op or str(uuid.uuid4())
    if expected is None: expected=current_meta(mid)
    obj=issue(1245)
    if sets is not None: obj['sets']=sets
    return ("SET ROLE service_role; SELECT public.reco_issue_manual_claim("+f"'{op}','{mid}',1245,"
      +literal(expected)+','+literal(obj)+",'lotto815',(now() AT TIME ZONE 'Asia/Seoul')::date,"
      +"extract(dow FROM now() AT TIME ZONE 'Asia/Seoul')::int,'manual',"+str(also_sms).lower()
      +f",'{actor}',{count},'vip','01000000000');")

def finish(c, outcome='accepted'):
    return value("SET ROLE service_role; SELECT public.reco_issue_finish("+f"'{c['claim_id']}','{c['claim_token']}','{outcome}',"
       +literal({'code':'0' if outcome=='accepted' else outcome,'httpStatus':200,'body':'synthetic'})+");")


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

    seed([issue(1245)])
    op=str(uuid.uuid4())
    c=value(manual_query(op));assert c['claimed'] and c['should_send'],c
    assert c['issue']['manual_request_id']==op
    assert len(current_meta()['weekly_recos'])==2
    repeated=value(manual_query(op));assert not repeated['claimed'],repeated
    assert value("SELECT count(*) FROM reco_issue_ledger")==1
    assert value("SELECT count(*) FROM sms_sends")==2
    assert value(manual_query(op, count=2))['reason']=='OPERATION_CONFLICT'
    assert value(manual_query(op, also_sms=False))['reason']=='OPERATION_CONFLICT'
    assert value(manual_query(op, actor='manager'))['reason']=='OPERATION_CONFLICT'
    passed('legacy current issue preserved; new UUID appends; same UUID never claims again; payload and actor binding')
    assert value(manual_query())['reason']=='PRIOR_RECEIPT_UNRESOLVED'
    assert value(claim_query())['reason']=='PRIOR_RECEIPT_UNRESOLVED'
    finish(c)
    c2=value(manual_query());assert c2['claimed'],c2
    finish(c2)
    assert len(current_meta()['weekly_recos'])==3
    assert value(claim_query())['reason']=='ALREADY_ISSUED'
    passed('unresolved operation blocks new manual and automatic; accepted allows deliberate additional UUID; legacy blocks auto')

    seed([])
    c=value(manual_query(also_sms=False));finish(c,'not_requested')
    automatic=value(claim_query());assert automatic['claimed'],automatic;finish(automatic)
    assert not value(claim_query())['claimed']
    assert len(current_meta()['weekly_recos'])==2
    passed('new manual-only issue does not suppress one automatic issue; second automatic remains blocked')

    seed([])
    op=str(uuid.uuid4())
    sql("UPDATE members SET meta=meta||'{\"reco_paused\":true}' WHERE id='a'")
    denied_op=value(manual_query(op));assert denied_op['confirmedNotIssued'] and denied_op['reason']=='HELD',denied_op
    sql("UPDATE members SET meta=meta||'{\"reco_paused\":false}' WHERE id='a'")
    assert value(manual_query(op))['confirmedNotIssued']
    assert value('SELECT count(*) FROM reco_issue_ledger')==0
    assert value(manual_query())['claimed']
    passed('pre-claim hold denial creates immutable blocked intent; delayed same UUID cannot issue after hold removed')

    for flag in [{'legacy_agree_sms_yn':'N'},{'sms_opt_out':True},{'sms_consent':False},{'do_not_contact':True}]:
        seed([]);sql("UPDATE members SET meta=meta||"+literal(flag)+" WHERE id='a'")
        got=value(manual_query());assert got['reason']=='CONSENT_REVIEW_REQUIRED',got
        assert value('SELECT count(*) FROM reco_issue_ledger')==0
    passed('explicit manual cannot bypass original N or current opt-out')

    for status in ['unknown','rejected']:
        seed([]);c=value(manual_query());finish(c,status)
        assert value(manual_query())['reason']=='PRIOR_RECEIPT_UNRESOLVED'
        assert value(claim_query())['reason']=='PRIOR_RECEIPT_UNRESOLVED'
    passed('unknown and rejected receipts block both new manual UUID and automatic until separate reconciliation')

    seed([issue(1245)])
    value(reset_query())
    sql("UPDATE members SET grade='vip' WHERE id='a'")
    assert not value(claim_query())['claimed']
    c=value(manual_query());assert c['claimed'],c;finish(c)
    old=c['issue']
    value(reset_query())
    sql("UPDATE members SET grade='vip' WHERE id='a'")
    denied("UPDATE members SET meta=meta||"+literal({'weekly_recos':[old]})+" WHERE id='a'",'RECO_RESET_ALREADY_ISSUED')
    new=value(manual_query());assert new['claimed'],new
    passed('legacy reset stays automatic tombstone; new manual allowed; reset exact manual restoration rejected')

    seed([])
    c=value(manual_query(also_sms=False));finish(c,'not_requested')
    value(reset_query());sql("UPDATE members SET grade='vip' WHERE id='a'")
    automatic=value(claim_query());assert automatic['claimed'],automatic
    passed('reset of only new manual does not forbid first automatic issuance')

    seed([issue(1200+n) for n in range(12)])
    before=current_meta()['weekly_recos']
    c=value(manual_query(also_sms=False));finish(c,'not_requested')
    assert current_meta()['weekly_recos'][1:]==before
    c=value(claim_query());assert c['claimed'];finish(c)
    assert len(current_meta()['weekly_recos'])==14
    passed('manual and automatic append preserve all previous issues beyond eight')

    seed([])
    expected=current_meta();op=str(uuid.uuid4())
    first=asyncsql("SET application_name='manual_once';BEGIN;"+manual_query(op,expected=expected)+"SELECT pg_sleep(1.2);COMMIT;")
    wait_sleep('manual_once')
    second=asyncsql(manual_query(op,expected=expected))
    a,ae=first.communicate(timeout=12);b,be=second.communicate(timeout=12)
    assert first.returncode==second.returncode==0,(ae,be)
    assert value('SELECT count(*) FROM reco_issue_ledger')==1
    assert value('SELECT count(*) FROM sms_sends')==2
    passed('concurrent same UUID takes one claim and one SMS placeholder')

    seed([])
    expected=current_meta()
    first=asyncsql("SET application_name='manual_race';BEGIN;"+manual_query(expected=expected,also_sms=False)+"SELECT pg_sleep(1.2);COMMIT;")
    wait_sleep('manual_race')
    second=asyncsql(claim_query(expected=expected))
    a,ae=first.communicate(timeout=12);b,be=second.communicate(timeout=12)
    assert first.returncode==second.returncode==0,(ae,be)
    assert value('SELECT count(*) FROM reco_issue_ledger')==1
    assert 'STALE_META' in b or 'PRIOR_RECEIPT_UNRESOLVED' in b,b
    assert len(current_meta()['weekly_recos'])==1
    passed('concurrent manual and automatic never overwrite metadata or issue based on stale snapshot')

    # Same round advisory lock as the real draw-start function, in both orderings.
    sql("CREATE OR REPLACE FUNCTION lotto_sync_private.expected_round() RETURNS integer LANGUAGE sql AS $$ SELECT 1245 $$;")
    draw={'round_no':1245,'draw_date':'2026-10-10T00:00:00+09:00','numbers':[1,2,3,4,5,6],
          'bonus':7,'prize_1':1000,'prize_2':100,'prize_3':10,'total_sales':10000}
    start_draw="SET ROLE service_role; SELECT public.lotto_sync_start("+literal(draw)+",false);"
    for issuing in [manual_query,claim_query]:
        seed([]);sql('DELETE FROM lotto_rounds WHERE round_no=1245')
        expected=current_meta()
        first=asyncsql("SET application_name='issue_before_draw';BEGIN;"+issuing(expected=expected)+"SELECT pg_sleep(1.2);COMMIT;")
        wait_sleep('issue_before_draw')
        second=asyncsql(start_draw)
        a,ae=first.communicate(timeout=12);b,be=second.communicate(timeout=12)
        assert first.returncode==second.returncode==0,(ae,be)
        assert value("SELECT count(*) FROM lotto_sync_work WHERE round_no=1245 AND target_id='a'")==1
        seed([]);sql('DELETE FROM lotto_rounds WHERE round_no=1245')
        expected=current_meta()
        first=asyncsql("SET application_name='draw_before_issue';BEGIN;"+start_draw+"SELECT pg_sleep(1.2);COMMIT;")
        wait_sleep('draw_before_issue')
        second=asyncsql(issuing(expected=expected))
        a,ae=first.communicate(timeout=12);b,be=second.communicate(timeout=12)
        assert first.returncode==second.returncode==0,(ae,be)
        assert 'ROUND_CHANGED' in b,b
        assert value('SELECT count(*) FROM reco_issue_ledger')==0
    passed('draw and issuance serialize: issue-first enters draw snapshot; draw-first blocks stale manual and automatic round')
    seed([]);sql('DELETE FROM lotto_rounds WHERE round_no=1245')

    seed([])
    for role in ['anon','authenticated']:
        assert sql('SET ROLE '+role+';SELECT * FROM reco_manual_operations',False).returncode!=0
        assert sql(manual_query().replace('SET ROLE service_role','SET ROLE '+role),False).returncode!=0
    assert value(manual_query(actor='inactive'))['reason']=='ACTOR_SCOPE'
    sql("UPDATE members SET assigned_staff_id='manager' WHERE id='a'")
    assert value(manual_query(actor='rep'))['reason']=='ACTOR_SCOPE'
    passed('operation ledger private; RPC service-only; current inactive and rep-scope checks retained')
    REPORT['passed']=True
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
