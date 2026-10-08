-- 이용자 목록·탭 건수·회원 검색을 SECURITY DEFINER 로 바꿔 RLS 아래에서도 인덱스를 쓰게 한다 (현장 10/8).
--
-- 증상: "전사이트 이용자>전체에 놓고 이름이나 전화번호를 검색하면 결과값이 너무 늦게 나오고,
--        데이터가 없다고 나오는 경우도 자주 있습니다." (조회 시간초과가 화면에서 0건으로 보였다)
--
-- 원인 — RLS 가 붙은 테이블에서는 누설 방지(leakproof)가 아닌 조건을 인덱스 조건으로 쓰지 못한다.
--   이 함수들은 SECURITY INVOKER 라 members_rw 정책이 붙는다. 검색의 LIKE·trigram,
--   사이트 조건의 meta->>'source_site' 는 leakproof 가 아니어서 trigram·사이트 인덱스를 못 쓰고
--   매번 회원 전체를 순차 스캔했다(전화번호 검색은 행마다 regexp_replace 까지).
--   20261008140000 의 계획 설정은 RLS 없는 환경에서 잰 값이라 운영(로그인 직원)에는 효과가 작았다.
--
-- 처방 — 결제 목록(20260911040000)과 같은 방식.
--   SECURITY DEFINER 로 RLS 평가를 없애고, RLS 가 하던 가시성 판단을 쿼리 안에 명시한다.
--   가시성 규칙은 members_rw(0016)와 같다: admin·manager·leader → 전체 / rep → 본인 담당 회원.
--   `(v_role::text <> 'rep' or m.assigned_staff_id = v_staff_id)` 한 줄이 그것이다.
--   중복유입(dupInflow) 건수의 하위 조회에도 같은 조건을 걸어, rep 가 보던 건수를 그대로 유지한다.
--
-- DEFINER 는 RLS 를 우회하므로 두 가지를 함께 건다.
--   ① 로그인·직원 역할이 없으면 즉시 거부한다(42501).
--   ② search_path = '' 로 고정하고 모든 객체를 스키마까지 적는다.
--
-- 본문 로직·시그니처·반환 모양은 그대로다(admin_members_page 20260909001521,
-- admin_member_facets 20261008140000, admin_member_search 20260911020000 판).
--
-- 로컬 PG16 재현(회원 60,000 · 운영과 같은 members_rw 정책 · authenticated 로 호출) 측정:
--   전화번호 검색(전체)      143 ms → 4 ms
--   이름 검색 3글자+(전체)   106 ms → 48 ms   (2글자는 trigram 불가 → 113 → 95 ms)
--   회원목록 815 선택        625 ms → 18 ms
--   탭 건수 815              728 ms → 88 ms
--   회원 검색(수기결제)       31 ms → 1 ms
-- 동일성: admin·manager·rep 각 72개(필터 34종 · 정렬 7종 · 담당 지정 · 탭 건수 사이트별 · 회원 검색)
--   216개 결과의 jsonb 가 기존 함수와 모두 같았다. 비로그인·직원 아닌 계정은 42501 로 거부됐다.

CREATE OR REPLACE FUNCTION public.admin_members_page(p_filter jsonb DEFAULT '{}'::jsonb, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50, p_sort_id text DEFAULT NULL::text, p_sort_desc boolean DEFAULT true, p_assigned_staff_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
 SET random_page_cost TO '1.1'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_filter->>'sourceSite');
  v_role public.role := public.app_role();
  v_staff_id text := public.app_staff_id();
