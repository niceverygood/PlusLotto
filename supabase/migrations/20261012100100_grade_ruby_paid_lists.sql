-- 루비(ruby) 등급을 유료등급으로 판정한다 (현장 10/12, 정의현 차장 — 실버와 골드 사이 등급).
-- 앞 마이그레이션(20261012100000)에서 enum 값이 커밋된 뒤 적용해야 한다.
--
-- 각 함수의 현재 정의(최신 마이그레이션)를 그대로 옮기고 유료 등급 목록에만 'ruby'를 더했다.
--   reco_issue_claim / reco_issue_manual_claim  — 지정요일 조합 발급·문자 대상(유료) 판정
--     (원본: 20261006133000_manual_additional_reco.sql)
--   lotto_sync_claim_sms                         — 당첨 문자 유료/무료 토글 판정
--     (원본: 20261003135703_durable_lotto_sync.sql)
--   admin_member_facets                          — 회원목록 '유료' 탭 건수 + '루비' 세그먼트 건수
--     (원본: 20261008160000_admin_members_definer.sql)
--   admin_stats_snapshot                         — 통계 유료회원 수
--     (원본: 20260916030000_legacy_unknown_payment_labels.sql)
-- 시그니처·권한·그 밖의 동작은 바꾸지 않는다(CREATE OR REPLACE 는 기존 GRANT 를 유지한다).
-- 루비 회원이 아직 없으므로 적용 직후 기존 회원의 발급·문자·건수는 달라지지 않는다.

