-- 회원목록·탭 건수·사이드바 배지·대시보드 조회 속도 개선 (현장 10/8 "이용자 검색/필터링 속도가 너무 느립니다")
--
-- 원인
--   1) 사이트 조건(meta->>'source_site')을 회원마다 meta(jsonb, 발급 이력 포함)를 풀어서 비교했다.
--      사이트 원식 인덱스(members_operating_site_registered_idx)가 있지만 plpgsql 의 공용 계획과
--      기본 random_page_cost(4) 때문에 순차 스캔을 골랐다. 이관 회원 적재와 주간 발급 이력이 쌓이며
--      meta 가 커져 사이트를 고른 화면부터 크게 느려졌다.
--   2) 탭 건수(admin_member_facets)와 대시보드가 m.*(meta 포함)를 통째로 물리화·정렬했다.
--   3) 사이드바 배지(admin_nav_badges)가 1분마다, 열린 화면마다 회원 전체를 사이트 조건으로 걸렀다.
--
-- 변경 (반환값·권한·필터 의미는 그대로)
--   - admin_members_page: 매 호출 계획(force_custom_plan) + random_page_cost 1.1 로 사이트 인덱스를 쓴다.
--   - admin_member_facets / admin_dashboard: 쓰는 열만 싣고, 같은 계획 설정을 준다.
--   - admin_nav_badges: 대기 결제에서 출발해 해당 회원만 확인한다.
--   - admin_member_search: random_page_cost 1.1 추가(이미 force_custom_plan).
--
-- 로컬 PG16 재현(회원 40,000 · 사이트 5곳 · 발급 이력 포함 meta, 같은 함수 정의) 측정:
--   회원목록 815 선택      378 ms → 10 ms
--   탭 건수 전체 / 815     386 ms → 153 ms / 505 ms → 54 ms
--   사이드바 배지 최악     437 ms → 25 ms
--   대시보드 평균          196 ms → 67 ms
--   탭 건수·배지·대시보드는 기존 함수와 결과 jsonb 가 같음을 역할·사이트 조합별로 확인했다.

CREATE OR REPLACE FUNCTION public.admin_member_facets(p_assigned_staff_id text DEFAULT NULL::text, p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 STABLE
 SET search_path TO 'public'
 SET plan_cache_mode TO 'force_custom_plan'
 SET random_page_cost TO '1.1'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
BEGIN
  RETURN (
with raw as materialized (
  -- 집계에 쓰는 열만 싣는다. m.*(meta 포함)를 통째로 물리화·정렬하면 회원 수만큼 큰 행을 디스크 정렬한다.
  select (m.registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date as is_today,
    m.grade::text as grade, m.assigned_staff_id, m.outcall_done, m.status, m.is_suspended, m.is_deleted,
    m.is_withdrawn, m.inflow_code, m.tendency, m.last_active_at,
    nullif(btrim(coalesce(m.win_history, '')), '') is not null as has_win,
    nullif(btrim(coalesce(m.memo, '')), '') is not null as has_memo,
    s.role::text as assigned_role
  from members m
  left join staff s on s.id = m.assigned_staff_id
  where (p_assigned_staff_id is null or m.assigned_staff_id = p_assigned_staff_id)
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
), base as materialized (
  select r.*,
    count(*) filter (where r.inflow_code is not null)
      over (partition by r.inflow_code) as inflow_all_count,
    count(*) filter (
      where r.inflow_code is not null
        and r.is_today
    ) over (partition by r.inflow_code) as inflow_today_count
  from raw r
)
select jsonb_build_object(
  'counts', jsonb_build_object(
    'all', count(*),
    'today-join', count(*) filter (where is_today),
    'paid', count(*) filter (where grade in ('gold','goldp','vip','royal')),
    'no-staff', count(*) filter (where assigned_staff_id is null),
    'no-outcall-new', count(*) filter (where not outcall_done and is_today),
    'winner', count(*) filter (where has_win),
    'normal', count(*) filter (where status::text = 'active'),
    'suspended', count(*) filter (where is_suspended),
    'deleted', count(*) filter (where is_deleted),
    'withdrawn', count(*) filter (where is_withdrawn),
    'free', count(*) filter (where grade = 'free'),
    'simple', count(*) filter (where grade = 'simple'),
    'gold', count(*) filter (where grade in ('gold','goldp')),
    'vip-royal', count(*) filter (where grade in ('vip','royal')),
    'ovr', count(*) filter (where grade = 'ovr'),
    'toss', count(*) filter (where grade = 'toss'),
    'manager-own', count(*) filter (where assigned_role = 'manager'),
    'leader-own', count(*) filter (where assigned_role = 'leader'),
    'dup-today', count(*) filter (where inflow_code is not null and inflow_today_count > 1 and is_today),
    'dup-all', count(*) filter (where inflow_code is not null and inflow_all_count > 1),
    'today-dabi', count(*) filter (where assigned_staff_id is not null and is_today),
    'retry', count(*) filter (where outcall_done and grade in ('free','simple')),
    'has-memo', count(*) filter (where has_memo),
    'tendency-active', count(*) filter (where tendency = '적극'),
    'no-outcall-all', count(*) filter (where not outcall_done),
    'long-inactive', count(*) filter (where last_active_at is null or last_active_at <= now() - interval '30 days')
  ),
  'inflowCodes', coalesce((
    select jsonb_agg(c.code order by c.code)
    from (select distinct inflow_code as code from base where inflow_code is not null and btrim(inflow_code) <> '') c
  ), '[]'::jsonb)
)
from base
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_member_facets(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_member_facets(text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_nav_badges(p_source_site text DEFAULT NULL::text)
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
)
select jsonb_build_object(
  -- 대기 결제에서 출발해 해당 회원만 확인한다. 전 회원을 먼저 거르면(사이트 조건 = meta 해석) 1분마다
  -- 열린 화면 수만큼 회원 전체를 읽는다.
  'payments', (
    select count(*)
    from payments p
    join members m on m.id = p.member_id
    cross join ctx c
    where p.status::text = 'wait'
      and (c.role in ('admin','manager','leader')
        or (c.role = 'rep' and m.assigned_staff_id = c.staff_id))
      and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
  ),
  'support', (select count(*) from inquiries where status::text = 'open')
)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_nav_badges(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_nav_badges(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_dashboard(p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 STABLE
 SET search_path TO 'public'
 SET plan_cache_mode TO 'force_custom_plan'
 SET random_page_cost TO '1.1'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
BEGIN
  RETURN (
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id, (select app_staff_id()) as staff_id
), scoped_members as materialized (
  -- 아래에서 쓰는 열만 싣는다. m.*(meta 포함)를 통째로 물리화하면 회원 수만큼 큰 행을 복사한다.
  select m.id, m.name, m.grade, m.phone, m.registered_at, m.outcall_done from members m, ctx c
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

ALTER FUNCTION public.admin_members_page(jsonb, integer, integer, text, boolean, text)
  SET plan_cache_mode = 'force_custom_plan';
ALTER FUNCTION public.admin_members_page(jsonb, integer, integer, text, boolean, text)
  SET random_page_cost = 1.1;
ALTER FUNCTION public.admin_member_search(text, integer, text)
  SET random_page_cost = 1.1;
