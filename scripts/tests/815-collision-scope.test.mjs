// Actual migration SQL against local PGlite and synthetic rows only. No network or customer fixtures.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const load = (file) => readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8')
const portalSql = await load('20260914032620_scoped_legacy_portal.sql')
const importSql = await load('20260914032636_atomic_815_collision_import.sql')
const protectedSql = await load('20260914033702_atomic_815_collision_protected_snapshot.sql')
const flags = Object.fromEntries(['groupSystemYN', 'groupAdminYN', 'groupPartnerYN', 'groupSalesYN',
  'groupSecondSalesYN', 'groupStaffYN', 'groupDummyYN', 'groupTeamAdmYN', 'groupTeamYN'].map((key) => [key, 'N']))
const adminUid = '00000000-0000-0000-0000-000000000001'
let serial = 100
const batch = () => `lotto815-collision-local-${++serial}`

function member(b, overrides = {}) {
  const idx = ++serial
  return {
    id: `mem_${randomUUID()}`, user_id: `local-${idx}`, name: '합성 815 계약', nickname: null,
    phone: `01091${String(idx).padStart(6, '0')}`, grade: 'goldp', status: 'active', consult_status: '신규',
    outcall_done: false, inflow_code: null, inflow_type: null, memo: null,
    registered_at: '2024-01-01T00:00:00Z', last_active_at: null,
    is_suspended: false, is_deleted: false, is_withdrawn: false,
    meta: { source_site: 'lotto815', import_batch: b, legacy_idx: idx, reco_paused: true,
      reco_pause_reason: 'legacy_import_review', legacy_consent_review_required: true,
      legacy_agree_sms_yn: 'N', legacy_account_flags: { ...flags } },
    ...overrides,
  }
}

function payment(b, m, overrides = {}) {
  return {
    id: `pay_${randomUUID()}`, member_id: m.id, product_id: 'legacy_lotto815_family', amount: 1000,
    method: 'manual', status: 'approved', period_start: '2024-01-01T00:00:00Z',
    period_end: '2027-01-01T00:00:00Z', depositor_name: null,
    paid_at: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z',
    meta: { source_site: 'lotto815', import_batch: b, legacy_idx: ++serial }, ...overrides,
  }
}

async function as(role, action, uid = '') {
  await db.exec(`SET ROLE ${role}`)
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid])
  try { return await action() } finally {
    await db.exec('RESET ROLE')
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)")
  }
}

async function call(b, members, payments, counts = [members.length, payments.length, payments.reduce((n, p) => n + p.amount, 0)]) {
  return (await db.query('SELECT public.admin_import_815_collision_batch($1,$2,$3,$4,$5,$6) AS result',
    [b, JSON.stringify(members), JSON.stringify(payments), ...counts])).rows[0].result
}