CREATE OR REPLACE FUNCTION public.reco_issue_claim(p_member_id text, p_round_no integer, p_expected_meta jsonb, p_issue jsonb, p_expected_site text, p_today date, p_weekday integer, p_mode text DEFAULT 'scheduled'::text, p_also_sms boolean DEFAULT true, p_actor text DEFAULT NULL::text, p_set_count integer DEFAULT NULL::integer, p_expected_grade text DEFAULT NULL::text, p_expected_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '3s'
 SET statement_timeout TO '15s'
AS $function$
DECLARE
  m public.members; actor public.staff; cfg public.site_settings; l public.reco_issue_ledger;
  current_day date := (statement_timestamp() AT TIME ZONE 'Asia/Seoul')::date;
  site text; reason text; day_no integer; set_count integer; expected_count integer;
  recos jsonb; next_recos jsonb; clean_issue jsonb; one_set jsonb; n jsonb;
  end_day date; end_text text; sender text; paid boolean; sms_on boolean; auto_on boolean;
  next_round integer;
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF p_member_id IS NULL OR btrim(p_member_id)='' OR p_round_no IS NULL OR p_round_no<1
    OR p_expected_site IS NULL OR p_expected_grade IS NULL OR p_mode IS NULL OR p_mode NOT IN ('scheduled','manual')
    OR (p_set_count IS NOT NULL AND (p_mode<>'manual' OR p_set_count<1 OR p_set_count>100))
    OR p_also_sms IS NULL OR jsonb_typeof(p_expected_meta) IS DISTINCT FROM 'object'
    OR p_today IS DISTINCT FROM current_day
    OR p_weekday IS DISTINCT FROM extract(dow FROM current_day)::integer THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','INVALID_CONTEXT');
  END IF;
  -- Serialize with lotto_sync_start so an issue cannot miss the draw snapshot.
  PERFORM pg_advisory_xact_lock(8141244,p_round_no);
  SELECT * INTO m FROM public.members WHERE id=p_member_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',true,'status','skipped','claimed',false,'reason','MEMBER_NOT_FOUND');
  END IF;
  site:=coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto');
  IF site NOT IN ('pluslotto','lotto815','infolotto','cplotto','best')
    OR site IS DISTINCT FROM p_expected_site THEN reason:='SITE_CHANGED';
  ELSIF m.grade::text IS DISTINCT FROM p_expected_grade OR m.phone IS DISTINCT FROM p_expected_phone THEN reason:='MEMBER_CHANGED';
  ELSIF m.status::text IS DISTINCT FROM 'active'
    OR m.is_deleted IS DISTINCT FROM false OR m.is_suspended IS DISTINCT FROM false
    OR m.is_withdrawn IS DISTINCT FROM false THEN reason:='MEMBER_INACTIVE';
  ELSIF m.meta->'reco_paused' = 'true'::jsonb THEN reason:='HELD';
  ELSIF m.meta ? 'reco_paused' AND jsonb_typeof(m.meta->'reco_paused') NOT IN ('boolean','null') THEN reason:='INVALID_HOLD';
  ELSIF coalesce(m.meta,'{}') IS DISTINCT FROM p_expected_meta THEN reason:='STALE_META';
  END IF;
  IF reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason',reason);
  END IF;
  IF p_actor IS NOT NULL THEN
    SELECT * INTO actor FROM public.staff WHERE id=p_actor FOR SHARE;
    IF NOT FOUND OR actor.is_active IS DISTINCT FROM true OR NOT (
      -- D51/D55: leader is the live operations role with all-member access, including team NULL.
      actor.role::text IN ('admin','manager','leader')
      OR (actor.role::text='rep' AND actor.id=m.assigned_staff_id)) THEN
      RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','ACTOR_SCOPE');
    END IF;
  ELSIF p_mode='manual' THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','ACTOR_REQUIRED');
  END IF;
  -- Check the durable tombstone and EVERY legacy issue, not only weekly_recos[0].
  IF EXISTS(SELECT 1 FROM public.reco_issue_ledger WHERE member_id=m.id AND round_no=p_round_no
    AND status IN ('claimed','unknown','rejected')) THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','PRIOR_RECEIPT_UNRESOLVED');
  END IF;
  SELECT * INTO l FROM public.reco_issue_ledger WHERE member_id=m.id AND round_no=p_round_no AND manual_request_id IS NULL;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'status','skipped','claimed',false,'reason','ALREADY_CLAIMED','outcome',l.status);
  END IF;
  IF m.meta ? 'weekly_recos' AND jsonb_typeof(m.meta->'weekly_recos') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','INVALID_HISTORY');
  END IF;
  recos:=coalesce(m.meta->'weekly_recos','[]');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(recos) e WHERE e->>'round_no'=p_round_no::text AND NOT EXISTS(SELECT 1 FROM public.reco_issue_ledger identified
      WHERE identified.member_id=m.id AND identified.manual_request_id::text=e->>'manual_request_id'
       AND identified.issue=e))
    OR EXISTS(SELECT 1 FROM public.member_reco_reset_archive a
      CROSS JOIN LATERAL jsonb_array_elements(a.issues) e
      WHERE a.member_id=m.id AND e->>'round_no'=p_round_no::text AND NOT EXISTS(SELECT 1 FROM public.reco_issue_ledger identified
      WHERE identified.member_id=m.id AND identified.manual_request_id::text=e->>'manual_request_id'
       AND identified.issue=e)) THEN
    RETURN jsonb_build_object('ok',true,'status','skipped','claimed',false,'reason','ALREADY_ISSUED');
  END IF;
  end_text:=btrim(m.meta->>'end_date');
  IF coalesce(end_text,'')<>'' THEN
    IF end_text !~ '^\d{4}-\d{2}-\d{2}($|[T[:space:]])' THEN reason:='INVALID_END_DATE';
    ELSE
      BEGIN end_day:=left(end_text,10)::date;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN reason:='INVALID_END_DATE'; END;
      IF end_day<current_day THEN reason:='EXPIRED'; END IF;
    END IF;
  END IF;
  IF reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'status','skipped','claimed',false,'reason',reason);
  END IF;
  SELECT * INTO cfg FROM public.site_settings WHERE id=1 FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','SETTINGS_MISSING');
  END IF;
  paid:=m.grade::text IN ('gold','goldp','ruby','vip','royal');
  sender:=CASE WHEN site='pluslotto' THEN cfg.sms->>'sender_no' ELSE cfg.sms->'by_site'->site->>'sender_no' END;
  sms_on:=coalesce(cfg.sms->'oneshot_enabled'='true'::jsonb,false)
    AND coalesce(cfg.weekly_free_reco->'paid_sms'='true'::jsonb,false) AND btrim(coalesce(sender,''))<>'';
  auto_on:=coalesce(cfg.weekly_free_reco->'enabled'='true'::jsonb,false);
  IF p_mode='scheduled' AND NOT auto_on AND NOT (sms_on AND paid) THEN
    RETURN jsonb_build_object('ok',true,'status','skipped','claimed',false,'reason','DISABLED');
  END IF;
  IF m.meta ? 'weekly_reco_day' AND m.meta->'weekly_reco_day'<>'null'::jsonb THEN
    IF jsonb_typeof(m.meta->'weekly_reco_day')<>'number' OR m.meta->>'weekly_reco_day' !~ '^[0-6]$' THEN reason:='INVALID_DAY';
    ELSE day_no:=(m.meta->>'weekly_reco_day')::integer; END IF;
  ELSIF m.grade::text='free' THEN day_no:=5; END IF;
  IF p_mode='scheduled' AND (day_no IS NULL OR day_no<>p_weekday) THEN reason:=coalesce(reason,'DAY'); END IF;
  IF m.meta ? 'weekly_reco_count' AND m.meta->'weekly_reco_count'<>'null'::jsonb THEN
    IF jsonb_typeof(m.meta->'weekly_reco_count')<>'number' OR m.meta->>'weekly_reco_count' !~ '^[0-9]{1,4}$' THEN reason:='INVALID_COUNT';
    ELSE expected_count:=(m.meta->>'weekly_reco_count')::integer; END IF;
  ELSE
    IF cfg.weekly_free_reco->>'set_count' ~ '^[1-9][0-9]{0,3}$' THEN expected_count:=(cfg.weekly_free_reco->>'set_count')::integer;
    ELSE expected_count:=30; END IF;
  END IF;
  -- An explicitly requested single-member manual issue supplies its own bounded count.
  -- It does not change weekly_reco_count=0 or enable scheduled issuance.
  IF expected_count=0 AND (p_mode='scheduled' OR p_set_count IS NULL) THEN reason:='COUNT_ZERO'; END IF;
  IF reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'status','skipped','claimed',false,'reason',reason);
  END IF;
  SELECT coalesce(max(round_no),0)+1 INTO next_round FROM public.lotto_rounds;
  IF p_round_no<>next_round THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','ROUND_CHANGED');
  END IF;
  IF jsonb_typeof(p_issue) IS DISTINCT FROM 'object' OR p_issue->'round_no' IS DISTINCT FROM to_jsonb(p_round_no)
    OR jsonb_typeof(p_issue->'sets') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','INVALID_ISSUE');
  END IF;
  set_count:=jsonb_array_length(p_issue->'sets');
  IF set_count<1 OR set_count>1000 OR (p_mode='manual' AND set_count>100)
    OR ((p_mode='scheduled' OR p_set_count IS NULL) AND set_count<>expected_count)
    OR (p_set_count IS NOT NULL AND set_count<>p_set_count) THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','COUNT_CHANGED');
  END IF;
  FOR one_set IN SELECT value FROM jsonb_array_elements(p_issue->'sets') LOOP
    IF jsonb_typeof(one_set)<>'array' OR jsonb_array_length(one_set)<>6 THEN reason:='INVALID_NUMBERS'; EXIT; END IF;
    FOR n IN SELECT value FROM jsonb_array_elements(one_set) LOOP
      IF jsonb_typeof(n)<>'number' OR n::text !~ '^([1-9]|[1-3][0-9]|4[0-5])$' THEN reason:='INVALID_NUMBERS'; EXIT; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(one_set))<>6 THEN reason:='INVALID_NUMBERS'; END IF;
    EXIT WHEN reason IS NOT NULL;
  END LOOP;
  IF reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason',reason);
  END IF;
  clean_issue:=jsonb_build_object('round_no',p_round_no,'issued_at',statement_timestamp(),'sets',p_issue->'sets');
  INSERT INTO public.reco_issue_ledger(member_id,round_no,source_site,issue,should_send,phone,actor_id,mode)
    VALUES(m.id,p_round_no,site,clean_issue,p_also_sms AND btrim(coalesce(m.phone,''))<>'' AND
      CASE WHEN p_mode='manual' THEN coalesce(cfg.sms->'oneshot_enabled'='true'::jsonb,false) AND btrim(coalesce(sender,''))<>''
      ELSE sms_on AND paid END,coalesce(m.phone,''),p_actor,p_mode)
    RETURNING * INTO l;
  SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') INTO next_recos
    FROM jsonb_array_elements(jsonb_build_array(clean_issue)||recos) WITH ORDINALITY e(value,ord);
  UPDATE public.members SET meta=jsonb_set(coalesce(meta,'{}'),'{weekly_recos}',next_recos,true) WHERE id=m.id;
  -- A lost claim response leaves an explicitly unresolved SMS row; it cannot be retried.
  IF l.should_send THEN
    INSERT INTO public.sms_sends(id,member_id,template_key,phone,body,type,status,sent_at,meta)
      VALUES('sms_reco_claim_'||l.id::text,m.id,'recommend',l.phone,'','recommend','접수확인필요(조합요청준비)',l.created_at,
        jsonb_build_object('reco_claim_id',l.id,'round_no',p_round_no,'source_site',site));
  END IF;
  RETURN jsonb_build_object('ok',true,'status','claimed','claimed',true,'claim_id',l.id,'claim_token',l.claim_token,
    'should_send',l.should_send,'member',jsonb_build_object('id',m.id,'name',m.name,'phone',m.phone,'grade',m.grade,'meta',m.meta),
    'issue',clean_issue);
