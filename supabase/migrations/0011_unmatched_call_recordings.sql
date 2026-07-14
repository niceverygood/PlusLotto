-- 0011 — 통화녹음 자동업로드 미매칭 보관함 (현장 7/3·7/6, 김형준 이사·정의현 차장)
-- 배경: Android 동반 앱이 전화번호로 회원 매칭을 시도하지만(0/2건 이상), 매칭 실패분을
--       버리지 않고 여기 보관했다가 어드민 '미매칭 통화녹음' 화면에서 운영자가 수동으로
--       회원에 연결한다. 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

create table if not exists unmatched_call_recordings (
  id                 text primary key,
  raw_phone          text not null,
  normalized_phone   text not null,
  recorded_at        timestamptz,
  file_path          text not null,
  file_name          text not null,
  uploaded_by        text references staff(id) on delete set null,
  created_at         timestamptz not null default now(),
  resolved_member_id text references members(id) on delete set null,
  resolved_at        timestamptz
);
create index if not exists unmatched_call_recordings_phone_idx on unmatched_call_recordings(normalized_phone);

alter table unmatched_call_recordings enable row level security;

-- 로그인한 활성 운영자 전체 조회/수정 가능(내부 운영툴 — 역할 세분화는 §5 권한관리 확정 시 조정).
-- service_role(서버리스 함수의 insert)은 RLS 를 우회하므로 이 정책은 웹 어드민 쪽 조회/해결에만 적용됨.
drop policy if exists unmatched_call_recordings_staff_all on unmatched_call_recordings;
create policy unmatched_call_recordings_staff_all on unmatched_call_recordings
for all
using (exists (select 1 from staff where auth_user_id = auth.uid() and is_active))
with check (exists (select 1 from staff where auth_user_id = auth.uid() and is_active));
