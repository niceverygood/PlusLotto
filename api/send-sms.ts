// Vercel 서버리스 함수 — OneShot(SMTNT/msgagent) 문자 발송을 '고정 IP 프록시' 경유로 호출(§V2-6).
// OneShot 인증 = 요청 IP 화이트리스트라, 서버리스의 가변 egress 대신 PROXY_URL(고정 IP)로 우회한다.
// 그 프록시의 고정 IP 를 OneShot 에 등록해야 발송이 허용된다.
//
// Vercel 환경변수(Project Settings → Environment Variables):
//   ONESHOT_ID         = lotto_dream_api
//   ONESHOT_SEND_PHONE = 15226385        (등록된 발신번호, 요청에 send_phone 오면 그게 우선)
//   FIXIE_URL          = (Vercel 의 Fixie 통합이 자동 생성)  ─ 없으면 PROXY_URL = http://user:pass@host:port
//   ONESHOT_RESELLER   = (특부가 사업자만, 9자리)   ※ 아니면 미설정
//
// 이 파일은 api/ 디렉터리라 Vite 앱 빌드(tsconfig include=src)에 포함되지 않는다(Vercel 함수로 빌드).
import { ProxyAgent, fetch as uFetch, FormData as UFormData } from 'undici'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/supabase.generated'
import crypto from 'node:crypto'

const ONESHOT_BASE = 'https://api2.msgagent.com/api/webshot/send/general'

