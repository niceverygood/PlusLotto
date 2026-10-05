-- One durable issuance per member/round across cron, manual, and lost HTTP responses.
-- A claimed/unknown/rejected issue is NEVER automatically reclaimable. Provider reconciliation
-- is separate from issuance. Member IDs, not phone numbers, identify contracts.
CREATE TABLE public.reco_issue_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id text NOT NULL,
  round_no integer NOT NULL CHECK (round_no > 0),
  source_site text NOT NULL,
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed','accepted','rejected','unknown','not_requested')),
  issue jsonb NOT NULL,
  should_send boolean NOT NULL,
  phone text NOT NULL DEFAULT '',
  actor_id text,
  mode text NOT NULL CHECK (mode IN ('scheduled','manual')),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(member_id,round_no)
);
-- No member FK/cascade: deleting a member or display history must not delete a send tombstone.
ALTER TABLE public.reco_issue_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reco_issue_ledger FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.reco_issue_ledger TO service_role;
CREATE INDEX reco_issue_unresolved_idx ON public.reco_issue_ledger(created_at)
  WHERE status IN ('claimed','unknown');

CREATE FUNCTION public.reco_issue_claim(
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
  SELECT * INTO l FROM public.reco_issue_ledger WHERE member_id=m.id AND round_no=p_round_no;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'status','skipped','claimed',false,'reason','ALREADY_CLAIMED','outcome',l.status);
  END IF;
  IF m.meta ? 'weekly_recos' AND jsonb_typeof(m.meta->'weekly_recos') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok',true,'status','review_required','claimed',false,'reason','INVALID_HISTORY');
  END IF;
  recos:=coalesce(m.meta->'weekly_recos','[]');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(recos) e WHERE e->>'round_no'=p_round_no::text) THEN
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
    FROM jsonb_array_elements(jsonb_build_array(clean_issue)||recos) WITH ORDINALITY e(value,ord) WHERE ord<=8;
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

CREATE FUNCTION public.reco_issue_finish(p_claim_id uuid,p_claim_token uuid,p_outcome text,p_receipt jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
  SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE l public.reco_issue_ledger; v_receipt jsonb; code text; updated integer;
BEGIN
  IF current_user <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE='42501'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','unknown','not_requested')
    OR jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR octet_length(p_receipt::text)>65536 THEN
    RAISE EXCEPTION 'INVALID_OUTCOME' USING ERRCODE='22023';
  END IF;
  SELECT * INTO l FROM public.reco_issue_ledger WHERE id=p_claim_id FOR UPDATE;
  IF NOT FOUND OR p_claim_token IS NULL OR l.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'INVALID_CLAIM' USING ERRCODE='22023';
  END IF;
  IF NOT l.should_send AND p_outcome<>'not_requested' THEN RAISE EXCEPTION 'SMS_NOT_REQUESTED' USING ERRCODE='22023'; END IF;
  code:=left(regexp_replace(coalesce(p_receipt->>'code',p_outcome),'[^a-zA-Z0-9_:-]','','g'),80);
  -- Only explicit receipt fields are retained; never persist a raw provider object/tokens.
  v_receipt:=jsonb_build_object('code',code,'cmid',left(regexp_replace(p_receipt->>'cmid','[[:cntrl:]]','','g'),128),
    'httpStatus',CASE WHEN p_receipt->>'httpStatus' ~ '^[1-5][0-9][0-9]$' THEN (p_receipt->>'httpStatus')::integer ELSE NULL END,
    'body',left(coalesce(p_receipt->>'body',''),20000));
  IF l.status<>'claimed' THEN
    IF l.status=p_outcome AND l.receipt=v_receipt THEN
      RETURN jsonb_build_object('ok',true,'status',l.status,'outcome',l.status,'repeated',true);
    END IF;
    RAISE EXCEPTION 'ALREADY_FINALIZED' USING ERRCODE='22023';
  END IF;
  IF l.should_send THEN
    UPDATE public.sms_sends SET body=v_receipt->>'body', status=CASE
      WHEN p_outcome='accepted' THEN '발송완료'
      WHEN p_outcome='not_requested' THEN '발송보류(조합요청취소)'
      ELSE '접수확인필요(조합:'||code||')' END
      WHERE id='sms_reco_claim_'||l.id::text AND member_id=l.member_id AND phone=l.phone;
    GET DIAGNOSTICS updated=ROW_COUNT;
    IF updated<>1 THEN RAISE EXCEPTION 'SMS_RECORD_MISSING' USING ERRCODE='22023'; END IF;
  END IF;
  UPDATE public.reco_issue_ledger SET status=p_outcome,receipt=v_receipt,finished_at=now() WHERE id=l.id;
  RETURN jsonb_build_object('ok',true,'status',p_outcome,'outcome',p_outcome,'repeated',false);
END $$;

REVOKE ALL ON FUNCTION public.reco_issue_claim(text,integer,jsonb,jsonb,text,date,integer,text,boolean,text,integer,text,text),
  public.reco_issue_finish(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reco_issue_claim(text,integer,jsonb,jsonb,text,date,integer,text,boolean,text,integer,text,text),
  public.reco_issue_finish(uuid,uuid,text,jsonb) TO service_role;
