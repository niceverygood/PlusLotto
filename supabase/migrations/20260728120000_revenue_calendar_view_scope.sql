-- 매출 캘린더도 전체매출/팀장매출/실장매출 3뷰로 분리(현장 피드백 7/28, 정의현 차장).
-- admin_revenue(p_view)와 동일한 is_conversion(1차결제=신규전환) 판정을 재사용해
-- admin_revenue_calendar·admin_revenue_day_payments에 p_view 파라미터를 추가한다.
-- 시그니처가 바뀌므로(인자 개수 증가) 기존 1-인자 함수는 명시적으로 drop 후 재생성한다.
drop function if exists admin_revenue_calendar(date);
drop function if exists admin_revenue_day_payments(date);

create or replace function admin_revenue_calendar(p_month date, p_view text default 'real')
returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role
), scoped_members as materialized (
  select m.id
  from members m, ctx c
  where c.role in ('admin','manager','leader')
), month_bounds as (
  select date_trunc('month', p_month)::date as start_day,
         (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date as end_day
), approved_all as materialized (
  -- 전월 이월 결제까지 포함해 first_paid(최초 결제) 판정이 월 경계에서도 정확하도록 회원 전체 승인결제를 본다.
  select p.id, p.member_id, p.amount, p.staff_id, p.product_id,
    coalesce(p.paid_at, p.created_at) as recognized_at
  from payments p
  join scoped_members m on m.id = p.member_id
  where p.status::text = 'approved'
), first_paid as (
  select distinct on (member_id) id
  from approved_all
  where product_id is not null
  order by member_id, recognized_at, id
), approved as materialized (
  select a.id, a.amount, a.staff_id,
    (a.recognized_at at time zone 'Asia/Seoul')::date as day
  from approved_all a
  left join first_paid f on f.id = a.id
  cross join month_bounds b
  where (a.recognized_at at time zone 'Asia/Seoul')::date between b.start_day and b.end_day
    -- 실장매출(team)=1차결제 제외 전체, 팀장매출(conversion)=1차결제만, 전체매출(real)=전부.
    and case p_view
          when 'conversion' then (f.id is not null)
          when 'team' then (f.id is null)
          else true
        end
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

create or replace function admin_revenue_day_payments(p_day date, p_view text default 'real')
returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role
), scoped_members as materialized (
  select m.id, m.user_id
  from members m, ctx c
  where c.role in ('admin','manager','leader')
), approved_all as materialized (
  select p.id, p.member_id, p.amount, p.staff_id, p.product_id, p.depositor_name, p.method,
    coalesce(p.paid_at, p.created_at) as recognized_at
  from payments p
  join scoped_members m on m.id = p.member_id
  where p.status::text = 'approved'
), first_paid as (
  select distinct on (member_id) id
  from approved_all
  where product_id is not null
  order by member_id, recognized_at, id
)
select coalesce(jsonb_agg(jsonb_build_object(
  'id', a.id,
  'depositorName', a.depositor_name,
  'memberUserId', m.user_id,
  'staffName', s.name,
  'method', a.method,
  'productName', pr.name,
  'amount', a.amount
) order by a.amount desc), '[]'::jsonb)
from approved_all a
join scoped_members m on m.id = a.member_id
left join first_paid f on f.id = a.id
left join staff s on s.id = a.staff_id
left join products pr on pr.id = a.product_id
where (a.recognized_at at time zone 'Asia/Seoul')::date = p_day
  and case p_view
        when 'conversion' then (f.id is not null)
        when 'team' then (f.id is null)
        else true
      end;
$$;

revoke execute on function admin_revenue_calendar(date, text) from public, anon;
grant execute on function admin_revenue_calendar(date, text) to authenticated;
revoke execute on function admin_revenue_day_payments(date, text) from public, anon;
grant execute on function admin_revenue_day_payments(date, text) to authenticated;
