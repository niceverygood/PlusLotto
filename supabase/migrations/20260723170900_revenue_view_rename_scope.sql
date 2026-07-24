-- 매출 뷰 명칭 변경 + '실장매출'(구 팀장매출) 정의 변경 (현장 피드백 7/23, 정의현 차장).
--   실매출 > 전체매출 (명칭만)
--   전환매출 > 팀장매출 (명칭만 — 신규전환 결제, 담당자별)
--   팀장매출 > 실장매출 (명칭 + 정의 변경: 1차결제(=신규전환)를 제외한 모든 매출, 팀별)
-- 라벨은 프론트(RevenuePage.tsx)에서만 바뀌므로 이 마이그레이션은 p_view='team' 뷰의 집계 범위만 바꾼다.
-- 함수 시그니처(p_view 값 'real'|'conversion'|'team')는 그대로 유지 — 화면 라벨과 내부 view 키는 분리된 개념.
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
  -- 실장매출(team) = 1차결제(신규전환) 제외한 모든 매출. 팀장매출(conversion) = 1차결제만. 전체매출(real) = 전부.
  where case p_view
          when 'conversion' then p.is_conversion
          when 'team' then not p.is_conversion
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

revoke execute on function admin_revenue(text, date, date, text) from public, anon;
grant execute on function admin_revenue(text, date, date, text) to authenticated;
