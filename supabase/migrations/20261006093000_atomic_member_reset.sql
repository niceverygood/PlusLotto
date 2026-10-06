-- Clear active recommendations atomically, retaining immutable legacy issuance tombstones.
-- No cascade: deleting a member must not erase evidence of an earlier issue.
CREATE TABLE public.member_reco_reset_archive (
 operation_id uuid NOT NULL, member_id text NOT NULL,
 issues jsonb NOT NULL CHECK (jsonb_typeof(issues)='array'),
 reset_at timestamptz NOT NULL, reset_by text NOT NULL,
 PRIMARY KEY(operation_id,member_id)
);
CREATE INDEX member_reco_reset_archive_member_idx ON public.member_reco_reset_archive(member_id);
CREATE TABLE public.member_reset_receipts (
 operation_id uuid PRIMARY KEY, member_ids text[] NOT NULL,
 actor_id text NOT NULL, created_at timestamptz NOT NULL
);
ALTER TABLE public.member_reco_reset_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_reset_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_reco_reset_archive,public.member_reset_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_reco_reset_archive,public.member_reset_receipts TO service_role;

CREATE FUNCTION public.admin_reset_members(p_member_ids text[],p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
 SET lock_timeout='3s' SET statement_timeout='45s' AS $$
DECLARE actor_id text; ids text[]; m public.members; receipt public.member_reset_receipts;
 ts timestamptz:=statement_timestamp(); locked_count integer:=0; total_issues integer:=0;
 issues jsonb; item jsonb; memos jsonb; memo_archive jsonb;
BEGIN
 SELECT id INTO actor_id FROM public.staff WHERE auth_user_id=auth.uid() AND is_active AND role::text='admin' FOR SHARE;
 IF auth.uid() IS NULL OR actor_id IS NULL THEN RAISE EXCEPTION 'ACTIVE_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_operation_id IS NULL OR p_member_ids IS NULL OR array_ndims(p_member_ids) IS DISTINCT FROM 1
  OR cardinality(p_member_ids)<1 OR cardinality(p_member_ids)>500
  OR EXISTS(SELECT 1 FROM unnest(p_member_ids) id WHERE id IS NULL OR btrim(id)='' OR length(id)>256)
  OR (SELECT count(DISTINCT id) FROM unnest(p_member_ids) id)<>cardinality(p_member_ids) THEN
  RAISE EXCEPTION 'INVALID_MEMBER_SCOPE' USING ERRCODE='22023';
 END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM unnest(p_member_ids) id;
 -- An uncertain HTTP response can retry the same operation without resetting again.
 PERFORM pg_advisory_xact_lock(hashtextextended('member-reset:'||p_operation_id::text,0));
 SELECT * INTO receipt FROM public.member_reset_receipts WHERE operation_id=p_operation_id;
 IF FOUND THEN
  IF receipt.member_ids IS DISTINCT FROM ids OR receipt.actor_id IS DISTINCT FROM actor_id THEN
   RAISE EXCEPTION 'RESET_OPERATION_SCOPE_CHANGED' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('member_ids',ids,'repeated',true);
 END IF;
 -- Same order as durable winner aggregation. Never take an outbox row lock after member locks.
 PERFORM pg_advisory_xact_lock(8141244,0);
 FOR m IN SELECT * FROM public.members WHERE id=ANY(ids) ORDER BY id FOR UPDATE LOOP
  locked_count:=locked_count+1;
 END LOOP;
 IF locked_count<>cardinality(ids) THEN RAISE EXCEPTION 'MEMBER_SCOPE_CHANGED' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.reco_issue_ledger WHERE member_id=ANY(ids) AND status IN ('claimed','unknown'))
  OR EXISTS(SELECT 1 FROM public.lotto_sync_sms_outbox WHERE member_id=ANY(ids) AND status IN ('pending','claimed','unknown')) THEN
  RAISE EXCEPTION 'RESET_DELIVERY_UNRESOLVED' USING ERRCODE='55000';
 END IF;
 FOR m IN SELECT * FROM public.members WHERE id=ANY(ids) ORDER BY id LOOP
  IF jsonb_typeof(m.meta) IS DISTINCT FROM 'object'
   OR (m.meta?'weekly_recos' AND jsonb_typeof(m.meta->'weekly_recos') IS DISTINCT FROM 'array') THEN
   RAISE EXCEPTION 'INVALID_RECO_HISTORY' USING ERRCODE='22023';
  END IF;
  issues:=coalesce(m.meta->'weekly_recos','[]');
  FOR item IN SELECT value FROM jsonb_array_elements(issues) LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR coalesce(item->>'round_no','') !~ '^[1-9][0-9]{0,9}$' THEN
    RAISE EXCEPTION 'INVALID_RECO_HISTORY' USING ERRCODE='22023';
   END IF;
   IF (item->>'round_no')::bigint>2147483647 THEN RAISE EXCEPTION 'INVALID_RECO_HISTORY' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (m.meta?'memos' AND jsonb_typeof(m.meta->'memos') IS DISTINCT FROM 'array')
   OR (m.meta?'reset_memos' AND jsonb_typeof(m.meta->'reset_memos') IS DISTINCT FROM 'array') THEN
   RAISE EXCEPTION 'INVALID_MEMO_HISTORY' USING ERRCODE='22023';
  END IF;
  memos:=coalesce(m.meta->'memos','[]'); memo_archive:=coalesce(m.meta->'reset_memos','[]');
  IF jsonb_array_length(memos)>0 THEN
   FOR item IN SELECT value FROM jsonb_array_elements(memos) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'body') IS DISTINCT FROM 'string' THEN
     RAISE EXCEPTION 'INVALID_MEMO_HISTORY' USING ERRCODE='22023';
    END IF;
    memo_archive:=memo_archive||jsonb_build_array(jsonb_build_object('body',item->'body','archived_at',ts,
     'reset_by',actor_id,'author',item->'author','consult_status',item->'consult_status'));
   END LOOP;
  ELSIF btrim(coalesce(m.memo,''))<>'' THEN
   memo_archive:=memo_archive||jsonb_build_array(jsonb_build_object('body',m.memo,'archived_at',ts,'reset_by',actor_id));
  END IF;
  INSERT INTO public.member_reco_reset_archive VALUES(p_operation_id,m.id,issues,ts,actor_id);
  total_issues:=total_issues+jsonb_array_length(issues);
  UPDATE public.members SET memo=NULL,grade='free',status='active',assigned_staff_id=NULL,team_id=NULL,
   outcall_done=false,tendency=NULL,consult_status='신규',last_active_at=NULL,registered_at=ts,
   is_suspended=false,is_deleted=false,is_withdrawn=false,win_history=NULL,
   meta=m.meta||jsonb_build_object('memos','[]'::jsonb,'reset_memos',memo_archive,'win_records','[]'::jsonb,
    'weekly_recos','[]'::jsonb,'last_reset_at',ts) WHERE id=m.id;
  INSERT INTO public.assignments(id,member_id,staff_id,assigned_by,type,created_at)
   VALUES('as_'||gen_random_uuid()::text,m.id,NULL,actor_id,'manual',ts);
 END LOOP;
 INSERT INTO public.logs(id,kind,actor,action,target_type,target_id,meta,created_at)
  VALUES('log_'||gen_random_uuid()::text,'admin',actor_id,'member.reset_db','member',NULL,
   jsonb_build_object('count',cardinality(ids),'operation_id',p_operation_id,'archived_issue_count',total_issues),ts);
 INSERT INTO public.member_reset_receipts VALUES(p_operation_id,ids,actor_id,ts);
 RETURN jsonb_build_object('member_ids',ids,'repeated',false);