async function snapshot() {
  return (await db.query(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM public.members m) AS members,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.payments p) AS payments,
    (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]') FROM public.logs l) AS logs,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.products p) AS products,
    (SELECT count(*)::int FROM public.sms_sends) AS sms,
    (SELECT count(*)::int FROM public.assignments) AS assignments`)).rows[0]
}

async function rejectsUnchanged(b, members, payments = [], counts, code = '22023') {
  const previous = await snapshot()
  await as('service_role', () => assert.rejects(call(b, members, payments, counts), { code }))
  assert.deepEqual(await snapshot(), previous)
  assert.equal((await db.query("SELECT nullif(current_setting('app.lotto815_collision_batch',true),'') AS batch")).rows[0].batch, null)
}

async function directMember(id, phone, meta = {}, extra = {}) {
  const row = { id, user_id: id, name: id, phone, meta, status: 'active', grade: 'free',
    registered_at: '2024-01-01T00:00:00Z', is_deleted: false, is_withdrawn: false, ...extra }
  return db.query(`INSERT INTO public.members(id,user_id,name,phone,meta,status,grade,registered_at,is_deleted,is_withdrawn)
    SELECT id,user_id,name,phone,meta,status,grade,registered_at,is_deleted,is_withdrawn
    FROM jsonb_populate_record(NULL::public.members,$1) RETURNING id`, [JSON.stringify(row)])
}

async function portal(phone, pw, site) {
  return (await db.query('SELECT portal_member_recos_for_site($1,$2,$3) AS result', [phone, pw, site])).rows[0].result
}
const forms = (phone) => [phone, `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`,
  `+82 ${phone.slice(1)}`, `0082 ${phone.slice(1)}`, `+82 ${phone}`, `0082 ${phone}`]

before(async () => {
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;`)
  await db.exec(await load('0001_schema.sql'))
  await db.exec(await load('0002_rls.sql'))
  await db.exec(`ALTER TABLE public.members ADD COLUMN consult_status text DEFAULT '신규';
    ALTER TABLE public.payments ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
    INSERT INTO auth.users VALUES ('${adminUid}');
    INSERT INTO staff(id,login_id,name,role,auth_user_id) VALUES ('admin','admin','테스트 관리자','admin','${adminUid}');
    INSERT INTO products(id,name,grade_granted,is_active) VALUES ('legacy_lotto815_family','합성 과거상품','goldp',false);`)
  const provenance = await load('20260831094500_legacy_import_provenance_and_source_filter.sql')
  await db.exec(provenance.slice(provenance.indexOf('create unique index if not exists members_legacy_source_idx'),
    provenance.indexOf('create unique index if not exists sms_sends_legacy_source_idx')))
  const siteSql = await load('20260909001521_admin_site_scope.sql')
  await db.exec(siteSql.slice(siteSql.indexOf('CREATE OR REPLACE FUNCTION public.member_operating_site'),
    siteSql.indexOf('CREATE INDEX IF NOT EXISTS members_operating_site')))
  await directMember('native', '01011112222', { unchanged: true, nested: { keep: [1, 2] }, homepage_pw: 'native-pw',
    weekly_recos: [{ round_no: 1200, sets: [[1, 2, 3, 4, 5, 6]] }] })
  await db.exec(`INSERT INTO payments(id,member_id,product_id,amount,method,status,meta)
    VALUES ('native-pay','native','legacy_lotto815_family',800,'manual','approved','{"untouched":[1,2,3]}')`)
  // Existing historical fixtures deliberately predate the duplicate guard.
  await directMember('portal-plus', '01022223333', { homepage_pw: 'plus-pw', weekly_recos: [{ round_no: 1200 }] })
  await directMember('portal-815', '+82 10 2222 3333', { source_site: 'lotto815', homepage_pw: '815-pw',
    reco_paused: true, reco_pause_reason: 'legacy_import_review', end_date: '2020-01-01', weekly_recos: [{ round_no: 1199 }] }, { grade: 'vip' })
  await directMember('portal-duplicate-a', '01033334444', { source_site: 'lotto815', homepage_pw: 'one' })
  await directMember('portal-duplicate-b', '0082 10 3333 4444', { source_site: 'lotto815', homepage_pw: 'two' })
  await directMember('portal-deleted', '01022223333', { source_site: 'lotto815', homepage_pw: 'deleted' }, { status: 'deleted', is_deleted: true })
  await directMember('portal-withdrawn', '01022223333', { source_site: 'lotto815', homepage_pw: 'withdrawn' }, { status: 'withdrawn', is_withdrawn: true })
  await directMember('portal-native-old', '01044445555', { homepage_pw: 'old-pw' }, { registered_at: '2023-01-01T00:00:00Z' })
  await directMember('portal-native-recent', '01044445555', { homepage_pw: 'recent-pw' }, { registered_at: '2024-01-01T00:00:00Z' })
  await directMember('portal-latest-other-site', '01044445555', { source_site: 'lotto815', homepage_pw: 'other-pw' }, { registered_at: '2025-01-01T00:00:00Z' })
  const guard = (await load('20260722081812_duplicate_member_guard.sql')).split('-- 신규 차단 뒤에는')[0]
  await db.exec(guard)
  await db.exec(await load('20260831095852_member_duplicate_guard_use_phone_index.sql'))
  await db.exec(`CREATE TRIGGER members_admin_ops BEFORE INSERT OR UPDATE ON public.members
    FOR EACH ROW EXECUTE FUNCTION public.enforce_member_admin_ops();`)
  await db.exec(portalSql)
  await db.exec(importSql)
  await db.exec(protectedSql)
})
after(() => db.close())

