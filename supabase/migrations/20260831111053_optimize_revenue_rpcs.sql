-- 815 레거시 결제 이관 후 매출 RPC가 RLS의 app_can_see_member()를 결제 행마다
-- 평가하며 타임아웃되던 병목을 제거한다.
--
-- 세 RPC는 원래부터 admin/manager/leader에게만 결과를 반환했고 세 역할 모두 전체
-- 회원 범위를 사용한다. 이 권한 의미는 그대로 유지하되, SECURITY DEFINER로 RLS를
-- 우회하기 전에 호출자 UID와 app_role()을 함수 진입 시 한 번 명시적으로 검증한다.
-- 입력값은 동적 SQL에 사용하지 않으며, 모든 객체를 스키마 한정하고 search_path를
-- 비워 SECURITY DEFINER의 객체 가로채기 위험을 차단한다.

-- 화면의 실제 필터 식과 같은 승인 결제 인식일 인덱스. paid_at이 없는 수기 이력은
-- created_at을 사용한다.
create index if not exists payments_approved_recognized_kst_day_idx
  on public.payments (
    ((coalesce(paid_at, created_at) at time zone 'Asia/Seoul')::date)
  )
  where status = 'approved'::public.payment_status;

-- 신규전환(회원별 최초 상품 결제) 판정의 DISTINCT ON 정렬을 지원한다.
create index if not exists payments_approved_member_first_idx
  on public.payments (
    member_id,
    (coalesce(paid_at, created_at)),
    id
  )
  where status = 'approved'::public.payment_status
    and product_id is not null;

create or replace function public.admin_revenue(
  p_view text,
  p_from date,
  p_to date,
  p_group text default 'staff'
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role public.role := public.app_role();
  v_result jsonb;
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
      and ((coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date
           between b.start_day and b.end_day)
  ), active as materialized (
    select p.*,
      case p.group_dim
        when 'team' then coalesce(p.team_id, 'none')
        when 'product' then coalesce(p.product_id, 'none')
        when 'pg' then case
          when p.method::text = 'pg' then 'pg:' || coalesce(p.pg_provider, 'PG(미지정)')
          else 'm:' || p.method::text
        end
        else coalesce(p.staff_id, 'none')
      end as group_key,
      case p.group_dim
        when 'team' then coalesce(t.name, '미배정')
        when 'product' then coalesce(pr.name, '기타')
        when 'pg' then case
          when p.method::text = 'pg' then coalesce(p.pg_provider, 'PG(미지정)')
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

create or replace function public.admin_revenue_calendar(
  p_month date,
  p_view text default 'real'
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role public.role := public.app_role();
  v_result jsonb;
begin
  if v_uid is null
     or v_role is null
     or v_role::text not in ('admin', 'manager', 'leader') then
    raise exception using
      errcode = '42501',
      message = 'insufficient privilege for revenue reports';
  end if;

  with month_bounds as materialized (
    select date_trunc('month', p_month)::date as start_day,
           (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date as end_day
  ), approved as materialized (
    select p.id,
           p.amount,
           p.staff_id,
           (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date as day
    from public.payments p
    join public.members m on m.id = p.member_id
    left join public.staff s on s.id = p.staff_id
    cross join month_bounds b
    where p.status = 'approved'::public.payment_status
      and ((coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date
           between b.start_day and b.end_day)
      and case p_view
        when 'conversion' then s.role::text = 'rep'
        when 'team' then s.role::text is not null and s.role::text <> 'rep'
        else true
      end
  ), by_day_staff as (
    select day,
           coalesce(staff_id, 'none') as staff_key,
           staff_id,
           sum(amount)::bigint as amount,
           count(*)::bigint as count
    from approved
    group by day, coalesce(staff_id, 'none'), staff_id
  ), day_rows as (
    select bds.day,
           sum(bds.amount)::bigint as total,
           sum(bds.count)::bigint as count,
           jsonb_agg(
             jsonb_build_object(
               'staffId', case when bds.staff_key = 'none' then null else bds.staff_id end,
               'label', coalesce(s.name, '미배정'),
               'count', bds.count,
               'amount', bds.amount
             ) order by bds.amount desc
           ) as by_staff
    from by_day_staff bds
    left join public.staff s on s.id = bds.staff_id
    group by bds.day
  )
  select jsonb_build_object(
    'month', to_char(p_month, 'YYYY-MM'),
    'monthTotal', coalesce((select sum(total) from day_rows), 0),
    'monthCount', coalesce((select sum(count) from day_rows), 0),
    'days', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'date', day::text,
          'total', total,
          'count', count,
          'byStaff', by_staff
        ) order by day
      )
      from day_rows
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$function$;

create or replace function public.admin_revenue_day_payments(
  p_day date,
  p_view text default 'real'
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role public.role := public.app_role();
  v_result jsonb;
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
    'productName', pr.name,
    'amount', p.amount
  ) order by p.amount desc), '[]'::jsonb)
  into v_result
  from public.payments p
  join public.members m on m.id = p.member_id
  left join public.staff s on s.id = p.staff_id
  left join public.products pr on pr.id = p.product_id
  where p.status = 'approved'::public.payment_status
    and (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date = p_day
    and case p_view
      when 'conversion' then s.role::text = 'rep'
      when 'team' then s.role::text is not null and s.role::text <> 'rep'
      else true
    end;

  return v_result;
end;
$function$;

-- SECURITY DEFINER 함수의 신규 기본 PUBLIC 실행 권한을 명시적으로 제거하고,
-- 로그인된 애플리케이션 역할에만 RPC 진입권한을 준다. 함수 내부에서 다시 역할을 검사한다.
revoke execute on function public.admin_revenue(text, date, date, text) from public, anon;
grant execute on function public.admin_revenue(text, date, date, text) to authenticated;

revoke execute on function public.admin_revenue_calendar(date, text) from public, anon;
grant execute on function public.admin_revenue_calendar(date, text) to authenticated;

revoke execute on function public.admin_revenue_day_payments(date, text) from public, anon;
grant execute on function public.admin_revenue_day_payments(date, text) to authenticated;

comment on function public.admin_revenue(text, date, date, text) is
  '승인 결제 매출 집계. 인증된 admin/manager/leader 전용 SECURITY DEFINER RPC.';
comment on function public.admin_revenue_calendar(date, text) is
  '월별 승인 결제 매출 캘린더. 인증된 admin/manager/leader 전용 SECURITY DEFINER RPC.';
comment on function public.admin_revenue_day_payments(date, text) is
  '일자별 승인 결제 상세. 인증된 admin/manager/leader 전용 SECURITY DEFINER RPC.';