END $$;
REVOKE ALL ON FUNCTION public.admin_reset_members(text[],uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_reset_members(text[],uuid) TO authenticated;

-- Older direct-meta clients must not restore a reset issue or issue its round again.
CREATE FUNCTION public.prevent_reset_reco_restore() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF jsonb_typeof(NEW.meta->'weekly_recos')='array' AND EXISTS(
  SELECT 1 FROM public.member_reco_reset_archive a
  CROSS JOIN LATERAL jsonb_array_elements(a.issues) previous
  CROSS JOIN LATERAL jsonb_array_elements(NEW.meta->'weekly_recos') active
  WHERE a.member_id=NEW.id AND previous->>'round_no'=active->>'round_no'
 ) THEN RAISE EXCEPTION 'RECO_RESET_ALREADY_ISSUED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.prevent_reset_reco_restore() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER prevent_reset_reco_restore BEFORE INSERT OR UPDATE OF meta ON public.members
 FOR EACH ROW EXECUTE FUNCTION public.prevent_reset_reco_restore();

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
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(recos) e WHERE e->>'round_no'=p_round_no::text)
    OR EXISTS(SELECT 1 FROM public.member_reco_reset_archive a
      CROSS JOIN LATERAL jsonb_array_elements(a.issues) e
      WHERE a.member_id=m.id AND e->>'round_no'=p_round_no::text) THEN
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

