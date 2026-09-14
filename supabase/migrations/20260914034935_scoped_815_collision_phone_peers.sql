-- 815 충돌 이관의 반복 전수 조회를 전화번호/예정 ID의 인덱스 조회로 좁힌다.
-- 모든 사이트의 같은 번호 계약과 전화번호가 바뀐 예정 ID도 포함한다.
-- 읽기 전용이며 회원/결제/발송 데이터를 변경하지 않는다.
CREATE OR REPLACE FUNCTION public.admin_815_collision_phone_peers(
  p_phones text[],
  p_member_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_phone_forms text[];
  v_result jsonb;
BEGIN
  -- EXECUTE 권한과 실제 실행 역할을 모두 좁힌다. 관리자 사용자도 호출하지 못한다.
  IF pg_catalog.current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Service role required';
  END IF;
  IF p_phones IS NULL OR p_member_ids IS NULL
     OR pg_catalog.array_ndims(p_phones) IS DISTINCT FROM 1
     OR pg_catalog.array_ndims(p_member_ids) IS DISTINCT FROM 1
     OR pg_catalog.cardinality(p_phones) NOT BETWEEN 1 AND 2666
     OR pg_catalog.cardinality(p_member_ids) NOT BETWEEN 1 AND 2666
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_phones) AS p(phone)
                WHERE p.phone IS NULL OR p.phone !~ '^01[0-9]{8,9}$')
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_member_ids) AS p(id)
                WHERE p.id IS NULL OR p.id !~ '^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid 815 phone peer query scope';
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT spelling.digits) INTO v_phone_forms
  FROM pg_catalog.unnest(p_phones) AS p(phone)
  CROSS JOIN LATERAL pg_catalog.unnest(ARRAY[
    p.phone,
    '82' || pg_catalog.substr(p.phone, 2),
    '0082' || pg_catalog.substr(p.phone, 2),
    '82' || p.phone,
    '0082' || p.phone
  ]) AS spelling(digits);

  -- OR로 서로 다른 인덱스 조건을 합치지 않는다. 전화번호 BTREE와 PK를 각각
  -- 사용해 ID 합집합을 구한 뒤, 단일 문장 snapshot으로 식별 필드만 반환한다.
  -- JSON 배열 하나를 반환하므로 PostgREST의 테이블 반환 행수 제한에 잘리지 않는다.
  WITH wanted AS (
    SELECT m.id FROM public.members AS m
    WHERE pg_catalog.regexp_replace(m.phone, '\D', '', 'g') = ANY(v_phone_forms)
    UNION
    SELECT m.id FROM public.members AS m
    WHERE m.id = ANY(p_member_ids)
  )
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', m.id,
    'user_id', m.user_id,
    'phone', m.phone,
    'source_site', m.meta->>'source_site',
    'legacy_idx', m.meta->>'legacy_idx',
    'import_batch', m.meta->>'import_batch'
  ) ORDER BY m.id), '[]'::jsonb)
  INTO v_result
  FROM wanted AS w
  JOIN public.members AS m ON m.id = w.id;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_815_collision_phone_peers(text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_815_collision_phone_peers(text[],text[]) TO service_role;
COMMENT ON FUNCTION public.admin_815_collision_phone_peers(text[],text[]) IS
  '서비스 전용 읽기 조회. 국내 전화번호 5개 표현의 전체 사이트 계약과 예정 ID를 합쳐 반환하며, 이관 중 기존/예정 계약의 식별 변경을 검증한다.';
