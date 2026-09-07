// Vercel 크론/수동 함수 — 충전금 부족 등으로 못 나간 문자를 같은 내용 그대로 다시 보낸다.
//
// 현장 9/7 정의현 차장 통화:
//   "아침 9시에 (문자 충전)돈이 떨어져서 조합 자동 발송이 완료가 안 됐다. 9시 반 이전에 보낸
//    그 발송 문자 그대로, 실패한 것만 그대로 다시 보내달라."
//   "저희가 쓰는 (원샷) API 모드는 (충전 후 자동 재발송이) 안 된다고 하더라."
//
// 왜 필요한가
//  ① 조합 자동발송 크론(api/weekly-reco)은 '회차 기준 멱등'이라 다시 돌려도 이미 발급된 회원은
//     통째로 건너뛴다 — 발급은 됐고 문자만 실패한 회원은 크론 재실행으로 절대 복구되지 않는다.
//  ② 원샷 API 모드는 충전 후 밀린 건을 이어 보내주지 않는다(9/7 벤더 확인).
// 그래서 sms_sends 의 '실패' 기록을 근거로 우리가 직접 다시 보낸다. 크론으로 오전에 몇 차례
// 돌려, 충전만 해두면 사람이 아무것도 누르지 않아도 그날 안에 회수되게 한다.
//
// ⚠️ 완전 자급자족 단일 파일: Vercel 함수 런타임(ESM)이 api/ → src/ 상대 import 를 해석하지 못해
// src/lib/smsRetry.ts 의 판정 로직 사본을 인라인한다(원본 수정 시 동기화).
//
// Vercel 환경변수: SUPABASE_URL(또는 VITE_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET
// 수동 실행: GET /api/resend-failed-sms?day=2026-09-07&type=recommend  (Authorization: Bearer $CRON_SECRET)
//   미리보기(발송 없이 건수만): &dryRun=1
import { createClient } from '@supabase/supabase-js'

interface SmsRow {
  id: string
  member_id: string
  phone: string
  body: string
  type: string
  status: string
}

// ── src/lib/smsRetry.ts 사본(동기화 대상) ────────────────────────────────────
function failureCodeOf(status: string | null | undefined): string | null {
  const m = /^실패\(([^)]*)\)/.exec(status ?? '')
  const code = m?.[1]?.trim()
  return code && code !== '?' ? code : null
}

// 다시 보내도 같은 결과인 '영구 실패' — 밀어넣으면 충전금만 깎이고 같은 실패가 다시 쌓인다.
const PERMANENT_CODES = new Set(['100', '200', '301', '305', '402', '7', '316', '317'])

function isRetriableFailure(status: string | null | undefined): boolean {
  if (typeof status !== 'string' || !status.startsWith('실패')) return false
  const code = failureCodeOf(status)
  if (!code) return true // 코드 미상(NET/EXCEPTION 등) — 네트워크성으로 보고 재시도
  return !PERMANENT_CODES.has(code)
}

const RESENT_STATUS = '발송완료(재발송)'

function kstDayRangeUtc(dayKst: string): { gte: string; lt: string } {
  const [y, m, d] = dayKst.split('-').map(Number)
  const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 3600_000
  return {
    gte: new Date(startUtcMs).toISOString(),
    lt: new Date(startUtcMs + 24 * 3600_000).toISOString(),
  }
}

function todayKst(nowMs: number = Date.now()): string {
  const d = new Date(nowMs + 9 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 한국 문자 바이트 길이(비ASCII=2byte). SMS=90byte 기준. */
function koByteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 0x7f ? 2 : 1
  return n
}

/** 검증된 발송 함수(/api/send-sms, 고정 IP 프록시 경유)를 재사용해 1건 발송. */
async function sendOne(
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
        // 조합 본문은 90byte 초과라 LMS — 미지정 시 SMS 로 처리돼 402(길이 초과)로 전건 실패한다(D68).
        msgType: koByteLength(body) <= 90 ? 'SMS' : 'LMS',
      }),
    })
    const d = (await r.json()) as { ok?: boolean; code?: string }
    return { ok: !!d.ok, code: d.code }
  } catch {
    return { ok: false, code: 'NET' }
  }
}

/** 페이지네이션 전량 수집(supabase 기본 1000행 한도 회피). */
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; from < 200_000; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

