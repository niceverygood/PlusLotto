-- 매출 "팀장매출/실장매출" 뷰 정의를 담당자 역할(role) 기준으로 재정의 (현장 피드백 7/29, 정의현 차장)
-- 증상: "팀장매출부분에 관리자 매출이 포함되는 현상이 나옵니다" / "실장매출 부분에는 '팀' 전체의
--       매출이 나오고 있습니다. 실장급 이상 매출만 나올 수 있도록 수정 부탁드립니다."
-- 원인: 7/23(20260723170900_revenue_view_rename_scope.sql)에서 "팀장매출"/"실장매출"이라는 화면
--       라벨을 도입하면서, 실제 필터 조건은 담당자 역할이 아니라 "1차결제(신규전환) 여부"로
--       구현됐다 — 팀장매출(conversion)=이 결제가 신규전환이면 담당자 역할 불문 전부 포함,
--       실장매출(team)=신규전환이 아니면(=갱신결제) 담당자 역할 불문 전부 포함. 그 결과 관리자·
--       최고관리자가 처리한 신규전환 결제도 "팀장매출"에 섞이고, 팀장(rep)이 처리한 갱신결제도
--       "실장매출"(팀 전체)에 그대로 섞여 나왔다.
-- 조치: 두 뷰를 담당자(payments.staff_id → staff.role) 기준으로 다시 정의한다.
--   팀장매출(conversion) = 담당자 역할이 정확히 '팀장'(rep)인 결제만.
--   실장매출(team)       = 담당자 역할이 '실장'(leader) 이상(leader/manager/admin)인 결제만.
--   전체매출(real)       = 그대로 전부(변경 없음).
--   담당자 미배정(staff_id is null) 결제는 두 뷰 어디에도 속하지 않고 전체매출에만 잡힌다.
-- "신규전환율" KPI(전환건수/전환매출/전환율)는 이 뷰 필터와 무관한 별개 지표라 손대지 않는다
-- (여전히 1차결제 여부 기준 — RevenuePage.tsx "신규전환율" 카드는 탭 선택과 무관하게 항상 노출).
-- 캘린더(admin_revenue_calendar)·일자별 결제내역(admin_revenue_day_payments)도 동일 뷰 개념을
-- 공유하므로 함께 수정한다. 세 함수 모두 시그니처는 그대로라 CREATE OR REPLACE 만으로 충분하다.
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

