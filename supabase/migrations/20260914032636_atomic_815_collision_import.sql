-- 전화 충돌은 기존 회원 갱신/동일인 병합 없이 별도 815 계약으로 적재한다.
-- 호출 전에 발송 회원 식별 및 사이트별 홈페이지 버전을 배포/검증해야 한다.
create or replace function public.enforce_member_admin_ops() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_phone text;
  v_existing_id text;
  v_actor text;
begin
  if tg_op = 'INSERT' then
    -- 시스템 경로(service_role/SQL Editor)는 권한 검사만 면제하고 중복 차단은 동일 적용한다.
    if auth.uid() is not null and app_role() is distinct from 'admin' then
      raise exception '회원 입력(디비 입력)은 최고관리자만 가능합니다';
    end if;

    -- 검증된 서비스 전용 원자 이관만 동일 번호의 별도 계약을 보존한다.
    -- 직원은 같은 트랜잭션 설정값을 직접 넣어도 service_role이 아니므로 통과할 수 없다.
    if current_setting('role', true) = 'service_role'
       and current_setting('app.lotto815_collision_batch', true) = new.meta->>'import_batch'
       and new.meta->>'import_batch' ~ '^lotto815-collision-[A-Za-z0-9._-]{1,40}$'
       and new.meta->>'source_site' = 'lotto815'
       and new.meta->'reco_paused' = 'true'::jsonb
       and new.meta->>'reco_pause_reason' = 'legacy_import_review' then
      return new;
    end if;
    if auth.uid() is not null and public.member_operating_site(new) = 'lotto815' then
      raise exception '이전 사이트는 신규가입 대신 검증된 이관 경로를 이용해야 합니다';
    end if;

    v_phone := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
    if v_phone <> '' then
      -- 같은 전화번호의 동시 INSERT가 모두 검사 전에 통과하는 경쟁조건을 차단한다.
      perform pg_advisory_xact_lock(hashtextextended(v_phone, 0));

      select m.id
      into v_existing_id
      from public.members m
      where regexp_replace(m.phone, '\D', '', 'g') = v_phone
        and public.member_operating_site(m) = public.member_operating_site(new)
      order by
        (not m.is_deleted and not m.is_withdrawn) desc,
        m.registered_at asc,
        m.id asc
      limit 1
      for update;

      if v_existing_id is not null then
        update public.members m
        set meta = coalesce(m.meta, '{}'::jsonb) || jsonb_build_object(
          'dup_phone', true,
          'duplicate_attempt_count', coalesce(
            case
              when jsonb_typeof(m.meta->'duplicate_attempt_count') = 'number'
                then (m.meta->>'duplicate_attempt_count')::integer
              else 0
            end,
            0
          ) + 1,
          'duplicate_last_at', now(),
          'duplicate_last_source', case
            when coalesce((new.meta->>'imported')::boolean, false) then 'bulk_import'
            else 'manual'
          end,
          'duplicate_last_inflow_code', new.inflow_code,
          'duplicate_last_inflow_type', new.inflow_type
        )
        where m.id = v_existing_id;

        v_actor := case when auth.uid() is null then null else app_staff_id() end;
        insert into public.logs(id, kind, actor, action, target_type, target_id, meta, created_at)
        values (
          'log_' || replace(gen_random_uuid()::text, '-', ''),
          'inflow',
          v_actor,
          'member.duplicate_rejected',
          'member',
          v_existing_id,
          jsonb_build_object(
            'phone_last4', right(v_phone, 4),
            'attempted_name', new.name,
            'source', case
              when coalesce((new.meta->>'imported')::boolean, false) then 'bulk_import'
              else 'manual'
            end,
            'inflow_code', new.inflow_code,
            'inflow_type', new.inflow_type
          ),
          now()
        );

        -- BEFORE INSERT에서 NULL 반환 → 신규 회원행을 만들지 않는다.
        return null;
      end if;
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.assigned_staff_id is distinct from old.assigned_staff_id
        or new.team_id is distinct from old.team_id)
       and auth.uid() is not null
       and app_role() is distinct from 'admin' then
      raise exception '담당자 변경(디비 배분)은 최고관리자만 가능합니다';
    end if;
  end if;
  return new;
end;
$$;
REVOKE EXECUTE ON FUNCTION public.enforce_member_admin_ops() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.admin_import_815_collision_batch(p_batch_id text, p_members jsonb, p_payments jsonb, p_expected_member_count integer, p_expected_payment_count integer, p_expected_amount bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '3s'
AS $function$
DECLARE
  v_count integer;
  v_amount bigint;
  v_phone text;
  v_members integer;
  v_payments integer;
BEGIN
  IF p_batch_id IS NULL OR p_batch_id !~ '^lotto815-collision-[A-Za-z0-9._-]{1,40}$'
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
  -- 원본 내 같은 전화번호의 서로 다른 계정도 원본 키별 계약으로 보존한다.
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

  -- 검사 완료 후 트랜잭션 동안만 INSERT 트리거의 별도 계약 경로를 허용한다.
  PERFORM pg_catalog.set_config('app.lotto815_collision_batch',p_batch_id,true);
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
  PERFORM pg_catalog.set_config('app.lotto815_collision_batch','',true);
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
$function$
;
REVOKE EXECUTE ON FUNCTION public.admin_import_815_collision_batch(text,jsonb,jsonb,integer,integer,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_import_815_collision_batch(text,jsonb,jsonb,integer,integer,bigint) TO service_role;
COMMENT ON FUNCTION public.admin_import_815_collision_batch(text,jsonb,jsonb,integer,integer,bigint) IS
  '서비스 전용 815 전화충돌 원자 이관. 원본키/행/결제/동의/발송보류 검증, 기존 계약 변경 없음.';
