// Vercel 서버리스 함수 — 통화 녹음 AI 분석(현장 피드백 7/10, 정의현 차장).
// 전사본(STT, api/transcribe-call.ts)을 OpenAI 챗 모델에 보내 성공요인·실패요인·스크립트
// 유사성·요약을 구조화된 JSON 으로 받는다. 기준 스크립트(site_settings.call_script)가 있으면
// 유사성 비교에 사용하고, 없으면 그 항목은 생략한다.
//
// Vercel 환경변수: OPENAI_API_KEY (api/transcribe-call.ts 와 공유)
import { createClient } from '@supabase/supabase-js'

// 호출자 인증 — 로그인 staff 의 Supabase access token 만 허용(다른 api/ 함수와 동일 패턴).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isAuthorized(req: any): Promise<boolean> {
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

interface AnalysisResult {
  successFactors: string[]
  failFactors: string[]
  scriptMatch: string | null
  summary: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'POST only' })
  if (!(await isAuthorized(req)))
    return res.status(401).json({ ok: false, message: '인증 필요(로그인만 허용)' })

  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) return res.status(500).json({ ok: false, message: 'OPENAI_API_KEY 미설정' })

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}
    const transcript = String(body.transcript ?? '').trim()
    const script = String(body.script ?? '').trim()
    if (!transcript) return res.status(400).json({ ok: false, message: 'transcript 누락' })

    const sys =
      '너는 로또 번호 추천 서비스 텔레마케팅 상담 품질 분석가다. 상담원과 고객의 통화 전사본을 읽고 ' +
      '반드시 JSON 객체 하나만 출력한다. 필드: successFactors(string[], 상담이 잘 된 요인, 없으면 빈 배열), ' +
      'failFactors(string[], 아쉬웠던·개선할 부분, 없으면 빈 배열), scriptMatch(string, 기준 스크립트가 ' +
      '주어진 경우에만 그 스크립트와 얼마나 유사하게 진행됐는지 2~3문장 서술, 기준 스크립트가 없으면 ' +
      '반드시 null), summary(string, 통화 결과를 한두 문장으로 요약). 한국어로 답한다.'
    const userMsg = script
      ? `[기준 스크립트]\n${script}\n\n[통화 전사본]\n${transcript}`
      : `[통화 전사본]\n${transcript}`

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
      }),
    })
    const data = (await upstream.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[]
      error?: { message?: string }
    }
    if (!upstream.ok) return res.status(502).json({ ok: false, message: data.error?.message ?? 'AI 분석 호출 실패' })

    const content = data.choices?.[0]?.message?.content ?? '{}'
    let parsed: Partial<AnalysisResult> = {}
    try {
      parsed = JSON.parse(content)
    } catch {
      return res.status(502).json({ ok: false, message: 'AI 응답 형식 오류' })
    }

    const result: AnalysisResult = {
      successFactors: Array.isArray(parsed.successFactors) ? parsed.successFactors.map(String) : [],
      failFactors: Array.isArray(parsed.failFactors) ? parsed.failFactors.map(String) : [],
      scriptMatch: script && typeof parsed.scriptMatch === 'string' ? parsed.scriptMatch : null,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    }
    return res.status(200).json({ ok: true, analysis: result })
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e) })
  }
}
