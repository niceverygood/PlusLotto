-- 매출 캘린더(현장 피드백 7/24, 정의현 차장) — 기존 전산의 월별 달력 매출 화면과 동일 구성.
-- 일자별 합계 + 담당자별(건수·금액) 내역을 admin_revenue 와 동일한 승인결제·역할 스코프로 집계한다.
create or replace function admin_revenue_calendar(p_month date)
returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id
), scoped_members as materialized (
  select m.id
  from members m, ctx c
  where c.role in ('admin','manager','leader')
), month_bounds as (
  select date_trunc('month', p_month)::date as start_day,
         (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date as end_day
), approved as materialized (
  select p.amount, p.staff_id,
    (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date as day
  from payments p
  join scoped_members m on m.id = p.member_id
  cross join month_bounds b
  where p.status::text = 'approved'
    and (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date between b.start_day and b.end_day
), by_day_staff as (
  select day, coalesce(staff_id, 'none') as staff_key, staff_id,
    sum(amount)::bigint as amount, count(*)::bigint as count
  from approved
  group by day, coalesce(staff_id, 'none'), staff_id
), day_rows as (
  select day,
    sum(amount)::bigint as total,
    sum(count)::bigint as count,
    jsonb_agg(
      jsonb_build_object(
        'staffId', case when staff_key = 'none' then null else staff_id end,
        'label', coalesce(s.name, '미배정'),
        'count', by_day_staff.count,
        'amount', by_day_staff.amount
      ) order by by_day_staff.amount desc
    ) as by_staff
  from by_day_staff
  left join staff s on s.id = by_day_staff.staff_id
  group by day
)
select jsonb_build_object(
  'month', to_char(p_month, 'YYYY-MM'),
  'monthTotal', coalesce((select sum(total) from day_rows), 0),
  'monthCount', coalesce((select sum(count) from day_rows), 0),
  'days', coalesce((
    select jsonb_agg(jsonb_build_object('date', day::text, 'total', total, 'count', count, 'byStaff', by_staff) order by day)
    from day_rows
  ), '[]'::jsonb)
);
$$;

revoke execute on function admin_revenue_calendar(date) from public, anon;
grant execute on function admin_revenue_calendar(date) to authenticated;
