-- 0010 — 통화 녹음 업로드 + 키워드 탐지 + 통화량 경고 (현장 7/3, 김형준 이사)
-- 배경: ① 법인폰 통화 녹음을 전산에 저장하고 싶다는 요청 — PBX/통신사 API 연동 정보가 없어
--       1단계는 상담원이 통화 후 녹음파일을 회원 상세에서 직접 업로드하는 방식으로 시작한다.
--       ② 녹취 텍스트 변환 후 특정 단어('보장' 등) 자동탐지 — 단어 목록은 site_settings 에서 편집.
--       ③ 월 발신 통화량(=상담상태 변경 건수로 집계) 임계치 초과 시 경고 — 임계치도 설정 가능.
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

-- ① Storage 버킷 — 녹음 파일(비공개). members.meta.call_recordings[] 에 경로·전사본 메타 적재.
insert into storage.buckets (id, name, public)
values ('call-recordings', 'call-recordings', false)
on conflict (id) do nothing;

-- 로그인한 활성 운영자만 업로드·조회·삭제 가능(내부 운영툴 — 역할 세분화는 §5 권한관리 확정 시 조정).
drop policy if exists call_recordings_staff_all on storage.objects;
create policy call_recordings_staff_all on storage.objects
for all
using (
  bucket_id = 'call-recordings'
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active)
)
with check (
  bucket_id = 'call-recordings'
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active)
);

-- ② 키워드 탐지 단어 목록 + ③ 통화량 경고 임계치 — site_settings 컬럼 추가.
alter table site_settings
  add column if not exists call_keywords jsonb not null default '["보장"]'::jsonb;
alter table site_settings
  add column if not exists call_volume_alert_threshold integer not null default 1000;
