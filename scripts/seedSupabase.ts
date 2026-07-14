/**
 * scripts/seedSupabase.ts — 라이브 Supabase 시드 적재 (service_role 전용, 로컬 실행).
 *
 * 사용:
 *   npm run seed:supabase            실 적재 (.env.local 의 SUPABASE_SERVICE_ROLE_KEY 필요)
 *   npm run seed:supabase -- --dry   적재 없이 시드 빌드/카운트만 출력 (키 불필요, 점검용)
 *
 * 사전조건: 0001_schema.sql → 0002_rls.sql 을 대시보드 SQL Editor 에서 먼저 실행.
 * 보안(CLAUDE §결정): service_role 키는 RLS 를 우회한다. 절대 커밋·브라우저 노출 금지(로컬 .env.local 전용).
 *
 * 동작: buildSeed() 로 mock 과 동일한 DbShape 를 만든 뒤, 부모→자식 순으로 적재한다.
 *       순환 FK(teams.leader_id ↔ staff.team_id) 는 teams 를 leader_id=null 로 먼저 넣고 나중에 패치.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { buildSeed } from '@/lib/db/seed'
import type { DbShape } from '@/lib/db/store'

const DRY = process.argv.includes('--dry')
const CHUNK = 500 // PostgREST payload 안전 분할 크기

// ── .env.local 수동 파싱 (dotenv 의존성 회피) ──────────────────────────────
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  let text = ''
  try {
    text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

// 청크 단위 insert (대량 배열용). 에러 시 테이블·오프셋 표기 후 throw.
async function insertChunked<T extends object>(sb: SupabaseClient, table: string, rows: T[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + CHUNK))
    if (error) throw new Error(`[insert ${table} @${i}] ${error.message}`)
  }
  console.log(`  ✓ ${table.padEnd(14)} ${rows.length}건`)
}

// 전체 행 삭제: "PK is not null" 은 모든 행과 매칭 → text/int PK 공용 안전 삭제.
async function wipe(sb: SupabaseClient, table: string, pk: string): Promise<void> {
  const { error } = await sb.from(table).delete().not(pk, 'is', null)
  if (error) throw new Error(`[wipe ${table}] ${error.message}`)
}

async function main(): Promise<void> {
  const db: DbShape = buildSeed()

  const counts: Record<string, number> = {
    teams: db.teams.length,
    staff: db.staff.length,
    products: db.products.length,
    members: db.members.length,
    payments: db.payments.length,
    sms_sends: db.sms_sends.length,
    sms_templates: db.sms_templates.length,
    lotto_rounds: db.lotto_rounds.length,
    bets: db.bets.length,
    assignments: db.assignments.length,
    logs: db.logs.length,
    notices: db.notices.length,
    events: db.events.length,
    inquiries: db.inquiries.length,
    faqs: db.faqs.length,
    nav_access: Object.keys(db.nav_access).length,
  }
  console.log('시드 빌드 완료:', JSON.stringify(counts))

  if (DRY) {
    console.log('--dry 모드: 적재 생략. (import 체인 + buildSeed 정상 동작 확인됨)')
    return
  }

  const env = loadEnv()
  const url = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
  const key = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !key) {
    console.error(
      '\n✗ 적재 불가: .env.local 에 VITE_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.\n' +
        '  • service_role 키: Supabase 대시보드 > Project Settings > API > service_role 에서 복사.\n' +
        '  • 먼저 0001_schema.sql, 0002_rls.sql 을 SQL Editor 에서 실행했는지 확인하세요.\n' +
        '  • 키 없이 점검만: npm run seed:supabase -- --dry\n',
    )
    process.exit(1)
  }

  const sb = createClient(url, key, { auth: { persistSession: false } })

  // staff.auth_user_id 보존: 재시드가 라이브 인증 연결을 끊지 않도록, 기존 링크를 읽어 두었다가
  // staff 적재 후 복원한다(첫 실행 시 비어 있으면 no-op). docs/SUPABASE_MIGRATION.md 의 연결 단계 참조.
  const { data: priorStaff } = await sb.from('staff').select('id, auth_user_id')
  const authLinks = new Map<string, string>()
  for (const row of (priorStaff ?? []) as { id: string; auth_user_id: string | null }[]) {
    if (row.auth_user_id) authLinks.set(row.id, row.auth_user_id)
  }
  if (authLinks.size > 0) console.log(`기존 staff.auth_user_id 링크 ${authLinks.size}건 보존 예정`)

  // ── 1. 기존 행 삭제 (자식 → 부모) ──────────────────────────────────────
  console.log('\n[1/3] 기존 행 삭제…')
  for (const [table, pk] of [
    ['site_settings', 'id'],
    ['nav_access', 'nav_key'],
    ['faqs', 'id'],
    ['inquiries', 'id'],
    ['events', 'id'],
    ['notices', 'id'],
    ['logs', 'id'],
    ['assignments', 'id'],
    ['bets', 'id'],
    ['lotto_rounds', 'round_no'],
    ['sms_templates', 'key'],
    ['sms_sends', 'id'],
    ['payments', 'id'],
    ['members', 'id'],
    ['products', 'id'],
    ['staff', 'id'],
    ['teams', 'id'],
  ] as const) {
    await wipe(sb, table, pk)
  }

  // ── 2. 적재 (부모 → 자식). 순환 FK 는 teams.leader_id 를 나중에 패치 ──────
  console.log('[2/3] 적재…')
  await insertChunked(
    sb,
    'teams',
    db.teams.map((t) => ({ ...t, leader_id: null })),
  )
  await insertChunked(sb, 'staff', db.staff)
  // 인증 연결 복원 (보존해 둔 staff.auth_user_id).
  for (const [id, uid] of authLinks) {
    const { error } = await sb.from('staff').update({ auth_user_id: uid }).eq('id', id)
    if (error) throw new Error(`[restore auth_user_id ${id}] ${error.message}`)
  }
  if (authLinks.size > 0) console.log(`  ✓ auth_user_id 복원   ${authLinks.size}건`)
  for (const t of db.teams) {
    if (!t.leader_id) continue
    const { error } = await sb.from('teams').update({ leader_id: t.leader_id }).eq('id', t.id)
    if (error) throw new Error(`[patch teams.leader_id ${t.id}] ${error.message}`)
  }
  await insertChunked(sb, 'products', db.products)
  await insertChunked(sb, 'members', db.members)
  await insertChunked(sb, 'payments', db.payments)
  await insertChunked(sb, 'sms_sends', db.sms_sends)
  await insertChunked(sb, 'sms_templates', db.sms_templates)
  await insertChunked(sb, 'lotto_rounds', db.lotto_rounds)
  await insertChunked(sb, 'bets', db.bets)
  await insertChunked(sb, 'assignments', db.assignments)
  await insertChunked(sb, 'logs', db.logs)
  await insertChunked(sb, 'notices', db.notices)
  await insertChunked(sb, 'events', db.events)
  await insertChunked(sb, 'inquiries', db.inquiries)
  await insertChunked(sb, 'faqs', db.faqs)
  await insertChunked(
    sb,
    'nav_access',
    Object.entries(db.nav_access).map(([nav_key, roles]) => ({ nav_key, roles })),
  )

  // ── 3. site_settings 단일 행 (id=1) ───────────────────────────────────
  console.log('[3/3] site_settings…')
  const { error: ssErr } = await sb.from('site_settings').insert({ id: 1, ...db.site_settings })
  if (ssErr) throw new Error(`[insert site_settings] ${ssErr.message}`)
  console.log('  ✓ site_settings   1건')

  console.log('\n✓ 시드 적재 완료. 대시보드 Table Editor 에서 행 수를 확인하세요.')
}

main().catch((e: unknown) => {
  console.error('\n✗ 시드 실패:', e instanceof Error ? e.message : e)
  process.exit(1)
})
