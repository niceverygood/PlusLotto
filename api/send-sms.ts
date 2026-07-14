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
import crypto from 'node:crypto'

const ONESHOT_BASE = 'https://api2.msgagent.com/api/webshot/send/general'

// 호출자 인증(보안 D68): 무인증 공개 시 검증된 발신번호로 임의 SMS 가 무제한 발송 가능 →
//   ① 서버-서버(크론): x-internal-secret === CRON_SECRET, 또는
//   ② 브라우저(운영자): Authorization Bearer = 로그인 staff 의 Supabase access token.
// 둘 중 하나도 충족 못 하면 401. (다른 api/ 함수와 동일한 인증 패턴.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isAuthorized(req: any): Promise<boolean> {
  const internal = String(req.headers?.['x-internal-secret'] ?? '')
  const cronSecret = process.env.CRON_SECRET
  if (internal && cronSecret && internal === cronSecret) return true // 크론(weekly-reco)
  const token = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '')
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!token || !url || !key) return false
  try {
    const admin = createClient(url, key, { auth: { persistSession: false } })
    const { data: ures } = await admin.auth.getUser(token)
    const uid = ures?.user?.id
    if (!uid) return false
    const { data: st } = await admin.from('staff').select('id, is_active').eq('auth_user_id', uid).maybeSingle()
    return !!st && (st as { is_active?: boolean }).is_active !== false
  } catch {
    return false
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'METHOD', message: 'POST only' })
  if (!(await isAuthorized(req)))
    return res.status(401).json({ ok: false, code: 'AUTH', message: '인증 필요(로그인 또는 내부 호출만 허용)' })

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}
    const id = process.env.ONESHOT_ID
    const reseller = process.env.ONESHOT_RESELLER
    const sender = String(body.send_phone ?? process.env.ONESHOT_SEND_PHONE ?? '').replace(/\D/g, '')
    const dest = String(body.dest_phone ?? '').replace(/\D/g, '')
    const msg = String(body.msg_body ?? '')
    const msgType = body.msgType === 'LMS' || body.msgType === 'MMS' ? body.msgType : 'SMS'

    if (!dest || !msg || !sender)
      return res.status(400).json({ ok: false, code: '200', message: '필수 값 누락(dest_phone/msg_body/send_phone)' })

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
          from: sender,
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
    form.append('send_phone', sender)
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