const CONC = 8
const BUDGET_MS = 240_000 // maxDuration 300초 중 안전 여유

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  // fail-closed(D68): CRON_SECRET 미설정이면 '열림'이 아니라 '차단'.
  const secret = process.env.CRON_SECRET
  if (!secret) return res.status(500).json({ ok: false, code: 'CONFIG', message: 'CRON_SECRET 미설정' })
  if (req.headers?.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false, code: 'AUTH' })

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return res.status(500).json({ ok: false, code: 'CONFIG', message: 'SUPABASE_URL/SERVICE_ROLE_KEY 미설정' })
  }

  const startedAt = Date.now()
  const day = String(req.query?.day ?? '') || todayKst()
  // 기본값은 조합문자만 — 크론이 사람 확인 없이 돌리는 경로라 대상을 좁게 잡는다.
  // 다른 종류까지 회수하려면 수동으로 type=all 을 지정한다.
  const type = String(req.query?.type ?? 'recommend')
  const dryRun = String(req.query?.dryRun ?? '') === '1'
  const sb = createClient(url, key, { auth: { persistSession: false } })

  try {
    const { data: sData, error: se } = await sb.from('site_settings').select('sms').eq('id', 1).maybeSingle()
    if (se) throw se
    const sms = (sData as { sms?: { oneshot_enabled?: boolean; sender_no?: string } } | null)?.sms ?? {}
    if (!sms.oneshot_enabled || !sms.sender_no) {
      // 실발송이 꺼져 있으면 조용히 no-op — 크론이 매번 에러로 뜨지 않게 ok 로 답한다.
      return res.status(200).json({ ok: true, skipped: 'sms_disabled', day, type })
    }
    const sender = sms.sender_no

    const { gte, lt } = kstDayRangeUtc(day)
    const failedRows = await pageAll<SmsRow>((from, to) => {
      let q = sb
        .from('sms_sends')
        .select('id, member_id, phone, body, type, status')
        .gte('sent_at', gte)
        .lt('sent_at', lt)
        .like('status', '실패%')
      if (type !== 'all') q = q.eq('type', type)
      return q.order('sent_at', { ascending: true }).range(from, to)
    })

    const targets = failedRows.filter((r) => isRetriableFailure(r.status) && r.phone)
    const skippedPermanent = failedRows.length - targets.length

    // 이중 발송 방지 — 크레딧이 중간에 떨어진 상황은 '일부는 나가고 일부는 실패'가 섞여 있어,
    // 실패 기록만 보고 밀어넣으면 이미 받은 회원에게 한 번 더 갈 수 있다.
    const okRows = await pageAll<{ member_id: string; body: string }>((from, to) =>
      sb
        .from('sms_sends')
        .select('member_id, body')
        .gte('sent_at', gte)
        .lt('sent_at', lt)
        .like('status', '발송완료%')
        .range(from, to),
    )
    const alreadySent = new Set(okRows.map((r) => `${r.member_id} ${r.body}`))
    const pending = targets.filter((r) => !alreadySent.has(`${r.member_id} ${r.body}`))
    const skippedAlreadySent = targets.length - pending.length

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        day,
        type,
        failed: failedRows.length,
        wouldSend: pending.length,
        skippedPermanent,
        skippedAlreadySent,
      })
    }

    const proto = req.headers?.['x-forwarded-proto'] ?? 'https'
    const host = req.headers?.host
    const selfBase = process.env.PUBLIC_BASE_URL || (host ? `${proto}://${host}` : '')

    const resentAt = new Date().toISOString()
    let sent = 0
    let failed = 0
    let processed = 0

    for (let i = 0; i < pending.length; i += CONC) {
      // 예산을 넘기면 남은 건은 다음 크론 주기가 회수한다(멱등이라 중복 발송되지 않는다).
      if (Date.now() - startedAt > BUDGET_MS) break
      const slice = pending.slice(i, i + CONC)
      await Promise.all(
        slice.map(async (r) => {
          const out = await sendOne(selfBase, r.phone, r.body, sender)
          if (out.ok) {
            sent++
            await sb
              .from('sms_sends')
              .update({
                status: RESENT_STATUS,
                meta: { resent_at: resentAt, resent_by: 'cron', original_status: r.status },
              })
              .eq('id', r.id)
          } else {
            failed++
            // 여전히 실패하면 최신 사유로 갱신 — 현장이 '아직 충전이 안 됐구나'를 볼 수 있게 한다.
            await sb
              .from('sms_sends')
              .update({ status: `실패(${out.code ?? '?'})`, meta: { retried_at: resentAt, retried_by: 'cron' } })
              .eq('id', r.id)
          }
        }),
      )
      processed += slice.length
    }

    const remaining = Math.max(0, pending.length - processed)
    // 아무것도 보낼 게 없던 실행은 로그를 남기지 않는다 — 크론이 하루 몇 번 도는데 매번 쌓이면
    // 로그 화면에서 진짜 사고가 묻힌다.
    if (sent > 0 || failed > 0) {
      await sb.from('logs').insert({
        id: `log_resend_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'sms',
        actor: null,
        action: 'sms.resend_failed',
        target_type: 'sms',
        target_id: null,
        meta: { day, type, source: 'cron', attempted: processed, sent, failed, skippedAlreadySent, skippedPermanent, remaining },
        created_at: resentAt,
      })
    }

    return res.status(200).json({
      ok: true,
      day,
      type,
      failed: failedRows.length,
      attempted: processed,
      sent,
      stillFailed: failed,
      skippedPermanent,
      skippedAlreadySent,
      remaining,
    })
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'EXCEPTION', message: String(e) })
  }
}
