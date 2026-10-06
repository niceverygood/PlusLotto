-- Same-round manual additions are separate issues; aggregate every active issue.
-- Requires 20261006133000_manual_additional_reco.sql.
CREATE OR REPLACE FUNCTION lotto_sync_private.active_reco_issues(p_member text,p_meta jsonb,p_round integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(issue ORDER BY ord),'[]'::jsonb) FROM (
  SELECT DISTINCT ON (identity_key) issue,ord FROM (
   SELECT e.value issue,e.ordinality ord,
    CASE WHEN e.value->>'manual_request_id' IS NOT NULL THEN 'manual:'||(e.value->>'manual_request_id')
      ELSE 'legacy:'||md5(e.value::text) END identity_key
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_meta->'weekly_recos')='array'
    THEN p_meta->'weekly_recos' ELSE '[]'::jsonb END) WITH ORDINALITY e
   WHERE e.value->'round_no'=to_jsonb(p_round)
    AND CASE WHEN e.value->>'manual_request_id' IS NOT NULL THEN
      EXISTS(SELECT 1 FROM public.reco_issue_ledger l WHERE l.member_id=p_member AND l.round_no=p_round
        AND l.manual_request_id::text=e.value->>'manual_request_id' AND l.issue=e.value)
      AND NOT EXISTS(SELECT 1 FROM public.member_reco_reset_archive a
        CROSS JOIN LATERAL jsonb_array_elements(a.issues) old
        WHERE a.member_id=p_member AND old->>'manual_request_id'=e.value->>'manual_request_id')
    ELSE NOT EXISTS(SELECT 1 FROM public.member_reco_reset_archive a
      CROSS JOIN LATERAL jsonb_array_elements(a.issues) old
      WHERE a.member_id=p_member AND old->>'round_no'=p_round::text
        AND old->>'manual_request_id' IS NULL) END
  ) candidates ORDER BY identity_key,ord
 ) unique_issues
$$;

CREATE OR REPLACE FUNCTION lotto_sync_private.reco_records(p_member text,p_meta jsonb,p_round public.lotto_rounds)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE issues jsonb; issue jsonb; combo jsonb; nums integer[]; rk integer;
 result jsonb:='[]'; idx integer:=0; local_idx integer; issue_key text;
BEGIN
 issues:=lotto_sync_private.active_reco_issues(p_member,p_meta,p_round.round_no);
 FOR issue IN SELECT value FROM jsonb_array_elements(issues) LOOP
  IF jsonb_typeof(issue->'sets') IS DISTINCT FROM 'array' OR jsonb_array_length(issue->'sets')=0
    THEN RAISE EXCEPTION 'RECO_INVALID' USING ERRCODE='22023'; END IF;
  local_idx:=0;
  issue_key:=coalesce(issue->>'manual_request_id','legacy:'||md5(issue::text));
  FOR combo IN SELECT value FROM jsonb_array_elements(issue->'sets') LOOP
   idx:=idx+1; local_idx:=local_idx+1;
   IF NOT lotto_sync_private.valid_balls(combo) THEN RAISE EXCEPTION 'RECO_INVALID' USING ERRCODE='22023'; END IF;
   nums:=ARRAY(SELECT value::text::integer FROM jsonb_array_elements(combo));
   rk:=lotto_sync_private.rank(nums,p_round.numbers,p_round.bonus);
   IF rk IS NOT NULL THEN
    result:=result||jsonb_build_array(jsonb_build_object('round_no',p_round.round_no,'draw_date',p_round.draw_date,
      'rank',rk,'prize',lotto_sync_private.prize(rk,p_round),'combo_index',idx,'source','reco',
      'issue_id',issue_key,'issue_combo_index',local_idx));
   END IF;
  END LOOP;
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION lotto_sync_private.active_reco_issues(text,jsonb,integer),
 lotto_sync_private.reco_records(text,jsonb,public.lotto_rounds) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION lotto_sync_private.active_reco_issues(text,jsonb,integer),
 lotto_sync_private.reco_records(text,jsonb,public.lotto_rounds) TO service_role;

