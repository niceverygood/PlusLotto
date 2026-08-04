-- 통화녹음 관련 내용 = 관리자 이상만 (현장 피드백 8/4, 정의현 차장 —
-- "통화녹음 관련 내용은 관리자 이상급 아이디만 볼수 있도록").
-- 라벨 기준(2026-06 명칭변경): admin=최고관리자, manager=관리자 → '관리자 이상' = admin·manager.
--
-- UI 는 이미 가드(회원상세 통화녹음 탭·미매칭 통화녹음 화면·설정 앱 카드)하지만, 기존 정책은
-- '활성 운영자 전체' 허용이라 실장·팀장이 API 직접 호출로 녹음을 조회할 수 있었다 → RLS 로 이중 통제(§5).
-- Android 자동업로드 앱은 api/ingest-call-recording.ts(service_role, RLS 우회) 경유라 영향 없음.
-- 웹의 수동 업로드·재생·삭제·전사는 모두 admin/manager 만 접근하는 화면에서만 일어난다.

-- ── storage: call-recordings 버킷 — admin·manager 만 ─────────────────────────
drop policy if exists call_recordings_staff_all on storage.objects;
create policy call_recordings_staff_all on storage.objects
for all
using (
  bucket_id = 'call-recordings'
  and app_role() in ('admin', 'manager')
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active)
)
with check (
  bucket_id = 'call-recordings'
  and app_role() in ('admin', 'manager')
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active)
);

-- ── 미매칭 보관함 — admin·manager 만 (insert 는 service_role 이 RLS 우회) ─────
drop policy if exists unmatched_call_recordings_staff_all on unmatched_call_recordings;
create policy unmatched_call_recordings_staff_all on unmatched_call_recordings
for all
using (
  app_role() in ('admin', 'manager')
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active)
)
with check (
  app_role() in ('admin', 'manager')
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active)
);
