// Vercel 크론 — 동행복권 최신 회차 자동 적재(현장 피드백 6/22 / DECISIONS D65).
// lotto_rounds의 max(round_no)+1부터 공식 추첨 완료 회차를 확인해 신규 행만 insert한다.
// 데이터가 밀려 발송/추천이 '이미 지난 회차'를 가리키던 회차 오류의 재발 방지.
// vercel.json crons: 매일 23:00 UTC(=익일 08:00 KST, 주간추천발급 09:00 직전)에 호출.
// 인증: CRON_SECRET Bearer(Vercel 크론 자동 첨부). env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// 상류 오류/추첨분 미수신은 오류 응답과 감사 로그를 남긴다. 기존 회차 복구는 별도 검증된 DB 작업이다.
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

/** 검증된 발송 함수(/api/send-sms, Fixie 프록시 경유) 재사용 — weekly-reco.ts 와 동일 경로. */
async function sendWinSms(
  base: string,
  memberId: string,
  dest: string,
  body: string,
  sender: string,
): Promise<{ ok: boolean; code?: string }> {
  try {
    const r = await fetch(`${base}/api/send-sms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.CRON_SECRET ? { 'x-internal-secret': process.env.CRON_SECRET } : {}),
      },
      body: JSON.stringify({
        member_id: memberId,
        dest_phone: dest,
        msg_body: body,
        send_phone: sender,
        msgType: koByteLength(body) <= 90 ? 'SMS' : 'LMS',
      }),
    })
    const d = (await r.json()) as { ok?: boolean; code?: string }
    return { ok: !!d.ok, code: d.code }
  } catch {
    return { ok: false, code: 'NET' }
  }
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
    if (prizes.some((p) => p == null || p <= 0)) throw new SyncFailure('UPSTREAM_NOT_READY', 503, '공식 당첨금 발표를 기다리고 있습니다.')
    seen.add(round)
    const odd = numbers.filter((n) => n % 2 === 1).length
    return { round_no: round, draw_date: drawDate(round), numbers, bonus: Number(d.bnsWnNo),
      sum: numbers.reduce((a, b) => a + b, 0), odd_even: `홀${odd}:짝${6 - odd}`, appear_rate: null,
      prize_1: prizes[0], prize_2: prizes[1], prize_3: prizes[2], total_sales: amount(d.wholEpsdSumNtslAmt), confirmed_at: null }
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

export default async function handler(req: SyncRequest, res: SyncResponse) {
  // fail-closed(D68): CRON_SECRET 미설정이면 차단.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return res.status(500).json({ ok: false, code: 'CONFIG', message: 'CRON_SECRET 미설정' })
  }
  if (req.headers?.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, code: 'AUTH' })
  }
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return res.status(500).json({ ok: false, code: 'CONFIG', message: 'SUPABASE_URL/SERVICE_ROLE_KEY 미설정' })
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  try {
    if (req.query?.recover_round !== undefined) throw new SyncFailure('RECOVERY_UNSUPPORTED', 400, '이 경로는 기존 회차를 복구하거나 문자를 재발송하지 않습니다.')
    const expected = latestCompletedRound()
    const { data: maxRows, error: me } = await sb.from('lotto_rounds').select('round_no').order('round_no', { ascending: false }).limit(1)
    if (me) throw new SyncFailure('DB_READ', 500, '최신 회차 조회에 실패했습니다.')
    const maxRound = (maxRows?.[0]?.round_no as number) ?? 0
    if (maxRound >= expected) return res.status(200).json({ ok: true, maxRound, expectedRound: expected, added: 0, note: '신규로 적재할 추첨 회차 없음' })
    const from = maxRound + 1
    const to = Math.min(from + 7, expected)
    let official: unknown
    try {
      const response = await fetch(`${DH_API}?srchStrLtEpsd=${from}&srchEndLtEpsd=${to}`, {
        headers: { 'User-Agent': UA, Referer: 'https://www.dhlottery.co.kr/' }, signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new SyncFailure('UPSTREAM_FETCH', 502, `동행복권 조회 HTTP ${response.status}`)
      official = await response.json()
    } catch (error) {
      if (error instanceof SyncFailure) throw error
      throw new SyncFailure('UPSTREAM_FETCH', 502, '동행복권 응답 수신 또는 JSON 해석에 실패했습니다.')
    }
    // 집계는 기존 순차 경로를 유지한다. 이미 저장된 회차의 부분 집계 실패는 자동 재발송하지 않는다.
    // TODO: 원자적 배치 집계 + 별도 상태/재개 RPC로 확정과 전체 집계 완료를 함께 보장한다.
    const rows = parseDrawResponse(official, from, to).map((row) => ({ ...row, confirmed_at: new Date().toISOString() }))
    const skipped = 0
    // INSERT만 허용한다. 동시에 수기 등록된 회차나 먼저 시작한 크론의 결과를 덮어쓰지 않는다.
    const { error: roundError } = await sb.from('lotto_rounds').insert(rows)
    if (roundError) throw new SyncFailure('ROUND_INSERT', 409, '회차 저장 충돌 또는 오류입니다. 기존 회차를 확인해야 합니다.')

    // 추천조합 당첨 집계 — 새로 적재된 회차별로 회원 추천번호(meta.weekly_recos)를 당첨번호와 대조해 win_history 갱신.
    // 실서비스는 베팅이 아니라 추천조합 발급이라, 이 집계가 '당첨자' 세그먼트의 실질 기준(현장 6/29).
    const gRank = (combo: number[], win: number[], bonus: number): number | null => {
      const w = new Set(win)
      const m = combo.reduce((c, n) => (w.has(n) ? c + 1 : c), 0)
      if (m === 6) return 1
      if (m === 5) return combo.includes(bonus) ? 2 : 3
      if (m === 4) return 4
      if (m === 3) return 5
      return null
    }
    // 회원별 당첨내역 누적(meta.win_records) — 이용자 '당첨회차/등수' 필터(D127)가 읽는 원본이다.
    // 예전에는 이 크론이 win_history(최근 1건 문자열)만 갱신해서, 크론이 적재한 회차는 필터에
    // 전혀 잡히지 않았다(현장 8/10 "1236회차가 필터링이 안되고 있습니다" — 1235회도 같은 이유로
    // 8/3 에 수동 백필했었다). src/lib/winHistory.ts 의 WinRecord/upsertWinRecords 를 자급자족 복제.
    interface WinRecord {
      round_no: number
      draw_date: string | null
      rank: number
      prize: number
      combo_index: number
      source: 'reco' | 'bet'
    }
    const wrKey = (w: WinRecord) => `${w.source}:${w.round_no}:${w.combo_index}`
    const upsertWinRecords = (existing: WinRecord[], fresh: WinRecord[]): WinRecord[] => {
      const map = new Map<string, WinRecord>()
      for (const w of existing) map.set(wrKey(w), w)
      for (const w of fresh) map.set(wrKey(w), w)
      return [...map.values()].sort((a, b) => b.round_no - a.round_no || a.combo_index - b.combo_index)
    }

    const mem: MemberRow[] = []
    let cursor: string | null = null
    for (;;) {
      let query = sb
        .from('members')
        .select('id, name, phone, grade, win_history, is_suspended, is_withdrawn, meta')
        .eq('is_deleted', false)
        .order('id', { ascending: true })
        .limit(1000)
      if (cursor) query = query.gt('id', cursor)
      const { data: md, error: memberError } = await query
      if (memberError) throw new SyncFailure('MEMBERS_READ', 500, '집계 대상 회원 조회에 실패했습니다.')
      const pg = (md ?? []) as MemberRow[]
      mem.push(...pg)
      if (pg.length < 1000) break
      const next = pg[pg.length - 1].id
      if (!next || (cursor && next <= cursor)) throw new SyncFailure('MEMBERS_CURSOR', 500, '회원 조회 커서가 진행하지 않았습니다.')
      cursor = next
    }

    // 당첨 안내문자 자동발송 설정(현장 7/28) — 꺼져 있으면 종전처럼 집계만 하고 문자는 보내지 않는다.
    const { data: setData, error: settingsError } = await sb.from('site_settings').select('sms, win_messages, win_sms').eq('id', 1).maybeSingle()
    if (settingsError) throw new SyncFailure('SETTINGS_READ', 500, '당첨 안내 설정 조회에 실패했습니다.')
    const settings = (setData ?? {}) as SiteSettingsLite
    const winCfg: WinSmsCfg = {
      enabled: !!settings.win_sms?.enabled,
      ranks: Array.isArray(settings.win_sms?.ranks) ? (settings.win_sms!.ranks as number[]) : [],
      paid: !!settings.win_sms?.paid,
      free: !!settings.win_sms?.free,
    }
    const senderNo = settings.sms?.sender_no ?? ''
    const winSmsOn = winCfg.enabled && !!settings.sms?.oneshot_enabled && !!senderNo
    const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT ?? 3000}`

    let tallied = 0
    let smsSent = 0
    for (const row of rows) {
      for (const m of mem) {
        const recos = Array.isArray(m.meta?.weekly_recos)
          ? (m.meta!.weekly_recos as { round_no: number; sets: number[][] }[])
          : []
        const issue = recos.find((x) => x.round_no === row.round_no)
        if (!issue) continue
        if (!Array.isArray(issue.sets) || issue.sets.some((set) => !Array.isArray(set) || set.length !== 6
          || set.some((n) => !Number.isInteger(n) || n < 1 || n > 45) || new Set(set).size !== 6)) {
          throw new SyncFailure('RECO_INVALID', 500, '집계 대상 추천조합이 유효하지 않습니다.')
        }
        let best: number | null = null
        let wins = 0
        const fresh: WinRecord[] = []
        issue.sets.forEach((set, i) => {
          const rk = gRank(set, row.numbers, row.bonus)
          if (rk == null) return
          wins += 1
          if (best === null || rk < best) best = rk
          fresh.push({
            round_no: row.round_no,
            draw_date: row.draw_date,
            rank: rk,
            prize: syncPrizeForRank(row, rk),
            combo_index: i + 1,
            source: 'reco',
          })
        })
        if (best == null) continue
        const winHistory = `${row.round_no}회 ${best}등${wins > 1 ? ` (${wins}건)` : ''}`

        // 자동발송 대상: 체크한 등수 + 체크한 회원분류(유료/무료), 이 회차 미발송, 정지/탈퇴 제외.
        const sentRounds = Array.isArray(m.meta?.win_sms_rounds) ? (m.meta!.win_sms_rounds as number[]) : []
        const gradeOk = PAID_GRADES.includes(m.grade) ? winCfg.paid : winCfg.free
        const eligible =
          winSmsOn &&
          winCfg.ranks.includes(best) &&
          gradeOk &&
          !sentRounds.includes(row.round_no) &&
          !!m.phone &&
          !m.is_suspended &&
          !m.is_withdrawn
        const tpl = eligible ? (settings.win_messages ?? []).find((w) => w.rank === best) : undefined
        const body = tpl?.body?.trim() ? renderWinSms(tpl.body, m, winHistory) : null

        // meta 는 항상 갱신한다 — win_records 가 빠지면 회차/등수 필터에서 이 회원이 사라진다.
        const prevRecords = Array.isArray(m.meta?.win_records) ? (m.meta!.win_records as WinRecord[]) : []
        const nextMeta: Record<string, unknown> = {
          ...(m.meta ?? {}),
          win_records: upsertWinRecords(prevRecords, fresh),
        }
        if (body) nextMeta.win_sms_rounds = [...sentRounds, row.round_no].slice(-40)
        const patch: Record<string, unknown> = { win_history: winHistory, meta: nextMeta }
        // 기존 업데이트 경로: 집계 중 오류를 성공으로 숨기지 않는다. 동시 meta 수정 보호는 배치 RPC 후속 작업이다.
        const memberWrite = await sb.from('members').update(patch).eq('id', m.id).select('id')
        if (memberWrite.error || memberWrite.data?.length !== 1) throw new SyncFailure('MEMBER_WRITE', 500, '회원 집계 저장에 실패했습니다. 기존 회차를 재발송 없이 점검해야 합니다.')
        m.meta = nextMeta
        m.win_history = winHistory
        tallied += 1

        if (body) {
          const r = await sendWinSms(base, m.id, m.phone as string, body, senderNo)
          const smsLog = await sb.from('sms_sends').insert({
            id: `sms_${row.round_no}_${m.id}`.slice(0, 60),
            member_id: m.id,
            template_key: 'win',
            phone: m.phone,
            body,
            type: 'win',
            status: r.ok ? '발송완료' : `실패(${r.code ?? '?'})`,
            sent_at: new Date().toISOString(),
          })
          if (smsLog.error) throw new SyncFailure('SMS_RECORD', 500, '당첨문자 요청 후 기록 저장에 실패했습니다. 재발송하지 말고 업체 접수를 확인해야 합니다.')
          if (r.ok) smsSent += 1
        }
      }

    }

    const receipt = await sb.from('logs').insert({
      id: `log_lotto_${Date.now().toString(36)}`,
      kind: 'admin',
      actor: null,
      action: 'lotto.auto_sync',
      target_type: 'lotto_round',
      target_id: null,
      meta: {
        added: rows.length,
        skipped,
        rounds: rows.map((x) => x.round_no),
        maxBefore: maxRound,
        winners: tallied,
        win_sms: smsSent,
      },
      created_at: new Date().toISOString(),
    })
    if (receipt.error) throw new SyncFailure('AUDIT_RECORD', 500, '회차 반영 후 감사 기록 저장에 실패했습니다. 재발송하지 않습니다.')
    return res
      .status(200)
      .json({ ok: true, maxRound, added: rows.length, skipped, rounds: rows.map((x) => x.round_no), winners: tallied, winSms: smsSent })
  } catch (e) {
    const failure = e instanceof SyncFailure ? e : new SyncFailure('ERROR', 500, '회차 동기화에 실패했습니다.')
    // 번호/회원/문자/응답 본문은 기록하지 않는다. HTTP 오류와 DB 감사 기록 모두로 실패를 드러낸다.
    const result = await sb.from('logs').insert({ id: `log_lotto_error_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      kind: 'admin', actor: null, action: 'lotto.sync_failed', target_type: 'lotto_round', target_id: null,
      meta: { code: failure.code, message: failure.message, recover_requested: req.query?.recover_round !== undefined }, created_at: new Date().toISOString() })
    return res.status(failure.httpStatus).json({ ok: false, code: failure.code, message: failure.message, auditRecorded: !result.error })
  }
}