create or replace function admin_revenue(
  p_view text,
  p_from date,
  p_to date,
  p_group text default 'staff'
) returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id
), scoped_members as materialized (
  select m.id, m.team_id
  from members m, ctx c
  where c.role in ('admin','manager','leader')
), approved as materialized (
  select p.*, m.team_id,
    coalesce(p.paid_at, p.created_at) as recognized_at
  from payments p
  join scoped_members m on m.id = p.member_id
  where p.status::text = 'approved'
), first_paid as (
  select distinct on (member_id) id
  from approved
  where product_id is not null
  order by member_id, recognized_at, id
), period as materialized (
  select a.*,
    (f.id is not null) as is_conversion,
    case when p_view = 'team' then 'team'
         when p_view = 'conversion' then 'staff'
         else p_group end as group_dim
  from approved a
  left join first_paid f on f.id = a.id
  where (a.recognized_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), active as materialized (
  select p.*,
    case p.group_dim
      when 'team' then coalesce(p.team_id, 'none')
      when 'product' then coalesce(p.product_id, 'none')
      when 'pg' then case when p.method::text = 'pg' then 'pg:' || coalesce(p.pg_provider, 'PG(미지정)') else 'm:' || p.method::text end
      else coalesce(p.staff_id, 'none')
    end as group_key,
    case p.group_dim
      when 'team' then coalesce(t.name, '미배정')
      when 'product' then coalesce(pr.name, '기타')
      when 'pg' then case when p.method::text = 'pg' then coalesce(p.pg_provider, 'PG(미지정)')
                          when p.method::text = 'bank' then '무통장' else '수기' end
      else coalesce(s.name, '미배정')
    end as group_label
  from period p
  left join staff s on s.id = p.staff_id
  left join teams t on t.id = p.team_id
  left join products pr on pr.id = p.product_id
  -- 팀장매출(conversion) = 담당자 역할이 정확히 팀장(rep). 실장매출(team) = 실장 이상(leader/manager/admin).
  -- 담당자 미배정은 둘 다 제외(전체매출에만 포함). 전체매출(real) = 그대로 전부.
  where case p_view
          when 'conversion' then s.role::text = 'rep'
          when 'team' then s.role::text is not null and s.role::text <> 'rep'
          else true
        end
), day_series as (
  select d::date as day
  from generate_series(
    greatest(least(p_from, p_to), greatest(p_from, p_to) - 369),
    greatest(p_from, p_to),
    interval '1 day'
  ) d
), day_totals as (
  select (recognized_at at time zone 'Asia/Seoul')::date as day,
    sum(amount)::bigint as amount, count(*)::bigint as count
  from active group by 1
), grouped as (
  select group_key as key, group_label as label,
    sum(amount)::bigint as amount, count(*)::bigint as count
  from active group by group_key, group_label
), totals as (
  select coalesce(sum(amount), 0)::bigint as total, count(*)::bigint as count from active
), period_totals as (
  select count(*)::bigint as count,
    count(*) filter (where is_conversion)::bigint as conversions,
    coalesce(sum(amount) filter (where is_conversion), 0)::bigint as conversion_revenue
  from period
)
select jsonb_build_object(
  'summary', jsonb_build_object(
    'total', t.total,
    'count', t.count,
    'avg', case when t.count > 0 then round(t.total::numeric / t.count)::bigint else 0 end,
    'conversions', pt.conversions,
    'conversionRevenue', pt.conversion_revenue,
    'conversionRate', case when pt.count > 0 then pt.conversions::numeric / pt.count else 0 end
  ),
  'trend', coalesce((
    select jsonb_agg(jsonb_build_object(
      'date', ds.day::text,
      'label', to_char(ds.day, 'MM-DD'),
      'amount', coalesce(dt.amount, 0),
      'count', coalesce(dt.count, 0)
    ) order by ds.day)
    from day_series ds left join day_totals dt on dt.day = ds.day
  ), '[]'::jsonb),
  'breakdown', coalesce((
    select jsonb_agg(jsonb_build_object(
      'key', g.key,
      'label', g.label,
      'amount', g.amount,
      'count', g.count,
      'share', case when t.total > 0 then g.amount::numeric / t.total else 0 end
    ) order by g.amount desc)
    from grouped g
  ), '[]'::jsonb),
  'groupDim', case when p_view = 'team' then 'team' when p_view = 'conversion' then 'staff' else p_group end
)
from totals t cross join period_totals pt;
$$;

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
  select p.id, p.member_id, p.amount, p.staff_id,
    coalesce(p.paid_at, p.created_at) as recognized_at
  from payments p
  join scoped_members m on m.id = p.member_id
  where p.status::text = 'approved'
), approved as materialized (
  select a.id, a.amount, a.staff_id,
    (a.recognized_at at time zone 'Asia/Seoul')::date as day
  from approved_all a
  left join staff s on s.id = a.staff_id
  cross join month_bounds b
  where (a.recognized_at at time zone 'Asia/Seoul')::date between b.start_day and b.end_day
    -- 팀장매출(conversion)=담당자 역할이 팀장(rep). 실장매출(team)=실장 이상(leader/manager/admin).
    and case p_view
          when 'conversion' then s.role::text = 'rep'
          when 'team' then s.role::text is not null and s.role::text <> 'rep'
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
left join staff s on s.id = a.staff_id
left join products pr on pr.id = a.product_id
where (a.recognized_at at time zone 'Asia/Seoul')::date = p_day
  -- 팀장매출(conversion)=담당자 역할이 팀장(rep). 실장매출(team)=실장 이상(leader/manager/admin).
  and case p_view
        when 'conversion' then s.role::text = 'rep'
        when 'team' then s.role::text is not null and s.role::text <> 'rep'
        else true
      end;
$$;

revoke execute on function admin_revenue(text, date, date, text) from public, anon;
grant execute on function admin_revenue(text, date, date, text) to authenticated;
revoke execute on function admin_revenue_calendar(date, text) from public, anon;
grant execute on function admin_revenue_calendar(date, text) to authenticated;
revoke execute on function admin_revenue_day_payments(date, text) from public, anon;
grant execute on function admin_revenue_day_payments(date, text) to authenticated;
