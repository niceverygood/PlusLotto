// Vercel 크론 — 동행복권 최신 회차 자동 적재(현장 피드백 6/22 / DECISIONS D65).
// lotto_rounds 의 max(round_no)+1 부터 추첨 완료된 신규 회차를 동행복권 내부 API 로 받아 upsert.
// 데이터가 밀려 발송/추천이 '이미 지난 회차'를 가리키던 회차 오류의 재발 방지.
// vercel.json crons: 매일 23:00 UTC(=익일 08:00 KST, 주간추천발급 09:00 직전)에 호출.
// 인증: CRON_SECRET Bearer(Vercel 크론 자동 첨부). env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// 주의: Vercel egress IP 가 동행복권 WAF 에 막히면 fetch 실패 → no-op 으로 로그만 남기고
//       운영자 '회차 등록' 수기 폴백(LottoResultsPage)이 안전망.
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
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
    const { data: maxRows, error: me } = await sb
      .from('lotto_rounds')
      .select('round_no')
      .order('round_no', { ascending: false })
      .limit(1)
    if (me) throw me
    const maxRound = (maxRows?.[0]?.round_no as number) ?? 0
    const from = maxRound + 1
    const to = from + 8 // 밀린 경우 최대 8회 따라잡기

    const r = await fetch(`${DH_API}?srchStrLtEpsd=${from}&srchEndLtEpsd=${to}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.dhlottery.co.kr/' },
    })
    if (!r.ok) {
      return res.status(200).json({ ok: false, code: 'FETCH', status: r.status, maxRound })
    }
    const j = (await r.json()) as { data?: { list?: DhRow[] } }
    const list = j?.data?.list ?? []

    // 추첨 완료·유효 회차만 — 응답 드리프트(필드 null/타입/누락) 시 크래시 대신 해당 행만 건너뜀(D68 #11).
    const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
    const validBall = (v: unknown) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 45
    const valid = list.filter(
      (d) =>
        isNum(d.ltEpsd) &&
        d.ltEpsd > maxRound &&
        typeof d.ltRflYmd === 'string' &&
        /^\d{8}$/.test(d.ltRflYmd) &&
        [d.tm1WnNo, d.tm2WnNo, d.tm3WnNo, d.tm4WnNo, d.tm5WnNo, d.tm6WnNo, d.bnsWnNo].every(validBall),
    )
    const skipped = list.length - valid.length
    const rows = valid.map((d) => {
      const numbers = [d.tm1WnNo, d.tm2WnNo, d.tm3WnNo, d.tm4WnNo, d.tm5WnNo, d.tm6WnNo].map(Number).sort((a, b) => a - b)
      const sum = numbers.reduce((a, n) => a + n, 0)
      const odd = numbers.filter((n) => n % 2 === 1).length
      const y = d.ltRflYmd.slice(0, 4)
      const mo = d.ltRflYmd.slice(4, 6)
      const da = d.ltRflYmd.slice(6, 8)
      return {
        round_no: Number(d.ltEpsd),
        draw_date: `${y}-${mo}-${da}T20:45:00+09:00`,
        numbers,
        bonus: Number(d.bnsWnNo),
        sum,
        odd_even: `홀${odd}:짝${6 - odd}`,
        appear_rate: null,
        prize_1: isNum(d.rnk1WnAmt) ? d.rnk1WnAmt : null,
        prize_2: isNum(d.rnk2WnAmt) ? d.rnk2WnAmt : null,
        prize_3: isNum(d.rnk3WnAmt) ? d.rnk3WnAmt : null,
        total_sales: null,
        confirmed_at: new Date().toISOString(),
      }
    })

    if (!rows.length) {
      return res.status(200).json({ ok: true, maxRound, added: 0, skipped, note: '신규 추첨분 없음' })
    }
    const { error } = await sb.from('lotto_rounds').upsert(rows, { onConflict: 'round_no' })
    if (error) throw error

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
    const mem: MemberRow[] = []
    for (let from = 0; ; from += 1000) {
      const { data: md } = await sb
        .from('members')
        .select('id, name, phone, grade, win_history, is_suspended, is_withdrawn, meta')
        .eq('is_deleted', false)
        .range(from, from + 999)
      const pg = (md ?? []) as MemberRow[]
      mem.push(...pg)
      if (pg.length < 1000) break
    }

    // 당첨 안내문자 자동발송 설정(현장 7/28) — 꺼져 있으면 종전처럼 집계만 하고 문자는 보내지 않는다.
    const { data: setData } = await sb.from('site_settings').select('sms, win_messages, win_sms').eq('id', 1).maybeSingle()
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
        let best: number | null = null
        let wins = 0
        for (const set of issue.sets) {
          const rk = gRank(set, row.numbers, row.bonus)
          if (rk != null) {
            wins += 1
            if (best === null || rk < best) best = rk
          }
        }
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

        const patch: Record<string, unknown> = { win_history: winHistory }
        if (body) {
          patch.meta = { ...(m.meta ?? {}), win_sms_rounds: [...sentRounds, row.round_no].slice(-40) }
        }
        await sb.from('members').update(patch).eq('id', m.id)
        tallied += 1

        if (body) {
          const r = await sendWinSms(base, m.phone as string, body, senderNo)
          await sb.from('sms_sends').insert({
            id: `sms_${row.round_no}_${m.id}`.slice(0, 60),
            member_id: m.id,
            template_key: 'win',
            phone: m.phone,
            body,
            type: 'win',
            status: r.ok ? '발송완료' : `실패(${r.code ?? '?'})`,
            sent_at: new Date().toISOString(),
          })
          if (r.ok) smsSent += 1
        }
      }
    }

    await sb.from('logs').insert({
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
    return res
      .status(200)
      .json({ ok: true, maxRound, added: rows.length, skipped, rounds: rows.map((x) => x.round_no), winners: tallied, winSms: smsSent })
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'ERROR', message: e instanceof Error ? e.message : String(e) })
  }
}
