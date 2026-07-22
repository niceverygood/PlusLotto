-- 0017 — 장기 증가 대비 보조 인덱스·RLS 실행계획 보강
-- 0016의 서버 페이지/집계 경로가 15만 회원·누적 로그에서도 날짜/FK 인덱스를 사용할 수 있게 한다.

-- KST 일자 필터는 화면/집계 RPC의 실제 식과 동일한 expression index로 맞춘다.
create index if not exists members_registered_kst_day_idx
  on members (((registered_at at time zone 'Asia/Seoul')::date));
create index if not exists payments_paid_kst_day_idx
  on payments (status, ((paid_at at time zone 'Asia/Seoul')::date))
  where paid_at is not null;
create index if not exists payments_created_kst_day_idx
  on payments (((created_at at time zone 'Asia/Seoul')::date));
create index if not exists logs_action_created_kst_day_idx
  on logs (action, ((created_at at time zone 'Asia/Seoul')::date));

-- FK 부모 갱신/삭제와 운영 조인의 역방향 탐색을 보호한다.
create index if not exists assignments_staff_idx on assignments (staff_id);
create index if not exists assignments_assigned_by_idx on assignments (assigned_by);
create index if not exists events_author_idx on events (author_id);
create index if not exists inquiries_member_idx on inquiries (member_id);
create index if not exists inquiries_answered_by_idx on inquiries (answered_by);
create index if not exists logs_actor_idx on logs (actor);
create index if not exists notices_author_idx on notices (author_id);
create index if not exists payments_product_idx on payments (product_id);
create index if not exists staff_team_idx on staff (team_id);
create index if not exists teams_leader_idx on teams (leader_id);
create index if not exists bets_member_ref_idx on bets (member_ref);
create index if not exists unmatched_call_recordings_resolved_member_idx
  on unmatched_call_recordings (resolved_member_id);
create index if not exists unmatched_call_recordings_uploaded_by_idx
  on unmatched_call_recordings (uploaded_by);

-- auth.uid()를 init plan으로 한 번만 계산해 행 수에 비례한 반복 평가를 없앤다.
drop policy if exists unmatched_call_recordings_staff_all on unmatched_call_recordings;
create policy unmatched_call_recordings_staff_all on unmatched_call_recordings
for all to authenticated
using (
  exists (
    select 1 from staff
    where auth_user_id = (select auth.uid()) and is_active
  )
)
with check (
  exists (
    select 1 from staff
    where auth_user_id = (select auth.uid()) and is_active
  )
);

-- RLS 내부에서 필요한 helper지만 anon REST RPC로 직접 호출할 이유는 없다.
revoke execute on function app_can_see_member(text) from public, anon;
grant execute on function app_can_see_member(text) to authenticated;
