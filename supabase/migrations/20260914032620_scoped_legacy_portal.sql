-- 전화번호가 같아도 사이트별 계약/추천 내역을 섞지 않는다.
-- 비밀번호와 기존 회원 데이터는 변경하지 않는다. 구형 요청은 플러스만 조회한다.
CREATE OR REPLACE FUNCTION public.portal_member_recos_for_site(
  p_phone text, p_pw text, p_source_site text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_digits text := pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_domestic text;
  v_forms text[];
  v_count integer;
  m public.members%ROWTYPE;
  expected_pw text;
BEGIN
  IF p_source_site IS NULL OR p_source_site NOT IN ('pluslotto','lotto815','infolotto','cplotto')
    OR p_pw IS NULL OR p_pw = '' THEN
    RETURN NULL;
  END IF;
  IF pg_catalog.left(v_digits,4) = '0082' THEN
    v_domestic := pg_catalog.substr(v_digits,5);
  ELSIF pg_catalog.left(v_digits,2) = '82' THEN
    v_domestic := pg_catalog.substr(v_digits,3);
  ELSE
    v_domestic := v_digits;
  END IF;
  IF v_domestic <> v_digits AND pg_catalog.left(v_domestic,1) <> '0' THEN
    v_domestic := '0' || v_domestic;
  END IF;
  IF v_domestic !~ '^0[0-9]{8,10}$' THEN RETURN NULL; END IF;
  v_forms := ARRAY[v_domestic, '82'||pg_catalog.substr(v_domestic,2),
    '0082'||pg_catalog.substr(v_domestic,2), '82'||v_domestic, '0082'||v_domestic];

  SELECT count(*) INTO v_count FROM public.members x
  WHERE public.member_operating_site(x) = p_source_site
    AND pg_catalog.regexp_replace(x.phone, '\D', '', 'g') = ANY(v_forms)
    AND NOT coalesce(x.is_deleted,false) AND NOT coalesce(x.is_withdrawn,false);
  -- 플러스는 기존 최신 가입자 선택을 유지하되 반드시 사이트로 먼저 제한한다.
  -- 이관 사이트는 복수 유효 계정을 임의 선택하지 않는다.
  IF v_count = 0 OR (p_source_site <> 'pluslotto' AND v_count <> 1) THEN RETURN NULL; END IF;
  SELECT x.* INTO m FROM public.members x
  WHERE public.member_operating_site(x) = p_source_site
    AND pg_catalog.regexp_replace(x.phone, '\D', '', 'g') = ANY(v_forms)
    AND NOT coalesce(x.is_deleted,false) AND NOT coalesce(x.is_withdrawn,false)
  ORDER BY x.registered_at DESC LIMIT 1;
  expected_pw := coalesce(m.meta->>'homepage_pw',
    pg_catalog.right(pg_catalog.regexp_replace(m.phone, '\D', '', 'g'),4));
  IF p_pw <> expected_pw THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object('name',m.name,'grade',m.grade,
    'recos',coalesce(m.meta->'weekly_recos','[]'::jsonb));
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.portal_member_recos_for_site(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_member_recos_for_site(text,text,text) TO anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.portal_member_recos(p_phone text,p_pw text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
  SELECT public.portal_member_recos_for_site(p_phone,p_pw,'pluslotto');
$function$;
REVOKE EXECUTE ON FUNCTION public.portal_member_recos(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_member_recos(text,text) TO anon,authenticated,service_role;
COMMENT ON FUNCTION public.portal_member_recos_for_site(text,text,text) IS
  '사이트를 먼저 제한한 고객 조회. 플러스는 기존 최신가입자 선택 유지, 이관 사이트는 유일한 회원만 비밀번호 확인 후 최소 추천정보 반환.';
