-- 통화녹음 자동업로드 앱(APK) 배포용 스토리지 (현장 피드백 8/3, 정의현 차장 — "어드민페이지에서
-- 다운받을 수 있게"). APK 를 파일로 전달하지 않고 전산에서 각자 내려받게 한다.
-- 비공개 버킷 + 서명 URL(call-recordings 와 동일 패턴) — 사내 앱이 공개 URL 로 크롤링되지 않게.
--   읽기(다운로드): 활성 staff 전원 (상담원이 본인 폰에 설치해야 하므로 rep 포함)
--   쓰기(새 버전 업로드/교체/삭제): 최고관리자만
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

insert into storage.buckets (id, name, public)
values ('app-downloads', 'app-downloads', false)
on conflict (id) do update set public = false;

drop policy if exists app_downloads_staff_read on storage.objects;
create policy app_downloads_staff_read on storage.objects
for select
using (
  bucket_id = 'app-downloads'
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active)
);

drop policy if exists app_downloads_admin_write on storage.objects;
create policy app_downloads_admin_write on storage.objects
for all
using (
  bucket_id = 'app-downloads'
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active and role = 'admin')
)
with check (
  bucket_id = 'app-downloads'
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active and role = 'admin')
);

-- 현재 배포본 메타(파일명·버전·크기·올린 사람) — 화면에 "언제 올린 무슨 버전"을 보여주기 위함.
-- 파일 자체는 스토리지에, 여기엔 경량 정보만(promo_slides 와 동일 원칙).
alter table site_settings
  add column if not exists app_download jsonb not null default '{}'::jsonb;
