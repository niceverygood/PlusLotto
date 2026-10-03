// Vercel 크론 — 동행복권 최신 회차 자동 적재(현장 피드백 6/22 / DECISIONS D65).
// lotto_rounds의 max(round_no)+1부터 공식 추첨 완료 회차를 확인해 신규 행만 insert한다.
// 데이터가 밀려 발송/추천이 '이미 지난 회차'를 가리키던 회차 오류의 재발 방지.
// vercel.json crons: 5분마다 호출해 공식 발표 지연과 저장된 미완료 집계를 이어 처리한다.
// 인증: CRON_SECRET Bearer(Vercel 크론 자동 첨부). env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// 회차 저장·집계 작업을 DB에 먼저 남기고, 다음 호출은 미완료 작업부터 재개한다. 문자 접수불명은 재전송하지 않는다.
import { createClient } from '@supabase/supabase-js'

const DH_API = 'https://www.dhlottery.co.kr/lt645/selectPstLt645Info.do'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// 당첨 안내문자 자동발송(현장 피드백 7/28, 정의현 차장) — 설정(site_settings.win_sms)에서 체크한
// 등수 × 회원분류(유료/무료)에만 발송. 판정 규칙 원본은 src/lib/winSms.ts (서버함수라 자급자족 복제).
const PAID_GRADES = ['gold', 'goldp', 'vip', 'royal']
interface WinSmsCfg {
  enabled: boolean
  ranks: number[]
  paid: boolean
  free: boolean
}
interface SiteSettingsLite {
  sms?: { oneshot_enabled?: boolean; sender_no?: string }
  win_messages?: { rank: number; body: string }[]
  win_sms?: Partial<WinSmsCfg>
}
interface MemberRow {
  id: string
  name: string | null
  phone: string | null
  grade: string
  win_history: string | null
  is_deleted?: boolean | null
  is_suspended: boolean | null
  is_withdrawn: boolean | null
  meta: Record<string, unknown> | null
}

/** 문자 본문 변수 치환 — src/lib/sms.ts renderSms 와 동일 규칙($id=전화번호, $pw=뒷4자리). */
function renderWinSms(body: string, m: MemberRow, contents: string): string {
  const digits = (m.phone ?? '').replace(/\D/g, '')
  const vars: Record<string, string> = {
    name: m.name ?? '',
    id: digits,
    pw: (typeof m.meta?.homepage_pw === 'string' ? (m.meta.homepage_pw as string) : '') || digits.slice(-4),
    num: '',
    contents,
    link: '',
  }
  return body.replace(/\$(name|id|pw|num|contents|link)/g, (_, k: string) => vars[k] ?? '')
}

/** 한국 문자 바이트 길이(비ASCII=2byte). SMS=90byte 기준. (src/lib/oneshot.ts 와 동기화) */
function koByteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 0x7f ? 2 : 1
  return n
}

type SmsOutcome = { status: 'accepted' | 'failed' | 'unknown'; code: string; httpStatus?: number; cmid?: string }
const safeCode = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : 'UNKNOWN'

/** 업체 요청 전에 DB claim이 커밋되어 있어야 한다. 타임아웃/응답불명은 자동 재전송 금지. */
async function sendWinSms(base: string, claim: SmsClaim, body: string, sender: string, timeout: number): Promise<SmsOutcome> {
  try {
    const response = await fetch(`${base}/api/send-sms`, {
      method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.CRON_SECRET ?? '' },
      body: JSON.stringify({ member_id: claim.member_id, dest_phone: claim.member.phone, msg_body: body,
        send_phone: sender, msgType: koByteLength(body) <= 90 ? 'SMS' : 'LMS' }),
    })
    const data: unknown = await response.json()
    if (!object(data)) return { status: 'unknown', code: 'RESPONSE_FORMAT', httpStatus: response.status }
    const code = safeCode(data.code)
    const accepted = response.ok && data.ok === true
    const uncertain = response.status >= 500 || code === 'EXCEPTION' || code === 'NET' || code === 'UNKNOWN'
    return { status: accepted ? 'accepted' : uncertain ? 'unknown' : 'failed', code, httpStatus: response.status,
      ...(typeof data.cmid === 'string' ? { cmid: data.cmid.slice(0, 200) } : {}) }
  } catch { return { status: 'unknown', code: 'NET' } }
}