test('migration replay changes no data and import permission is service-only', async () => {
  const previous = await snapshot()
  await db.exec(portalSql)
  await db.exec(importSql)
  await db.exec(protectedSql)
  assert.deepEqual(await snapshot(), previous)
  const fn = (await db.query(`SELECT prosecdef,proconfig FROM pg_proc
    WHERE oid='public.admin_import_815_collision_batch(text,jsonb,jsonb,integer,integer,bigint)'::regprocedure`)).rows[0]
  assert.equal(fn.prosecdef, false)
  assert.ok(fn.proconfig.includes('search_path=""'))
  assert.ok(fn.proconfig.includes('lock_timeout=3s'))
  for (const role of ['anon', 'authenticated']) {
    const b = batch()
    await as(role, () => assert.rejects(call(b, [member(b)], []), { code: '42501' }), role === 'authenticated' ? adminUid : '')
  }
})

test('same-phone PlusLotto and held 815 remain separate with every native row and log unchanged', async () => {
  const previous = await snapshot()
  const b = batch(), m = member(b, { phone: '01011112222' }), p = payment(b, m)
  const result = await as('service_role', () => call(b, [m], [p]))
  assert.deepEqual(result, { batch_id: b, members: 1, payments: 1, amount: 1000, held_members: 1, atomic: true,
    protected_members: 1, protected_payments: 1, existing_full_rows_unchanged: true })
  const next = await snapshot()
  assert.deepEqual(next.members.filter((row) => row.id !== m.id), previous.members)
  assert.deepEqual(next.payments.filter((row) => row.id !== p.id), previous.payments)
  for (const key of ['logs', 'products', 'sms', 'assignments']) assert.deepEqual(next[key], previous[key])
  assert.equal(next.members.find((row) => row.id === m.id).meta.reco_paused, true)
  await rejectsUnchanged(b, [m], [p], undefined, '23505')
  const replay = member(batch(), { user_id: 'fresh-user' })
  replay.meta.legacy_idx = m.meta.legacy_idx
  await rejectsUnchanged(replay.meta.import_batch, [replay], [], undefined, '23505')
})

test('native international phone spellings do not cause updates during domestic collision import', async () => {
  for (let i = 0; i < 5; i++) {
    const b = batch(), m = member(b), id = `native-alias-${++serial}`
    await directMember(id, forms(m.phone)[i + 1], { unchanged: true })
    const previous = await snapshot()
    const proof = await as('service_role', () => call(b, [m], []))
    assert.equal(proof.protected_members, 1)
    assert.equal(proof.protected_payments, 0)
    assert.equal(proof.existing_full_rows_unchanged, true)
    const next = await snapshot()
    assert.deepEqual(next.members.filter((row) => row.id !== m.id), previous.members)
    assert.deepEqual(next.logs, previous.logs)
    assert.deepEqual(next.payments, previous.payments)
  }
})

test('two inactive 815 source accounts at the same phone keep distinct source keys', async () => {
  const b = batch(), a = member(b, { status: 'deleted', is_deleted: true })
  const c = member(b, { phone: a.phone, status: 'withdrawn', is_withdrawn: true })
  const result = await as('service_role', () => call(b, [a, c], []))
  assert.equal(result.members, 2)
  assert.equal(result.held_members, 2)
  assert.equal(result.protected_members, 0)
  assert.equal(result.protected_payments, 0)
  assert.equal(result.existing_full_rows_unchanged, true)
  const rows = (await db.query('SELECT id,meta FROM members WHERE id=ANY($1)', [[a.id, c.id]])).rows
  assert.equal(new Set(rows.map((row) => row.meta.legacy_idx)).size, 2)
  await as('anon', async () => assert.equal(await portal(a.phone, a.phone.slice(-4), 'lotto815'), null))
})

