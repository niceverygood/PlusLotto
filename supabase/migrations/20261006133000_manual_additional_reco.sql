-- Explicit staff-confirmed additional issuance has its own durable request identity.
-- Legacy/manual-null and scheduled issuance retain a single member/round tombstone.
ALTER TABLE public.reco_issue_ledger ADD COLUMN manual_request_id uuid;
ALTER TABLE public.reco_issue_ledger DROP CONSTRAINT reco_issue_ledger_member_id_round_no_key;
CREATE UNIQUE INDEX reco_issue_once_per_round ON public.reco_issue_ledger(member_id,round_no) WHERE manual_request_id IS NULL;
CREATE UNIQUE INDEX reco_issue_manual_request_unique ON public.reco_issue_ledger(manual_request_id) WHERE manual_request_id IS NOT NULL;
ALTER TABLE public.reco_issue_ledger ADD CONSTRAINT reco_issue_manual_mode CHECK(manual_request_id IS NULL OR mode='manual');
CREATE TABLE public.reco_manual_operations (
 id uuid PRIMARY KEY, member_id text NOT NULL, actor_id text NOT NULL, round_no integer NOT NULL,
 set_count integer NOT NULL CHECK(set_count BETWEEN 1 AND 100), also_sms boolean NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','blocked','claimed')), reason text,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.reco_manual_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reco_manual_operations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.reco_manual_operations TO service_role;
CREATE FUNCTION public.reco_manual_block(p_operation_id uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE='42501'; END IF;
 UPDATE public.reco_manual_operations SET status='blocked',reason=p_reason WHERE id=p_operation_id AND status='pending';
 IF NOT FOUND THEN RAISE EXCEPTION 'MANUAL_OPERATION_STATE_CHANGED'; END IF;
 RETURN jsonb_build_object('ok',true,'claimed',false,'status','blocked','reason',p_reason,
  'confirmedNotIssued',true,'operationId',p_operation_id);
END $$;
REVOKE ALL ON FUNCTION public.reco_manual_block(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reco_manual_block(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.reco_issue_claim(
  p_member_id text,p_round_no integer,p_expected_meta jsonb,p_issue jsonb,
  p_expected_site text,p_today date,p_weekday integer,
  p_mode text DEFAULT 'scheduled',p_also_sms boolean DEFAULT true,p_actor text DEFAULT NULL,p_set_count integer DEFAULT NULL,
  p_expected_grade text DEFAULT NULL,p_expected_phone text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
  SET lock_timeout='3s' SET statement_timeout='15s' AS $$
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
  paid:=m.grade::text IN ('gold','goldp','vip','royal');
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
END $$;

CREATE FUNCTION public.reco_issue_manual_claim(
  p_operation_id uuid,
  p_member_id text,p_round_no integer,p_expected_meta jsonb,p_issue jsonb,
  p_expected_site text,p_today date,p_weekday integer,
  p_mode text DEFAULT 'scheduled',p_also_sms boolean DEFAULT true,p_actor text DEFAULT NULL,p_set_count integer DEFAULT NULL,
  p_expected_grade text DEFAULT NULL,p_expected_phone text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
  SET lock_timeout='3s' SET statement_timeout='15s' AS $$
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
  paid:=m.grade::text IN ('gold','goldp','vip','royal');
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
END $$;


-- Reset archives prevent restoration of any original issue. A NEW identified manual
-- issue is allowed only when its exact immutable ledger issue matches and it was not reset.
CREATE OR REPLACE FUNCTION public.prevent_reset_reco_restore() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF jsonb_typeof(NEW.meta->'weekly_recos')='array' AND EXISTS(
  SELECT 1 FROM public.member_reco_reset_archive a
  CROSS JOIN LATERAL jsonb_array_elements(a.issues) previous
  CROSS JOIN LATERAL jsonb_array_elements(NEW.meta->'weekly_recos') active
  WHERE a.member_id=NEW.id AND previous->>'round_no'=active->>'round_no'
   AND (previous=active OR NOT (
    (EXISTS(
     SELECT 1 FROM public.reco_issue_ledger l WHERE l.member_id=NEW.id AND l.issue=active
      AND (l.manual_request_id::text=active->>'manual_request_id'
       OR (l.manual_request_id IS NULL AND EXISTS(SELECT 1 FROM public.reco_issue_ledger prior
        WHERE prior.member_id=NEW.id AND prior.manual_request_id::text=previous->>'manual_request_id' AND prior.issue=previous)))
    ) OR (
     -- Removing one new manual card must preserve unchanged pre-ledger legacy cards.
     EXISTS(SELECT 1 FROM public.reco_issue_ledger prior WHERE prior.member_id=NEW.id
      AND prior.manual_request_id::text=previous->>'manual_request_id' AND prior.issue=previous)
     AND jsonb_typeof(OLD.meta->'weekly_recos')='array'
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.meta->'weekly_recos') unchanged WHERE unchanged=active)
    ))
    AND NOT EXISTS(SELECT 1 FROM public.member_reco_reset_archive z
     CROSS JOIN LATERAL jsonb_array_elements(z.issues) old_issue WHERE z.member_id=NEW.id AND old_issue=active)
   ))
 ) THEN RAISE EXCEPTION 'RECO_RESET_ALREADY_ISSUED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.reco_issue_manual_claim(uuid,text,integer,jsonb,jsonb,text,date,integer,text,boolean,text,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reco_issue_manual_claim(uuid,text,integer,jsonb,jsonb,text,date,integer,text,boolean,text,integer,text,text) TO service_role;
