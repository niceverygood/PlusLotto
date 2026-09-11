-- 국내번호 후보와 같은 +82/0082 표기 기존 회원도 원자 이관 전에 거부한다.
-- 전화 충돌 semi-join의 우변만 다섯 표현으로 확장한다. 좌변 인덱스 식,
-- 기존 잠금/검사 순서/원자성/권한은 유지하며 회원/설정/로그를 변경하지 않는다.
CREATE OR REPLACE FUNCTION public.admin_import_815_review_batch(
  p_batch_id text,
  p_members jsonb,
  p_payments jsonb,
  p_expected_member_count integer,
  p_expected_payment_count integer,
  p_expected_amount bigint
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' SET lock_timeout = '3s'
AS $function$
DECLARE
  v_count integer;
  v_amount bigint;
  v_phone text;
  v_members integer;
  v_payments integer;
BEGIN
  IF p_batch_id IS NULL OR p_batch_id !~ '^lotto815-[A-Za-z0-9._-]{1,55}$'
     OR p_expected_member_count IS NULL OR p_expected_member_count NOT BETWEEN 1 AND 500
     OR p_expected_payment_count IS NULL OR p_expected_payment_count NOT BETWEEN 0 AND 10000
     OR p_expected_amount IS NULL OR p_expected_amount < 0
     OR pg_catalog.jsonb_typeof(p_members) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(p_payments) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid 815 review batch envelope';
  END IF;
  IF pg_catalog.jsonb_array_length(p_members) <> p_expected_member_count
     OR pg_catalog.jsonb_array_length(p_payments) <> p_expected_payment_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '815 review batch count mismatch';
  END IF;

  -- 일반 조회는 허용하고 짧은 배치 동안 INSERT/UPDATE를 직렬화한다.
  -- 전화 UPDATE는 기존 전화 advisory lock을 쓰지 않으며 user_id도 UNIQUE가 아니다.
  -- 이를 사전 대조와 INSERT 사이에 변경하지 못하도록 함께 보호한다. 3초 안에 잠금을
  -- 얻지 못하면 이번 이관만 중단하고 자동 재시도하지 않는다.
  LOCK TABLE public.members, public.payments IN SHARE ROW EXCLUSIVE MODE;
  -- 같은 배치의 동시 호출을 직렬화한다. 이미 저장된 배치를 다시 실행하지 않는다.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('815-import:' || p_batch_id, 0));
  IF EXISTS (SELECT 1 FROM public.members WHERE meta->>'source_site' = 'lotto815' AND meta->>'import_batch' = p_batch_id)
     OR EXISTS (SELECT 1 FROM public.payments WHERE meta->>'source_site' = 'lotto815' AND meta->>'import_batch' = p_batch_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = '815 review batch already exists; verify without reinserting';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_members) AS t(r)
    WHERE (
      pg_catalog.jsonb_typeof(r) = 'object'
      AND r->>'id' ~ '^mem_[0-9a-f-]{36}$'
      AND coalesce(r->>'user_id', '') <> ''
      AND r->>'phone' ~ '^01[0-9]{8,9}$'
      AND pg_catalog.jsonb_typeof(r->'meta') = 'object'
      AND r->'meta'->>'source_site' = 'lotto815'
      AND r->'meta'->>'import_batch' = p_batch_id
      AND r->'meta'->>'legacy_idx' ~ '^[1-9][0-9]*$'
      AND r->'meta'->'reco_paused' = 'true'::jsonb
      AND r->'meta'->>'reco_pause_reason' = 'legacy_import_review'
      AND r->'meta'->'legacy_consent_review_required' = 'true'::jsonb
      AND r->'meta'->>'legacy_agree_sms_yn' IN ('Y', 'N')
      AND r->'meta'->'legacy_account_flags' @> '{"groupSystemYN":"N","groupAdminYN":"N","groupPartnerYN":"N","groupSalesYN":"N","groupSecondSalesYN":"N","groupStaffYN":"N","groupDummyYN":"N","groupTeamAdmYN":"N","groupTeamYN":"N"}'::jsonb
      AND r->>'assigned_staff_id' IS NULL AND r->>'team_id' IS NULL
      AND r->'is_suspended' = pg_catalog.to_jsonb(r->>'status' = 'suspended')
      AND r->'is_deleted' = pg_catalog.to_jsonb(r->>'status' = 'deleted')
      AND r->'is_withdrawn' = pg_catalog.to_jsonb(r->>'status' = 'withdrawn')
      AND NOT (r->'meta' ? 'weekly_recos')
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '815 member source, role, consent or hold validation failed';
  END IF;
  SELECT count(DISTINCT r->>'id') INTO v_count FROM pg_catalog.jsonb_array_elements(p_members) t(r);
  IF v_count <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate 815 member id in payload';
  END IF;
  SELECT count(DISTINCT r->>'phone') INTO v_count FROM pg_catalog.jsonb_array_elements(p_members) t(r);
  IF v_count <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate 815 phone in payload';
  END IF;
  SELECT count(DISTINCT r->'meta'->>'legacy_idx') INTO v_count FROM pg_catalog.jsonb_array_elements(p_members) t(r);
  IF v_count <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate 815 source member key in payload';
  END IF;
  SELECT count(DISTINCT r->>'user_id') INTO v_count FROM pg_catalog.jsonb_array_elements(p_members) t(r);
  IF v_count <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate 815 login id in payload';
  END IF;

  -- 기존 INSERT 트리거와 같은 전화 lock을 정렬 순서로 선점한다.
  FOR v_phone IN SELECT r->>'phone' FROM pg_catalog.jsonb_array_elements(p_members) t(r) ORDER BY r->>'phone' LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_phone, 0));
  END LOOP;
  -- 각 식별자는 독립 semi-join으로 대조한다. OR 조인은 전체 회원 × 후보만큼
  -- 전화 정규식을 반복 계산해 운영 REST 시간 제한을 넘길 수 있다.
  IF EXISTS (SELECT 1 FROM public.members m
      WHERE m.id IN (SELECT r->>'id' FROM pg_catalog.jsonb_array_elements(p_members) t(r)))
     OR EXISTS (SELECT 1 FROM public.members m
      WHERE m.user_id IN (SELECT r->>'user_id' FROM pg_catalog.jsonb_array_elements(p_members) t(r)))
     OR EXISTS (SELECT 1 FROM public.members m
      WHERE pg_catalog.regexp_replace(m.phone, '\D', '', 'g') IN
        (SELECT representation.digits
         FROM pg_catalog.jsonb_array_elements(p_members) t(r)
         CROSS JOIN LATERAL pg_catalog.unnest(ARRAY[
           r->>'phone',
           '82' || pg_catalog.substr(r->>'phone', 2),
           '0082' || pg_catalog.substr(r->>'phone', 2),
           '82' || (r->>'phone'),
           '0082' || (r->>'phone')
         ]) AS representation(digits)))
     OR EXISTS (SELECT 1 FROM public.members m WHERE m.meta->>'source_site' = 'lotto815'
      AND m.meta->>'legacy_idx' IN (SELECT r->'meta'->>'legacy_idx' FROM pg_catalog.jsonb_array_elements(p_members) t(r))) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = '815 candidate conflicts with an existing member';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_payments) t(r)
    WHERE (
      pg_catalog.jsonb_typeof(r) = 'object'
      AND r->>'id' ~ '^pay_[0-9a-f-]{36}$'
      AND r->>'member_id' IN (SELECT m->>'id' FROM pg_catalog.jsonb_array_elements(p_members) s(m))
      AND r->>'product_id' IN ('legacy_lotto815_family', 'legacy_lotto815_mania', 'legacy_lotto815_first')
      AND r->>'status' = 'approved'
      AND pg_catalog.jsonb_typeof(r->'amount') = 'number'
      AND r->>'amount' ~ '^[0-9]+$'
      AND r->>'staff_id' IS NULL
      AND r->'meta'->>'source_site' = 'lotto815'
      AND r->'meta'->>'import_batch' = p_batch_id
      AND r->'meta'->>'legacy_idx' ~ '^[1-9][0-9]*$'
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '815 payment source, link or amount validation failed';
  END IF;
  SELECT count(DISTINCT r->>'id'), coalesce(sum((r->>'amount')::bigint), 0)
    INTO v_count, v_amount FROM pg_catalog.jsonb_array_elements(p_payments) t(r);
  IF v_count <> p_expected_payment_count OR v_amount <> p_expected_amount THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '815 payment id count or amount mismatch';
  END IF;
  SELECT count(DISTINCT r->'meta'->>'legacy_idx') INTO v_count FROM pg_catalog.jsonb_array_elements(p_payments) t(r);
  IF v_count <> p_expected_payment_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate 815 payment source key in payload';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments p
      WHERE p.id IN (SELECT r->>'id' FROM pg_catalog.jsonb_array_elements(p_payments) t(r)))
     OR EXISTS (SELECT 1 FROM public.payments p WHERE p.meta->>'source_site' = 'lotto815'
      AND p.meta->>'legacy_idx' IN (SELECT r->'meta'->>'legacy_idx' FROM pg_catalog.jsonb_array_elements(p_payments) t(r))) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = '815 candidate conflicts with an existing payment';
  END IF;

  INSERT INTO public.members (
    id, user_id, name, nickname, phone, grade, status, consult_status, outcall_done,
    inflow_code, inflow_type, memo, registered_at, last_active_at,
    is_suspended, is_deleted, is_withdrawn, meta
  ) SELECT
    id, user_id, name, nickname, phone, grade, status, consult_status, outcall_done,
    inflow_code, inflow_type, memo, registered_at, last_active_at,
    is_suspended, is_deleted, is_withdrawn, meta
  FROM pg_catalog.jsonb_populate_recordset(NULL::public.members, p_members);
  GET DIAGNOSTICS v_members = ROW_COUNT;
  IF v_members <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '815 member insert count mismatch; transaction rolled back';
  END IF;
  -- 결제까지 한 요청 안에서 처리하므로 어느 단계든 실패하면 회원과 부수효과도 롤백된다.
  INSERT INTO public.payments (
    id, member_id, product_id, amount, method, status, period_start, period_end,
    depositor_name, paid_at, created_at, meta
  ) SELECT
    id, member_id, product_id, amount, method, status, period_start, period_end,
    depositor_name, paid_at, created_at, meta
  FROM pg_catalog.jsonb_populate_recordset(NULL::public.payments, p_payments);
  GET DIAGNOSTICS v_payments = ROW_COUNT;
  IF v_payments <> p_expected_payment_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '815 payment insert count mismatch; transaction rolled back';
  END IF;
  SELECT count(*) INTO v_count FROM public.members
    WHERE meta->>'source_site' = 'lotto815' AND meta->>'import_batch' = p_batch_id
      AND meta->'reco_paused' = 'true'::jsonb AND meta->>'reco_pause_reason' = 'legacy_import_review'
      AND assigned_staff_id IS NULL AND team_id IS NULL;
  IF v_count <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '815 inserted hold or assignment state mismatch; transaction rolled back';
  END IF;
  RETURN pg_catalog.jsonb_build_object('batch_id', p_batch_id, 'members', v_members,
    'payments', v_payments, 'amount', v_amount, 'held_members', v_count, 'atomic', true);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_import_815_review_batch(text,jsonb,jsonb,integer,integer,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_import_815_review_batch(text,jsonb,jsonb,integer,integer,bigint) TO service_role;
COMMENT ON FUNCTION public.admin_import_815_review_batch(text,jsonb,jsonb,integer,integer,bigint) IS
  '서버 전용 815 검수 보류 신규행 원자적 이관. 기존 회원·상품·설정 수정과 문자 발송 없이 전체 성공 또는 전체 취소.';