test('flags, missing consent, unheld rows and operational recommendation content reject atomically', async () => {
  for (const change of [{ reco_paused: false }, { reco_paused: 'true' }, { source_site: 'pluslotto' },
    { legacy_agree_sms_yn: null }, { legacy_consent_review_required: false }, { weekly_recos: [] },
    { legacy_account_flags: { ...flags, groupTeamYN: 'Y' } }, { legacy_account_flags: {} }]) {
    const b = batch(), a = member(b), c = member(b)
    c.meta = { ...c.meta, ...change }
    await rejectsUnchanged(b, [a, c], [payment(b, a)])
  }
})

test('counts, amount, member link, source key and status mismatches reject before changes', async () => {
  const b = batch(), m = member(b), p = payment(b, m)
  await rejectsUnchanged(b, [m], [p], [1, 1, 999])
  await rejectsUnchanged(b, [m], [p], [2, 1, 1000])
  await rejectsUnchanged(b, [m], [{ ...p, member_id: 'native' }])
  const duplicate = member(b); duplicate.meta.legacy_idx = m.meta.legacy_idx
  await rejectsUnchanged(b, [m, duplicate], [])
  await rejectsUnchanged(b, [member(b, { status: 'deleted', is_deleted: false })])
  await rejectsUnchanged(b, [member(b, { assigned_staff_id: 'admin' })])
})

test('payment FK failure rolls back imported members, side effects and transaction context', async () => {
  const b = batch(), m = member(b, { phone: '01011112222' })
  await rejectsUnchanged(b, [m], [payment(b, m, { product_id: 'legacy_lotto815_mania' })], undefined, '23503')
})

test('context clears before RPC returns and an ordinary service INSERT still follows duplicate rules', async () => {
  const b = batch(), m = member(b)
  await db.exec('BEGIN; SET LOCAL ROLE service_role')
  try {
    await call(b, [m], [])
    assert.equal((await db.query("SELECT current_setting('app.lotto815_collision_batch',true) AS batch")).rows[0].batch, '')
    const duplicate = await directMember(`direct-${++serial}`, m.phone, { ...m.meta, legacy_idx: ++serial })
    assert.equal(duplicate.rows.length, 0)
    assert.equal((await db.query('SELECT meta FROM members WHERE id=$1', [m.id])).rows[0].meta.duplicate_attempt_count, 1)
  } finally { await db.exec('ROLLBACK') }
})

test('authenticated admin cannot forge the transaction context to import a held legacy contract', async () => {
  const previous = await snapshot(), b = batch()
  await as('authenticated', async () => {
    await db.query("SELECT set_config('app.lotto815_collision_batch',$1,false)", [b])
    try {
      await assert.rejects(directMember(`forged-${++serial}`, '01011112222', member(b).meta),
        /이전 사이트는 신규가입 대신 검증된 이관 경로/)
    } finally { await db.query("SELECT set_config('app.lotto815_collision_batch','',false)") }
  }, adminUid)
  assert.deepEqual(await snapshot(), previous)
})

test('ordinary native duplicate preserves rejection and only marks the existing same-site contract', async () => {
  const previous = await snapshot()
  const result = await as('authenticated', () => directMember(`native-duplicate-${++serial}`, '01011112222'), adminUid)
  assert.equal(result.rows.length, 0)
  const next = await snapshot()
  const oldNative = previous.members.find((row) => row.id === 'native')
  const newNative = next.members.find((row) => row.id === 'native')
  assert.equal(newNative.meta.duplicate_attempt_count, 1)
  assert.deepEqual({ ...newNative, meta: oldNative.meta }, oldNative)
  assert.deepEqual(next.members.filter((row) => row.id !== 'native'), previous.members.filter((row) => row.id !== 'native'))
  assert.deepEqual(next.payments, previous.payments)
  assert.equal(next.logs.length, previous.logs.length + 1)
  assert.equal(next.logs.find((row) => !previous.logs.some((old) => old.id === row.id)).target_id, 'native')
})

