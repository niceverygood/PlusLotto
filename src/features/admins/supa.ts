// 관리자(운영자 계정·권한 매트릭스) — supabase 쓰기 경로 (M7). mock 의 mutateDb + adminLog 미러링.
// staff 는 소규모(운영자) 테이블이라 중복 login_id 검사는 전체 조회 후 JS 비교로 mock 과 동일하게 처리.
// nav_access 는 행(nav_key→roles)으로 영속 → 맵을 upsert 한다(remote.fetchNavAccess 와 대칭).
// TODO(live-verify): 라이브 운영자 생성은 Supabase auth.users 연결(auth_user_id)이 별도로 필요.
import type { Role, Staff } from '@/types/db'
import { genId, nowIso } from '@/lib/db/store'
import { fetchSiteSettings, insertLog, sb } from '@/lib/db/remote'
import type { NavAccessMap } from '@/lib/permissions'
import { CALL_VOLUME_ALERT_DEFAULT, tallyCallVolume, type CallVolumeStatus } from '@/lib/callVolume'
import type { MemberLite, StaffInput, UnmatchedRecording } from './api'

/** 이번 달 발신 통화량(상담상태 변경 건수 근사) + 경고 임계치(현장 피드백 7/3). */
export async function fetchCallVolumeStatus(): Promise<CallVolumeStatus> {
  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  const [{ data, error }, settings] = await Promise.all([
    sb().from('logs').select('action, created_at, meta').eq('action', 'member.update').gte('created_at', start.toISOString()),
    fetchSiteSettings(),
  ])
  if (error) throw error
  const count = tallyCallVolume(
    (data ?? []) as { action: string; created_at: string; meta?: Record<string, unknown> }[],
  )
  const threshold = settings.call_volume_alert_threshold ?? CALL_VOLUME_ALERT_DEFAULT
  return { count, threshold, over: count > threshold }
}

// 운영자 Auth 비밀번호 설정/생성 — 서버 함수(/api/staff-set-password, service_role) 호출.
// login_id 기준으로 Auth 유저를 보장(없으면 생성·있으면 비번변경)하고 staff.auth_user_id 링크.
// 최고관리자만 호출 가능(서버에서 access token 으로 재검증). 현장 피드백 6/23.
export async function setStaffPassword(login_id: string, password: string): Promise<void> {
  const { data } = await sb().auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.')
  const r = await fetch('/api/staff-set-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ login_id, password }),
  })
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string }
  if (!r.ok || !j.ok) throw new Error(j.message || `비밀번호 설정 실패 (${r.status})`)
}

/** 운영자 계정 생성/수정. login_id 중복은 거부(throw). 반환=staff id. */
export async function saveStaff(
  v: { id?: string; input: StaffInput },
  actor: string | null,
): Promise<string> {
  const login = v.input.login_id.trim()
  const { data: all, error: le } = await sb().from('staff').select('id, login_id')
  if (le) throw le
  const dup = ((all ?? []) as { id: string; login_id: string }[]).find(
    (s) => s.login_id.toLowerCase() === login.toLowerCase() && s.id !== v.id,
  )
  if (dup) throw new Error('이미 사용 중인 로그인 ID 입니다.')

  const name = v.input.name.trim()
  // admin 은 팀 소속 없음(전체 관리).
  const team_id = v.input.role === 'admin' ? null : v.input.team_id
  if (v.id) {
    const { error } = await sb()
      .from('staff')
      .update({ name, login_id: login, role: v.input.role, team_id, is_active: v.input.is_active, auto_assign_enabled: v.input.auto_assign_enabled })
      .eq('id', v.id)
    if (error) throw error
    await insertLog({
      kind: 'admin',
      actor,
      action: 'staff.update',
      target_type: 'staff',
      target_id: v.id,
      meta: { name, role: v.input.role },
    })
    return v.id
  }
  const id = genId('staff')
  const row: Staff = {
    id,
    login_id: login,
    name,
    role: v.input.role,
    team_id,
    is_active: v.input.is_active,
    auto_assign_enabled: v.input.auto_assign_enabled,
    last_login_at: null,
  }
  const { error } = await sb().from('staff').insert(row)
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'staff.create',
    target_type: 'staff',
    target_id: id,
    meta: { name, role: v.input.role, login_id: login },
  })
  return id
}

