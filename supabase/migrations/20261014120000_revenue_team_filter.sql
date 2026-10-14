-- 매출 센터(팀) 필터 (현장 10/14, 정의현 차장 — "팀구분을 대전센터·전주센터·원주센터로 … 매출메뉴>팀장매출에서
-- 팀별 매출을 필터링").
--
-- admin_revenue 에 p_team_id(선택)를 더한다. 지정하면 결제 담당자(payments.staff_id)의 현재 센터가 그 센터인
-- 승인 결제만 집계한다(매출 귀속 규칙 = 결제 담당자, revenueRules.ts). 미지정이면 기존과 같은 결과다.
-- 원본: 20260916030000_legacy_unknown_payment_labels.sql 의 정의를 그대로 옮기고 위 두 줄만 더했다.
-- 인자 개수가 바뀌므로 기존 5인자 함수를 지우고 만든다(남겨 두면 PostgREST 오버로드 모호성).
DROP FUNCTION IF EXISTS public.admin_revenue(text, date, date, text, text);

CREATE OR REPLACE FUNCTION public.admin_revenue(p_view text, p_from date, p_to date, p_group text DEFAULT 'staff'::text, p_source_site text DEFAULT NULL::text, p_team_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role public.role := public.app_role();
  v_result jsonb;
  v_source_site text := public.admin_validate_source_site(p_source_site);
begin
  if v_uid is null
     or v_role is null
     or v_role::text not in ('admin', 'manager', 'leader') then
    raise exception using
      errcode = '42501',
      message = 'insufficient privilege for revenue reports';
  end if;

  with bounds as materialized (
    select least(p_from, p_to) as start_day,
           greatest(p_from, p_to) as end_day
  ), first_paid as materialized (
    select distinct on (p.member_id) p.member_id, p.id
    from public.payments p
    where p.status = 'approved'::public.payment_status
      and p.product_id is not null
    order by p.member_id, coalesce(p.paid_at, p.created_at), p.id
  ), period as materialized (
    select
      p.id,
      p.member_id,
      p.product_id,
      p.meta,
      p.amount,
      p.method,
      p.pg_provider,
      p.staff_id,
      m.team_id,
      coalesce(p.paid_at, p.created_at) as recognized_at,
      (f.id is not null) as is_conversion,
      case
        when p_view = 'team' then 'staff'
        when p_view = 'conversion' then 'staff'
        else p_group
      end as group_dim
    from public.payments p
    join public.members m on m.id = p.member_id
    left join first_paid f on f.member_id = p.member_id and f.id = p.id
    left join public.staff ps on ps.id = p.staff_id
    cross join bounds b
    where p.status = 'approved'::public.payment_status
      -- 센터(팀) 필터(10/14): 결제 담당자의 현재 센터. 지정 시 요약·추이·내역·신규전환율 모두 그 센터 결제만.
      and (p_team_id IS NULL OR ps.team_id = p_team_id)
      and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
      and ((coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date
           between b.start_day and b.end_day)
  ), active as materialized (
    select p.*,
      case p.group_dim
        when 'team' then coalesce(p.team_id, 'none')
        when 'product' then coalesce(p.product_id, case when p.meta->>'source_site' in ('lotto815','cplotto','infolotto') then p.meta->>'source_site' || ':legacy:' || nullif(p.meta->>'legacy_item_code', '') end, 'none')
        when 'pg' then case
          when p.method::text = 'pg' then 'pg:' || coalesce(p.pg_provider, 'PG(미지정)')
          else 'm:' || p.method::text
        end
        else coalesce(p.staff_id, 'none')
      end as group_key,
      case p.group_dim
        when 'team' then coalesce(t.name, '미배정')
        when 'product' then coalesce(pr.name, case when p.meta->>'source_site' in ('lotto815','cplotto','infolotto') then nullif(btrim(p.meta->>'legacy_item_name'), '') || ' (이전상품)' end, '기타')
        when 'pg' then case
          when p.method::text = 'pg' then coalesce(p.pg_provider, 'PG(미지정)')
          when p.method::text = 'unknown' then '이전자료 미기재'
             when p.method::text = 'bank' then '무통장'
          else '수기'
        end
        else coalesce(s.name, '미배정')
      end as group_label
    from period p
    left join public.staff s on s.id = p.staff_id
    left join public.teams t on t.id = p.team_id
    left join public.products pr on pr.id = p.product_id
    where case p_view
      when 'conversion' then s.role::text = 'rep'
      when 'team' then s.role::text is not null and s.role::text <> 'rep'
      else true
    end
  ), day_series as (
    select d::date as day
    from bounds b
    cross join lateral pg_catalog.generate_series(
      greatest(b.start_day, b.end_day - 369),
      b.end_day,
      interval '1 day'
    ) d
  ), day_totals as (
    select (recognized_at at time zone 'Asia/Seoul')::date as day,
           sum(amount)::bigint as amount,
           count(*)::bigint as count
    from active
    group by 1
  ), grouped as (
    select group_key as key,
           group_label as label,
           sum(amount)::bigint as amount,
           count(*)::bigint as count
    from active
    group by group_key, group_label
  ), totals as (
    select coalesce(sum(amount), 0)::bigint as total,
           count(*)::bigint as count
    from active
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
      from day_series ds
      left join day_totals dt on dt.day = ds.day
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
    'groupDim', case
      when p_view = 'team' then 'staff'
      when p_view = 'conversion' then 'staff'
      else p_group
    end
  )
  into v_result
  from totals t
  cross join period_totals pt;

  return v_result;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_revenue(text,date,date,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revenue(text,date,date,text,text,text) TO authenticated, service_role;
