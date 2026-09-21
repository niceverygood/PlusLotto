-- 이관 검수 보류 대상 사이트에 88로또(lotto88)를 추가한다.
--
-- 88로또는 신전산으로 통째로 옮겨온 뒤 전환일(2026-10-05)에 발송 대상으로 활성화된다
-- (docs/LOTTO88_MIGRATION_PLAN.md 4단계). 그 전까지 적재된 회원에게 문자가 나가면
-- 아직 운영 시작 전인 회원에게 발송되는 사고가 된다. 앞선 세 사이트와 같은 게이트를 태운다.
--
-- 함수 본문은 20260910000100_legacy_sms_import_hold.sql 과 동일하고 IN 목록만 바뀐다.
-- 이 목록은 src/lib/legacySites.ts · api/send-sms.ts 와 같아야 하며,
-- scripts/tests/legacy-site-list-sync.test.ts 가 세 곳의 일치를 강제한다.

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
      AND m.meta->>'source_site' IN ('lotto815', 'cplotto', 'infolotto', 'lotto88')
      AND m.meta->>'reco_pause_reason' = 'legacy_import_review'
      AND m.meta->'reco_paused' = 'true'::jsonb
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.sms_is_legacy_import_held(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sms_is_legacy_import_held(text) TO service_role;
COMMENT ON FUNCTION public.sms_is_legacy_import_held(text) IS
  '문자 서버 전용: 동일 수신번호의 레거시 회원 중 이관 검토 보류가 있는지 boolean만 반환. 회원/설정 변경 없음.';
