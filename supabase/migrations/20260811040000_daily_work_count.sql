-- 일일 근무인원수 (현장 피드백 8/7, 정의현 차장 — "해당일의 근무인원수(자체입력), 팀장매출,
-- 실장매출, 카드결제, 무통장결제 내용이 요약되어 보여질수 있도록 추가 페이지")
--
-- 근무인원은 결제·회원 데이터로 계산할 수 없는 값이라(출근 인원은 전산에 기록되지 않는다)
-- 운영자가 날짜별로 직접 입력하는 별도 테이블로 둔다. 나머지 지표(팀장/실장매출·카드·무통장)는
-- 기존 payments 에서 파생 집계하므로 저장하지 않는다 — 매출 수치를 두 곳에 두면 어긋난다.
create table if not exists public.daily_work_count (
  day         date primary key,
  head_count  integer not null default 0 check (head_count >= 0),
  updated_by  text references public.staff(id) on delete set null,
  updated_at  timestamptz not null default now()
);

alter table public.daily_work_count enable row level security;

-- 읽기: 매출 화면을 볼 수 있는 역할(실장 이상)과 동일하게 활성 운영자 전체 허용.
-- 쓰기: 최고관리자·관리자만 — 근무인원은 매출 요약의 분모라 아무나 바꾸면 지표가 흔들린다.
drop policy if exists daily_work_count_select on public.daily_work_count;
create policy daily_work_count_select on public.daily_work_count
for select to authenticated
using (exists (select 1 from public.staff where auth_user_id = auth.uid() and is_active));

drop policy if exists daily_work_count_write on public.daily_work_count;
create policy daily_work_count_write on public.daily_work_count
for all to authenticated
using (app_role() in ('admin', 'manager'))
with check (app_role() in ('admin', 'manager'));

comment on table public.daily_work_count is
  '날짜별 근무인원수(운영자 수기 입력). 매출 일일요약 화면에서 사용.';