// 회원을 지정하지 않은 이전 클라이언트/번호 직접 입력 경로의 보수적 이관 검토 보류.
// 서비스 전용 RPC가 전체 회원의 정규화된 전화번호를 비교한다. 동일 번호 회원 중
// 하나라도 legacy_import_review 보류 중이면 발송하지 않으며, 명시적 보류 해제 후에는 허용한다.
// RPC 배포/DB 접근 실패를 '보류 없음'으로 간주하면 실제 문자가 나가므로 반드시 닫힌 상태로 실패한다.
async function legacyImportHoldStatus(phone: string): Promise<'held' | 'clear' | 'unavailable'> {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return 'unavailable'
  try {
    const admin = createClient<Database>(url, key, { auth: { persistSession: false } })
    const { data, error } = await admin
      .rpc('sms_is_legacy_import_held', { p_phone: phone })
      .abortSignal(AbortSignal.timeout(5_000))
    if (error) return 'unavailable'
    if (data === true) return 'held'
    if (data === false) return 'clear'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

// ── 사이트별 발신번호 ────────────────────────────────────────────────────────
// 이관 사이트(815·인포·일행) 회원에게 플러스로또 발신번호로 문자가 나가면 회원은 모르는 번호로
// 받는다. 발신번호는 사전등록제라 브랜드별로 따로 등록해야 하고, CLAUDE.md 도 두 전산의 SMS
// 발신 계정을 완전히 분리하도록 정하고 있다.
//
// 호출자가 보낸 send_phone 을 그대로 믿지 않고 **서버가 회원의 사이트로 다시 고른다.** 발송
// 경로가 11곳이라 호출자마다 고치면 한 곳만 빠져도 새고, 새로 생기는 경로는 또 빠진다.
//
// 설정이 없으면 기본 발신번호로 폴백하지 않고 **거부한다.** 보류만 풀고 발신번호 설정을
// 빠뜨리는 것이 가장 하기 쉬운 실수인데, 폴백하면 그 실수가 곧바로 사고가 된다.
type SiteSenderMap = Map<string, string>
let senderCache: { at: number; map: SiteSenderMap } | null = null
const SENDER_TTL_MS = 60_000 // 대량 발송(수천 건)에서 설정 조회가 건마다 나가지 않도록.

/**
 * 테스트 전용 — 위 캐시를 비운다. 캐시가 모듈 전역이라 한 프로세스에서 여러 시나리오를 돌리면
 * 앞 테스트의 설정이 뒤 테스트로 샌다. 운영 코드는 이 함수를 부르지 않는다.
 */
export function __resetSiteSenderCacheForTests(): void {
  senderCache = null
}

/** site_settings.sms.by_site → 사이트별 발신번호. 조회 실패는 null(= 발송 보류). */
async function loadSiteSenders(): Promise<SiteSenderMap | null> {
  const now = Date.now()
  if (senderCache && now - senderCache.at < SENDER_TTL_MS) return senderCache.map
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  try {
    const admin = createClient<Database>(url, key, { auth: { persistSession: false } })
    const { data, error } = await admin.from('site_settings').select('sms').eq('id', 1)
      .abortSignal(AbortSignal.timeout(5_000)).maybeSingle()
    if (error || !isRecord(data)) return null
    const sms = data.sms
    const map: SiteSenderMap = new Map()
    if (isRecord(sms) && isRecord(sms.by_site)) {
      for (const [site, cfg] of Object.entries(sms.by_site)) {
        if (!LEGACY_SITES.has(site) || !isRecord(cfg)) continue
        const digits = String(cfg.sender_no ?? '').replace(/\D/g, '')
        if (digits) map.set(site, digits)
      }
    }
    senderCache = { at: now, map }
    return map
  } catch {
    return null
  }
}

// 호출자 인증(보안 D68): 무인증 공개 시 검증된 발신번호로 임의 SMS 가 무제한 발송 가능 →
//   ① 서버-서버(크론): x-internal-secret === CRON_SECRET, 또는
//   ② 브라우저(운영자): Authorization Bearer = 로그인 staff 의 Supabase access token.
// 둘 중 하나도 충족 못 하면 401. (다른 api/ 함수와 동일한 인증 패턴.)
type StaffRole = Database['public']['Enums']['role']
type SmsCaller = { kind: 'cron' } | { kind: 'staff'; id: string; role: StaffRole; teamId: string | null }
type AuthRequest = { headers?: Record<string, string | string[] | undefined> }
type HoldStatus = 'held' | 'clear' | 'unavailable' | 'forbidden'
/** 보류 판정 + 그 회원이 실제로 속한 사이트. 발신번호를 서버에서 고르기 위해 함께 돌려준다. */
type HoldResult = { status: HoldStatus; site: string | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStaffRole(value: unknown): value is StaffRole {
  return value === 'admin' || value === 'manager' || value === 'leader' || value === 'rep'
}

function isNullableId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
}

const MEMBER_SITES = new Set(['pluslotto', 'lotto815', 'cplotto', 'infolotto'])
const LEGACY_SITES = new Set(['lotto815', 'cplotto', 'infolotto'])

// 목적지 일치는 서버가 읽은 회원 번호로 판정한다. 국내/+82/0082는 같은 번호로 비교한다.
function domesticPhone(phone: string): string | null {
  let digits = phone.replace(/\D/g, '')
  if (digits.startsWith('0082')) {
    digits = digits.slice(4)
    if (!digits.startsWith('0')) digits = `0${digits}`
  } else if (digits.startsWith('82')) {
    digits = digits.slice(2)
    if (!digits.startsWith('0')) digits = `0${digits}`
  }
  return /^0[1-9]\d{7,9}$/.test(digits) ? digits : null
}

async function authorize(req: AuthRequest): Promise<SmsCaller | null> {
  const internal = String(req.headers?.['x-internal-secret'] ?? '')
  const cronSecret = process.env.CRON_SECRET
  if (internal && cronSecret && internal === cronSecret) return { kind: 'cron' }
  const token = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '')
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!token || !url || !key) return null
  try {
    const admin = createClient<Database>(url, key, { auth: { persistSession: false } })
    const { data: ures, error: authError } = await admin.auth.getUser(token)
    const uid = ures?.user?.id
    if (authError || !uid) return null
    const { data: st, error } = await admin.from('staff').select('id, role, team_id, is_active')
      .eq('auth_user_id', uid).abortSignal(AbortSignal.timeout(5_000)).maybeSingle()
    if (error || !isRecord(st) || st.is_active !== true || typeof st.id !== 'string' || !st.id.trim()
      || !isStaffRole(st.role) || !isNullableId(st.team_id)) return null
    return { kind: 'staff', id: st.id, role: st.role, teamId: st.team_id }
  } catch {
    return null
  }
}