BEGIN
  -- DEFINER 는 RLS 를 우회하므로 로그인·역할이 없으면 즉시 거부한다(20260911040000 결제 목록과 같은 방식).
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'insufficient privilege for members';
  END IF;
  RETURN (
with filtered as not materialized (
  select m.*
  from public.members m
  -- RLS(members_rw)가 하던 가시성: admin·manager·leader 전체 / rep 본인 담당.
  where (v_role::text <> 'rep' or m.assigned_staff_id = v_staff_id)
    and (p_assigned_staff_id is null or m.assigned_staff_id = p_assigned_staff_id)
    and (not (p_filter ? 'status') or m.status::text = p_filter->>'status')
    and (not (p_filter ? 'grade') or m.grade::text = p_filter->>'grade')
    and (
      not (p_filter ? 'gradeIn')
      or exists (
        select 1 from jsonb_array_elements_text(p_filter->'gradeIn') g(value)
        where g.value = m.grade::text
      )
    )
    and (
      not (p_filter ? 'hasStaff')
      or (m.assigned_staff_id is not null) = ((p_filter->>'hasStaff')::boolean)
    )
    and (not (p_filter ? 'assignedStaffId') or m.assigned_staff_id = p_filter->>'assignedStaffId')
    and (
      not (p_filter ? 'staffRole')
      or exists (
        select 1 from public.staff s
        where s.id = m.assigned_staff_id and s.role::text = p_filter->>'staffRole'
      )
    )
    and (not (p_filter ? 'is_suspended') or m.is_suspended = ((p_filter->>'is_suspended')::boolean))
    and (not (p_filter ? 'is_deleted') or m.is_deleted = ((p_filter->>'is_deleted')::boolean))
    and (not (p_filter ? 'is_withdrawn') or m.is_withdrawn = ((p_filter->>'is_withdrawn')::boolean))
    and (not (p_filter ? 'hasWin') or nullif(btrim(coalesce(m.win_history, '')), '') is not null)
    and (
      not (p_filter ? 'winRound') and not (p_filter ? 'winRank')
      or exists (
        select 1 from jsonb_array_elements(coalesce(m.meta->'win_records', '[]'::jsonb)) w
        where (not (p_filter ? 'winRound') or (w->>'round_no')::numeric = (p_filter->>'winRound')::numeric)
          and (not (p_filter ? 'winRank') or (w->>'rank')::numeric = (p_filter->>'winRank')::numeric)
      )
    )
    and (not (p_filter ? 'hasMemo') or nullif(btrim(coalesce(m.memo, '')), '') is not null)
    and (not (p_filter ? 'outcall') or m.outcall_done = ((p_filter->>'outcall')::boolean))
    and (not (p_filter ? 'tendency') or m.tendency = p_filter->>'tendency')
    and (not (p_filter ? 'inflowCode') or m.inflow_code = p_filter->>'inflowCode')
    and (not (p_filter ? 'inflowType') or public.canonical_inflow_type(m.inflow_type) = public.canonical_inflow_type(p_filter->>'inflowType'))
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
    and (not (p_filter ? 'consultStatus') or m.consult_status = p_filter->>'consultStatus')
    and (
      not coalesce((p_filter->>'registeredToday')::boolean, false)
      or (m.registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
    )
    and (
      not (p_filter ? 'registeredFrom')
      or (m.registered_at at time zone 'Asia/Seoul')::date >= (p_filter->>'registeredFrom')::date
    )
    and (
      not (p_filter ? 'registeredTo')
      or (m.registered_at at time zone 'Asia/Seoul')::date <= (p_filter->>'registeredTo')::date
    )
    and (
      not coalesce((p_filter->>'dupPhone')::boolean, false)
      or m.meta @> '{"dup_phone":true}'::jsonb
    )
    and (
      not (p_filter ? 'inactiveDays')
      or m.last_active_at is null
      or m.last_active_at <= now() - make_interval(days => (p_filter->>'inactiveDays')::integer)
    )
    and (
      not (p_filter ? 'dupInflow')
      or (
        m.inflow_code is not null
        and (
          select count(*) from public.members d
          where d.inflow_code = m.inflow_code
            and (v_role::text <> 'rep' or d.assigned_staff_id = v_staff_id)
            and (v_source_site IS NULL OR coalesce(nullif(btrim(d.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
            and (
              p_filter->>'dupInflow' = 'all'
              or (d.registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
            )
        ) > 1
      )
    )
    and (
      not coalesce((p_filter->>'retry')::boolean, false)
      or (m.outcall_done and m.grade::text in ('free','simple'))
    )
    and (
      nullif(btrim(coalesce(p_filter->>'search', '')), '') is null
      or lower(m.user_id) like '%' || lower(p_filter->>'search') || '%'
      or lower(m.name) like '%' || lower(p_filter->>'search') || '%'
      or lower(coalesce(m.nickname, '')) like '%' || lower(p_filter->>'search') || '%'
      or (
        nullif(regexp_replace(p_filter->>'search', '\D', '', 'g'), '') is not null
        and regexp_replace(m.phone, '\D', '', 'g') like '%' || regexp_replace(p_filter->>'search', '\D', '', 'g') || '%'
      )
    )
), page_rows as (
  select f.*
  from filtered f
  order by
    case when coalesce((p_filter->>'dupPhone')::boolean, false) then f.meta->>'duplicate_last_at' end desc nulls last,
    case when p_sort_id = 'name' and not p_sort_desc then f.name end asc nulls last,
    case when p_sort_id = 'name' and p_sort_desc then f.name end desc nulls last,
    case when p_sort_id = 'user_id' and not p_sort_desc then f.user_id end asc nulls last,
    case when p_sort_id = 'user_id' and p_sort_desc then f.user_id end desc nulls last,
    case when p_sort_id = 'grade' and not p_sort_desc then f.grade::text end asc nulls last,
    case when p_sort_id = 'grade' and p_sort_desc then f.grade::text end desc nulls last,
    case when p_sort_id = 'status' and not p_sort_desc then f.status::text end asc nulls last,
    case when p_sort_id = 'status' and p_sort_desc then f.status::text end desc nulls last,
    case when p_sort_id = 'registered_at' and not p_sort_desc then f.registered_at end asc nulls last,
    case when p_sort_id = 'registered_at' and p_sort_desc then f.registered_at end desc nulls last,
    case when p_sort_id = 'last_active_at' and not p_sort_desc then f.last_active_at end asc nulls last,
    case when p_sort_id = 'last_active_at' and p_sort_desc then f.last_active_at end desc nulls last,
    f.registered_at desc,
    f.id asc
  offset greatest(0, p_offset)
  limit greatest(1, least(coalesce(p_limit, 50), 1000))
)
select jsonb_build_object(
  'rows', coalesce((select jsonb_agg(to_jsonb(p)) from page_rows p), '[]'::jsonb),
  'total', (select count(*) from filtered)
)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_members_page(jsonb,integer,integer,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_members_page(jsonb,integer,integer,text,boolean,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_member_facets(p_assigned_staff_id text DEFAULT NULL::text, p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
 SET random_page_cost TO '1.1'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
  v_role public.role := public.app_role();
  v_staff_id text := public.app_staff_id();
BEGIN
  -- DEFINER 는 RLS 를 우회하므로 로그인·역할이 없으면 즉시 거부한다(20260911040000 결제 목록과 같은 방식).
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'insufficient privilege for members';
  END IF;
  RETURN (
with raw as materialized (
  -- 집계에 쓰는 열만 싣는다. m.*(meta 포함)를 통째로 물리화·정렬하면 회원 수만큼 큰 행을 디스크 정렬한다.
  select (m.registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date as is_today,
    m.grade::text as grade, m.assigned_staff_id, m.outcall_done, m.status, m.is_suspended, m.is_deleted,
    m.is_withdrawn, m.inflow_code, m.tendency, m.last_active_at,
    nullif(btrim(coalesce(m.win_history, '')), '') is not null as has_win,
    nullif(btrim(coalesce(m.memo, '')), '') is not null as has_memo,
    s.role::text as assigned_role
  from public.members m
  left join public.staff s on s.id = m.assigned_staff_id
  -- RLS(members_rw)가 하던 가시성: admin·manager·leader 전체 / rep 본인 담당.
  where (v_role::text <> 'rep' or m.assigned_staff_id = v_staff_id)
    and (p_assigned_staff_id is null or m.assigned_staff_id = p_assigned_staff_id)
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

CREATE OR REPLACE FUNCTION public.admin_member_search(p_term text DEFAULT ''::text, p_limit integer DEFAULT 20, p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
 SET random_page_cost TO '1.1'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
  v_role public.role := public.app_role();
  v_staff_id text := public.app_staff_id();
BEGIN
  -- DEFINER 는 RLS 를 우회하므로 로그인·역할이 없으면 즉시 거부한다(20260911040000 결제 목록과 같은 방식).
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'insufficient privilege for members';
  END IF;
  RETURN (
select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
from (
  select m.id, m.name, m.user_id, m.phone, m.grade
  from public.members m
  where (v_role::text <> 'rep' or m.assigned_staff_id = v_staff_id)
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
    and (nullif(btrim(p_term), '') is null
    or lower(m.name) like '%' || lower(p_term) || '%'
    or lower(m.user_id) like '%' || lower(p_term) || '%'
    or (
      nullif(regexp_replace(p_term, '\D', '', 'g'), '') is not null
      -- members_phone_digits_trgm_idx 가 받는 형태는 LIKE 뿐이다. position() 으로 바꾸지 말 것(0018).
      and regexp_replace(m.phone, '\D', '', 'g') like '%' || regexp_replace(p_term, '\D', '', 'g') || '%'
    )
    )
  order by m.registered_at desc, m.id asc
  limit greatest(1, least(coalesce(p_limit, 20), 50))
) x
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_member_search(text,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_member_search(text,integer,text) TO authenticated, service_role;

-- 끝(이 줄까지 붙여넣어야 합니다).
