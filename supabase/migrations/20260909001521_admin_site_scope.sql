-- 사이트별 운영 범위: 누락/빈 source_site는 플러스로또, NULL 인자는 전체.
-- 2026-09-09 운영 DB 함수 정의를 기준으로 기존 결과와 역할/RLS를 보존한다.
-- 회원/결제 원본, 전화번호 중복 규칙, SMS 발송 설정은 변경하지 않는다.
-- 함수 인자 확장 시 이전 시그니처를 명시적으로 제거한다. DEFAULT NULL 덕분에
-- 기존 프런트의 인자 없는 호출도 계속 동작하며 PostgREST 오버로드 충돌은 없다.
-- CASCADE를 사용하지 않아 예상하지 않은 의존성이 있으면 적용 자체가 실패한다.

CREATE OR REPLACE FUNCTION public.admin_validate_source_site(p_source_site text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  IF p_source_site IS NOT NULL
     AND p_source_site NOT IN ('pluslotto', 'lotto815', 'infolotto', 'cplotto') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid source site';
  END IF;
  RETURN p_source_site;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_validate_source_site(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_validate_source_site(text) TO authenticated, service_role;

-- PostgREST computed field: 직접 회원/관계 조회도 RPC와 동일한 공백 정규화를 쓴다.
-- 이름 없는 복합 인자로 /rpc 엔드포인트 노출을 피한다. INVOKER이며 테이블을 읽지 않는다.
-- 단일 SQL 식의 인라인화를 유지해 아래 원식 인덱스를 사용하도록 SET 절은 두지 않는다.
CREATE OR REPLACE FUNCTION public.member_operating_site(public.members)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER
AS $function$
  SELECT coalesce(nullif(pg_catalog.btrim($1.meta->>'source_site'), ''), 'pluslotto');
$function$;
REVOKE EXECUTE ON FUNCTION public.member_operating_site(public.members) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_operating_site(public.members) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS members_operating_site_registered_idx
  ON public.members ((coalesce(nullif(btrim(meta->>'source_site'), ''), 'pluslotto')), registered_at DESC, id);

-- 기존 일일요약의 수기 근무인원 테이블이 누락된 환경도 지원한다.
-- 근무인원은 회사 전체 값이며 사이트에 임의 배분하지 않는다.
CREATE TABLE IF NOT EXISTS public.daily_work_count (
  day date PRIMARY KEY,
  head_count integer NOT NULL DEFAULT 0 CHECK (head_count >= 0),
  updated_by text REFERENCES public.staff(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.daily_work_count ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS daily_work_count_select ON public.daily_work_count;
CREATE POLICY daily_work_count_select ON public.daily_work_count
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.staff WHERE auth_user_id = (SELECT auth.uid()) AND is_active));
DROP POLICY IF EXISTS daily_work_count_write ON public.daily_work_count;
CREATE POLICY daily_work_count_write ON public.daily_work_count
  FOR ALL TO authenticated
  USING ((SELECT public.app_role()) IN ('admin', 'manager'))
  WITH CHECK ((SELECT public.app_role()) IN ('admin', 'manager'));
REVOKE ALL ON public.daily_work_count FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_work_count TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.admin_dashboard();

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

DROP FUNCTION IF EXISTS public.admin_member_facets(text);

CREATE OR REPLACE FUNCTION public.admin_member_facets(p_assigned_staff_id text DEFAULT NULL::text, p_source_site text DEFAULT NULL::text)
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
with raw as materialized (
  select m.*, s.role::text as assigned_role
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
        and (r.registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
    ) over (partition by r.inflow_code) as inflow_today_count
  from raw r
)
select jsonb_build_object(
  'counts', jsonb_build_object(
    'all', count(*),
    'today-join', count(*) filter (where (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'paid', count(*) filter (where grade::text in ('gold','goldp','vip','royal')),
    'no-staff', count(*) filter (where assigned_staff_id is null),
    'no-outcall-new', count(*) filter (where not outcall_done and (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'winner', count(*) filter (where nullif(btrim(coalesce(win_history, '')), '') is not null),
    'normal', count(*) filter (where status::text = 'active'),
    'suspended', count(*) filter (where is_suspended),
    'deleted', count(*) filter (where is_deleted),
    'withdrawn', count(*) filter (where is_withdrawn),
    'free', count(*) filter (where grade::text = 'free'),
    'simple', count(*) filter (where grade::text = 'simple'),
    'gold', count(*) filter (where grade::text in ('gold','goldp')),
    'vip-royal', count(*) filter (where grade::text in ('vip','royal')),
    'ovr', count(*) filter (where grade::text = 'ovr'),
    'toss', count(*) filter (where grade::text = 'toss'),
    'manager-own', count(*) filter (where assigned_role = 'manager'),
    'leader-own', count(*) filter (where assigned_role = 'leader'),
    'dup-today', count(*) filter (where inflow_code is not null and inflow_today_count > 1 and (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'dup-all', count(*) filter (where inflow_code is not null and inflow_all_count > 1),
    'today-dabi', count(*) filter (where assigned_staff_id is not null and (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'retry', count(*) filter (where outcall_done and grade::text in ('free','simple')),
    'has-memo', count(*) filter (where nullif(btrim(coalesce(memo, '')), '') is not null),
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

DROP FUNCTION IF EXISTS public.admin_member_search(text,integer);

CREATE OR REPLACE FUNCTION public.admin_member_search(p_term text DEFAULT ''::text, p_limit integer DEFAULT 20, p_source_site text DEFAULT NULL::text)
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
select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
from (
  select m.id, m.name, m.user_id, m.phone, m.grade
  from members m
  where (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
    and (nullif(btrim(p_term), '') is null
    or lower(m.name) like '%' || lower(p_term) || '%'
    or lower(m.user_id) like '%' || lower(p_term) || '%'
    or (
      nullif(regexp_replace(p_term, '\D', '', 'g'), '') is not null
      and position(regexp_replace(p_term, '\D', '', 'g') in regexp_replace(m.phone, '\D', '', 'g')) > 0
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

CREATE OR REPLACE FUNCTION public.admin_members_page(p_filter jsonb DEFAULT '{}'::jsonb, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50, p_sort_id text DEFAULT NULL::text, p_sort_desc boolean DEFAULT true, p_assigned_staff_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_filter->>'sourceSite');
BEGIN
  RETURN (
with filtered as not materialized (
  select m.*
  from members m
  where (p_assigned_staff_id is null or m.assigned_staff_id = p_assigned_staff_id)
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
        select 1 from staff s
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
          select count(*) from members d
          where d.inflow_code = m.inflow_code
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

DROP FUNCTION IF EXISTS public.admin_nav_badges();

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
), scoped_members as materialized (
  select m.id from members m, ctx c
  where (c.role in ('admin','manager','leader')
    or (c.role = 'rep' and m.assigned_staff_id = c.staff_id))
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
)
select jsonb_build_object(
  'payments', (select count(*) from payments p join scoped_members m on m.id = p.member_id where p.status::text = 'wait'),
  'support', (select count(*) from inquiries where status::text = 'open')
)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_nav_badges(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_nav_badges(text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.admin_payment_counts();

CREATE OR REPLACE FUNCTION public.admin_payment_counts(p_source_site text DEFAULT NULL::text)
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
select jsonb_build_object(
  'all', count(*),
  'wait', count(*) filter (where p.status::text = 'wait'),
  'approved', count(*) filter (where p.status::text = 'approved'),
  'failed', count(*) filter (where p.status::text = 'failed'),
  'cancelled', count(*) filter (where p.status::text = 'cancelled')
) from payments p join members m on m.id = p.member_id
where (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_payment_counts(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_payment_counts(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_payments_page(p_filter jsonb DEFAULT '{}'::jsonb, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50, p_sort_id text DEFAULT NULL::text, p_sort_desc boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_filter->>'sourceSite');
BEGIN
  RETURN (
with filtered as not materialized (
  select p.*,
    jsonb_build_object('id', m.id, 'name', m.name, 'user_id', m.user_id, 'inflow_code', m.inflow_code) as member,
    case when pr.id is null then null else jsonb_build_object('id', pr.id, 'name', pr.name, 'grade_granted', pr.grade_granted) end as product
  from payments p
  join members m on m.id = p.member_id
  left join products pr on pr.id = p.product_id
  where (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
    and (not (p_filter ? 'status') or p_filter->>'status' = 'all' or p.status::text = p_filter->>'status')
    and (not (p_filter ? 'method') or nullif(p_filter->>'method', '') is null or p.method::text = p_filter->>'method')
    and (not (p_filter ? 'pg') or p.pg_provider = p_filter->>'pg')
    and (coalesce(p_filter->>'grade', '') = '' or pr.grade_granted::text = p_filter->>'grade')
    and (not (p_filter ? 'staffId') or p.staff_id = p_filter->>'staffId')
    and (not (p_filter ? 'dateFrom') or (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date >= (p_filter->>'dateFrom')::date)
    and (not (p_filter ? 'dateTo') or (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date <= (p_filter->>'dateTo')::date)
    and (
      nullif(btrim(coalesce(p_filter->>'search', '')), '') is null
      or lower(m.name) like '%' || lower(p_filter->>'search') || '%'
      or lower(m.user_id) like '%' || lower(p_filter->>'search') || '%'
      or lower(coalesce(p.depositor_name, '')) like '%' || lower(p_filter->>'search') || '%'
    )
), page_rows as (
  select f.* from filtered f
  order by
    case when p_sort_id = 'amount' and not p_sort_desc then f.amount end asc nulls last,
    case when p_sort_id = 'amount' and p_sort_desc then f.amount end desc nulls last,
    case when p_sort_id = 'status' and not p_sort_desc then f.status::text end asc nulls last,
    case when p_sort_id = 'status' and p_sort_desc then f.status::text end desc nulls last,
    case when p_sort_id = 'method' and not p_sort_desc then f.method::text end asc nulls last,
    case when p_sort_id = 'method' and p_sort_desc then f.method::text end desc nulls last,
    case when p_sort_id = 'paid_at' and not p_sort_desc then f.paid_at end asc nulls last,
    case when p_sort_id = 'paid_at' and p_sort_desc then f.paid_at end desc nulls last,
    case when p_sort_id = 'created_at' and not p_sort_desc then f.created_at end asc nulls last,
    case when p_sort_id = 'created_at' and p_sort_desc then f.created_at end desc nulls last,
    f.created_at desc,
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

REVOKE EXECUTE ON FUNCTION public.admin_payments_page(jsonb,integer,integer,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_payments_page(jsonb,integer,integer,text,boolean) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.admin_revenue(text,date,date,text);

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

REVOKE EXECUTE ON FUNCTION public.admin_revenue(text,date,date,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revenue(text,date,date,text,text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.admin_revenue_calendar(date,text);

CREATE OR REPLACE FUNCTION public.admin_revenue_calendar(p_month date, p_view text DEFAULT 'real'::text, p_source_site text DEFAULT NULL::text)
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
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
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

REVOKE EXECUTE ON FUNCTION public.admin_revenue_calendar(date,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revenue_calendar(date,text,text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.admin_revenue_day_payments(date,text);

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
    'productName', pr.name,
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

DROP FUNCTION IF EXISTS public.admin_stats_snapshot(text,date,date);

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
      select coalesce(ap.product_id, 'none') as key, coalesce(pr.name, '기타') as label,
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

DROP FUNCTION IF EXISTS public.admin_consult_report(text,text,date,date);

CREATE OR REPLACE FUNCTION public.admin_consult_report(p_dimension text, p_period text, p_from date, p_to date, p_source_site text DEFAULT NULL::text)
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
  select m.id, m.inflow_code
  from members m, ctx c
  where (c.role in ('admin','manager','leader')
    or (c.role = 'rep' and m.assigned_staff_id = c.staff_id))
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
), relevant_logs as materialized (
  select l.* from logs l
  where l.action in ('member.update','member.bulk_update')
    and (l.created_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), events as (
  select l.created_at, l.actor, l.target_id as member_id, l.meta->'patch'->>'consult_status' as status
  from relevant_logs l
  where l.action = 'member.update' and l.target_id is not null
  union all
  select l.created_at, l.actor, ids.member_id, l.meta->'patch'->>'consult_status' as status
  from relevant_logs l
  cross join lateral jsonb_array_elements_text(coalesce(l.meta->'ids', '[]'::jsonb)) ids(member_id)
  where l.action = 'member.bulk_update'
), normalized as (
  select
    case when p_period = 'month'
      then date_trunc('month', e.created_at at time zone 'Asia/Seoul')::date
      else date_trunc('week', e.created_at at time zone 'Asia/Seoul')::date end as period_key,
    case when p_dimension = 'staff' then coalesce(e.actor, '(미배정)') else coalesce(m.inflow_code, '(미상)') end as dim_key,
    case when p_dimension = 'staff' then coalesce(s.name, e.actor, '(미배정)') else coalesce(m.inflow_code, '(미상)') end as dim_label,
    e.status
  from events e
  join scoped_members m on m.id = e.member_id
  left join staff s on s.id = e.actor
  where e.status in ('신규','결번','부재','가망','승인','통화예약','도입거절','일반거절','기타')
), counts as (
  select period_key, dim_key, dim_label, status, count(*)::bigint as count
  from normalized group by 1, 2, 3, 4
), grouped as (
  select period_key, dim_key, dim_label,
    jsonb_object_agg(status, count) as counts,
    sum(count)::bigint as total
  from counts group by 1, 2, 3
)
select coalesce(jsonb_agg(jsonb_build_object(
  'periodKey', period_key::text,
  'periodLabel', case when p_period = 'month'
    then extract(year from period_key)::integer || '년 ' || extract(month from period_key)::integer || '월'
    else period_key::text || ' 주' end,
  'dimKey', dim_key,
  'dimLabel', dim_label,
  'counts', counts,
  'total', total
) order by period_key desc, total desc, dim_label), '[]'::jsonb)
from grouped
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_consult_report(text,text,date,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_consult_report(text,text,date,date,text) TO authenticated, service_role;

-- 기간 내 승인 결제를 DB에서 집계해 PostgREST 기본 행 제한에 따른 누락을 막는다.
-- 기존 매출 RPC와 같은 UID/운영역할 검증 후에만 RLS 우회 집계를 수행한다.
-- 사이트는 payments.meta가 아닌 계약 회원의 source_site에 귀속된다.
CREATE OR REPLACE FUNCTION public.admin_revenue_daily_summary(
  p_from date,
  p_to date,
  p_source_site text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.role := public.app_role();
  v_source_site text := public.admin_validate_source_site(p_source_site);
  v_result jsonb;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role::text NOT IN ('admin', 'manager', 'leader') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'insufficient privilege for revenue reports';
  END IF;

  WITH approved AS MATERIALIZED (
    SELECT (coalesce(p.paid_at, p.created_at) AT TIME ZONE 'Asia/Seoul')::date AS day,
      p.amount, p.method, s.role AS staff_role
    FROM public.payments p
    JOIN public.members m ON m.id = p.member_id
    LEFT JOIN public.staff s ON s.id = p.staff_id
    WHERE p.status = 'approved'::public.payment_status
      AND (coalesce(p.paid_at, p.created_at) AT TIME ZONE 'Asia/Seoul')::date
        BETWEEN least(p_from, p_to) AND greatest(p_from, p_to)
      AND (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
  ), totals AS (
    SELECT day,
      coalesce(sum(amount) FILTER (WHERE staff_role = 'rep'::public.role), 0)::bigint AS leader_total,
      coalesce(sum(amount) FILTER (WHERE staff_role <> 'rep'::public.role), 0)::bigint AS manager_total,
      coalesce(sum(amount) FILTER (WHERE method = 'pg'::public.payment_method), 0)::bigint AS card_total,
      coalesce(sum(amount) FILTER (WHERE method = 'bank'::public.payment_method), 0)::bigint AS bank_total,
      sum(amount)::bigint AS total, count(*)::bigint AS count
    FROM approved GROUP BY day
  ), workforce AS (
    SELECT day, head_count FROM public.daily_work_count
    WHERE v_source_site IS NULL
      AND day BETWEEN least(p_from, p_to) AND greatest(p_from, p_to)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'day', coalesce(t.day, w.day)::text,
    'headCount', coalesce(w.head_count, 0),
    'leaderTotal', coalesce(t.leader_total, 0),
    'managerTotal', coalesce(t.manager_total, 0),
    'cardTotal', coalesce(t.card_total, 0),
    'bankTotal', coalesce(t.bank_total, 0),
    'total', coalesce(t.total, 0),
    'count', coalesce(t.count, 0)
  ) ORDER BY coalesce(t.day, w.day) DESC), '[]'::jsonb)
  INTO v_result
  FROM totals t FULL OUTER JOIN workforce w ON w.day = t.day;
  RETURN v_result;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_revenue_daily_summary(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revenue_daily_summary(date, date, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
