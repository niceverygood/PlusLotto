-- 매출 > 실장매출 하단 분해표를 팀 단위 → 담당자(개인) 단위로 변경 (현장 피드백 8/3, 정의현 차장)
-- 요청: "매출>실장 매출 하단에 팀장매출처럼 실장급 이상 이름과 액수 나오게 설정 부탁드립니다."
-- 원인: 20260729090000(실장매출 역할 스코프 수정)에서 필터 조건(담당자 역할=실장 이상)은 맞게
--       고쳤지만, 분해표 그룹 기준(group_dim)이 'team'으로 남아있어 개인이 아니라 팀 단위로
--       뭉쳐 나왔다 — 팀장매출(conversion)은 이미 'staff'로 개인별 이름·금액이 나오고 있었다.
-- 조치: p_view='team' 일 때도 group_dim/groupDim 을 'staff'로 통일한다. 시그니처는 그대로라
--       CREATE OR REPLACE 만으로 충분하다. 캘린더(admin_revenue_calendar)·일자별 결제내역
--       (admin_revenue_day_payments)은 애초에 항상 담당자별로 집계해 영향 없음(수정 불필요).

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
    case when p_view = 'team' then 'staff'
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
  'groupDim', case when p_view = 'team' then 'staff' when p_view = 'conversion' then 'staff' else p_group end
)
from totals t cross join period_totals pt;
$$;