CREATE OR REPLACE FUNCTION lotto_sync_private.snapshot(p_round integer,p_queue boolean) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 DELETE FROM public.lotto_sync_work WHERE round_no=p_round;
 INSERT INTO public.lotto_sync_work(round_no,kind,target_id,issue)
 SELECT p_round,'member',m.id,jsonb_build_object('round_no',p_round,'issues',x.issues)
 FROM public.members m CROSS JOIN LATERAL (
  SELECT lotto_sync_private.active_reco_issues(m.id,m.meta,p_round) issues
 ) x WHERE NOT m.is_deleted AND jsonb_array_length(x.issues)>0;
 INSERT INTO public.lotto_sync_work(round_no,kind,target_id,issue)
 SELECT p_round,'bet',b.id,jsonb_build_object('numbers',b.numbers,'member_ref',b.member_ref,
  'combo_index',row_number() OVER(PARTITION BY b.member_ref ORDER BY b.id)) FROM public.bets b WHERE b.round_no=p_round;
 UPDATE public.lotto_sync_jobs SET status='pending',queue_sms=p_queue,
  total=(SELECT count(*) FROM public.lotto_sync_work WHERE round_no=p_round),done=0,winners=0,
  rank_counts='{"1":0,"2":0,"3":0,"4":0,"5":0}',last_error=NULL,updated_at=now(),completed_at=NULL WHERE round_no=p_round;
 UPDATE public.lotto_rounds SET confirmed_at=NULL WHERE round_no=p_round;
END $$;