END $function$;

CREATE OR REPLACE FUNCTION public.reco_issue_manual_claim(p_operation_id uuid, p_member_id text, p_round_no integer, p_expected_meta jsonb, p_issue jsonb, p_expected_site text, p_today date, p_weekday integer, p_mode text DEFAULT 'scheduled'::text, p_also_sms boolean DEFAULT true, p_actor text DEFAULT NULL::text, p_set_count integer DEFAULT NULL::integer, p_expected_grade text DEFAULT NULL::text, p_expected_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '3s'
 SET statement_timeout TO '15s'
AS $function$
DECLARE
  m public.members; actor public.staff; cfg public.site_settings; l public.reco_issue_ledger;
  current_day date := (statement_timestamp() AT TIME ZONE 'Asia/Seoul')::date;
  site text; reason text; day_no integer; set_count integer; expected_count integer;
  recos jsonb; next_recos jsonb; clean_issue jsonb; one_set jsonb; n jsonb;
  end_day date; end_text text; sender text; paid boolean; sms_on boolean; auto_on boolean;
  next_round integer; op public.reco_manual_operations;
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF p_operation_id IS NULL OR p_set_count IS NULL OR p_actor IS NULL OR p_mode<>'manual' OR p_member_id IS NULL OR btrim(p_member_id)='' OR p_round_no IS NULL OR p_round_no<1
    OR p_expected_site IS NULL OR p_expected_grade IS NULL OR p_mode IS NULL OR p_mode NOT IN ('scheduled','manual')
    OR (p_set_count IS NOT NULL AND (p_mode<>'manual' OR p_set_count<1 OR p_set_count>100))
    OR p_also_sms IS NULL OR jsonb_typeof(p_expected_meta) IS DISTINCT FROM 'object'
    OR p_today IS DISTINCT FROM current_day
    OR p_weekday IS DISTINCT FROM extract(dow FROM current_day)::integer THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','INVALID_CONTEXT');
  END IF;
  -- Serialize with lotto_sync_start so an issue cannot miss the draw snapshot.
  PERFORM pg_advisory_xact_lock(8141244,p_round_no);
  SELECT * INTO m FROM public.members WHERE id=p_member_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',true,'status','skipped','claimed',false,'reason','MEMBER_NOT_FOUND');
  END IF;
  IF p_actor IS NOT NULL THEN
    SELECT * INTO actor FROM public.staff WHERE id=p_actor FOR SHARE;
    IF NOT FOUND OR actor.is_active IS DISTINCT FROM true OR NOT (
      -- D51/D55: leader is the live operations role with all-member access, including team NULL.
      actor.role::text IN ('admin','manager','leader')
      OR (actor.role::text='rep' AND actor.id=m.assigned_staff_id)) THEN
      RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','ACTOR_SCOPE');
    END IF;
  ELSIF p_mode='manual' THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','ACTOR_REQUIRED');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('manual-reco:'||p_operation_id::text,0));
  SELECT * INTO op FROM public.reco_manual_operations WHERE id=p_operation_id;
  IF FOUND THEN
    IF op.member_id IS DISTINCT FROM p_member_id OR op.actor_id IS DISTINCT FROM p_actor
      OR op.set_count IS DISTINCT FROM p_set_count OR op.also_sms IS DISTINCT FROM p_also_sms OR op.round_no<>p_round_no THEN
      RETURN jsonb_build_object('ok',true,'claimed',false,'status','review_required','reason','OPERATION_CONFLICT');
    END IF;
    RETURN jsonb_build_object('ok',true,'claimed',false,'status',op.status,'reason',coalesce(op.reason,'OPERATION_EXISTS'),
      'confirmedNotIssued',op.status='blocked','operationId',p_operation_id);
  END IF;
  INSERT INTO public.reco_manual_operations(id,member_id,actor_id,round_no,set_count,also_sms,status)
   VALUES(p_operation_id,p_member_id,p_actor,p_round_no,p_set_count,p_also_sms,'pending');
  site:=coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto');
  IF site NOT IN ('pluslotto','lotto815','infolotto','cplotto','best')
    OR site IS DISTINCT FROM p_expected_site THEN reason:='SITE_CHANGED';
  ELSIF m.grade::text IS DISTINCT FROM p_expected_grade OR m.phone IS DISTINCT FROM p_expected_phone THEN reason:='MEMBER_CHANGED';
  ELSIF m.status::text IS DISTINCT FROM 'active'
    OR m.is_deleted IS DISTINCT FROM false OR m.is_suspended IS DISTINCT FROM false
    OR m.is_withdrawn IS DISTINCT FROM false THEN reason:='MEMBER_INACTIVE';
  ELSIF m.meta->'reco_paused' = 'true'::jsonb THEN reason:='HELD';
  ELSIF m.meta ? 'reco_paused' AND jsonb_typeof(m.meta->'reco_paused') NOT IN ('boolean','null') THEN reason:='INVALID_HOLD';
  ELSIF coalesce(m.meta,'{}') IS DISTINCT FROM p_expected_meta THEN reason:='STALE_META';
  END IF;
  IF reason IS NOT NULL THEN
    RETURN public.reco_manual_block(p_operation_id,reason);
  END IF;
  IF EXISTS(SELECT 1 FROM public.reco_issue_ledger WHERE member_id=m.id AND round_no=p_round_no
    AND status IN ('claimed','unknown','rejected')) THEN
    RETURN public.reco_manual_block(p_operation_id,'PRIOR_RECEIPT_UNRESOLVED');
  END IF;
  IF m.meta ? 'weekly_recos' AND jsonb_typeof(m.meta->'weekly_recos') IS DISTINCT FROM 'array' THEN
    RETURN public.reco_manual_block(p_operation_id,'INVALID_HISTORY');
  END IF;
  recos:=coalesce(m.meta->'weekly_recos','[]');
  IF p_also_sms AND (m.meta->>'legacy_agree_sms_yn'='N' OR m.meta->'sms_opt_out'='true'::jsonb
    OR m.meta->'sms_optout'='true'::jsonb OR m.meta->'sms_blocked'='true'::jsonb
    OR m.meta->'do_not_contact'='true'::jsonb OR m.meta->'sms_consent'='false'::jsonb OR m.meta->'sms_agreed'='false'::jsonb) THEN
    RETURN public.reco_manual_block(p_operation_id,'CONSENT_REVIEW_REQUIRED');
  END IF;
  end_text:=btrim(m.meta->>'end_date');
  IF coalesce(end_text,'')<>'' THEN
    IF end_text !~ '^\d{4}-\d{2}-\d{2}($|[T[:space:]])' THEN reason:='INVALID_END_DATE';
    ELSE
      BEGIN end_day:=left(end_text,10)::date;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN reason:='INVALID_END_DATE'; END;
      IF end_day<current_day THEN reason:='EXPIRED'; END IF;
    END IF;
  END IF;
  IF reason IS NOT NULL THEN
    RETURN public.reco_manual_block(p_operation_id,reason);
  END IF;
  SELECT * INTO cfg FROM public.site_settings WHERE id=1 FOR SHARE;
  IF NOT FOUND THEN
    RETURN public.reco_manual_block(p_operation_id,'SETTINGS_MISSING');
  END IF;
  IF p_also_sms AND btrim(coalesce(m.phone,''))='' THEN
    RETURN public.reco_manual_block(p_operation_id,'PHONE_REQUIRED');
  END IF;
  paid:=m.grade::text IN ('gold','goldp','ruby','vip','royal');
  sender:=CASE WHEN site='pluslotto' THEN cfg.sms->>'sender_no' ELSE cfg.sms->'by_site'->site->>'sender_no' END;
  sms_on:=coalesce(cfg.sms->'oneshot_enabled'='true'::jsonb,false)
    AND coalesce(cfg.weekly_free_reco->'paid_sms'='true'::jsonb,false) AND btrim(coalesce(sender,''))<>'';
  auto_on:=coalesce(cfg.weekly_free_reco->'enabled'='true'::jsonb,false);
  IF p_also_sms AND (cfg.sms->'oneshot_enabled' IS DISTINCT FROM 'true'::jsonb OR btrim(coalesce(sender,''))='') THEN
    RETURN public.reco_manual_block(p_operation_id,'SMS_DISABLED_OR_SENDER_UNSET');
  END IF;
  IF p_mode='scheduled' AND NOT auto_on AND NOT (sms_on AND paid) THEN
    RETURN public.reco_manual_block(p_operation_id,'DISABLED');
  END IF;
  IF m.meta ? 'weekly_reco_day' AND m.meta->'weekly_reco_day'<>'null'::jsonb THEN
    IF jsonb_typeof(m.meta->'weekly_reco_day')<>'number' OR m.meta->>'weekly_reco_day' !~ '^[0-6]$' THEN reason:='INVALID_DAY';
    ELSE day_no:=(m.meta->>'weekly_reco_day')::integer; END IF;
  ELSIF m.grade::text='free' THEN day_no:=5; END IF;
  IF p_mode='scheduled' AND (day_no IS NULL OR day_no<>p_weekday) THEN reason:=coalesce(reason,'DAY'); END IF;
  IF m.meta ? 'weekly_reco_count' AND m.meta->'weekly_reco_count'<>'null'::jsonb THEN
    IF jsonb_typeof(m.meta->'weekly_reco_count')<>'number' OR m.meta->>'weekly_reco_count' !~ '^[0-9]{1,4}$' THEN reason:='INVALID_COUNT';
    ELSE expected_count:=(m.meta->>'weekly_reco_count')::integer; END IF;
  ELSE
    IF cfg.weekly_free_reco->>'set_count' ~ '^[1-9][0-9]{0,3}$' THEN expected_count:=(cfg.weekly_free_reco->>'set_count')::integer;
    ELSE expected_count:=30; END IF;
  END IF;
  -- An explicitly requested single-member manual issue supplies its own bounded count.
  -- It does not change weekly_reco_count=0 or enable scheduled issuance.
  IF expected_count=0 AND (p_mode='scheduled' OR p_set_count IS NULL) THEN reason:='COUNT_ZERO'; END IF;
  IF reason IS NOT NULL THEN
    RETURN public.reco_manual_block(p_operation_id,reason);
  END IF;
  SELECT coalesce(max(round_no),0)+1 INTO next_round FROM public.lotto_rounds;
  IF p_round_no<>next_round THEN
    RETURN public.reco_manual_block(p_operation_id,'ROUND_CHANGED');
  END IF;
  IF jsonb_typeof(p_issue) IS DISTINCT FROM 'object' OR p_issue->'round_no' IS DISTINCT FROM to_jsonb(p_round_no)
    OR jsonb_typeof(p_issue->'sets') IS DISTINCT FROM 'array' THEN
    RETURN public.reco_manual_block(p_operation_id,'INVALID_ISSUE');
  END IF;
  set_count:=jsonb_array_length(p_issue->'sets');
  IF set_count<1 OR set_count>1000 OR (p_mode='manual' AND set_count>100)
    OR ((p_mode='scheduled' OR p_set_count IS NULL) AND set_count<>expected_count)
    OR (p_set_count IS NOT NULL AND set_count<>p_set_count) THEN
    RETURN public.reco_manual_block(p_operation_id,'COUNT_CHANGED');
  END IF;
  FOR one_set IN SELECT value FROM jsonb_array_elements(p_issue->'sets') LOOP
    IF jsonb_typeof(one_set)<>'array' OR jsonb_array_length(one_set)<>6 THEN reason:='INVALID_NUMBERS'; EXIT; END IF;
    FOR n IN SELECT value FROM jsonb_array_elements(one_set) LOOP
      IF jsonb_typeof(n)<>'number' OR n::text !~ '^([1-9]|[1-3][0-9]|4[0-5])$' THEN reason:='INVALID_NUMBERS'; EXIT; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(one_set))<>6 THEN reason:='INVALID_NUMBERS'; END IF;
    EXIT WHEN reason IS NOT NULL;
  END LOOP;
  IF reason IS NOT NULL THEN
    RETURN public.reco_manual_block(p_operation_id,reason);
  END IF;
  clean_issue:=jsonb_build_object('round_no',p_round_no,'issued_at',statement_timestamp(),'sets',p_issue->'sets','manual_request_id',p_operation_id);
  INSERT INTO public.reco_issue_ledger(member_id,round_no,source_site,issue,should_send,phone,actor_id,mode,manual_request_id)
    VALUES(m.id,p_round_no,site,clean_issue,p_also_sms AND btrim(coalesce(m.phone,''))<>'' AND
      CASE WHEN p_mode='manual' THEN coalesce(cfg.sms->'oneshot_enabled'='true'::jsonb,false) AND btrim(coalesce(sender,''))<>''
      ELSE sms_on AND paid END,coalesce(m.phone,''),p_actor,p_mode,p_operation_id)
    RETURNING * INTO l;
  SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') INTO next_recos
    FROM jsonb_array_elements(jsonb_build_array(clean_issue)||recos) WITH ORDINALITY e(value,ord);
  UPDATE public.members SET meta=jsonb_set(coalesce(meta,'{}'),'{weekly_recos}',next_recos,true) WHERE id=m.id;
  -- A lost claim response leaves an explicitly unresolved SMS row; it cannot be retried.
  IF l.should_send THEN
    INSERT INTO public.sms_sends(id,member_id,template_key,phone,body,type,status,sent_at,meta)
      VALUES('sms_reco_claim_'||l.id::text,m.id,'recommend',l.phone,'','recommend','접수확인필요(조합요청준비)',l.created_at,
        jsonb_build_object('reco_claim_id',l.id,'round_no',p_round_no,'source_site',site,'manual_request_id',p_operation_id));
  END IF;
  UPDATE public.reco_manual_operations SET status='claimed' WHERE id=p_operation_id;
  RETURN jsonb_build_object('ok',true,'status','claimed','claimed',true,'claim_id',l.id,'claim_token',l.claim_token,
    'should_send',l.should_send,'member',jsonb_build_object('id',m.id,'name',m.name,'phone',m.phone,'grade',m.grade,'meta',m.meta),
    'issue',clean_issue);
