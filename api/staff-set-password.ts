// Vercel 함수 — 운영자(staff) Auth 계정 프로비저닝/비밀번호 설정 (현장 피드백 6/23 / DECISIONS D67).
// 문제: 앱의 운영자 생성/이름변경은 staff 행만 만들고 Supabase Auth 계정(로그인 주체)을 만들지/갱신하지 않아
//       신규·이름변경 계정이 로그인 불가였다(M8 수동생성 5명만 가능).
// 이 엔드포인트가 service_role 로 login_id 기준 Auth 유저를 '보장'(없으면 생성·있으면 비번변경)하고
// staff.auth_user_id 를 그 유저로 링크한다(스테일 링크 덮어쓰기). → 신규 로그인 + 최고관리자 비번변경 동시 해결.
// 보안: 호출자가 admin(최고관리자) 인지 access token 으로 검증한 뒤에만 동작.
import { createClient } from '@supabase/supabase-js'

const DOMAIN = '@pluslotto.local' // 내부 인증 도메인(사용자 비노출 — 변경 시 기존 로그인 깨짐, 유지)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'METHOD' })
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ ok: false, code: 'CONFIG' })
  const admin = createClient(url, key, { auth: { persistSession: false } })

  try {
    // 1) 호출자 = 최고관리자(admin) 검증
    const token = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ ok: false, code: 'NO_TOKEN' })
    const { data: ures } = await admin.auth.getUser(token)
    const callerUid = ures?.user?.id
    if (!callerUid) return res.status(401).json({ ok: false, code: 'BAD_TOKEN' })
    const { data: caller } = await admin
      .from('staff')
      .select('role')
      .eq('auth_user_id', callerUid)
      .maybeSingle()
    if ((caller as { role?: string } | null)?.role !== 'admin') {
      return res.status(403).json({ ok: false, code: 'NOT_ADMIN', message: '최고관리자만 가능합니다.' })
    }

    // 2) 입력
    const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {}
    const login_id = String(body.login_id ?? '').trim()
    const password = String(body.password ?? '')
    if (!login_id || password.length < 6) {
      return res.status(400).json({ ok: false, code: 'INPUT', message: '아이디·비밀번호(6자 이상) 필요' })
    }
    const email = `${login_id}${DOMAIN}`

    // 3) staff 존재 확인
    const { data: staff } = await admin
      .from('staff')
      .select('id, auth_user_id')
      .eq('login_id', login_id)
      .maybeSingle()
    if (!staff) return res.status(404).json({ ok: false, code: 'NO_STAFF', message: '해당 아이디의 운영자가 없습니다.' })

    // 4) login_id 이메일 기준 Auth 유저 탐색(페이지네이션)
    let found: string | null = null
    for (let page = 1; page <= 20; page++) {
      const { data: list } = await admin.auth.admin.listUsers({ page, perPage: 200 })
      const us = list?.users ?? []
      const hit = us.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase())
      if (hit) {
        found = hit.id
        break
      }
      if (us.length < 200) break
    }

    // 5) 보장: 있으면 비번변경, 없으면 생성
    let uid: string
    if (found) {
      const { error } = await admin.auth.admin.updateUserById(found, { password, email_confirm: true })
      if (error) return res.status(500).json({ ok: false, code: 'UPDATE', message: error.message })
      uid = found
    } else {
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (error || !created?.user) {
        return res.status(500).json({ ok: false, code: 'CREATE', message: error?.message ?? '생성 실패' })
      }
      uid = created.user.id
    }

    // 6) staff 링크(현 login_id 의 Auth 로 갱신 — 스테일 링크 교정)
    const sid = (staff as { id: string }).id
    await admin.from('staff').update({ auth_user_id: uid }).eq('id', sid)

    return res.status(200).json({ ok: true, login_id, created: !found })
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'ERROR', message: e instanceof Error ? e.message : String(e) })
  }
}
