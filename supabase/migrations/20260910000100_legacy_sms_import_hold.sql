-- 레거시 이관 검토가 끝나기 전에는 같은 수신번호로 들어오는 모든 문자 경로를 보류한다.
-- 문자 서버의 service_role만 호출하며, 회원/설정/기존 RLS는 변경하지 않는다.
-- 먼저 이 함수를 적용한 뒤 문자 서버에서 호출한다. API 없이 적용해도 기존 동작은 동일하다.
CREATE OR REPLACE FUNCTION public.sms_is_legacy_import_held(p_phone text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_digits text := pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_domestic text;
  v_phone_representations text[];
BEGIN
  IF v_digits = '' THEN
    RETURN false;
  END IF;

  -- +82 / 0082 모두 국내의 선행 0 유무에 관계없이 같은 수신번호로 취급한다.
  IF pg_catalog.left(v_digits, 4) = '0082' THEN
    v_domestic := pg_catalog.substr(v_digits, 5);
  ELSIF pg_catalog.left(v_digits, 2) = '82' THEN
    v_domestic := pg_catalog.substr(v_digits, 3);
  ELSE
    v_domestic := v_digits;
  END IF;
  IF v_domestic = '' THEN
    RETURN false;
  END IF;
  IF v_domestic <> v_digits AND pg_catalog.left(v_domestic, 1) <> '0' THEN
    v_domestic := '0' || v_domestic;
  END IF;

  v_phone_representations := ARRAY[v_domestic];
  IF pg_catalog.left(v_domestic, 1) = '0' AND pg_catalog.length(v_domestic) > 1 THEN
    v_phone_representations := ARRAY[
      v_domestic,
      '82' || pg_catalog.substr(v_domestic, 2),
      '0082' || pg_catalog.substr(v_domestic, 2),
      '82' || v_domestic,
      '0082' || v_domestic
    ];
  END IF;

  -- 좌변은 members_phone_digits_idx와 같은 식을 유지한다.
  -- 중복 수신번호 중 한 회원이라도 검토 중이면 보류한다. 일반 일시정지는 대상이 아니다.
  -- JSON 문자열 "true"를 boolean true로 해석하지 않는다. 명시적 false로 보류 해제 가능.
  RETURN EXISTS (
    SELECT 1
    FROM public.members AS m
    WHERE pg_catalog.regexp_replace(m.phone, '\D', '', 'g') = ANY(v_phone_representations)
      AND m.meta->>'source_site' IN ('lotto815', 'cplotto', 'infolotto')
      AND m.meta->>'reco_pause_reason' = 'legacy_import_review'
      AND m.meta->'reco_paused' = 'true'::jsonb
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.sms_is_legacy_import_held(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sms_is_legacy_import_held(text) TO service_role;
COMMENT ON FUNCTION public.sms_is_legacy_import_held(text) IS
  '문자 서버 전용: 동일 수신번호의 레거시 회원 중 이관 검토 보류가 있는지 boolean만 반환. 회원/설정 변경 없음.';