// 같은 번호의 다른 사이트 계약에 보류가 있어도, 검증된 대상 회원의 보류만 적용한다.
// service_role 조회이므로 직원 권한·목적지·출처를 이 경로에서 모두 검증해야 한다.
async function memberHoldStatus(
  memberId: string, phone: string, expectedSite: string | undefined, caller: SmsCaller,
): Promise<HoldResult> {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return { status: 'unavailable', site: null }
  try {
    const admin = createClient<Database>(url, key, { auth: { persistSession: false } })
    const { data: member, error } = await admin.from('members')
      .select('id, phone, assigned_staff_id, team_id, meta').eq('id', memberId)
      .abortSignal(AbortSignal.timeout(5_000)).maybeSingle()
    if (error) return { status: 'unavailable', site: null }
    if (member === null) return { status: 'forbidden', site: null }
    if (!isRecord(member) || member.id !== memberId || typeof member.phone !== 'string'
      || !isNullableId(member.assigned_staff_id) || !isNullableId(member.team_id)
      || (member.meta !== null && !isRecord(member.meta))) return { status: 'unavailable', site: null }
    if (caller.kind === 'staff') {
      // D51/D55 및 members_rw/app_can_see_member: 실장(leader)은 팀 배정과 무관하게 전체 회원 범위다.
      const allowed = caller.role === 'admin' || caller.role === 'manager' || caller.role === 'leader'
        || (caller.role === 'rep' && member.assigned_staff_id === caller.id)
      if (!allowed) return { status: 'forbidden', site: null }
    }
    const actualPhone = domesticPhone(member.phone)
    if (!actualPhone) return { status: 'unavailable', site: null }
    if (domesticPhone(phone) !== actualPhone) return { status: 'forbidden', site: null }
    const meta = member.meta ?? {}
    const rawSite = meta.source_site
    if (rawSite !== undefined && rawSite !== null && typeof rawSite !== 'string') return { status: 'unavailable', site: null }
    const site = typeof rawSite === 'string' && rawSite.trim() ? rawSite.trim() : 'pluslotto'
    if (!MEMBER_SITES.has(site)) return { status: 'unavailable', site: null }
    if (expectedSite !== undefined && expectedSite !== site) return { status: 'forbidden', site: null }
    if (meta.reco_paused !== undefined && meta.reco_paused !== null && typeof meta.reco_paused !== 'boolean')
      return { status: 'unavailable', site: null }
    if (meta.reco_pause_reason !== undefined && meta.reco_pause_reason !== null && typeof meta.reco_pause_reason !== 'string')
      return { status: 'unavailable', site: null }
    return {
      status: LEGACY_SITES.has(site) && meta.reco_pause_reason === 'legacy_import_review' && meta.reco_paused === true
        ? 'held' : 'clear',
      site,
    }
  } catch {
    return { status: 'unavailable', site: null }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'METHOD', message: 'POST only' })
  const caller = await authorize(req)
  if (!caller)
    return res.status(401).json({ ok: false, code: 'AUTH', message: '인증 필요(로그인 또는 내부 호출만 허용)' })

  try {
    const parsed: unknown = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}
    if (!isRecord(parsed))
      return res.status(400).json({ ok: false, code: 'PARAM', message: '잘못된 발송 요청입니다.' })
    const body = parsed
    const id = process.env.ONESHOT_ID
    const reseller = process.env.ONESHOT_RESELLER
    const sender = String(body.send_phone ?? process.env.ONESHOT_SEND_PHONE ?? '').replace(/\D/g, '')
    const dest = String(body.dest_phone ?? '').replace(/\D/g, '')
    const msg = String(body.msg_body ?? '')
    const msgType = body.msgType === 'LMS' || body.msgType === 'MMS' ? body.msgType : 'SMS'
    const checkOnly = body.check_only === true

    if (body.check_only !== undefined && typeof body.check_only !== 'boolean')
      return res.status(400).json({ ok: false, code: 'PARAM', message: 'check_only는 boolean 값이어야 합니다.' })
    if (!dest || (!checkOnly && (!msg || !sender)))
      return res.status(400).json({ ok: false, code: '200', message: '필수 값 누락(dest_phone/msg_body/send_phone)' })

    const hasMember = Object.prototype.hasOwnProperty.call(body, 'member_id')
    const hasSite = Object.prototype.hasOwnProperty.call(body, 'source_site')
    if ((hasMember && (typeof body.member_id !== 'string' || !body.member_id.trim() || body.member_id.length > 256))
      || (hasSite && (!hasMember || typeof body.source_site !== 'string' || !MEMBER_SITES.has(body.source_site))))
      return res.status(400).json({ ok: false, code: 'PARAM', message: '잘못된 발송 대상입니다.' })
    const holdResult: HoldResult = hasMember
      ? await memberHoldStatus(String(body.member_id), dest, hasSite ? String(body.source_site) : undefined, caller)
      : { status: await legacyImportHoldStatus(dest), site: null }
    const hold = holdResult.status
    if (hold === 'forbidden')
      return res.status(403).json({ ok: false, code: 'SMS_TARGET', message: '발송 대상을 확인할 수 없습니다.' })
    if (hold === 'unavailable')
      return res.status(503).json({
        ok: false,
        code: 'SMS_HOLD_CHECK',
        message: '발송 보류 상태를 확인할 수 없어 문자를 보내지 않았습니다. 연결 상태 확인 후 다시 시도해 주세요.',
      })
    if (hold === 'held')
      return res.status(423).json({
        ok: false,
        code: 'LEGACY_IMPORT_HOLD',
        message: '이관 검토 중인 수신번호는 발송이 보류됩니다. 검토를 마친 후 발송 보류를 해제해 주세요.',
      })
    // 운영 smoke 점검용: 정상 인증과 동일 보류 검사를 수행하되 실제 발송 경로로는 진입하지 않는다.
    if (checkOnly)
      return res.status(200).json({ ok: true, code: 'CHECK_ONLY', message: '발송 보류 확인 완료. 문자는 발송하지 않았습니다.' })

    // 이관 사이트 회원이면 그 사이트로 등록된 발신번호를 쓴다. 없으면 보내지 않는다(위 주석 참조).
    // 플러스로또(및 회원 식별이 없는 구형 요청)는 기존 기본 발신번호를 그대로 쓴다.
    let effectiveSender = sender
    if (holdResult.site !== null && LEGACY_SITES.has(holdResult.site)) {
      const senders = await loadSiteSenders()
      if (senders === null)
        return res.status(503).json({
          ok: false,
          code: 'SMS_SENDER_LOOKUP',
          message: '사이트별 발신번호를 확인할 수 없어 문자를 보내지 않았습니다. 연결 상태 확인 후 다시 시도해 주세요.',
        })
      const siteSender = senders.get(holdResult.site)
      if (!siteSender)
        return res.status(409).json({
          ok: false,
          code: 'SMS_SENDER_UNSET',
          message: `${holdResult.site} 사이트의 발신번호가 설정되지 않아 문자를 보내지 않았습니다. 설정 > 문자 설정에서 사이트별 발신번호를 먼저 등록해 주세요.`,
        })
      effectiveSender = siteSender
    }

    // ── Solapi 경로 (API키 HMAC 인증 → 고정IP/프록시 불필요). 키 설정 시 우선 사용. Fixie 한도 영구 해소(현장 6/30). ──
    // SOLAPI_ENABLED='true' 일 때만 Solapi 사용(IP화이트리스트 해제 검증 후 활성화). 그 전엔 OneShot 유지(현장 6/30).
    const solapiKey = process.env.SOLAPI_API_KEY
    const solapiSecret = process.env.SOLAPI_API_SECRET
    if (solapiKey && solapiSecret && process.env.SOLAPI_ENABLED === 'true') {
      try {
        const sdate = new Date().toISOString()
        const salt = crypto.randomBytes(32).toString('hex')
        const signature = crypto.createHmac('sha256', solapiSecret).update(sdate + salt).digest('hex')
        const message: Record<string, unknown> = {
          to: dest,
          from: effectiveSender,
          text: msg,
          type: msgType === 'MMS' ? 'MMS' : msgType === 'LMS' ? 'LMS' : 'SMS',
        }
        if (msgType !== 'SMS') message.subject = String(body.subject ?? '추천번호').slice(0, 40)
        const sr = await fetch('https://api.solapi.com/messages/v4/send', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `HMAC-SHA256 apiKey=${solapiKey}, date=${sdate}, salt=${salt}, signature=${signature}`,
          },
          body: JSON.stringify({ message }),
        })
        const sd = (await sr.json().catch(() => ({}))) as Record<string, unknown>
        const code = String(sd.statusCode ?? '')
        return res
          .status(200)
          .json({ ok: code === '2000', code, cmid: sd.messageId ?? null, provider: 'solapi', msgType, raw: sd })
      } catch (e) {
        return res.status(200).json({ ok: false, code: 'EXCEPTION', provider: 'solapi', message: String(e) })
      }
    }

    if (!id) return res.status(500).json({ ok: false, code: 'CONFIG', message: 'ONESHOT_ID 미설정(Solapi 미설정 시 필수)' })
    const form = new UFormData()
    form.append('id', id)
    form.append('dest_phone', dest)
    form.append('send_phone', effectiveSender)
    form.append('msg_body', msg)
    if (msgType !== 'SMS') form.append('subject', String(body.subject ?? '안내').slice(0, 40))
    if (body.send_time) form.append('send_time', String(body.send_time)) // YYYYMMDDHHMISS, 없으면 즉시
    if (body.tran_id) form.append('tran_id', String(body.tran_id).slice(0, 30))
    if (reseller) form.append('resellerCode', reseller)

    // Vercel Fixie 통합이 FIXIE_URL 을 자동 생성. 없으면 수동 PROXY_URL.
    const proxyUrl = process.env.FIXIE_URL || process.env.PROXY_URL
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
    const url = `${ONESHOT_BASE}/${msgType}/${encodeURIComponent(id)}`
    const upstream = await uFetch(url, { method: 'POST', body: form, dispatcher })
    const text = await upstream.text()
    let data: Record<string, unknown> = {}
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
    const code = String(data.result_code ?? '')
    return res.status(200).json({ ok: code === '0', code, cmid: data.cmid ?? null, msgType, raw: data })
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'EXCEPTION', message: String(e) })
  }
}
