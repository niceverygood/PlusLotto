// Vercel 서버리스 함수 — 통화녹음 자동업로드 수신(현장 피드백 7/3·7/6, 김형준 이사·정의현 차장).
// Android 동반 앱(android-call-uploader/)이 폰 기본 통화녹음 폴더에서 감지한 파일을 멀티파트로
// 올리면, 전화번호로 회원을 매칭해 그 회원의 meta.call_recordings[]에 자동으로 붙여준다.
// 매칭 실패(0건/2건 이상)면 unmatched_call_recordings 테이블에 보관 → 어드민 '미매칭 통화녹음'
// 화면에서 운영자가 수동으로 회원에 연결한다.
//
// Vercel 환경변수: SUPABASE_URL(또는 VITE_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import Busboy from 'busboy'
import crypto from 'node:crypto'

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

// 호출자 인증 — 로그인 staff 의 Supabase access token 만 허용(다른 api/ 함수와 동일 패턴).
// 다른 파일과 달리 staff.id 까지 반환해 uploaded_by 기록에 쓴다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function authorize(req: any, admin: SupabaseClient): Promise<{ id: string } | null> {
  const token = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  try {
    const { data: ures } = await admin.auth.getUser(token)
    const uid = ures?.user?.id
    if (!uid) return null
    const { data: st } = await admin.from('staff').select('id, is_active').eq('auth_user_id', uid).maybeSingle()
    if (!st || (st as { is_active?: boolean }).is_active === false) return null
    return { id: (st as { id: string }).id }
  } catch {
    return null
  }
}

interface ParsedFile {
  buffer: Buffer
  filename: string
  mimeType: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMultipart(req: any): Promise<{ fields: Record<string, string>; file: ParsedFile | null }> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } })
    const fields: Record<string, string> = {}
    let file: ParsedFile | null = null
    bb.on('field', (name, val) => {
      fields[name] = val
    })
    bb.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = []
      stream.on('data', (d: Buffer) => chunks.push(d))
      stream.on('end', () => {
        file = { buffer: Buffer.concat(chunks), filename: info.filename || 'recording', mimeType: info.mimeType }
      })
    })
    bb.on('error', reject)
    bb.on('finish', () => resolve({ fields, file }))
    req.pipe(bb)
  })
}

// 010-1234-5678 / +82 10 1234 5678 등 → 국가코드 제거 + 숫자만.
function normalizeKr(raw: string): string {
  let d = raw.replace(/\D/g, '')
  if (d.startsWith('82') && d.length > 9) d = '0' + d.slice(2)
  return d
}

// members.phone 이 "그대로 저장"(대시 포함/미포함 혼재)이라, 두 형태 후보로 인덱스 매치.
function phoneCandidates(digits: string): string[] {
  const out = [digits]
  if (digits.length === 11) out.push(`${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`)
  else if (digits.length === 10) out.push(`${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`)
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'POST only' })

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return res.status(500).json({ ok: false, message: 'SUPABASE 서버 환경변수 미설정' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  const staff = await authorize(req, admin)
  if (!staff) return res.status(401).json({ ok: false, message: '인증 필요(로그인만 허용)' })

  try {
    const { fields, file } = await parseMultipart(req)
    if (!file) return res.status(400).json({ ok: false, message: 'file 누락' })
    // phone 은 비어 있어도 받는다(현장 8/4 "자동 업로드 안됨" 원인 수정) — 삼성 등은 상대가
    // 연락처에 저장돼 있으면 파일명이 이름("통화 녹음 홍길동_…")이라 앱이 번호를 못 뽑는데,
    // 예전엔 앱·서버가 그 파일을 통째로 버려 업로드가 0건이 됐다. 이제 번호 없는 녹음도
    // 업로드 자체는 받고 미매칭 보관함으로 보내 전산에서 수동 연결한다.
    const phoneRaw = String(fields.phone ?? '').trim()
    const recordedAt = fields.recorded_at ? String(fields.recorded_at) : new Date().toISOString()

    const normalized = normalizeKr(phoneRaw)
    const candidates = phoneCandidates(normalized)

    // Storage 업로드(call-recordings 버킷, 0010 마이그레이션에서 생성) — 자동업로드는 auto/ 하위에.
    const path = `auto/${staff.id}/${Date.now()}_${file.filename}`
    const { error: upErr } = await admin.storage
      .from('call-recordings')
      .upload(path, file.buffer, { contentType: file.mimeType || 'audio/mp4' })
    if (upErr) return res.status(500).json({ ok: false, message: `업로드 실패: ${upErr.message}` })

    // 번호가 아예 없으면 회원 매치를 시도하지 않는다 — 빈 문자열로 .in() 하면 전화번호가
    // 비어 있는 회원과 오매치될 수 있다.
    let rows: { id: string; meta: Record<string, unknown> | null }[] = []
    if (normalized) {
      const { data: matches, error: findErr } = await admin
        .from('members')
        .select('id, meta')
        .in('phone', candidates)
      if (findErr) return res.status(500).json({ ok: false, message: findErr.message })
      rows = (matches ?? []) as { id: string; meta: Record<string, unknown> | null }[]
    }

    if (rows.length === 1) {
      const m = rows[0]
      const meta = m.meta ?? {}
      const list = Array.isArray(meta.call_recordings) ? (meta.call_recordings as unknown[]) : []
      const entry = {
        id: genId('rec'),
        created_at: new Date().toISOString(),
        uploaded_by: staff.id,
        file_path: path,
        file_name: file.filename,
        source: 'auto',
      }
      const { error: updErr } = await admin
        .from('members')
        .update({ meta: { ...meta, call_recordings: [entry, ...list] } })
        .eq('id', m.id)
      if (updErr) return res.status(500).json({ ok: false, message: updErr.message })
      return res.status(200).json({ ok: true, matched: true, member_id: m.id })
    }

    // 0건 또는 2건 이상 — 미매칭 보관(어드민 '미매칭 통화녹음' 화면에서 수동 연결).
    const { error: insErr } = await admin.from('unmatched_call_recordings').insert({
      id: genId('umc'),
      raw_phone: phoneRaw,
      normalized_phone: normalized,
      recorded_at: recordedAt,
      file_path: path,
      file_name: file.filename,
      uploaded_by: staff.id,
    })
    if (insErr) return res.status(500).json({ ok: false, message: insErr.message })
    return res.status(200).json({ ok: true, matched: false })
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e) })
  }
}
