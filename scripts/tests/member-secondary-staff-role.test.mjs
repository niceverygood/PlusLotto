// Synthetic, in-memory PostgreSQL only. No credentials, network, or customer rows.
// 2차담당자 변경 권한(현장 10/16): 실장·관리자·최고관리자는 2차담당을 바꿀 수 있고, 팀장은 못 바꾼다.
// 1차담당·팀 변경은 계속 최고관리자만이다.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const load = name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
const users = { admin: 1, manager: 2, leader: 3, rep: 4, leader2: 5, noStaff: 6 }
const uuid = key => `00000000-0000-0000-0000-${String(users[key]).padStart(12, '0')}`
async function as(key, fn) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [key ? uuid(key) : ''])
  await db.exec(`SET ROLE ${key ? 'authenticated' : 'service_role'}`)
  try { return await fn() } finally { await db.exec('RESET ROLE') }
}
const update = (patch, id = 'm1') => db.query(
  `UPDATE public.members SET ${Object.keys(patch).map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
  [id, ...Object.values(patch)])
const secondaryOf = async id => (await db.query('SELECT secondary_staff_id FROM public.members WHERE id = $1', [id])).rows[0].secondary_staff_id
const reset = () => as(null, () => update({ secondary_staff_id: null, assigned_staff_id: 'rep', team_id: 't1' }))

before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;`)
  await db.exec(await load('0001_schema.sql'))
  await db.exec(await load('0002_rls.sql'))
  // 운영과 같은 members 정책(0016: admin·manager·leader 전체, rep 본인 담당만).
  const perf = await load('0016_admin_read_performance.sql')
  await db.exec(perf.slice(perf.indexOf('drop policy if exists members_rw'), perf.indexOf('create or replace function app_can_see_member')))
  const sites = await load('20260909001521_admin_site_scope.sql')
  await db.exec(sites.slice(sites.indexOf('CREATE OR REPLACE FUNCTION public.member_operating_site'), sites.indexOf('CREATE INDEX IF NOT EXISTS members_operating_site')))
  const secondary = await load('20261014130000_member_secondary_staff.sql')
  await db.exec(secondary.slice(secondary.indexOf('ALTER TABLE public.members'), secondary.indexOf('CREATE OR REPLACE FUNCTION public.enforce_member_admin_ops')))
  await db.exec(await load('20261016100000_secondary_staff_leader.sql'))
  await db.exec(`CREATE TRIGGER members_admin_ops BEFORE INSERT OR UPDATE ON public.members
    FOR EACH ROW EXECUTE FUNCTION public.enforce_member_admin_ops()`)
  await db.exec('GRANT SELECT, UPDATE ON public.members TO service_role;')
  await db.exec("INSERT INTO teams(id,name) VALUES ('t1','대전센터'),('t2','전주센터')")
  for (const key of Object.keys(users)) {
    await db.query('INSERT INTO auth.users VALUES ($1)', [uuid(key)])
    if (key === 'noStaff') continue
    await db.query('INSERT INTO staff(id,login_id,name,role,team_id,auth_user_id) VALUES ($1,$1,$1,$2,$3,$4)',
      [key, key === 'leader2' ? 'leader' : key, key === 'admin' ? null : 't1', uuid(key)])
  }
  await db.query("INSERT INTO members(id,user_id,name,team_id,assigned_staff_id) VALUES ('m1','m1','m1','t1','rep')")
})
after(() => db.close())

test('leader, manager and admin can set and clear the secondary assignee', async () => {
  for (const actor of ['leader', 'manager', 'admin']) {
    await reset()
    await as(actor, () => update({ secondary_staff_id: 'leader2' }))
    assert.equal(await secondaryOf('m1'), 'leader2', `${actor} sets`)
    await as(actor, () => update({ secondary_staff_id: null }))
    assert.equal(await secondaryOf('m1'), null, `${actor} clears`)
  }
})

test('rep cannot change the secondary assignee even on an own member', async () => {
  await reset()
  await assert.rejects(as('rep', () => update({ secondary_staff_id: 'leader2' })), /2차담당자 변경은 실장 이상만/)
  await as(null, () => update({ secondary_staff_id: 'leader2' }))
  await assert.rejects(as('rep', () => update({ secondary_staff_id: null })), /2차담당자 변경은 실장 이상만/)
  assert.equal(await secondaryOf('m1'), 'leader2')
  // 2차담당을 건드리지 않는 수정(메모 등)은 그대로 된다.
  await as('rep', () => update({ memo: '콜 메모' }))
})

test('primary assignee and team stay admin-only', async () => {
  for (const actor of ['leader', 'manager']) {
    await reset()
    await assert.rejects(as(actor, () => update({ assigned_staff_id: 'leader2' })), /최고관리자만/)
    await assert.rejects(as(actor, () => update({ team_id: 't2' })), /최고관리자만/)
    // 2차와 1차를 한 번에 바꾸면 1차 규칙에 걸려 전체가 막힌다.
    await assert.rejects(as(actor, () => update({ secondary_staff_id: 'leader2', assigned_staff_id: 'leader2' })), /최고관리자만/)
    assert.equal(await secondaryOf('m1'), null)
  }
  await reset()
  await as('admin', () => update({ assigned_staff_id: 'leader2', team_id: 't2' }))
})

test('a signed-in user without a staff row cannot change it; system path is exempt', async () => {
  await reset()
  await as('noStaff', () => update({ secondary_staff_id: 'leader2' })) // RLS: 보이는 행 없음 → 0건
  assert.equal(await secondaryOf('m1'), null)
  await as(null, () => update({ secondary_staff_id: 'leader2' }))
  assert.equal(await secondaryOf('m1'), 'leader2')
})
