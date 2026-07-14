// Vercel 서버리스 함수 — 통화 녹음 STT 전사(현장 피드백 7/3, 김형준 이사).
// 녹음 파일은 Storage(call-recordings, 비공개)에 있고, 이 함수가 service_role 로 다운로드해
// OpenAI 전사 API 로 보낸 뒤 텍스트만 반환한다(전사본 저장·키워드 탐지는 클라이언트가 이어서 처리).
//
// Vercel 환경변수: SUPABASE_URL(또는 VITE_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY
import { createClient } from '@supabase/supabase-js'

// 호출자 인증(보안) — 로그인 staff 의 Supabase access token 만 허용(다른 api/ 함수와 동일 패턴).
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
    const filePath = String(body.file_path ?? '')
    if (!filePath) return res.status(400).json({ ok: false, message: 'file_path 누락' })

    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceKey) return res.status(500).json({ ok: false, message: 'SUPABASE 서버 환경변수 미설정' })
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

    const { data: file, error: dlErr } = await admin.storage.from('call-recordings').download(filePath)
    if (dlErr || !file) return res.status(404).json({ ok: false, message: `녹음 파일을 찾을 수 없습니다: ${dlErr?.message ?? ''}` })

    const form = new FormData()
    form.append('file', file, filePath.split('/').pop() || 'recording.m4a')
    form.append('model', 'gpt-4o-transcribe')

    const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${openaiKey}` },
      body: form,
    })
    const data = (await upstream.json().catch(() => ({}))) as { text?: string; error?: { message?: string } }
    if (!upstream.ok || typeof data.text !== 'string') {
      return res.status(502).json({ ok: false, message: data.error?.message ?? '전사 API 호출 실패' })
    }
    return res.status(200).json({ ok: true, transcript: data.text })
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e) })
  }
}
