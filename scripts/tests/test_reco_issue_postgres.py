#!/usr/bin/env python3
"""Real PostgreSQL regression tests. Cached Docker only, --network none, synthetic data.

python3 scripts/tests/test_reco_issue_postgres.py [--report /private/result.json]
No production environment files, credentials, ports, or external requests are used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261005103000_atomic_reco_issue.sql'
CONTAINER = f'lotto-reco-claim-test-{os.getpid()}'
REPORT = {'passed': False, 'network': 'none', 'production_access': False, 'provider_calls': 0, 'checks': [],
          'migration_sha256': hashlib.sha256(MIGRATION.read_bytes()).hexdigest()}
ARGS = argparse.ArgumentParser()
ARGS.add_argument('--report', type=Path)
OPTIONS = ARGS.parse_args()


def run(args, data=None, check=True):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=40)
    if check and result.returncode:
        raise RuntimeError(result.stderr[-2500:])
    return result


def sql(query, check=True):
    return run(['docker', 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], query, check)


def value(query):
    return json.loads(sql(query).stdout.strip().splitlines()[-1])


def literal(obj):
    return "'" + json.dumps(obj, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def meta(member='fixture'):
    return value(f"SELECT meta FROM public.members WHERE id='{member}'")


def reset():
    sql("""TRUNCATE public.reco_issue_ledger,public.sms_sends,public.members CASCADE;
      UPDATE staff SET is_active=true,team_id=CASE WHEN id='other-leader' THEN 'other-team' ELSE 'team' END;
      UPDATE site_settings SET weekly_free_reco='{"enabled":true,"paid_sms":true,"set_count":2}',
        sms='{"oneshot_enabled":true,"sender_no":"0200000000","by_site":{"lotto815":{"sender_no":"0200000001"},"infolotto":{"sender_no":"0200000002"}}}';
      INSERT INTO members(id,user_id,name,phone,grade,status,assigned_staff_id,team_id,meta)
        VALUES('fixture','synthetic','synthetic','01000000000','vip','active','rep','team',
        jsonb_build_object('weekly_reco_day',extract(dow FROM now() AT TIME ZONE 'Asia/Seoul')::int,
          'weekly_reco_count',2,'end_date','2099-12-31','source_site','lotto815',
          'unrelated',jsonb_build_object('nested',jsonb_build_array('preserve',null,17))));""")


def query(member='fixture', expected=None, mode='scheduled', actor=None, also_sms=True, sets=None, site='lotto815', day='today', round_no=1245, set_count=None, expected_grade='vip', expected_phone='01000000000'):
    if expected is None:
        expected = meta(member)
    if sets is None:
        sets = [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]]
    issue = {'round_no': round_no, 'issued_at': '2020-01-01T00:00:00Z', 'sets': sets}
    d = "(now() AT TIME ZONE 'Asia/Seoul')::date"
    if day != 'today':
        d += '-1'
    return ("SET ROLE service_role; SELECT public.reco_issue_claim(" +
            f"'{member}',{round_no},{literal(expected)},{literal(issue)},'{site}',{d}," +
            f"extract(dow FROM {d})::integer,'{mode}',{str(also_sms).lower()}," +
            ('NULL' if actor is None else f"'{actor}'") + ',' + ('NULL' if set_count is None else str(set_count)) + f",'{expected_grade}','{expected_phone}');")


def claim(**kwargs):
    return value(query(**kwargs))


def finish(c, outcome='accepted', receipt=None, check=True):
    if receipt is None:
        receipt = {'body': 'synthetic combo only', 'code': '0', 'cmid': 'synthetic-receipt', 'httpStatus': 200}
    q = "SET ROLE service_role; SELECT public.reco_issue_finish(" + f"'{c['claim_id']}','{c['claim_token']}','{outcome}',{literal(receipt)});"
    result = sql(q, check)
    return json.loads(result.stdout.strip().splitlines()[-1]) if result.returncode == 0 else result


def snapshot():
    return {table: value(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.{table} t")
            for table in ('members', 'reco_issue_ledger', 'sms_sends')}


def passed(name):
    REPORT['checks'].append({'name': name, 'passed': True})
    print(json.dumps({'passed': name}), flush=True)


def unchanged_denial(expected_reason, **kwargs):
    before = snapshot()
    got = claim(**kwargs)
    assert got['claimed'] is False and got['reason'] == expected_reason, got
    assert snapshot() == before, 'denied claim mutated data'


def asyncsql(q):
    p = subprocess.Popen(['docker', 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    p.stdin.write(q)
    p.stdin.close()
    p.stdin = None
    return p


def wait_sleep(app):
    for _ in range(80):
        if sql(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{app}' AND wait_event='PgSleep'").stdout.strip() == '1':
            return
        time.sleep(.025)
    raise AssertionError('concurrent transaction did not reach sleep')


try:
    run(['docker', 'run', '--rm', '--pull', 'never', '-d', '--name', CONTAINER, '--network', 'none',
         '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine'])
    for _ in range(100):
        logs = run(['docker', 'logs', CONTAINER], check=False)
        if 'PostgreSQL init process complete' in logs.stdout + logs.stderr and run(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'postgres'], check=False).returncode == 0:
            break
        time.sleep(.1)
    else:
        raise RuntimeError('isolated PostgreSQL startup timed out')
    REPORT['postgres_version'] = sql('SHOW server_version').stdout.strip()
    sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);')
    sql((ROOT / 'supabase/migrations/0001_schema.sql').read_text())
    sql((ROOT / 'supabase/migrations/0004_settings_missing_columns.sql').read_text())
    sql("ALTER TABLE public.sms_sends ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'; GRANT USAGE ON SCHEMA public TO service_role,authenticated,anon; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;")
    sql(MIGRATION.read_text())
    sql("""INSERT INTO teams(id,name) VALUES('team','synthetic'),('other-team','synthetic-other');
      INSERT INTO staff(id,login_id,name,role,team_id) VALUES('admin','admin','synthetic','admin','team'),
        ('leader','leader','synthetic','leader','team'),('other-leader','other-leader','synthetic','leader','other-team'),
        ('rep','rep','synthetic','rep','team'),('other-rep','other-rep','synthetic','rep','team');
      INSERT INTO site_settings(id) VALUES(1);
      INSERT INTO lotto_rounds(round_no,draw_date,numbers,bonus) VALUES(1244,'2026-10-03',ARRAY[1,2,3,4,5,6],7);""")
    reset()
    original = snapshot()['members'][0]
    c = claim()
    assert c['claimed'] and c['should_send'] and c['status'] == 'claimed', c
    assert c['issue']['issued_at'] != '2020-01-01T00:00:00Z'
    changed = snapshot()['members'][0]
    old_meta = original['meta']; new_meta = changed['meta']
    assert {k: v for k, v in old_meta.items() if k != 'weekly_recos'} == {k: v for k, v in new_meta.items() if k != 'weekly_recos'}
    assert {k: v for k, v in original.items() if k != 'meta'} == {k: v for k, v in changed.items() if k != 'meta'}
    assert len(snapshot()['sms_sends']) == 1 and '접수확인필요' in snapshot()['sms_sends'][0]['status']
    passed('claim commits ledger, exact issue and unresolved SMS together; unrelated whole row preserved')
    unchanged_denial('ALREADY_CLAIMED')
    passed('lost claim response cannot reclaim or issue again')
    assert finish(c)['status'] == 'accepted'
    accepted = snapshot()
    assert accepted['sms_sends'][0]['status'] == '발송완료'
    assert finish(c)['repeated'] is True and snapshot() == accepted
    unchanged_denial('ALREADY_CLAIMED')
    assert finish(c, 'unknown', check=False).returncode != 0
    passed('lost finish response safely repeats receipt only; finalized receipt cannot change or resend')

    for outcome in ('rejected', 'unknown', 'not_requested'):
        reset(); c = claim(); finish(c, outcome)
        unchanged_denial('ALREADY_CLAIMED')
        assert len(snapshot()['sms_sends']) == 1
    reset(); c = claim(also_sms=False)
    assert c['should_send'] is False and snapshot()['sms_sends'] == []
    assert finish(c, 'accepted', check=False).returncode != 0
    assert finish(c, 'not_requested')['status'] == 'not_requested'
    unchanged_denial('ALREADY_CLAIMED')
    passed('all outcomes including generation-only permanently block automatic re-claim')

    changes = [
        ("UPDATE members SET is_suspended=true", 'MEMBER_INACTIVE'),
        ("UPDATE members SET status='withdrawn'", 'MEMBER_INACTIVE'),
        ("UPDATE members SET is_deleted=true", 'MEMBER_INACTIVE'),
        ("UPDATE members SET is_withdrawn=true", 'MEMBER_INACTIVE'),
        ("UPDATE members SET meta=meta||'{\"reco_paused\":true}'", 'HELD'),
        ("UPDATE members SET meta=meta||'{\"reco_pause_reason\":\"legacy_import_review\"}'", 'STALE_META'),
        ("UPDATE members SET meta=meta||'{\"source_site\":\"infolotto\"}'", 'SITE_CHANGED'),
        ("UPDATE members SET meta=meta||'{\"field_edit\":\"preserve\"}'", 'STALE_META'),
    ]
    for change, reason in changes:
        reset(); stale = meta(); sql(change); unchanged_denial(reason, expected=stale)
    passed('fresh booleans/status/hold/site and whole-meta CAS reject every stale snapshot before writes')
    for change in ("UPDATE members SET grade='free'", "UPDATE members SET phone='01000000001'"):
        reset(); stale = meta(); sql(change); unchanged_denial('MEMBER_CHANGED', expected=stale)
    passed('grade and phone changes reject generated-for-old-member snapshot before durable claim')
    reset(); sql("UPDATE members SET meta=meta||'{\"reco_paused\":false,\"reco_pause_reason\":\"legacy_import_review\"}'")
    assert claim()['claimed']
    reset(); sql("UPDATE members SET meta=meta||'{\"reco_paused\":\"false\"}'")
    unchanged_denial('INVALID_HOLD')
    passed('explicit boolean false allows retained hold history; malformed pause type fails closed')

    for patch, reason in [({'end_date': '2020-01-01'}, 'EXPIRED'), ({'end_date': '2026-02-30'}, 'INVALID_END_DATE'),
                          ({'weekly_reco_count': 0}, 'COUNT_ZERO'), ({'weekly_reco_count': 3}, 'COUNT_CHANGED'),
                          ({'weekly_reco_day': 9}, 'INVALID_DAY')]:
        reset(); sql('UPDATE members SET meta=meta||' + literal(patch)); unchanged_denial(reason)
    reset(); sql("UPDATE members SET meta=jsonb_set(meta,'{weekly_reco_day}',to_jsonb((extract(dow FROM now() AT TIME ZONE 'Asia/Seoul')::int+1)%7))")
    unchanged_denial('DAY')
    reset(); unchanged_denial('INVALID_CONTEXT', day='yesterday'); unchanged_denial('ROUND_CHANGED', round_no=1246)
    passed('DB KST/round/expiry/day/count checks are authoritative')
    reset(); sql("UPDATE members SET meta=meta||'{\"weekly_recos\":[{\"round_no\":1246},{\"round_no\":1245}]}'")
    unchanged_denial('ALREADY_ISSUED')
    passed('legacy same-round entry anywhere in history blocks issuance')

    reset(); sql("UPDATE site_settings SET weekly_free_reco='{" + '"enabled":false,"paid_sms":false,"set_count":2' + "}'")
    unchanged_denial('DISABLED')
    reset(); sql("UPDATE site_settings SET sms=jsonb_set(sms,'{oneshot_enabled}','false')")
    c = claim(); assert c['should_send'] is False; finish(c, 'not_requested')
    reset(); sql("UPDATE site_settings SET sms=sms-'by_site'")
    c = claim(); assert c['should_send'] is False and snapshot()['sms_sends'] == []
    passed('current global toggles and per-site sender cannot use stale API settings or default sender fallback')

    for actor in ('admin', 'leader', 'other-leader', 'rep'):
        reset(); c = claim(mode='manual', actor=actor); assert c['claimed']
    reset(); sql("UPDATE staff SET team_id=NULL WHERE id='leader'"); assert claim(mode='manual', actor='leader')['claimed']
    for actor in ('other-rep', 'missing'):
        reset(); unchanged_denial('ACTOR_SCOPE', mode='manual', actor=actor)
    reset(); unchanged_denial('ACTOR_REQUIRED', mode='manual')
    sql("UPDATE staff SET is_active=false WHERE id='admin'")
    unchanged_denial('ACTOR_SCOPE', mode='manual', actor='admin')
    passed('manual preserves live admin/manager/leader whole-member scope, including cross-team/null-team leader, and rep-own-only')
    reset(); sql("UPDATE members SET grade='free',meta=meta||'{\"weekly_reco_count\":0}'")
    sql("UPDATE site_settings SET weekly_free_reco=jsonb_set(weekly_free_reco,'{paid_sms}','false')")
    unchanged_denial('COUNT_ZERO', mode='manual', actor='admin', expected_grade='free')
    c = claim(mode='manual', actor='admin', sets=[[1, 2, 3, 4, 5, 6]], set_count=1, expected_grade='free')
    assert c['claimed'] and c['should_send'] and meta()['weekly_reco_count'] == 0
    passed('explicit single-member manual count overrides zero without enabling future scheduled sends')

    for role in ('anon', 'authenticated'):
        reset()
        denied = sql(query().replace('SET ROLE service_role;', f'SET ROLE {role};'), False)
        assert denied.returncode != 0
        assert sql(f'SET ROLE {role}; SELECT * FROM public.reco_issue_ledger;', False).returncode != 0
        assert sql(f"SET ROLE {role}; UPDATE public.reco_issue_ledger SET status='accepted';", False).returncode != 0
        assert snapshot()['reco_issue_ledger'] == []
    assert sql('SET ROLE service_role; DELETE FROM public.reco_issue_ledger;', False).returncode != 0
    passed('anon/authenticated cannot execute RPC or read/write ledger; service cannot delete tombstones')

    reset(); q = query()
    sql("CREATE FUNCTION synthetic_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER synthetic_fail BEFORE INSERT ON public.sms_sends FOR EACH ROW EXECUTE FUNCTION synthetic_fail_insert();")
    before = snapshot(); assert sql(q, False).returncode != 0; assert snapshot() == before
    sql('DROP TRIGGER synthetic_fail ON public.sms_sends; DROP FUNCTION synthetic_fail_insert();')
    passed('claim SMS-history insert failure rolls back ledger and metadata atomically')
    c = claim(); before = snapshot()
    sql("CREATE FUNCTION synthetic_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER synthetic_fail BEFORE UPDATE ON public.sms_sends FOR EACH ROW EXECUTE FUNCTION synthetic_fail_update();")
    assert finish(c, check=False).returncode != 0 and snapshot() == before
    sql('DROP TRIGGER synthetic_fail ON public.sms_sends; DROP FUNCTION synthetic_fail_update();')
    unchanged_denial('ALREADY_CLAIMED'); finish(c)
    passed('finish failure preserves unresolved claim; receipt can be recorded without provider retry')

    reset(); stale = meta(); q = query(expected=stale)
    a = asyncsql("SET application_name='claim_same'; BEGIN;" + q + 'SELECT pg_sleep(1.2); COMMIT;')
    wait_sleep('claim_same'); b = asyncsql(q)
    ao, ae = a.communicate(timeout=12); bo, be = b.communicate(timeout=12)
    assert a.returncode == b.returncode == 0, (ae, be)
    assert '"claimed": true' in ao and '"claimed": false' in bo
    assert len(snapshot()['reco_issue_ledger']) == len(snapshot()['sms_sends']) == 1
    passed('two real concurrent claim sessions commit one issue and one SMS intent')

    for change, reason, label in [
        ("UPDATE members SET is_suspended=true WHERE id='fixture'", 'MEMBER_INACTIVE', 'status'),
        ("UPDATE members SET meta=meta||'{\"unrelated_concurrent\":true}' WHERE id='fixture'", 'STALE_META', 'metadata')]:
        reset(); stale = meta()
        a = asyncsql("SET application_name='field_edit'; BEGIN;" + change + '; SELECT pg_sleep(1.2); COMMIT;')
        wait_sleep('field_edit'); b = asyncsql(query(expected=stale))
        ao, ae = a.communicate(timeout=12); bo, be = b.communicate(timeout=12)
        assert a.returncode == b.returncode == 0 and reason in bo, (ae, be, bo)
        assert snapshot()['reco_issue_ledger'] == [] and snapshot()['sms_sends'] == []
        passed('two sessions: committed field ' + label + ' edit rejects waiting stale claim')

    reset(); sql("INSERT INTO members(id,user_id,name,phone,grade,status,meta) SELECT 'other-contract','synthetic-other',name,phone,grade,status,meta||'{\"source_site\":\"infolotto\"}' FROM members WHERE id='fixture'")
    first = claim(); second = claim(member='other-contract', site='infolotto')
    assert first['claimed'] and second['claimed'] and len(snapshot()['reco_issue_ledger']) == 2
    passed('identical phone across source-site member IDs preserves separate contracts and claims')
    assert hashlib.sha256(MIGRATION.read_bytes()).hexdigest() == REPORT['migration_sha256'], 'migration changed during verification'
    REPORT['passed'] = True
except Exception as error:
    REPORT['error'] = str(error)
    raise
finally:
    cleanup = run(['docker', 'rm', '-f', CONTAINER], check=False)
    REPORT['container_removed'] = cleanup.returncode == 0
    if OPTIONS.report:
        OPTIONS.report.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        OPTIONS.report.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
        OPTIONS.report.chmod(0o600)
    print(json.dumps(REPORT, ensure_ascii=False), flush=True)