test('ordinary PlusLotto registration at a legacy-only phone does not mark the legacy contract', async () => {
  const b = batch(), m = member(b)
  await as('service_role', () => call(b, [m], []))
  const previous = await snapshot(), id = `new-native-${++serial}`
  const result = await as('authenticated', () => directMember(id, m.phone), adminUid)
  assert.equal(result.rows[0].id, id)
  const next = await snapshot()
  assert.deepEqual(next.members.filter((row) => row.id !== id), previous.members)
  assert.deepEqual(next.logs, previous.logs)
})

test('new 815 signup restriction does not block existing infolotto and cplotto signup rules', async () => {
  for (const source of ['infolotto', 'cplotto']) {
    const phone = member(batch()).phone, id = `${source}-${++serial}`
    const result = await as('authenticated', () => directMember(id, phone, { source_site: source }), adminUid)
    assert.equal(result.rows[0].id, id)
  }
})

test('anon portal isolates passwords, grade and histories per site for all phone spellings', async () => {
  const previous = await snapshot()
  await as('anon', async () => {
    for (const phone of forms('01022223333')) {
      assert.deepEqual(await portal(phone, 'plus-pw', 'pluslotto'), { name: 'portal-plus', grade: 'free', recos: [{ round_no: 1200 }] })
      assert.deepEqual(await portal(phone, '815-pw', 'lotto815'), { name: 'portal-815', grade: 'vip', recos: [{ round_no: 1199 }] })
      assert.equal(await portal(phone, '815-pw', 'pluslotto'), null)
      assert.equal(await portal(phone, 'plus-pw', 'lotto815'), null)
    }
  })
  assert.deepEqual(await snapshot(), previous)
})

test('portal rejects unsupported/missing site and same-site ambiguity without newest-member fallback', async () => {
  const previous = await snapshot()
  await as('anon', async () => {
    for (const site of ['all', 'unknown', '', null]) assert.equal(await portal('01022223333', '815-pw', site), null)
    for (const pw of ['one', 'two']) assert.equal(await portal('01033334444', pw, 'lotto815'), null)
    assert.equal(await portal('01022223333', 'deleted', 'lotto815'), null)
    assert.equal(await portal('01022223333', 'withdrawn', 'lotto815'), null)
    assert.equal(await portal('01022223333', '815-pw', 'infolotto'), null)
    assert.equal(await portal('01022223333', '', 'lotto815'), null)
  })
  assert.deepEqual(await snapshot(), previous)
})

test('old two-argument portal resolves PlusLotto only and never returns held 815 content', async () => {
  const previous = await snapshot()
  await as('anon', async () => {
    for (const [pw, name] of [['plus-pw', 'portal-plus'], ['815-pw', null]]) {
      const result = (await db.query('SELECT portal_member_recos($1,$2) AS result', ['01022223333', pw])).rows[0].result
      assert.equal(result?.name ?? null, name)
    }
  })
  assert.deepEqual(await snapshot(), previous)
})

test('existing multiple PlusLotto accounts retain newest selection without cross-site or older-password fallback', async () => {
  const previous = await snapshot()
  await as('anon', async () => {
    for (const phone of forms('01044445555')) {
      assert.equal((await portal(phone, 'recent-pw', 'pluslotto'))?.name, 'portal-native-recent')
      assert.equal(await portal(phone, 'old-pw', 'pluslotto'), null)
      assert.equal(await portal(phone, 'other-pw', 'pluslotto'), null)
      assert.equal((await portal(phone, 'other-pw', 'lotto815'))?.name, 'portal-latest-other-site')
      const old = (await db.query('SELECT portal_member_recos($1,$2) AS result', [phone, 'recent-pw'])).rows[0].result
      assert.equal(old?.name, 'portal-native-recent')
      assert.equal((await db.query('SELECT portal_member_recos($1,$2) AS result', [phone, 'old-pw'])).rows[0].result, null)
    }
  })
  assert.deepEqual(await snapshot(), previous)
})

