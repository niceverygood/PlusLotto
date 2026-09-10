-- 이관 배치의 보류 상태를 한 번의 읽기로 검증한다. 발송/회원 갱신 기능 없음.
CREATE INDEX IF NOT EXISTS members_815_import_batch_idx
  ON public.members ((meta->>'import_batch'), id)
  WHERE meta->>'source_site' = 'lotto815';

CREATE OR REPLACE FUNCTION public.admin_verify_815_batch_holds(p_batch_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF p_batch_id IS NULL OR p_batch_id !~ '^lotto815-[a-z0-9][a-z0-9-]{0,95}$' THEN
    RAISE EXCEPTION 'Invalid 815 batch audit request' USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::integer INTO v_count FROM (
    SELECT 1 FROM public.members m
    WHERE m.meta->>'source_site' = 'lotto815' AND m.meta->>'import_batch' = p_batch_id
    LIMIT 501
  ) limited;
  IF v_count > 500 THEN
    RAISE EXCEPTION '815 batch audit exceeds 500 members' USING ERRCODE = '22023';
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'batch_id', p_batch_id,
      'members', count(*),
      'held_metadata_members', count(*) FILTER (
        WHERE m.meta->'reco_paused' = 'true'::jsonb
          AND m.meta->>'reco_pause_reason' = 'legacy_import_review'),
      'held_rpc_members', count(*) FILTER (WHERE public.sms_is_legacy_import_held(m.phone)),
      'consent_review_members', count(*) FILTER (
        WHERE m.meta->'legacy_consent_review_required' = 'true'::jsonb)
    )
    FROM public.members m
    WHERE m.meta->>'source_site' = 'lotto815' AND m.meta->>'import_batch' = p_batch_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_verify_815_batch_holds(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_verify_815_batch_holds(text) TO service_role;
COMMENT ON FUNCTION public.admin_verify_815_batch_holds(text) IS
  'Read-only 815 import batch hold audit, maximum 500 members, service_role only; never sends SMS or changes rows.';