CREATE OR REPLACE FUNCTION public.lotto_sync_batch(p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='3s' SET statement_timeout='45s' AS $$
DECLARE j public.lotto_sync_jobs; r public.lotto_rounds; w public.lotto_sync_work; m public.members; b public.bets;
 combo jsonb; nums integer[]; rk integer; best integer; wins integer; idx integer; fresh jsonb; records jsonb;
 processed integer:=0; winner_count integer:=0; ranks jsonb:='{}'; entry jsonb; latest integer; v_error text;
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'BATCH_LIMIT' USING ERRCODE='22023'; END IF;
 -- Serialize jobs as well as batches: an unfinished earlier round must finish before a later round.
 PERFORM pg_advisory_xact_lock(8141244,0);
 SELECT * INTO j FROM public.lotto_sync_jobs WHERE status<>'complete' ORDER BY round_no LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'status','idle','processed',0,'remaining',0); END IF;
 SELECT * INTO r FROM public.lotto_rounds WHERE round_no=j.round_no FOR UPDATE;
 BEGIN
  FOR w IN SELECT * FROM public.lotto_sync_work WHERE round_no=j.round_no AND NOT done ORDER BY kind,target_id LIMIT p_limit FOR UPDATE LOOP
   IF w.kind='bet' THEN
    SELECT * INTO b FROM public.bets WHERE id=w.target_id AND round_no=j.round_no FOR UPDATE;
    IF FOUND THEN
     IF NOT lotto_sync_private.valid_balls(to_jsonb(b.numbers)) THEN RAISE EXCEPTION 'BET_INVALID' USING ERRCODE='22023'; END IF;
     rk:=lotto_sync_private.rank(b.numbers,r.numbers,r.bonus);
     UPDATE public.bets SET rank=rk,prize=lotto_sync_private.prize(rk,r) WHERE id=b.id;
     IF b.member_ref IS DISTINCT FROM w.issue->>'member_ref' THEN RAISE EXCEPTION 'BET_CHANGED' USING ERRCODE='22023'; END IF;
     SELECT * INTO m FROM public.members WHERE id=b.member_ref FOR UPDATE;
     IF FOUND THEN
      IF m.meta?'win_records' AND jsonb_typeof(m.meta->'win_records')<>'array' THEN RAISE EXCEPTION 'WIN_RECORDS_INVALID' USING ERRCODE='22023'; END IF;
      idx:=(w.issue->>'combo_index')::integer;
      SELECT coalesce(jsonb_agg(e),'[]') INTO records FROM jsonb_array_elements(coalesce(m.meta->'win_records','[]')) e
       WHERE (e->'round_no'=to_jsonb(r.round_no) AND e->>'source'='bet' AND (idx=1 OR e->'combo_index'=to_jsonb(idx))) IS NOT TRUE;
      IF rk<=3 THEN records:=records||jsonb_build_array(jsonb_build_object('round_no',r.round_no,'draw_date',r.draw_date,'rank',rk,'prize',lotto_sync_private.prize(rk,r),'combo_index',idx,'source','bet')); END IF;
      SELECT coalesce(jsonb_agg(e ORDER BY CASE WHEN e->>'round_no'~'^[0-9]+$' THEN (e->>'round_no')::bigint END DESC NULLS LAST,CASE WHEN e->>'combo_index'~'^[0-9]+$' THEN (e->>'combo_index')::bigint END),'[]') INTO records FROM jsonb_array_elements(records) e;
      SELECT max((e->>'round_no')::integer) INTO latest FROM jsonb_array_elements(records) e WHERE e->>'round_no'~'^[0-9]+$';
      UPDATE public.members SET meta=jsonb_set(coalesce(meta,'{}'),'{win_records}',records),win_history=lotto_sync_private.win_summary(records,win_history,r.round_no) WHERE id=m.id;
     END IF;
    END IF;
   ELSE
    SELECT * INTO m FROM public.members WHERE id=w.target_id FOR UPDATE;
    -- A snapshot queued before reset cannot recreate reset winnings or a winner SMS.
    IF FOUND AND NOT EXISTS(SELECT 1 FROM public.member_reco_reset_archive a
      CROSS JOIN LATERAL jsonb_array_elements(a.issues) e
      WHERE a.member_id=m.id AND e->>'round_no'=j.round_no::text) THEN
     IF jsonb_typeof(w.issue->'sets') IS DISTINCT FROM 'array' OR jsonb_array_length(w.issue->'sets')=0 THEN RAISE EXCEPTION 'RECO_INVALID' USING ERRCODE='22023'; END IF;
     fresh:='[]'; best:=NULL; wins:=0; idx:=0;
     FOR combo IN SELECT value FROM jsonb_array_elements(w.issue->'sets') LOOP
      idx:=idx+1;
      IF NOT lotto_sync_private.valid_balls(combo) THEN RAISE EXCEPTION 'RECO_INVALID' USING ERRCODE='22023'; END IF;
      nums:=ARRAY(SELECT value::text::integer FROM jsonb_array_elements(combo));
      rk:=lotto_sync_private.rank(nums,r.numbers,r.bonus);
      IF rk IS NOT NULL THEN
       wins:=wins+1; best:=least(best,rk);
       fresh:=fresh||jsonb_build_array(jsonb_build_object('round_no',r.round_no,'draw_date',r.draw_date,'rank',rk,'prize',lotto_sync_private.prize(rk,r),'combo_index',idx,'source','reco'));
       ranks:=jsonb_set(ranks,ARRAY[rk::text],to_jsonb(coalesce((ranks->>rk::text)::integer,0)+1));
      END IF;
     END LOOP;
     IF m.meta?'win_records' AND jsonb_typeof(m.meta->'win_records')<>'array' THEN RAISE EXCEPTION 'WIN_RECORDS_INVALID' USING ERRCODE='22023'; END IF;
     SELECT coalesce(jsonb_agg(e),'[]') INTO records FROM jsonb_array_elements(coalesce(m.meta->'win_records','[]')) e WHERE (e->'round_no'=to_jsonb(r.round_no) AND e->>'source'='reco') IS NOT TRUE;
     records:=records||fresh;
     SELECT coalesce(jsonb_agg(e ORDER BY CASE WHEN e->>'round_no'~'^[0-9]+$' THEN (e->>'round_no')::bigint END DESC NULLS LAST,CASE WHEN e->>'combo_index'~'^[0-9]+$' THEN (e->>'combo_index')::bigint END),'[]') INTO records FROM jsonb_array_elements(records) e;
     -- Preserve a more recent summary, including one saved concurrently before this row lock.
     SELECT max((e->>'round_no')::integer) INTO latest FROM jsonb_array_elements(records) e WHERE e->>'round_no'~'^[0-9]+$';
     UPDATE public.members SET meta=jsonb_set(coalesce(meta,'{}'),'{win_records}',records),win_history=lotto_sync_private.win_summary(records,win_history,r.round_no) WHERE id=m.id;
     IF best IS NOT NULL THEN
      winner_count:=winner_count+1;
      IF j.queue_sms THEN INSERT INTO public.lotto_sync_sms_outbox(round_no,member_id,rank,numbers,prize) VALUES(j.round_no,m.id,best,r.numbers,lotto_sync_private.prize(best,r)) ON CONFLICT(round_no,member_id) DO NOTHING; END IF;
     END IF;
    END IF;
   END IF;
   UPDATE public.lotto_sync_work SET done=true WHERE round_no=w.round_no AND kind=w.kind AND target_id=w.target_id;
   processed:=processed+1;
  END LOOP;
  FOR entry IN SELECT jsonb_build_object('rank',key,'count',value) FROM jsonb_each(ranks) LOOP
   j.rank_counts:=jsonb_set(j.rank_counts,ARRAY[entry->>'rank'],to_jsonb(coalesce((j.rank_counts->>(entry->>'rank'))::integer,0)+(entry->>'count')::integer));
  END LOOP;
  UPDATE public.lotto_sync_jobs SET done=done+processed,winners=winners+winner_count,rank_counts=j.rank_counts,last_error=NULL,updated_at=now(),
   status=CASE WHEN done+processed=total THEN 'complete' ELSE 'running' END,completed_at=CASE WHEN done+processed=total THEN now() ELSE NULL END WHERE round_no=j.round_no RETURNING * INTO j;
  IF j.status='complete' THEN UPDATE public.lotto_rounds SET confirmed_at=now() WHERE round_no=j.round_no; END IF;
 EXCEPTION WHEN OTHERS THEN
  -- Inner changes are rolled back; durable failure metadata survives, and a future tick can resume.
  v_error:=CASE WHEN SQLERRM IN ('RECO_INVALID','BET_INVALID','BET_CHANGED','WIN_RECORDS_INVALID') THEN SQLERRM ELSE 'BATCH_FAILED' END;
  UPDATE public.lotto_sync_jobs SET status='blocked',last_error=v_error,updated_at=now() WHERE round_no=j.round_no;
  RETURN jsonb_build_object('ok',false,'round_no',j.round_no,'status','blocked','processed',0,'remaining',j.total-j.done,'error',v_error);
 END;
 RETURN jsonb_build_object('ok',true,'round_no',j.round_no,'status',j.status,'processed',processed,'remaining',j.total-j.done,'winners',j.winners);
END $$;

NOTIFY pgrst, 'reload schema';
