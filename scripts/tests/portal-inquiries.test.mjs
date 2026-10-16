// Synthetic, in-memory PostgreSQL only. No credentials, network, or customer rows.
// 고객 홈페이지 1:1 문의(현장 10/16): 접수 RPC, 비밀글(작성자만 열람), 가린 목록, 대입 제한.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const load = name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
async function asAnon(fn) {
  await db.exec('SET ROLE anon')
  try { return await fn() } finally { await db.exec('RESET ROLE') }
}
const submit = (site, name, phone, title, body, pw = null, category = '기타') => db.query(
  'SELECT public.portal_submit_inquiry($1,$2,$3,$4,$5,$6,$7) AS r', [site, name, phone, category, title, body, pw])
const mine = async (site, phone, pw) =>
  (await db.query('SELECT public.portal_my_inquiries($1,$2,$3) AS r', [site, phone, pw])).rows[0].r
const board = async (site) => (await db.query('SELECT public.portal_inquiry_board($1) AS r', [site])).rows[0].r

before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;`)
  await db.exec(await load('0001_schema.sql'))
  await db.exec(await load('0002_rls.sql'))
  await db.exec(await load('0007_public_site_anon.sql'))
  await db.exec(await load('20261016120000_portal_inquiries.sql'))
  await db.exec(await load('20261016120000_portal_inquiries.sql')) // 재실행 안전
})
after(() => db.close())

test('anon submits through the RPC only; direct table access is closed', async () => {
  const r = (await asAnon(() => submit('infolotto', '홍길동', '010-1234-5678', '결제 문의', '입금했는데 확인 부탁', '1234'))).rows[0].r
  assert.match(r.id, /^inq_[0-9a-f]{32}$/)
  const row = (await db.query('SELECT status, source_site, author_phone, answer FROM public.inquiries WHERE id=$1', [r.id])).rows[0]
  assert.deepEqual(row, { status: 'open', source_site: 'infolotto', author_phone: '01012345678', answer: null })
  await assert.rejects(asAnon(() => db.query("INSERT INTO public.inquiries(author_name,title,body,status,answer) VALUES ('x','t','b','answered','fake')")))
  await assert.rejects(asAnon(() => db.query('SELECT * FROM public.inquiries')))
  await assert.rejects(asAnon(() => db.query('SELECT * FROM public.inquiry_secrets')))
  // 비밀번호 해시는 직원(authenticated)에게도 보이지 않는다.
  await db.exec('SET ROLE authenticated')
  try { await assert.rejects(db.query('SELECT * FROM public.inquiry_secrets')) } finally { await db.exec('RESET ROLE') }
})

test('only the writer (phone + password) can read the post and the answer', async () => {
  const { id } = (await asAnon(() => submit('lotto815', '김철수', '01099998888', '번호 문의', '비밀 내용', 'abcd'))).rows[0].r
  await db.query("UPDATE public.inquiries SET status='answered', answer='답변입니다', answered_at=now() WHERE id=$1", [id])
  const own = await asAnon(() => mine('lotto815', '+82 10-9999-8888', 'abcd'))
  assert.equal(own.length, 1)
  assert.equal(own[0].body, '비밀 내용')
  assert.equal(own[0].answer, '답변입니다')
  assert.deepEqual(await asAnon(() => mine('lotto815', '01099998888', 'wrong')), [])
  assert.deepEqual(await asAnon(() => mine('lotto815', '01000000000', 'abcd')), [])
  assert.deepEqual(await asAnon(() => mine('infolotto', '01099998888', 'abcd')), [], '다른 사이트 글은 안 보임')
})

test('the board shows only masked rows of that site, no title/body/phone', async () => {
  await asAnon(() => submit('cplotto', '이영', '01011112222', '제목A', '내용A', '1111'))
  await asAnon(() => submit('cplotto', '남궁민수', '01011113333', '제목B', '내용B', '2222'))
  await asAnon(() => submit('cplotto', '가입자', '01011114444', '홈페이지 회원가입 신청', '가입', null, '가입문의'))
  const rows = await asAnon(() => board('cplotto'))
  assert.deepEqual(rows.map(r => r.author).sort(), ['남**수', '이*'])
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['author', 'created_at', 'id', 'status'])
  assert.ok(!JSON.stringify(rows).includes('제목'))
  await assert.rejects(asAnon(() => board('evil')), /invalid inquiry site/)
})

test('validation, signup inquiries without password, and per-phone limits', async () => {
  await assert.rejects(asAnon(() => submit('pluslotto', '', '01012341234', 't', 'b', '1234')), /invalid inquiry fields/)
  await assert.rejects(asAnon(() => submit('pluslotto', 'a', '12345', 't', 'b', '1234')), /invalid inquiry phone/)
  await assert.rejects(asAnon(() => submit('pluslotto', 'a', '01012341234', 't', 'b', '12')), /invalid inquiry password/)
  await assert.rejects(asAnon(() => submit('nowhere', 'a', '01012341234', 't', 'b', '1234')), /invalid inquiry site/)
  // 가입문의(비밀번호 없음)도 접수되고, 비밀번호가 없으니 열람 대상이 아니다.
  await asAnon(() => submit('pluslotto', '신규', '01055556666', '홈페이지 회원가입 신청', '가입 원함', null, '가입문의'))
  assert.equal((await db.query("SELECT count(*)::int n FROM public.inquiries WHERE author_phone='01055556666'")).rows[0].n, 1)
  for (let i = 0; i < 4; i++) await asAnon(() => submit('pluslotto', '반복', '01077778888', `t${i}`, 'b', '1234'))
  await asAnon(() => submit('pluslotto', '반복', '01077778888', 't4', 'b', '1234'))
  await assert.rejects(asAnon(() => submit('pluslotto', '반복', '01077778888', 't5', 'b', '1234')), /too many inquiries/)
})

test('password guessing is throttled per phone', async () => {
  await asAnon(() => submit('best', '박', '01033334444', 't', 'b', '9999'))
  for (let i = 0; i < 10; i++) assert.deepEqual(await asAnon(() => mine('best', '01033334444', `000${i}`)), [])
  await assert.rejects(asAnon(() => mine('best', '01033334444', '9999')), /too many inquiry lookups/)
})