/** 계정 활성/비활성 토글. */
export async function toggleStaffActive(
  id: string,
  active: boolean,
  actor: string | null,
): Promise<string> {
  const { data } = await sb().from('staff').select('name').eq('id', id).maybeSingle()
  const name = (data as { name: string } | null)?.name ?? ''
  const { error } = await sb().from('staff').update({ is_active: active }).eq('id', id)
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: active ? 'staff.activate' : 'staff.deactivate',
    target_type: 'staff',
    target_id: id,
    meta: { name },
  })
  return id
}

/** 권한 매트릭스 저장 → 사이드바/가드 즉시 반영(§8). 맵의 각 nav_key 행을 upsert. */
export async function saveNavAccess(map: NavAccessMap, actor: string | null): Promise<void> {
  const rows = Object.entries(map).map(([nav_key, roles]) => ({ nav_key, roles: [...roles] as Role[] }))
  const { error } = await sb().from('nav_access').upsert(rows, { onConflict: 'nav_key' })
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'roles.update',
    target_type: 'nav_access',
    target_id: null,
    meta: { modules: rows.length },
  })
}

// ── 통화녹음 자동업로드 미매칭 보관함(현장 피드백 7/3·7/6) ──────────────────────────
/** 아직 회원에 연결 안 된 미매칭 녹음 목록(최신순). */
export async function fetchUnmatchedRecordings(): Promise<UnmatchedRecording[]> {
  const { data, error } = await sb()
    .from('unmatched_call_recordings')
    .select('id, raw_phone, normalized_phone, recorded_at, file_path, file_name, uploaded_by, created_at')
    .is('resolved_member_id', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as UnmatchedRecording[]
}

/** 재생용 서명 URL(비공개 버킷, 1시간 유효). */
export async function signUnmatchedRecordingUrl(filePath: string): Promise<string> {
  const { data, error } = await sb().storage.from('call-recordings').createSignedUrl(filePath, 3600)
  if (error) throw error
  return data.signedUrl
}

/** 이름/전화/로그인ID 검색(최대 8건) — '회원에게 연결' 드롭다운용. */
export async function searchMembersLite(q: string): Promise<MemberLite[]> {
  const { data, error } = await sb()
    .from('members')
    .select('id, name, phone, user_id')
    .or(`name.ilike.%${q}%,phone.ilike.%${q}%,user_id.ilike.%${q}%`)
    .limit(8)
  if (error) throw error
  return (data ?? []) as MemberLite[]
}

/** 미매칭 녹음을 회원에 연결 — 그 회원 meta.call_recordings 에 append + 미매칭 행을 resolved 처리. */
export async function resolveUnmatchedRecording(
  rec: UnmatchedRecording,
  memberId: string,
  actor: string | null,
): Promise<void> {
  const { data: cur } = await sb().from('members').select('meta').eq('id', memberId).maybeSingle()
  const meta = ((cur as { meta: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>
  const list = Array.isArray(meta.call_recordings) ? (meta.call_recordings as unknown[]) : []
  const entry = {
    id: rec.id,
    created_at: rec.recorded_at ?? rec.created_at,
    uploaded_by: rec.uploaded_by,
    file_path: rec.file_path,
    file_name: rec.file_name,
    source: 'auto',
  }
  const { error: updErr } = await sb()
    .from('members')
    .update({ meta: { ...meta, call_recordings: [entry, ...list] } })
    .eq('id', memberId)
  if (updErr) throw updErr
  const { error: resErr } = await sb()
    .from('unmatched_call_recordings')
    .update({ resolved_member_id: memberId, resolved_at: nowIso() })
    .eq('id', rec.id)
  if (resErr) throw resErr
  await insertLog({
    kind: 'admin',
    actor,
    action: 'call_recording.resolve',
    target_type: 'member',
    target_id: memberId,
    meta: { unmatched_id: rec.id },
  })
}
