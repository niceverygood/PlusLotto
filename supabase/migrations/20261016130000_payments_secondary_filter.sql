-- 결제내역 2차담당자 필터 (현장 10/16, 정의현 차장 — "결제내역 페이지에서도 2차담당자 필터 추가 부탁드립니다").
-- 결제 건의 회원(members.secondary_staff_id) 기준. 이용자 목록(admin_members_page)과 같은 키:
--   secondaryStaffId = 특정 2차담당자, hasSecondary = false 면 2차 미지정 회원의 결제.
-- 운영 정의(20260911040000 과 같음을 확인)를 그대로 옮기고 조건만 더했다. 시그니처·권한 변경 없음.
CREATE OR REPLACE FUNCTION public.admin_payments_page(p_filter jsonb DEFAULT '{}'::jsonb, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50, p_sort_id text DEFAULT NULL::text, p_sort_desc boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
    and (not (p_filter ? 'secondaryStaffId') or m.secondary_staff_id = p_filter->>'secondaryStaffId')
    and (
      not (p_filter ? 'hasSecondary')
      or (m.secondary_staff_id is not null) = ((p_filter->>'hasSecondary')::boolean)
    )
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