interface DhRow {
  ltEpsd: number // 회차
  tm1WnNo: number
  tm2WnNo: number
  tm3WnNo: number
  tm4WnNo: number
  tm5WnNo: number
  tm6WnNo: number
  bnsWnNo: number // 보너스
  ltRflYmd: string // 추첨일 YYYYMMDD
  rnk1WnAmt: number // 1등 1인당 당첨금
  rnk2WnAmt: number
  rnk3WnAmt: number
  wholEpsdSumNtslAmt?: number // 총판매금액
}

const WEEK_MS = 7 * 86400_000
const FIRST_DRAW = Date.parse('2002-12-07T20:45:00+09:00')
type SyncedRound = {
  round_no: number; draw_date: string; numbers: number[]; bonus: number; sum: number
  odd_even: string; appear_rate: null; prize_1: number | null; prize_2: number | null
  prize_3: number | null; total_sales: number | null; confirmed_at: string | null
}
interface SyncRequest { headers?: { authorization?: string }; query?: { recover_round?: unknown } }
interface SyncResponse { status(code: number): SyncResponse; json(body: Record<string, unknown>): unknown }
class SyncFailure extends Error {
  constructor(readonly code: string, readonly httpStatus: number, message: string) { super(message) }
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** KST 추첨 시각 이후에만 새 회차를 기대한다. 금요일/토요일 오전에는 현재 회차가 정상이다. */
export function latestCompletedRound(now = Date.now()): number {
  return Math.max(0, Math.floor((now - FIRST_DRAW) / WEEK_MS) + 1)
}
const drawDate = (round: number) => new Date(FIRST_DRAW + (round - 1) * WEEK_MS).toISOString()

/** 응답 형식 변경을 '신규 없음'으로 숨기지 않고, 요청 밖 회차/중복 번호/잘못된 날짜를 거부한다. */
export function parseDrawResponse(value: unknown, from: number, to: number): SyncedRound[] {
  if (!object(value) || !object(value.data) || !Array.isArray(value.data.list)) {
    throw new SyncFailure('UPSTREAM_FORMAT', 502, '동행복권 응답 형식이 올바르지 않습니다.')
  }
  const seen = new Set<number>()
  const rows = value.data.list.map((value): SyncedRound => {
    if (!object(value)) throw new SyncFailure('UPSTREAM_INVALID', 502, '유효하지 않은 추첨 결과입니다.')
    const d = value as unknown as DhRow
    const round = Number(d.ltEpsd)
    const balls = [d.tm1WnNo, d.tm2WnNo, d.tm3WnNo, d.tm4WnNo, d.tm5WnNo, d.tm6WnNo, d.bnsWnNo]
    const numbers = balls.slice(0, 6).map(Number).sort((a, b) => a - b)
    const expectedDay = Number.isSafeInteger(round) && round >= from && round <= to
      ? drawDate(round).slice(0, 10).replace(/-/g, '') : ''
    const amount = (v: unknown): number | null => {
      if (v == null) return null
      if ((typeof v !== 'number' && typeof v !== 'string') || String(v).trim() === '') return null
      const n = Number(v)
      return Number.isSafeInteger(n) && n >= 0 ? n : null
    }
    if (!Number.isSafeInteger(round) || round < from || round > to || seen.has(round)
      || typeof d.ltRflYmd !== 'string' || d.ltRflYmd !== expectedDay
      || balls.some((n) => (typeof n !== 'number' && typeof n !== 'string') || !Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 45)
      || new Set(balls.map(Number)).size !== 7) {
      throw new SyncFailure('UPSTREAM_INVALID', 502, '회차·추첨일·당첨번호 검증에 실패했습니다.')
    }
    const prizes = [amount(d.rnk1WnAmt), amount(d.rnk2WnAmt), amount(d.rnk3WnAmt)]
    const totalSales = amount(d.wholEpsdSumNtslAmt)
    if (prizes.some((p) => p == null || p <= 0) || totalSales == null || totalSales <= 0) {
      throw new SyncFailure('UPSTREAM_NOT_READY', 503, '공식 당첨금 및 판매금액 발표를 기다리고 있습니다.')
    }
    seen.add(round)
    const odd = numbers.filter((n) => n % 2 === 1).length
    return { round_no: round, draw_date: drawDate(round), numbers, bonus: Number(d.bnsWnNo),
      sum: numbers.reduce((a, b) => a + b, 0), odd_even: `홀${odd}:짝${6 - odd}`, appear_rate: null,
      prize_1: prizes[0], prize_2: prizes[1], prize_3: prizes[2], total_sales: totalSales, confirmed_at: null }
  }).sort((a, b) => a.round_no - b.round_no)
  if (!rows.length || rows[0].round_no !== from || rows.some((row, index) => row.round_no !== from + index)) {
    throw new SyncFailure('UPSTREAM_NOT_READY', 503, '필요한 회차의 공식 결과를 아직 받지 못했습니다.')
  }
  return rows
}

export function syncPrizeForRank(row: Pick<SyncedRound, 'prize_1' | 'prize_2' | 'prize_3'>, rank: number): number {
  return rank === 1 ? (row.prize_1 ?? 0) : rank === 2 ? (row.prize_2 ?? 0)
    : rank === 3 ? (row.prize_3 ?? 0) : rank === 4 ? 50000 : rank === 5 ? 5000 : 0
}

// RPCs are versioned as one migration; missing/changed contracts fail before upstream fetch or SMS.
interface SyncJob { round_no: number; status: string; total: number; done: number; winners: number; last_error?: unknown }
interface SyncHealth {
  schema_version: number; max_round: number; max_confirmed_round: number; jobs: SyncJob[]
  sms: { pending: number; claimed: number; accepted: number; failed: number; unknown: number; skipped: number }
}
interface BatchResult { ok: boolean; status: string; round_no?: number; processed?: number; remaining?: number; winners?: number; error?: unknown }
interface SmsClaim { id: number; claim_token: string; round_no: number; member_id: string; rank: number; member: MemberRow }
const RUN_BUDGET_MS = 180_000
const BATCH_SIZE = 100
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function parseHealth(value: unknown): SyncHealth {
  if (!object(value) || value.schema_version !== 1 || !count(value.max_round) || !count(value.max_confirmed_round)
    || !Array.isArray(value.jobs) || !object(value.sms)
    || !['pending', 'claimed', 'accepted', 'failed', 'unknown', 'skipped'].every((key) => count(value.sms && (value.sms as Record<string, unknown>)[key]))
    || value.jobs.some((job) => !object(job) || !count(job.round_no) || typeof job.status !== 'string'
      || !['pending', 'running', 'complete', 'blocked'].includes(job.status))) {
    throw new SyncFailure('RPC_CONTRACT', 503, '회차 집계 상태를 안전하게 확인할 수 없습니다.')
  }
  return value as unknown as SyncHealth
}

/** 88은 같은 집계 경로를 쓰되 winSms:false로 설정해 문자 설정/claim/업체 요청을 하지 않는다. */
export function createWeeklyLottoSyncHandler(options: { winSms: boolean }) {
  return async function handler(req: SyncRequest, res: SyncResponse) {
    const secret = process.env.CRON_SECRET
    if (!secret) return res.status(500).json({ ok: false, code: 'CONFIG', message: 'CRON_SECRET 미설정' })
    if (req.headers?.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false, code: 'AUTH' })
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return res.status(500).json({ ok: false, code: 'CONFIG', message: 'SUPABASE_URL/SERVICE_ROLE_KEY 미설정' })
    const sb = createClient(url, key, { auth: { persistSession: false } })
    const deadline = Date.now() + RUN_BUDGET_MS
    const expected = latestCompletedRound()
    let stage = 'health'
    let added = 0
    let processed = 0
    let smsSent = 0
    const rounds: number[] = []
    const timeLeft = () => deadline - Date.now()
    const timeout = (max: number) => {
      if (timeLeft() < 1_000) throw new SyncFailure('IN_PROGRESS', 202, '집계가 진행 중이며 다음 호출에서 이어집니다.')
      return Math.max(1, Math.min(max, timeLeft()))
    }
    const rpc = async (name: string, args: Record<string, unknown> = {}, code = 'DB_RPC'): Promise<unknown> => {
      const result = await sb.rpc(name, args).abortSignal(AbortSignal.timeout(timeout(25_000)))
      if (result.error) throw new SyncFailure(code, 503, '회차 집계 저장 또는 조회에 실패했습니다. 저장된 작업부터 재개합니다.')
      return result.data
    }
    const tick = async (ok: boolean, code: string | null): Promise<boolean> => {
      try {
        const result = await sb.rpc('lotto_sync_record_tick', { p_ok: ok, p_code: code })
          .abortSignal(AbortSignal.timeout(3_000))
        return !result.error
      } catch { return false }
    }
    const readHealth = async () => parseHealth(await rpc('lotto_sync_health', {}, 'HEALTH_READ'))
    const resume = async () => {
      stage = 'aggregate'
      for (;;) {
        const result = await rpc('lotto_sync_batch', { p_limit: BATCH_SIZE }, 'AGGREGATION_RPC')
        if (!object(result) || typeof result.status !== 'string' || typeof result.ok !== 'boolean') {
          throw new SyncFailure('RPC_CONTRACT', 503, '집계 처리 결과를 안전하게 확인할 수 없습니다.')
        }
        const batch = result as unknown as BatchResult
        if (!batch.ok || batch.status === 'blocked') throw new SyncFailure('AGGREGATION_BLOCKED', 503, '검토가 필요한 집계 자료가 있어 처리를 보류했습니다.')
        if (batch.status === 'idle') return
        if (!['running', 'complete'].includes(batch.status) || !count(batch.processed) || !count(batch.remaining)) {
          throw new SyncFailure('RPC_CONTRACT', 503, '집계 처리 건수를 안전하게 확인할 수 없습니다.')
        }
        processed += batch.processed
        if (batch.status === 'running' && batch.processed === 0) {
          throw new SyncFailure('IN_PROGRESS', 202, '다른 실행이 집계 중이며 다음 호출에서 이어집니다.')
        }
      }
    }
    try {
      if (req.query?.recover_round !== undefined) throw new SyncFailure('RECOVERY_UNSUPPORTED', 400, '이 경로는 기존 회차를 다시 발송하거나 수동 복구하지 않습니다.')
      let health = await readHealth()
      // max_round만 보고 종료하면 저장 후 중단된 집계를 영구 누락한다. 항상 미완료 작업부터 처리한다.
      if (health.jobs.some((job) => job.status !== 'complete')) await resume()
      health = await readHealth()
      if (health.jobs.some((job) => job.status !== 'complete')) throw new SyncFailure('IN_PROGRESS', 202, '집계가 진행 중이며 다음 호출에서 이어집니다.')
      if (health.max_round < expected) {
        stage = 'official'
        const from = health.max_round + 1
        const to = Math.min(from + 7, expected)
        let official: unknown
        try {
          const response = await fetch(`${DH_API}?srchStrLtEpsd=${from}&srchEndLtEpsd=${to}`, {
            headers: { 'User-Agent': UA, Referer: 'https://www.dhlottery.co.kr/' }, signal: AbortSignal.timeout(timeout(15_000)),
          })
          if (!response.ok) throw new SyncFailure('UPSTREAM_FETCH', 502, `동행복권 조회 HTTP ${response.status}`)
          official = await response.json()
        } catch (error) {
          if (error instanceof SyncFailure) throw error
          throw new SyncFailure('UPSTREAM_FETCH', 502, '동행복권 응답 수신 또는 JSON 해석에 실패했습니다.')
        }
        for (const row of parseDrawResponse(official, from, to)) {
          stage = 'persist'
          // 과거 누락분 집계는 복구하되 당첨문자를 만들지 않는다. 기존 1244 등 수동 복구 회차는 start가 건너뛴다.
          const result = await rpc('lotto_sync_start', { p_round: row, p_queue_sms: options.winSms && row.round_no === expected }, 'ROUND_PERSIST')
          if (!object(result) || result.ok !== true || typeof result.created !== 'boolean') {
            throw new SyncFailure('RPC_CONTRACT', 503, '회차 작업 저장 결과를 안전하게 확인할 수 없습니다.')
          }
          if (result.created) { added++; rounds.push(row.round_no) }
        }
        await resume()
      }
      health = await readHealth()
      if (options.winSms && health.sms.pending > 0) {
        stage = 'sms_settings'
        const settingsResult = await sb.from('site_settings').select('sms, win_messages, win_sms').eq('id', 1)
          .abortSignal(AbortSignal.timeout(timeout(15_000))).maybeSingle()
        if (settingsResult.error) throw new SyncFailure('SETTINGS_READ', 503, '당첨 안내 설정 조회에 실패했습니다.')
        const settings = (settingsResult.data ?? {}) as SiteSettingsLite
        const cfg: WinSmsCfg = { enabled: settings.win_sms?.enabled === true, ranks: settings.win_sms?.ranks ?? [],
          paid: settings.win_sms?.paid === true, free: settings.win_sms?.free === true }
        const sender = settings.sms?.sender_no ?? ''
        const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT ?? 3000}`
        let previouslyPending = health.sms.pending
        for (;;) {
          // 한 건씩 선점해서 시간 소진 시 아직 요청하지 않은 다수 건을 claim 상태로 남기지 않는다.
          if (timeLeft() < 30_000) throw new SyncFailure('IN_PROGRESS', 202, '집계 완료 후 문자 처리가 진행 중이며 다음 호출에서 이어집니다.')
          stage = 'sms_claim'
          const claims = await rpc('lotto_sync_claim_sms', { p_limit: 1 }, 'SMS_CLAIM')
          if (!Array.isArray(claims) || claims.length > 1) throw new SyncFailure('RPC_CONTRACT', 503, '문자 요청 선점 결과가 올바르지 않습니다.')
          if (!claims.length) {
            const afterSkip = await readHealth()
            if (afterSkip.sms.pending > 0 && afterSkip.sms.pending < previouslyPending) {
              previouslyPending = afterSkip.sms.pending
              continue // DB가 보류 대상을 묶음 제외했다면 다음 묶음을 이어 확인한다.
            }
            break // 진전이 없으면 다른 실행의 선점 가능성이 있으므로 바쁜 반복을 하지 않는다.
          }
          previouslyPending = Math.max(0, previouslyPending - 1)
          const value: unknown = claims[0]
          if (!object(value) || !count(value.id) || typeof value.claim_token !== 'string' || typeof value.member_id !== 'string'
            || !count(value.round_no) || !count(value.rank) || !object(value.member) || value.member.id !== value.member_id) {
            throw new SyncFailure('RPC_CONTRACT', 503, '문자 요청 대상을 안전하게 확인할 수 없습니다.')
          }
          const claim = value as unknown as SmsClaim
          const member = claim.member
          const paid = PAID_GRADES.includes(member.grade)
          const held = member.meta?.reco_paused === true && member.meta?.reco_pause_reason === 'legacy_import_review'
          const eligible = cfg.enabled && settings.sms?.oneshot_enabled === true && !!sender && Array.isArray(cfg.ranks)
            && cfg.ranks.includes(claim.rank) && (paid ? cfg.paid : cfg.free) && !!member.phone
            && !member.is_deleted && !member.is_suspended && !member.is_withdrawn && !held
          const template = eligible ? settings.win_messages?.find((item) => item.rank === claim.rank)?.body : undefined
          const body = template?.trim() ? renderWinSms(template, member, member.win_history || `${claim.round_no}회 ${claim.rank}등`) : null
          stage = 'sms_finish'
          if (!body) {
            const result = await rpc('lotto_sync_finish_sms', { p_id: claim.id, p_claim_token: claim.claim_token,
              p_status: 'skipped', p_provider_result: { code: 'INELIGIBLE' } }, 'SMS_RECORD')
            if (!object(result) || result.ok !== true) throw new SyncFailure('SMS_RECORD', 503, '문자 보류 결과 저장을 확인해야 합니다.')
            continue
          }
          stage = 'sms_provider'
          const outcome = await sendWinSms(base, claim, body, sender, timeout(20_000))
          stage = 'sms_finish'
          const result = await rpc('lotto_sync_finish_sms', { p_id: claim.id, p_claim_token: claim.claim_token,
            p_status: outcome.status, p_provider_result: { ...outcome, phone: member.phone, body, sent_at: new Date().toISOString() } }, 'SMS_RECORD')
          if (!object(result) || result.ok !== true) throw new SyncFailure('SMS_RECORD', 503, '업체 요청 결과 저장을 확인해야 합니다. 자동 재발송하지 않습니다.')
          if (outcome.status !== 'accepted') throw new SyncFailure('SMS_REVIEW_REQUIRED', 503, '당첨 안내문자 접수 결과를 확인해야 합니다. 자동 재발송하지 않습니다.')
          smsSent++
        }
      }
      stage = 'verify'
      health = await readHealth()
      const incomplete = health.jobs.some((job) => job.status !== 'complete') || health.max_confirmed_round < expected
        || (options.winSms && health.sms.pending > 0)
      if (incomplete) throw new SyncFailure('IN_PROGRESS', 202, '미완료 작업이 남아 있으며 다음 호출에서 이어집니다.')
      const reviewRequired = options.winSms && health.sms.claimed + health.sms.failed + health.sms.unknown > 0
      if (reviewRequired) throw new SyncFailure('SMS_REVIEW_REQUIRED', 503, '접수 확인이 필요한 당첨 안내문자가 남아 있습니다. 자동 재발송하지 않습니다.')
      if (!await tick(true, null)) throw new SyncFailure('HEALTH_RECORD', 503, '집계 결과는 저장됐으나 점검 기록 저장을 확인해야 합니다.')
      return res.status(200).json({ ok: true, complete: true, maxRound: health.max_round, expectedRound: expected,
        added, rounds, processed, winSms: smsSent, note: added || processed ? '회차 및 당첨 집계 완료' : '최신 회차 집계 정상' })
    } catch (error) {
      const failure = error instanceof SyncFailure ? error : new SyncFailure('ERROR', 500, '회차 동기화에 실패했습니다.')
      await tick(false, failure.code)
      let auditRecorded = false
      // 로그에는 단계·고정 오류 코드만 남긴다. DB 오류 원문/회원/문자/업체 응답 본문은 넣지 않는다.
      try {
        const audit = await sb.from('logs').insert({ id: `log_lotto_error_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          kind: 'admin', actor: null, action: failure.httpStatus === 202 ? 'lotto.sync_in_progress' : 'lotto.sync_failed',
          target_type: 'lotto_round', target_id: null, meta: { code: failure.code, stage, expected_round: expected }, created_at: new Date().toISOString() })
          .abortSignal(AbortSignal.timeout(3_000))
        auditRecorded = !audit.error
      } catch { /* HTTP 응답은 감사 로그 저장 실패에도 남긴다. */ }
      return res.status(failure.httpStatus).json({ ok: false, complete: false, code: failure.code, message: failure.message,
        stage, expectedRound: expected, added, processed, winSms: smsSent, auditRecorded })
    }
  }
}

export default createWeeklyLottoSyncHandler({ winSms: true })
