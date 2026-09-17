-- 이전자료의 결제수단 미기재와 등급 미확정 상품명을 조회에서 명시한다.
-- 기존 역할과 사이트 범위는 20260909001521과 동일하다.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.admin_dashboard(text)'::regprocedure
                 AND (md5(prosrc) = 'e291f0510c66235b04958e0bdf92b6a3' OR prosrc LIKE '%이전자료 미기재%' OR prosrc LIKE '%legacy_item_name%')) THEN RAISE EXCEPTION 'RPC definition changed: admin_dashboard'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.admin_revenue(text,date,date,text,text)'::regprocedure
                 AND (md5(prosrc) = 'ac4ac20fb2293b0b4b9437cfce198c67' OR prosrc LIKE '%이전자료 미기재%' OR prosrc LIKE '%legacy_item_name%')) THEN RAISE EXCEPTION 'RPC definition changed: admin_revenue'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.admin_revenue_day_payments(date,text,text)'::regprocedure
                 AND (md5(prosrc) = '275d28862121b73bae9e2c8c3d239b7d' OR prosrc LIKE '%이전자료 미기재%' OR prosrc LIKE '%legacy_item_name%')) THEN RAISE EXCEPTION 'RPC definition changed: admin_revenue_day_payments'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.admin_stats_snapshot(text,date,date,text)'::regprocedure
                 AND (md5(prosrc) = '6f58d9f28d9f929cfc4ef6b71ce024b3' OR prosrc LIKE '%이전자료 미기재%' OR prosrc LIKE '%legacy_item_name%')) THEN RAISE EXCEPTION 'RPC definition changed: admin_stats_snapshot'; END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.admin_dashboard(p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
BEGIN
  RETURN (
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id, (select app_staff_id()) as staff_id
), scoped_members as materialized (
  select m.* from members m, ctx c
  where (c.role in ('admin','manager','leader')
    or (c.role = 'rep' and m.assigned_staff_id = c.staff_id))
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
), scoped_payments as materialized (
  select p.* from payments p join scoped_members m on m.id = p.member_id
), trend as (
  select d::date as day, count(m.id) as value
  from generate_series(
    (now() at time zone 'Asia/Seoul')::date - 13,
    (now() at time zone 'Asia/Seoul')::date,
    interval '1 day'
  ) d
  left join scoped_members m on (m.registered_at at time zone 'Asia/Seoul')::date = d::date
  group by d::date
  order by d::date
)
select jsonb_build_object(
  'kpis', jsonb_build_object(
    'todayJoin', (select count(*) from scoped_members where (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'weekJoin', (select count(*) from scoped_members where (registered_at at time zone 'Asia/Seoul')::date between (now() at time zone 'Asia/Seoul')::date - 6 and (now() at time zone 'Asia/Seoul')::date),
    'noOutcall', (select count(*) from scoped_members where not outcall_done),
    'paymentWait', (select count(*) from scoped_payments where status::text = 'wait'),
    'paymentWaitAmount', (select coalesce(sum(amount), 0) from scoped_payments where status::text = 'wait'),
    'todayRevenue', (select coalesce(sum(amount), 0) from scoped_payments where status::text = 'approved' and (paid_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'todayApproved', (select count(*) from scoped_payments where status::text = 'approved' and (paid_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date)
  ),
  'trend', coalesce((select jsonb_agg(jsonb_build_object('date', day::text, 'label', to_char(day, 'MM-DD'), 'value', value) order by day) from trend), '[]'::jsonb),
  'pendingOutcall', coalesce((
    select jsonb_agg(to_jsonb(x)) from (
      select id, name, grade, phone, registered_at as "registeredAt"
      from scoped_members where not outcall_done
      order by registered_at desc limit 6
    ) x
  ), '[]'::jsonb),
  'pendingPayment', coalesce((
    select jsonb_agg(to_jsonb(x)) from (
      select p.id, m.name as "memberName", p.amount,
        case when p.method::text = 'pg' then coalesce(p.pg_provider, 'PG')
             when p.method::text = 'unknown' then '이전자료 미기재'
             when p.method::text = 'bank' then '무통장' else '수기' end as "methodLabel",
        p.created_at as "createdAt"
      from scoped_payments p join scoped_members m on m.id = p.member_id
      where p.status::text = 'wait'
      order by p.created_at desc limit 6
    ) x
  ), '[]'::jsonb),
  'outcallMore', greatest(0, (select count(*) from scoped_members where not outcall_done) - 6),
  'paymentMore', greatest(0, (select count(*) from scoped_payments where status::text = 'wait') - 6)
)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_dashboard(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_revenue(p_view text, p_from date, p_to date, p_group text DEFAULT 'staff'::text, p_source_site text DEFAULT NULL::text)
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
    cross join bounds b
    where p.status = 'approved'::public.payment_status
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

REVOKE EXECUTE ON FUNCTION public.admin_revenue(text,date,date,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revenue(text,date,date,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_revenue_day_payments(p_day date, p_view text DEFAULT 'real'::text, p_source_site text DEFAULT NULL::text)
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'depositorName', p.depositor_name,
    'memberUserId', m.user_id,
    'staffName', s.name,
    'method', p.method,
    'productName', coalesce(pr.name, case when p.meta->>'source_site' in ('lotto815','cplotto','infolotto') then nullif(btrim(p.meta->>'legacy_item_name'), '') || ' (이전상품)' end),
    'amount', p.amount
  ) order by p.amount desc), '[]'::jsonb)
  into v_result
  from public.payments p
  join public.members m on m.id = p.member_id
  left join public.staff s on s.id = p.staff_id
  left join public.products pr on pr.id = p.product_id
  where p.status = 'approved'::public.payment_status
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
    and (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date = p_day
    and case p_view
      when 'conversion' then s.role::text = 'rep'
      when 'team' then s.role::text is not null and s.role::text <> 'rep'
      else true
    end;

  return v_result;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_revenue_day_payments(date,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revenue_day_payments(date,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_stats_snapshot(p_view text, p_from date, p_to date, p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
BEGIN
  RETURN (
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id, (select app_staff_id()) as staff_id
), scoped_members as materialized (
  select m.id, m.grade, m.registered_at, m.inflow_type, m.inflow_code
  from members m, ctx c
  where (c.role in ('admin','manager','leader')
    or (c.role = 'rep' and m.assigned_staff_id = c.staff_id))
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
), member_period as materialized (
  select * from scoped_members
  where (registered_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), scoped_payments as materialized (
  select p.* from payments p join scoped_members m on m.id = p.member_id
), approved_period as materialized (
  select * from scoped_payments
  where status::text = 'approved' and paid_at is not null
    and (paid_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), created_period as materialized (
  select * from scoped_payments
  where (created_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
)
select case when p_view in ('signup','inflow') then jsonb_build_object(
  'kind', 'members',
  'total', (select count(*) from scoped_members),
  'paid', (select count(*) from scoped_members where grade::text in ('gold','goldp','vip','royal')),
  'period', (select count(*) from member_period),
  'periodPaid', (select count(*) from member_period where grade::text in ('gold','goldp','vip','royal')),
  'distinctTypes', (select count(distinct coalesce(inflow_type, '미상')) from scoped_members),
  'days', coalesce((
    select jsonb_agg(jsonb_build_object('date', x.day::text, 'value', x.value) order by x.day)
    from (
      select (registered_at at time zone 'Asia/Seoul')::date as day, count(*)::bigint as value
      from member_period group by 1
    ) x
  ), '[]'::jsonb),
  'grades', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count) order by x.count desc)
    from (select grade::text as key, count(*)::bigint as count from scoped_members group by 1) x
  ), '[]'::jsonb),
  'inflowTypes', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count, 'paid', x.paid) order by x.count desc)
    from (
      select coalesce(inflow_type, '미상') as key, count(*)::bigint as count,
        count(*) filter (where grade::text in ('gold','goldp','vip','royal'))::bigint as paid
      from member_period group by 1
    ) x
  ), '[]'::jsonb),
  'inflowCodes', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count) order by x.count desc)
    from (
      select coalesce(inflow_code, '미상') as key, count(*)::bigint as count
      from member_period group by 1
    ) x
  ), '[]'::jsonb)
) else jsonb_build_object(
  'kind', 'payments',
  'total', (select coalesce(sum(amount), 0) from approved_period),
  'approvedCount', (select count(*) from approved_period),
  'createdCount', (select count(*) from created_period),
  'days', coalesce((
    select jsonb_agg(jsonb_build_object('date', x.day::text, 'value', x.value) order by x.day)
    from (
      select (paid_at at time zone 'Asia/Seoul')::date as day, sum(amount)::bigint as value
      from approved_period group by 1
    ) x
  ), '[]'::jsonb),
  'products', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'label', x.label, 'value', x.value, 'count', x.count) order by x.value desc)
    from (
      select coalesce(ap.product_id, case when ap.meta->>'source_site' in ('lotto815','cplotto','infolotto') then ap.meta->>'source_site' || ':legacy:' || nullif(ap.meta->>'legacy_item_code', '') end, 'none') as key,
        coalesce(pr.name, case when ap.meta->>'source_site' in ('lotto815','cplotto','infolotto') then nullif(btrim(ap.meta->>'legacy_item_name'), '') || ' (이전상품)' end, '기타') as label,
        sum(ap.amount)::bigint as value, count(*)::bigint as count
      from approved_period ap left join products pr on pr.id = ap.product_id
      group by 1, 2
    ) x
  ), '[]'::jsonb),
  'methods', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'label', x.label, 'value', x.value, 'count', x.count) order by x.value desc)
    from (
      select case when method::text = 'pg' then 'pg:' || coalesce(pg_provider, 'PG') else 'm:' || method::text end as key,
        case when method::text = 'pg' then coalesce(pg_provider, 'PG(미지정)')
             when method::text = 'unknown' then '이전자료 미기재'
             when method::text = 'bank' then '무통장' else '수기' end as label,
        sum(amount)::bigint as value, count(*)::bigint as count
      from approved_period group by 1, 2
    ) x
  ), '[]'::jsonb),
  'statuses', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count) order by x.count desc)
    from (select status::text as key, count(*)::bigint as count from created_period group by 1) x
  ), '[]'::jsonb)
) end
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_stats_snapshot(text,date,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_stats_snapshot(text,date,date,text) TO authenticated, service_role;

COMMIT;