END $function$;

CREATE OR REPLACE FUNCTION public.lotto_sync_claim_sms(p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '3s'
 SET statement_timeout TO '30s'
AS $function$
DECLARE o public.lotto_sync_sms_outbox; m public.members; cfg jsonb; result jsonb:='[]'; token uuid; rounds jsonb; eligible boolean; scanned integer;
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>50 THEN RAISE EXCEPTION 'CLAIM_LIMIT' USING ERRCODE='22023'; END IF;
 SELECT to_jsonb(s) INTO cfg FROM public.site_settings s WHERE id=1;
 FOR scanned IN 1..500 LOOP
  EXIT WHEN jsonb_array_length(result)>=p_limit;
  SELECT q.* INTO o FROM public.lotto_sync_sms_outbox q JOIN public.lotto_sync_jobs j USING(round_no) WHERE q.status='pending' AND j.status='complete' ORDER BY q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED;
  EXIT WHEN NOT FOUND;
  SELECT * INTO m FROM public.members WHERE id=o.member_id FOR UPDATE;
  eligible:=FOUND AND lotto_sync_private.sms_enabled() AND NOT m.is_deleted AND NOT m.is_suspended AND NOT m.is_withdrawn AND m.phone<>''
   AND coalesce(m.meta->>'reco_paused','false')<>'true'
   AND coalesce(m.meta->>'reco_pause_reason','')<>'legacy_import_review'
   AND coalesce(cfg->'win_sms'->'ranks','[]') @> to_jsonb(o.rank)
   AND CASE WHEN m.grade IN ('gold','goldp','ruby','vip','royal') THEN cfg->'win_sms'->>'paid'='true' ELSE cfg->'win_sms'->>'free'='true' END
   AND NOT coalesce(m.meta->'win_sms_rounds','[]') @> to_jsonb(o.round_no)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cfg->'win_messages')='array' THEN cfg->'win_messages' ELSE '[]' END) t WHERE t->'rank'=to_jsonb(o.rank) AND btrim(coalesce(t->>'body',''))<>'');
  IF NOT coalesce(eligible,false) THEN UPDATE public.lotto_sync_sms_outbox SET status='skipped',finished_at=now(),result_code='INELIGIBLE' WHERE id=o.id; CONTINUE; END IF;
  token:=gen_random_uuid();
  rounds:=CASE WHEN jsonb_typeof(m.meta->'win_sms_rounds')='array' THEN m.meta->'win_sms_rounds' ELSE '[]' END;
  UPDATE public.members SET meta=jsonb_set(meta,'{win_sms_rounds}',rounds||to_jsonb(o.round_no)) WHERE id=m.id;
  UPDATE public.lotto_sync_sms_outbox SET status='claimed',claim_token=token,claimed_at=now() WHERE id=o.id;
  INSERT INTO public.sms_sends(id,member_id,template_key,phone,body,type,status,sent_at) VALUES('sms_lotto_outbox_'||o.id,m.id,'win',m.phone,'','win','접수확인필요(요청중)',now());
  result:=result||jsonb_build_array(jsonb_build_object('id',o.id,'claim_token',token,'round_no',o.round_no,'member_id',m.id,'rank',o.rank,'numbers',o.numbers,'prize',o.prize,'member',jsonb_build_object('id',m.id,'name',m.name,'phone',m.phone,'grade',m.grade,'win_history',m.win_history,'is_deleted',m.is_deleted,'is_suspended',m.is_suspended,'is_withdrawn',m.is_withdrawn,'meta',jsonb_build_object('homepage_pw',m.meta->'homepage_pw','source_site',m.meta->'source_site','reco_paused',m.meta->'reco_paused','reco_pause_reason',m.meta->'reco_pause_reason','win_sms_rounds',rounds))));
 END LOOP;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.admin_member_facets(p_assigned_staff_id text DEFAULT NULL::text, p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
 SET random_page_cost TO '1.1'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
  v_role public.role := public.app_role();
  v_staff_id text := public.app_staff_id();
BEGIN
  -- DEFINER 는 RLS 를 우회하므로 로그인·역할이 없으면 즉시 거부한다(20260911040000 결제 목록과 같은 방식).
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'insufficient privilege for members';
  END IF;
  RETURN (
with raw as materialized (
  -- 집계에 쓰는 열만 싣는다. m.*(meta 포함)를 통째로 물리화·정렬하면 회원 수만큼 큰 행을 디스크 정렬한다.
  select (m.registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date as is_today,
    m.grade::text as grade, m.assigned_staff_id, m.outcall_done, m.status, m.is_suspended, m.is_deleted,
    m.is_withdrawn, m.inflow_code, m.tendency, m.last_active_at,
    nullif(btrim(coalesce(m.win_history, '')), '') is not null as has_win,
    nullif(btrim(coalesce(m.memo, '')), '') is not null as has_memo,
    s.role::text as assigned_role
  from public.members m
  left join public.staff s on s.id = m.assigned_staff_id
  -- RLS(members_rw)가 하던 가시성: admin·manager·leader 전체 / rep 본인 담당.
  where (v_role::text <> 'rep' or m.assigned_staff_id = v_staff_id)
    and (p_assigned_staff_id is null or m.assigned_staff_id = p_assigned_staff_id)
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
), base as materialized (
  select r.*,
    count(*) filter (where r.inflow_code is not null)
      over (partition by r.inflow_code) as inflow_all_count,
    count(*) filter (
      where r.inflow_code is not null
        and r.is_today
    ) over (partition by r.inflow_code) as inflow_today_count
  from raw r
)
select jsonb_build_object(
  'counts', jsonb_build_object(
    'all', count(*),
    'today-join', count(*) filter (where is_today),
    'paid', count(*) filter (where grade in ('gold','goldp','ruby','vip','royal')),
    'no-staff', count(*) filter (where assigned_staff_id is null),
    'no-outcall-new', count(*) filter (where not outcall_done and is_today),
    'winner', count(*) filter (where has_win),
    'normal', count(*) filter (where status::text = 'active'),
    'suspended', count(*) filter (where is_suspended),
    'deleted', count(*) filter (where is_deleted),
    'withdrawn', count(*) filter (where is_withdrawn),
    'free', count(*) filter (where grade = 'free'),
    'simple', count(*) filter (where grade = 'simple'),
    'gold', count(*) filter (where grade in ('gold','goldp')),
    'ruby', count(*) filter (where grade = 'ruby'),
    'vip-royal', count(*) filter (where grade in ('vip','royal')),
    'ovr', count(*) filter (where grade = 'ovr'),
    'toss', count(*) filter (where grade = 'toss'),
    'manager-own', count(*) filter (where assigned_role = 'manager'),
    'leader-own', count(*) filter (where assigned_role = 'leader'),
    'dup-today', count(*) filter (where inflow_code is not null and inflow_today_count > 1 and is_today),
    'dup-all', count(*) filter (where inflow_code is not null and inflow_all_count > 1),
    'today-dabi', count(*) filter (where assigned_staff_id is not null and is_today),
    'retry', count(*) filter (where outcall_done and grade in ('free','simple')),
    'has-memo', count(*) filter (where has_memo),
    'tendency-active', count(*) filter (where tendency = '적극'),
    'no-outcall-all', count(*) filter (where not outcall_done),
    'long-inactive', count(*) filter (where last_active_at is null or last_active_at <= now() - interval '30 days')
  ),
  'inflowCodes', coalesce((
    select jsonb_agg(c.code order by c.code)
    from (select distinct inflow_code as code from base where inflow_code is not null and btrim(inflow_code) <> '') c
  ), '[]'::jsonb)
)
from base
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_stats_snapshot(p_view text, p_from date, p_to date, p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
BEGIN
  RETURN (
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id, (select app_staff_id()) as staff_id
), scoped_members as materialized (
  select m.id, m.grade, m.registered_at, m.inflow_type, m.inflow_code
  from members m, ctx c
  where (c.role in ('admin','manager','leader')
    or (c.role = 'rep' and m.assigned_staff_id = c.staff_id))
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
), member_period as materialized (
  select * from scoped_members
  where (registered_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), scoped_payments as materialized (
  select p.* from payments p join scoped_members m on m.id = p.member_id
), approved_period as materialized (
  select * from scoped_payments
  where status::text = 'approved' and paid_at is not null
    and (paid_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), created_period as materialized (
  select * from scoped_payments
  where (created_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
)
select case when p_view in ('signup','inflow') then jsonb_build_object(
  'kind', 'members',
  'total', (select count(*) from scoped_members),
  'paid', (select count(*) from scoped_members where grade::text in ('gold','goldp','ruby','vip','royal')),
  'period', (select count(*) from member_period),
  'periodPaid', (select count(*) from member_period where grade::text in ('gold','goldp','ruby','vip','royal')),
  'distinctTypes', (select count(distinct coalesce(inflow_type, '미상')) from scoped_members),
  'days', coalesce((
    select jsonb_agg(jsonb_build_object('date', x.day::text, 'value', x.value) order by x.day)
    from (
      select (registered_at at time zone 'Asia/Seoul')::date as day, count(*)::bigint as value
      from member_period group by 1
    ) x
  ), '[]'::jsonb),
  'grades', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count) order by x.count desc)
    from (select grade::text as key, count(*)::bigint as count from scoped_members group by 1) x
  ), '[]'::jsonb),
  'inflowTypes', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count, 'paid', x.paid) order by x.count desc)
    from (
      select coalesce(inflow_type, '미상') as key, count(*)::bigint as count,
        count(*) filter (where grade::text in ('gold','goldp','ruby','vip','royal'))::bigint as paid
      from member_period group by 1
    ) x
  ), '[]'::jsonb),
  'inflowCodes', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count) order by x.count desc)
    from (
      select coalesce(inflow_code, '미상') as key, count(*)::bigint as count
      from member_period group by 1
    ) x
  ), '[]'::jsonb)
) else jsonb_build_object(
  'kind', 'payments',
  'total', (select coalesce(sum(amount), 0) from approved_period),
  'approvedCount', (select count(*) from approved_period),
  'createdCount', (select count(*) from created_period),
  'days', coalesce((
    select jsonb_agg(jsonb_build_object('date', x.day::text, 'value', x.value) order by x.day)
    from (
      select (paid_at at time zone 'Asia/Seoul')::date as day, sum(amount)::bigint as value
      from approved_period group by 1
    ) x
  ), '[]'::jsonb),
  'products', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'label', x.label, 'value', x.value, 'count', x.count) order by x.value desc)
    from (
      select coalesce(ap.product_id, case when ap.meta->>'source_site' in ('lotto815','cplotto','infolotto','best') then ap.meta->>'source_site' || ':legacy:' || nullif(ap.meta->>'legacy_item_code', '') end, 'none') as key,
        coalesce(pr.name, case when ap.meta->>'source_site' in ('lotto815','cplotto','infolotto','best') then nullif(btrim(ap.meta->>'legacy_item_name'), '') || ' (이전상품)' end, '기타') as label,
        sum(ap.amount)::bigint as value, count(*)::bigint as count
      from approved_period ap left join products pr on pr.id = ap.product_id
      group by 1, 2
    ) x
  ), '[]'::jsonb),
  'methods', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'label', x.label, 'value', x.value, 'count', x.count) order by x.value desc)
    from (
      select case when method::text = 'pg' then 'pg:' || coalesce(pg_provider, 'PG') else 'm:' || method::text end as key,
        case when method::text = 'pg' then coalesce(pg_provider, 'PG(미지정)')
             when method::text = 'unknown' then '이전자료 미기재'
             when method::text = 'bank' then '무통장' else '수기' end as label,
        sum(amount)::bigint as value, count(*)::bigint as count
      from approved_period group by 1, 2
    ) x
  ), '[]'::jsonb),
  'statuses', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count) order by x.count desc)
    from (select status::text as key, count(*)::bigint as count from created_period group by 1) x
  ), '[]'::jsonb)
) end
  );
END;
$function$;