test('atomic proof protects all preexisting sites and linked payment statuses at the destination phone', async () => {
  const phone = member(batch()).phone
  const peers = ['pluslotto', 'infolotto', 'cplotto'].map((site) => ({ site, id: `proof-peer-${site}-${++serial}` }))
  for (const [index, peer] of peers.entries()) {
    await directMember(peer.id, forms(phone)[index + 1], { source_site: peer.site },
      index === 2 ? { status: 'withdrawn', is_withdrawn: true } : {})
    await db.query(`INSERT INTO payments(id,member_id,amount,method,status,meta)
      VALUES ($1,$2,500,'manual',$3,'{"preserved":true}')`,
    [`peer-payment-${++serial}`, peer.id, index === 2 ? 'cancelled' : 'approved'])
  }
  const before = await snapshot(), b = batch(), m = member(b, { phone })
  const proof = await as('service_role', () => call(b, [m], []))
  assert.equal(proof.protected_members, 3)
  assert.equal(proof.protected_payments, 3)
  assert.equal(proof.existing_full_rows_unchanged, true)
  const after = await snapshot()
  assert.deepEqual(after.members.filter((row) => row.id !== m.id), before.members)
  assert.deepEqual(after.payments, before.payments)
})

test('legitimate native edits before the import transaction are preserved without requiring stale values', async () => {
  await db.exec(`UPDATE members SET memo='normal operator edit',consult_status='재통화',
    meta=meta||'{"end_date":"2027-12-31","weekly_reco_count":12}' WHERE id='native'`)
  const before = await snapshot(), b = batch(), m = member(b, { phone: '01011112222' })
  const proof = await as('service_role', () => call(b, [m], []))
  assert.equal(proof.existing_full_rows_unchanged, true)
  const after = await snapshot()
  assert.deepEqual(after.members.filter((row) => row.id !== m.id), before.members)
  assert.deepEqual(after.payments, before.payments)
})

const protectedSideEffects = [
  ['member metadata', 'members', "UPDATE public.members SET meta=meta||'{\"unexpected\":true}' WHERE id='native';"],
  ['member phone moved out of cohort', 'members', "UPDATE public.members SET phone='01099998888' WHERE id='native';"],
  ['existing payment amount', 'payments', "UPDATE public.payments SET amount=amount+1 WHERE id='native-pay';"],
  ['existing payment deletion', 'payments', "DELETE FROM public.payments WHERE id='native-pay';"],
  ['new payment for existing member', 'payments', "INSERT INTO public.payments(id,member_id,amount,method,status) VALUES ('unexpected-pay','native',1,'manual','approved');"],
  ['unexpected additional same-phone contract', 'members', "INSERT INTO public.members(id,user_id,name,phone,meta) VALUES ('unexpected-peer','unexpected-peer','synthetic','01011112222','{\"source_site\":\"infolotto\"}');"],
]
for (const [name, table, effect] of protectedSideEffects) {
  test(`a trigger changing ${name} rolls back every import row and the side effect`, async () => {
    await db.exec(`CREATE FUNCTION public.synthetic_protected_side_effect() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $attack$
      BEGIN
        IF NEW.meta->>'import_batch' LIKE 'lotto815-collision-%' THEN ${effect} END IF;
        RETURN NEW;
      END; $attack$;
      CREATE TRIGGER synthetic_protected_side_effect AFTER INSERT ON public.${table}
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_protected_side_effect();`)
    try {
      const b = batch(), m = member(b, { phone: '01011112222' }), p = payment(b, m)
      await rejectsUnchanged(b, [m], [p], undefined, 'P0001')
    } finally {
      await db.exec(`DROP TRIGGER synthetic_protected_side_effect ON public.${table};
        DROP FUNCTION public.synthetic_protected_side_effect();`)
    }
  })
}
