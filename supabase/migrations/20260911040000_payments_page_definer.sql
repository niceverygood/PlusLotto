-- 결제 목록이 statement timeout 으로 통째로 안 보이던 것을 고친다 (현장 9/11).
--
-- 증상: 결제 > 승인 탭이 "데이터가 없습니다". 탭 건수는 1,537건인데 목록만 비어 있었다.
-- 직전 커밋에서 오류를 화면에 드러내자 실제 원인이 나왔다:
--   조회 오류: canceling statement due to statement timeout
--
-- 원인 — RLS 정책이 결제 행마다 회원 조회를 한 번씩 더 한다.
--   payments 의 정책은 `using (app_can_see_member(member_id))` 이고,
--   app_can_see_member 는 SECURITY DEFINER 함수라 플래너가 인라인할 수 없다.
--   따라서 스캔하는 결제 행마다 members 인덱스 조회가 한 번씩 따로 붙는다.
--   게다가 이 함수는 `total` 을 위해 같은 필터를 한 번 더 돌리므로 비용이 두 배다.
--
-- 실측(PG16 재현 환경 — 회원 150,000 · 결제 1,712 · 저장소와 동일한 RLS 정책):
--   현행(INVOKER)          : 100 ~ 111 ms, 버퍼 32,128
--   본 수정(DEFINER)       :  11 ~  17 ms
--   결제 1,712건짜리 화면이 버퍼 32,128개를 건드리고 있었다.
--   운영 인스턴스는 같은 날 EXPLAIN 에서 버퍼당 약 0.8ms 가 나왔다(콜드 캐시).
--   32,128 × 0.8ms ≈ 25초 → statement timeout 과 맞는다.
--
-- 처방 — D176(매출 RPC)에서 이미 쓴 방법을 그대로 적용한다.
--   SECURITY DEFINER 로 바꿔 행마다 도는 RLS 평가를 없애고, RLS 가 하던 가시성 판단을
--   쿼리 안에 명시적으로 되살린다.
--
-- 가시성 규칙은 그대로다. members_rw(0016) 와 app_can_see_member(0016) 가 정의하는 규칙은
--   admin·manager·leader → 전체 / rep → 본인 담당(assigned_staff_id) 회원
-- 이고, 아래 `(v_role <> 'rep' or m.assigned_staff_id = v_staff_id)` 한 줄이 정확히 같다.
-- 재현 환경 대조: 관리자 1,537건(기존과 동일), 담당자 512건(기존과 동일, 독립 집계와도 일치).
--
-- DEFINER 는 RLS 를 우회하므로 두 가지를 함께 건다.
--   ① 로그인·역할이 없으면 즉시 거부한다(비로그인 호출로 전체가 새지 않게).
--   ② search_path = '' 로 고정하고 모든 객체를 스키마까지 적어 탐색 경로 가로채기를 막는다.
--
-- 본문 로직·시그니처·반환 모양은 20260909001521 판과 동일하다. 바뀌는 것은
-- DEFINER 전환, 역할 게이트, 가시성 조건 한 줄, 스키마 한정뿐이다.

CREATE OR REPLACE FUNCTION public.admin_payment_counts(p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
  v_role public.role := public.app_role();
  v_staff_id text := public.app_staff_id();
BEGIN
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'insufficient privilege for payments';
  END IF;
  RETURN (
select jsonb_build_object(
  'all', count(*),
  'wait', count(*) filter (where p.status::text = 'wait'),
  'approved', count(*) filter (where p.status::text = 'approved'),
  'failed', count(*) filter (where p.status::text = 'failed'),
  'cancelled', count(*) filter (where p.status::text = 'cancelled')
) from public.payments p join public.members m on m.id = p.member_id
where (v_role::text <> 'rep' or m.assigned_staff_id = v_staff_id)
  and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_payment_counts(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_payment_counts(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_payments_page(p_filter jsonb DEFAULT '{}'::jsonb, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50, p_sort_id text DEFAULT NULL::text, p_sort_desc boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_filter->>'sourceSite');
  v_role public.role := public.app_role();
  v_staff_id text := public.app_staff_id();
BEGIN
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'insufficient privilege for payments';
  END IF;
  RETURN (
with filtered as not materialized (
  select p.*,
    jsonb_build_object('id', m.id, 'name', m.name, 'user_id', m.user_id, 'inflow_code', m.inflow_code) as member,
    case when pr.id is null then null else jsonb_build_object('id', pr.id, 'name', pr.name, 'grade_granted', pr.grade_granted) end as product
  from public.payments p
  join public.members m on m.id = p.member_id
  left join public.products pr on pr.id = p.product_id
  where (v_role::text <> 'rep' or m.assigned_staff_id = v_staff_id)
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
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