-- Delete only the selected visible issue. Delivery receipts are immutable evidence.
CREATE OR REPLACE FUNCTION public.admin_delete_member_reco(p_member_id text,p_round_no integer,p_issued_at text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.staff; m public.members; r public.lotto_rounds; removed jsonb; remaining jsonb;
 records jsonb; fresh jsonb; next_meta jsonb; site text; removed_count integer;
BEGIN
 SELECT * INTO actor FROM public.staff WHERE auth_user_id=auth.uid() AND is_active IS TRUE;
 IF NOT FOUND OR actor.role::text NOT IN ('admin','manager','leader') THEN
  RAISE EXCEPTION 'ACTIVE_RECO_ADMIN_REQUIRED' USING ERRCODE='42501';
 END IF;
 IF p_member_id IS NULL OR btrim(p_member_id)='' OR p_round_no IS NULL OR p_round_no<1
   OR p_issued_at IS NULL OR btrim(p_issued_at)='' THEN RAISE EXCEPTION 'INVALID_ISSUE_SCOPE' USING ERRCODE='22023'; END IF;
 -- Same lock order as reset and winner aggregation; never erase an unresolved delivery.
 PERFORM pg_advisory_xact_lock(8141244,0);
 SELECT * INTO m FROM public.members WHERE id=p_member_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM public.reco_issue_ledger WHERE member_id=m.id AND round_no=p_round_no AND status IN ('claimed','unknown'))
  OR EXISTS(SELECT 1 FROM public.lotto_sync_sms_outbox WHERE member_id=m.id AND round_no=p_round_no AND status IN ('pending','claimed','unknown'))
 THEN RAISE EXCEPTION 'RECO_DELETE_DELIVERY_UNRESOLVED' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(m.meta->'weekly_recos') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'INVALID_RECO_HISTORY' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(e ORDER BY ord) FILTER(WHERE e->>'round_no'=p_round_no::text AND e->>'issued_at'=p_issued_at),'[]'),
  coalesce(jsonb_agg(e ORDER BY ord) FILTER(WHERE (e->>'round_no'=p_round_no::text AND e->>'issued_at'=p_issued_at) IS NOT TRUE),'[]')
 INTO removed,remaining FROM jsonb_array_elements(m.meta->'weekly_recos') WITH ORDINALITY q(e,ord);
 removed_count:=jsonb_array_length(removed);
 IF removed_count=0 THEN RAISE EXCEPTION 'RECO_ISSUE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 -- The old API identifies a card by timestamp. Never delete multiple ambiguous cards.
 IF removed_count<>1 THEN RAISE EXCEPTION 'AMBIGUOUS_ISSUE_SCOPE' USING ERRCODE='22023'; END IF;
 site:=coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto');
 -- A legacy issue without a durable ledger must not become automatically eligible after deletion.
 IF removed->0->>'manual_request_id' IS NULL THEN
  INSERT INTO public.reco_issue_ledger(member_id,round_no,source_site,status,issue,should_send,phone,actor_id,mode,receipt,finished_at)
   VALUES(m.id,p_round_no,site,'not_requested',removed->0,false,coalesce(m.phone,''),actor.id,'manual',
    jsonb_build_object('code','LEGACY_ISSUE_DELETED_DISPLAY_ONLY'),now())
   ON CONFLICT(member_id,round_no) WHERE manual_request_id IS NULL DO NOTHING;
 ELSE
  -- Exact manual-issue tombstone prevents a stale client from restoring this card.
  -- The reset trigger distinguishes this issue identity from other issues in the round.
  INSERT INTO public.member_reco_reset_archive(operation_id,member_id,issues,reset_at,reset_by)
   VALUES(gen_random_uuid(),m.id,removed,now(),actor.id);
 END IF;
 next_meta:=jsonb_set(m.meta,'{weekly_recos}',remaining,true);
 IF m.meta?'win_records' AND jsonb_typeof(m.meta->'win_records') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'WIN_RECORDS_INVALID' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(e),'[]') INTO records FROM jsonb_array_elements(coalesce(m.meta->'win_records','[]')) e
  WHERE (e->'round_no'=to_jsonb(p_round_no) AND e->>'source'='reco') IS NOT TRUE;
 SELECT * INTO r FROM public.lotto_rounds WHERE round_no=p_round_no;
 IF FOUND THEN fresh:=lotto_sync_private.reco_records(m.id,next_meta,r); ELSE fresh:='[]'; END IF;
 records:=records||fresh;
 next_meta:=jsonb_set(next_meta,'{win_records}',records,true);
 UPDATE public.members SET meta=next_meta,
  win_history=lotto_sync_private.win_summary(records,win_history,p_round_no) WHERE id=m.id;
 INSERT INTO public.logs(id,kind,actor,action,target_type,target_id,meta,created_at)
 VALUES('log_'||gen_random_uuid()::text,'admin',actor.id,'reco.issue_delete','member',m.id,
  jsonb_build_object('round_no',p_round_no,'issued_at',p_issued_at,'deleted_issues',removed_count,
   'deleted_sms',0,'receipts_preserved',true,'removed_issue',removed->0,
   'archive_kind',CASE WHEN removed->0->>'manual_request_id' IS NOT NULL THEN 'single_manual_issue_delete' ELSE 'legacy_ledger_tombstone' END),now());
 RETURN jsonb_build_object('deleted_issues',removed_count,'deleted_sms',0);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_member_reco(text,integer,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_member_reco(text,integer,text) TO authenticated;

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
    -- Re-read under the member lock: queued snapshots must not revive deleted/reset issues.
    -- Include every active issue in this round, with a stable issue identity per combination.
    IF FOUND AND m.is_deleted IS FALSE THEN
     fresh:=lotto_sync_private.reco_records(m.id,m.meta,r);
     SELECT min((e->>'rank')::integer) INTO best FROM jsonb_array_elements(fresh) e;
     FOR entry IN SELECT value FROM jsonb_array_elements(fresh) LOOP
      rk:=(entry->>'rank')::integer;
      ranks:=jsonb_set(ranks,ARRAY[rk::text],to_jsonb(coalesce((ranks->>rk::text)::integer,0)+1));
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
