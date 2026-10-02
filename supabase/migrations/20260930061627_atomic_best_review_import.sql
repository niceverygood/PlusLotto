-- 전달된 2026-09-29 프리미엄로또 자료만 검수 보류 상태로 원자적으로 추가한다.
-- 기존 고객 갱신·전화번호 alias 병합·담당자/인증계정 생성·문자 발송은 하지 않는다.
-- 타 사이트의 동일 전화번호는 별도 계약으로 보존하며 best 내부 중복은 거절한다.
CREATE OR REPLACE FUNCTION public.admin_import_best_review_batch(
  p_batch_id text,
  p_members jsonb,
  p_payments jsonb,
  p_expected_member_count integer,
  p_expected_payment_count integer,
  p_expected_amount bigint
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = '' SET lock_timeout = '3s' SET statement_timeout = '60s'
AS $function$
DECLARE
  v_count integer;
  v_amount bigint;
  v_phone text;
  v_members integer;
  v_payments integer;
  v_source_sha constant text := '433ce78f8e86966cc948282d59fd3c165afc2da3a9a52a8df720408d1d5d9818';
  v_receipt jsonb;
  v_log_count integer;
  v_stored_payment_count integer;
  v_stored_payment_amount bigint;
  v_phone_forms text[];
  v_input_member_ids text[];
  v_protected_member_ids text[];
  v_protected_payment_ids text[];
  v_members_before jsonb;
  v_members_after jsonb;
  v_payments_before jsonb;
  v_payments_after jsonb;
BEGIN
  -- EXECUTE 권한 외에 실행 역할도 확인한다. 직원 JWT와 SQL Editor 기본 역할은 거절한다.
  IF pg_catalog.current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Service role required';
  END IF;
  IF p_batch_id IS NULL OR p_batch_id !~ '^best-review-20260930-[0-9]{1,4}$'
     OR p_expected_member_count IS NULL OR p_expected_member_count NOT BETWEEN 1 AND 100
     OR p_expected_payment_count IS NULL OR p_expected_payment_count NOT BETWEEN 0 AND 1000
     OR p_expected_amount IS NULL OR p_expected_amount < 0
     OR pg_catalog.jsonb_typeof(p_members) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(p_payments) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid best review batch envelope';
  END IF;
  IF pg_catalog.jsonb_array_length(p_members) <> p_expected_member_count
     OR pg_catalog.jsonb_array_length(p_payments) <> p_expected_payment_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'best review batch count mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_members) AS t(r)
    WHERE (
      pg_catalog.jsonb_typeof(r) = 'object'
      AND r->>'id' ~ '^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND coalesce(pg_catalog.btrim(r->>'user_id'), '') <> ''
      -- 원본 이름이 비어 있어도 임의의 고객명을 만들지 않는다. 식별·연락 검증은
      -- 별도 필드로 수행하며, 운영 화면에서 검수 시 이름 미기재를 확인할 수 있다.
      AND r->>'name' IS NOT NULL
      AND r->>'phone' ~ '^01[0-9]{8,9}$'
      AND r->>'grade' = CASE r->'meta'->>'legacy_level_num'
        WHEN '0' THEN 'simple' WHEN '1' THEN 'free' WHEN '2' THEN 'goldp'
        WHEN '3' THEN 'vip' WHEN '4' THEN 'royal' WHEN '6' THEN 'vip' END
      AND r->>'status' = CASE r->'meta'->>'legacy_status'
        WHEN 'normal' THEN 'active' WHEN 'standby' THEN 'active' WHEN 'end' THEN 'active'
        WHEN 'block' THEN 'suspended' WHEN 'remove' THEN 'deleted' WHEN 'leave' THEN 'withdrawn' END
      AND r->>'registered_at' IS NOT NULL
      AND pg_catalog.jsonb_typeof(r->'meta') = 'object'
      AND r->'meta'->>'source_site' = 'best'
      AND r->'meta'->>'import_batch' = p_batch_id
      AND r->'meta'->>'legacy_source_sha256' = v_source_sha
      AND r->'meta'->'imported' = 'true'::jsonb
      AND r->'meta'->>'legacy_idx' ~ '^[1-9][0-9]*$'
      AND r->'meta'->'reco_paused' = 'true'::jsonb
      AND r->'meta'->>'reco_pause_reason' = 'legacy_import_review'
      AND r->'meta'->'legacy_consent_review_required' = 'true'::jsonb
      AND r->'meta'->>'legacy_agree_sms_yn' IN ('Y', 'N')
      AND r->'meta'->'legacy_account_flags' = '{"groupSystemYN":"N","groupAdminYN":"N","groupPartnerYN":"N","groupSalesYN":"N","groupSecondSalesYN":"N","groupStaffYN":"N","groupDummyYN":"N","groupTeamAdmYN":"N","groupTeamYN":"N"}'::jsonb
      AND r->>'assigned_staff_id' IS NULL AND r->>'team_id' IS NULL
      AND r->'is_suspended' = pg_catalog.to_jsonb(r->>'status' = 'suspended')
      AND r->'is_deleted' = pg_catalog.to_jsonb(r->>'status' = 'deleted')
      AND r->'is_withdrawn' = pg_catalog.to_jsonb(r->>'status' = 'withdrawn')
      AND NOT (r->'meta' ?| ARRAY['weekly_recos', 'pw', 'password', 'token', 'ci', 'di'])
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_object_keys(r) k(key)
        WHERE key <> ALL (ARRAY['id','user_id','name','nickname','phone','grade','status','consult_status','outcall_done',
          'inflow_code','inflow_type','memo','registered_at','last_active_at','is_suspended','is_deleted','is_withdrawn',
          'meta','assigned_staff_id','team_id'])
      )
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'best member source, role, consent or hold validation failed';
  END IF;
  SELECT count(DISTINCT r->>'id') INTO v_count FROM pg_catalog.jsonb_array_elements(p_members) t(r);
  IF v_count <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate best member id in payload';
  END IF;
  SELECT count(DISTINCT r->>'phone') INTO v_count FROM pg_catalog.jsonb_array_elements(p_members) t(r);
  IF v_count <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate best phone in payload';
  END IF;
  SELECT count(DISTINCT r->'meta'->>'legacy_idx') INTO v_count FROM pg_catalog.jsonb_array_elements(p_members) t(r);
  IF v_count <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate best source member key in payload';
  END IF;
  SELECT count(DISTINCT r->>'user_id') INTO v_count FROM pg_catalog.jsonb_array_elements(p_members) t(r);
  IF v_count <> p_expected_member_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate best login id in payload';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_payments) t(r)
    WHERE (
      pg_catalog.jsonb_typeof(r) = 'object'
      AND r->>'id' ~ '^pay_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_members) s(m)
        WHERE m->>'id' = r->>'member_id' AND m->'meta'->>'legacy_idx' = r->'meta'->>'legacy_user_idx')
      AND r->>'product_id' = CASE r->'meta'->>'legacy_item_code'
        WHEN 'premium' THEN 'legacy_best_premium' WHEN 'vip' THEN 'legacy_best_vip'
        WHEN 'royal' THEN 'legacy_best_royal' WHEN 'unbalance' THEN 'legacy_best_unbalance' END
      AND r->>'status' = 'approved'
      AND r->'meta'->>'legacy_status' = 'success'
      -- 대응표에 없는 원본 결제수단은 unknown과 원문으로 보존한다. 수기/PG로 추정하지 않는다.
      AND r->>'method' = CASE r->'meta'->>'legacy_payment_method_code'
        WHEN 'officeCredit' THEN 'manual' WHEN 'siteBank' THEN 'bank'
        WHEN 'siteCredit' THEN 'pg' ELSE 'unknown' END
      AND pg_catalog.jsonb_typeof(r->'meta'->'legacy_payment_method_code') = 'string'
      AND r->'meta'->'legacy_payment_method_review_required' =
        pg_catalog.to_jsonb(r->'meta'->>'legacy_payment_method_code' NOT IN ('officeCredit','siteBank','siteCredit'))
      AND r->'meta'->'legacy_item_won' = r->'amount'
      AND pg_catalog.jsonb_typeof(r->'amount') = 'number'
      AND r->>'amount' ~ '^[0-9]+$'
      AND r->>'created_at' IS NOT NULL
      AND r->>'staff_id' IS NULL
      AND r->'meta'->>'source_site' = 'best'
      AND r->'meta'->>'import_batch' = p_batch_id
      AND r->'meta'->>'legacy_source_sha256' = v_source_sha
      AND r->'meta'->>'legacy_idx' ~ '^[1-9][0-9]*$'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_object_keys(r) k(key)
        WHERE key <> ALL (ARRAY['id','member_id','product_id','amount','method','status','period_start','period_end',
          'depositor_name','paid_at','created_at','meta','staff_id'])
      )
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'best payment source, link, product or amount validation failed';
  END IF;
  SELECT count(DISTINCT r->>'id'), coalesce(sum((r->>'amount')::bigint), 0)
    INTO v_count, v_amount FROM pg_catalog.jsonb_array_elements(p_payments) t(r);
  IF v_count <> p_expected_payment_count OR v_amount <> p_expected_amount THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'best payment id count or amount mismatch';
  END IF;
  SELECT count(DISTINCT r->'meta'->>'legacy_idx') INTO v_count FROM pg_catalog.jsonb_array_elements(p_payments) t(r);
  IF v_count <> p_expected_payment_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Duplicate best payment source key in payload';
  END IF;

  -- 짧은 잠금 동안 기존 회원/결제의 PK·전화·로그인·원본키 사전 대조와 INSERT를 직렬화한다.
  -- 3초 안에 잠금을 얻지 못하면 이관 배치만 실패한다. 기존 데이터에 UPDATE 하지 않는다.
  LOCK TABLE public.members, public.payments IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('best-import:' || p_batch_id, 0));
  IF EXISTS (SELECT 1 FROM public.members WHERE meta->>'source_site' = 'best' AND meta->>'import_batch' = p_batch_id)
     OR EXISTS (SELECT 1 FROM public.payments WHERE meta->>'source_site' = 'best' AND meta->>'import_batch' = p_batch_id)
     OR EXISTS (SELECT 1 FROM public.logs WHERE id = 'log_' || p_batch_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'best review batch already exists; verify without reinserting';
  END IF;
  FOR v_phone IN SELECT r->>'phone' FROM pg_catalog.jsonb_array_elements(p_members) t(r) ORDER BY r->>'phone' LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_phone, 0));
  END LOOP;
  -- 독립 semi-join으로 전체 회원 × 후보 수만큼 정규식 계산을 반복하지 않는다.
  IF EXISTS (SELECT 1 FROM public.members m
      WHERE m.id IN (SELECT r->>'id' FROM pg_catalog.jsonb_array_elements(p_members) t(r)))
     OR EXISTS (SELECT 1 FROM public.members m
      WHERE m.user_id IN (SELECT r->>'user_id' FROM pg_catalog.jsonb_array_elements(p_members) t(r)))
     OR EXISTS (SELECT 1 FROM public.members m WHERE public.member_operating_site(m) = 'best'
      AND m.meta->>'legacy_idx' IN (SELECT r->'meta'->>'legacy_idx' FROM pg_catalog.jsonb_array_elements(p_members) t(r)))
     OR EXISTS (SELECT 1 FROM public.members m WHERE public.member_operating_site(m) = 'best'
      AND pg_catalog.regexp_replace(m.phone, '\D', '', 'g') IN (
        SELECT form.phone FROM pg_catalog.jsonb_array_elements(p_members) t(r)
        CROSS JOIN LATERAL pg_catalog.unnest(ARRAY[
          r->>'phone', '82' || pg_catalog.substr(r->>'phone', 2), '0082' || pg_catalog.substr(r->>'phone', 2),
          '82' || (r->>'phone'), '0082' || (r->>'phone')
        ]) AS form(phone)
      )) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'best candidate conflicts with an existing member identity';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments p
      WHERE p.id IN (SELECT r->>'id' FROM pg_catalog.jsonb_array_elements(p_payments) t(r)))
     OR EXISTS (SELECT 1 FROM public.payments p WHERE p.meta->>'source_site' = 'best'
      AND p.meta->>'legacy_idx' IN (SELECT r->'meta'->>'legacy_idx' FROM pg_catalog.jsonb_array_elements(p_payments) t(r))) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'best candidate conflicts with an existing payment';
  END IF;

  -- 운영 직원의 이전 변경은 그대로 보존한다. 현재 잠금 획득 직후의 기존 계약과
  -- 연결 결제 전체 행을 저장하고 INSERT 후 비교하므로 트리거의 부수 변경도 롤백한다.
  SELECT pg_catalog.array_agg(DISTINCT representation.digits) INTO v_phone_forms
  FROM pg_catalog.jsonb_array_elements(p_members) AS t(r)
  CROSS JOIN LATERAL pg_catalog.unnest(ARRAY[
    r->>'phone', '82'||pg_catalog.substr(r->>'phone',2),
    '0082'||pg_catalog.substr(r->>'phone',2), '82'||(r->>'phone'), '0082'||(r->>'phone')
  ]) AS representation(digits);
  SELECT pg_catalog.array_agg(r->>'id') INTO v_input_member_ids
  FROM pg_catalog.jsonb_array_elements(p_members) AS t(r);
  SELECT coalesce(pg_catalog.array_agg(m.id ORDER BY m.id),ARRAY[]::text[]),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.id),'[]'::jsonb)
  INTO v_protected_member_ids,v_members_before
  FROM public.members m
  WHERE pg_catalog.regexp_replace(m.phone,'\D','','g') = ANY(v_phone_forms);
  SELECT coalesce(pg_catalog.array_agg(p.id ORDER BY p.id),ARRAY[]::text[]),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id),'[]'::jsonb)
  INTO v_protected_payment_ids,v_payments_before
  FROM public.payments p WHERE p.member_id = ANY(v_protected_member_ids);

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
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'best member insert count mismatch; transaction rolled back';
  END IF;
  INSERT INTO public.payments (
    id, member_id, product_id, amount, method, status, period_start, period_end,
    depositor_name, paid_at, created_at, meta
  ) SELECT
    id, member_id, product_id, amount, method, status, period_start, period_end,
    depositor_name, paid_at, created_at, meta
  FROM pg_catalog.jsonb_populate_recordset(NULL::public.payments, p_payments);
  GET DIAGNOSTICS v_payments = ROW_COUNT;
  IF v_payments <> p_expected_payment_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'best payment insert count mismatch; transaction rolled back';
  END IF;

  -- 감사 로그까지 같은 트랜잭션에 기록한 뒤 모든 부수 효과를 검증한다.
  v_receipt := pg_catalog.jsonb_build_object('batch_id', p_batch_id, 'source_site', 'best',
    'legacy_source_sha256', v_source_sha, 'members', v_members, 'payments', v_payments,
    'amount', v_amount, 'held_members', p_expected_member_count, 'atomic', true,
    'protected_existing_members',pg_catalog.jsonb_array_length(v_members_before),
    'protected_existing_payments',pg_catalog.jsonb_array_length(v_payments_before),
    'protected_existing_full_rows_unchanged',true,
    'payload_md5', pg_catalog.md5(p_members::text || p_payments::text));
  INSERT INTO public.logs(id,kind,actor,action,target_type,target_id,meta)
  VALUES ('log_' || p_batch_id,'admin',NULL,'legacy_best.import_review_batch','legacy_import',p_batch_id,v_receipt);
  GET DIAGNOSTICS v_log_count = ROW_COUNT;
  IF v_log_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.logs WHERE id='log_' || p_batch_id AND kind='admin'
      AND actor IS NULL AND action='legacy_best.import_review_batch'
      AND target_type='legacy_import' AND target_id=p_batch_id AND meta=v_receipt
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='best atomic receipt mismatch; transaction rolled back';
  END IF;

  -- 트리거가 건수를 유지하면서 회원/금액/출처를 바꿔도 전체 배치를 취소한다.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_populate_recordset(NULL::public.members, p_members) r
    LEFT JOIN public.members m ON m.id = r.id
    WHERE m.id IS NULL OR (m.user_id,m.name,m.nickname,m.phone,m.grade,m.status,m.consult_status,m.outcall_done,
      m.inflow_code,m.inflow_type,m.memo,m.registered_at,m.last_active_at,m.is_suspended,m.is_deleted,m.is_withdrawn,m.meta)
      IS DISTINCT FROM
      (r.user_id,r.name,r.nickname,r.phone,r.grade,r.status,r.consult_status,r.outcall_done,
      r.inflow_code,r.inflow_type,r.memo,r.registered_at,r.last_active_at,r.is_suspended,r.is_deleted,r.is_withdrawn,r.meta)
      OR m.assigned_staff_id IS NOT NULL OR m.team_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_populate_recordset(NULL::public.payments, p_payments) r
    LEFT JOIN public.payments p ON p.id = r.id
    WHERE p.id IS NULL OR (p.member_id,p.product_id,p.amount,p.method,p.status,p.period_start,p.period_end,p.depositor_name,p.paid_at,p.created_at,p.meta)
      IS DISTINCT FROM
      (r.member_id,r.product_id,r.amount,r.method,r.status,r.period_start,r.period_end,r.depositor_name,r.paid_at,r.created_at,r.meta)
      OR p.staff_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'best inserted source payload mismatch; transaction rolled back';
  END IF;
  SELECT count(*),coalesce(sum(p.amount),0)
  INTO v_stored_payment_count,v_stored_payment_amount
  FROM public.payments p WHERE p.member_id = ANY(v_input_member_ids);
  IF v_stored_payment_count <> p_expected_payment_count OR v_stored_payment_amount <> p_expected_amount THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='best inserted payment totals mismatch; transaction rolled back';
  END IF;
  SELECT count(*) INTO v_count FROM public.members
    WHERE meta->>'source_site' = 'best' AND meta->>'import_batch' = p_batch_id
      AND meta->'reco_paused' = 'true'::jsonb AND meta->>'reco_pause_reason' = 'legacy_import_review'
      AND assigned_staff_id IS NULL AND team_id IS NULL;
  IF v_count <> p_expected_member_count
     OR EXISTS (SELECT 1 FROM public.sms_sends WHERE member_id IN (SELECT r->>'id' FROM pg_catalog.jsonb_array_elements(p_members) t(r)))
     OR EXISTS (SELECT 1 FROM public.bets WHERE member_ref IN (SELECT r->>'id' FROM pg_catalog.jsonb_array_elements(p_members) t(r)))
     OR EXISTS (SELECT 1 FROM public.assignments WHERE member_id IN (SELECT r->>'id' FROM pg_catalog.jsonb_array_elements(p_members) t(r))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'best hold or no-send boundary mismatch; transaction rolled back';
  END IF;
  -- 원래 ID도 비교하므로 기존 회원의 전화 또는 결제의 연결 회원이 바뀌어도 검출된다.
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.id),'[]'::jsonb)
  INTO v_members_after
  FROM public.members m
  WHERE m.id IN (
    SELECT pg_catalog.unnest(v_protected_member_ids)
    UNION
    SELECT peer.id FROM public.members peer
    WHERE pg_catalog.regexp_replace(peer.phone,'\D','','g') = ANY(v_phone_forms)
      AND NOT (peer.id = ANY(v_input_member_ids))
  );
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id),'[]'::jsonb)
  INTO v_payments_after
  FROM public.payments p
  WHERE p.member_id = ANY(v_protected_member_ids) OR p.id = ANY(v_protected_payment_ids);
  IF v_members_after IS DISTINCT FROM v_members_before
     OR v_payments_after IS DISTINCT FROM v_payments_before THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'best import changed a protected existing contract; transaction rolled back';
  END IF;
  RETURN v_receipt;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_import_best_review_batch(text,jsonb,jsonb,integer,integer,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_import_best_review_batch(text,jsonb,jsonb,integer,integer,bigint) TO service_role;
COMMENT ON FUNCTION public.admin_import_best_review_batch(text,jsonb,jsonb,integer,integer,bigint) IS
  '고정된 프리미엄로또 원본 SHA의 검수 보류 신규 회원/결제만 한 배치로 추가한다. 기존 데이터 변경·전화 alias 병합·발송 없이 전체 성공 또는 전체 취소.';
