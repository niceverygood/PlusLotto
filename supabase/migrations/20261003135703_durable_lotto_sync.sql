-- Durable winner aggregation. No historical job/SMS backfill is performed by this migration.
-- Each batch changes locked current member rows and its progress in ONE transaction.
CREATE SCHEMA IF NOT EXISTS lotto_sync_private;
REVOKE ALL ON SCHEMA lotto_sync_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA lotto_sync_private TO service_role;

CREATE TABLE public.lotto_sync_jobs (
  round_no integer PRIMARY KEY REFERENCES public.lotto_rounds(round_no),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','blocked','complete')),
  queue_sms boolean NOT NULL DEFAULT false,
  total integer NOT NULL DEFAULT 0, done integer NOT NULL DEFAULT 0,
  winners integer NOT NULL DEFAULT 0, rank_counts jsonb NOT NULL DEFAULT '{"1":0,"2":0,"3":0,"4":0,"5":0}',
  last_error text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  CHECK(done BETWEEN 0 AND total)
);
CREATE TABLE public.lotto_sync_work (
  round_no integer NOT NULL REFERENCES public.lotto_sync_jobs(round_no),
  kind text NOT NULL CHECK(kind IN ('member','bet')),
  target_id text NOT NULL, issue jsonb,
  done boolean NOT NULL DEFAULT false,
  PRIMARY KEY(round_no,kind,target_id)
);
CREATE INDEX lotto_sync_work_pending ON public.lotto_sync_work(round_no,kind,target_id) WHERE NOT done;
CREATE TABLE public.lotto_sync_sms_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_no integer NOT NULL REFERENCES public.lotto_sync_jobs(round_no), member_id text NOT NULL,
  rank integer NOT NULL CHECK(rank BETWEEN 1 AND 5), numbers integer[] NOT NULL, prize bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','accepted','failed','unknown','skipped')),
  claim_token uuid, claimed_at timestamptz, finished_at timestamptz,
  result_code text, provider_receipt_id text, provider_http_status integer, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(round_no,member_id)
);
CREATE INDEX lotto_sync_sms_pending ON public.lotto_sync_sms_outbox(id) WHERE status='pending';
CREATE TABLE public.lotto_sync_tick (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  last_attempt_at timestamptz,last_success_at timestamptz,last_error text
);
INSERT INTO public.lotto_sync_tick(id) VALUES(true);
ALTER TABLE public.lotto_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lotto_sync_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lotto_sync_sms_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lotto_sync_tick ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lotto_sync_jobs,public.lotto_sync_work,public.lotto_sync_sms_outbox,public.lotto_sync_tick FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.lotto_sync_jobs,public.lotto_sync_work,public.lotto_sync_sms_outbox,public.lotto_sync_tick TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.lotto_sync_sms_outbox_id_seq TO service_role;

CREATE FUNCTION lotto_sync_private.expected_round() RETURNS integer
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT greatest(0,floor(extract(epoch FROM (now()-timestamptz '2002-12-07 20:45:00+09'))/604800)::integer+1)
$$;
CREATE FUNCTION lotto_sync_private.valid_balls(p_numbers jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE n jsonb; seen integer[]:='{}'; v integer;
BEGIN
 IF jsonb_typeof(p_numbers) IS DISTINCT FROM 'array' OR jsonb_array_length(p_numbers)<>6 THEN RETURN false; END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(p_numbers) LOOP
  IF jsonb_typeof(n)<>'number' OR n::text !~ '^[0-9]+$' THEN RETURN false; END IF;
  v:=n::text::integer;
  IF v<1 OR v>45 OR v=ANY(seen) THEN RETURN false; END IF;
  seen:=array_append(seen,v);
 END LOOP;
 RETURN true;
EXCEPTION WHEN numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION lotto_sync_private.rank(p_numbers integer[],p_win integer[],p_bonus integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE count(*) WHEN 6 THEN 1 WHEN 5 THEN CASE WHEN p_bonus=ANY(p_numbers) THEN 2 ELSE 3 END WHEN 4 THEN 4 WHEN 3 THEN 5 ELSE NULL END
 FROM unnest(p_numbers) n WHERE n=ANY(p_win)
$$;
CREATE FUNCTION lotto_sync_private.prize(p_rank integer,p_round public.lotto_rounds) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE p_rank WHEN 1 THEN coalesce(p_round.prize_1,0) WHEN 2 THEN coalesce(p_round.prize_2,0) WHEN 3 THEN coalesce(p_round.prize_3,0) WHEN 4 THEN 50000 WHEN 5 THEN 5000 ELSE 0 END
$$;
-- Calculate one summary across BOTH reco and bet records, preserving future summaries.
CREATE FUNCTION lotto_sync_private.win_summary(p_records jsonb,p_previous text,p_round integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE old_round numeric; latest numeric; best integer; wins integer;
BEGIN
 old_round:=substring(p_previous FROM '^([0-9]+)회')::numeric;
 IF old_round>p_round THEN RETURN p_previous; END IF;
 SELECT max((e->>'round_no')::numeric) INTO latest FROM jsonb_array_elements(p_records) e WHERE e->>'round_no'~'^[0-9]+$' AND e->>'rank'~'^[1-5]$';
 IF latest IS NULL THEN RETURN CASE WHEN old_round=p_round THEN NULL ELSE p_previous END; END IF;
 IF latest<p_round AND old_round IS DISTINCT FROM p_round THEN RETURN p_previous; END IF;
 SELECT min((e->>'rank')::integer),count(*)::integer INTO best,wins FROM jsonb_array_elements(p_records) e WHERE e->>'round_no'~'^[0-9]+$' AND e->>'rank'~'^[1-5]$' AND (e->>'round_no')::numeric=latest;
 RETURN format('%s회 %s등%s',latest,best,CASE WHEN wins>1 THEN format(' (%s건)',wins) ELSE '' END);
END $$;
CREATE FUNCTION lotto_sync_private.sms_enabled() RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce((SELECT to_jsonb(s)->'win_sms'->>'enabled'='true'
  AND s.sms->>'oneshot_enabled'='true' AND coalesce(s.sms->>'sender_no','')<>''
  FROM public.site_settings s WHERE s.id=1),false)
$$;
CREATE FUNCTION lotto_sync_private.snapshot(p_round integer,p_queue boolean) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 DELETE FROM public.lotto_sync_work WHERE round_no=p_round;
 INSERT INTO public.lotto_sync_work(round_no,kind,target_id,issue)
 SELECT p_round,'member',m.id,x.issue
 FROM public.members m CROSS JOIN LATERAL (
  SELECT e.value AS issue FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.meta->'weekly_recos')='array' THEN m.meta->'weekly_recos' ELSE '[]'::jsonb END) WITH ORDINALITY e
  WHERE e.value->'round_no'=to_jsonb(p_round) ORDER BY e.ordinality LIMIT 1
 ) x WHERE NOT m.is_deleted AND m.meta->'weekly_recos' @> jsonb_build_array(jsonb_build_object('round_no',p_round));
 INSERT INTO public.lotto_sync_work(round_no,kind,target_id,issue)
 SELECT p_round,'bet',b.id,jsonb_build_object('numbers',b.numbers,'member_ref',b.member_ref,'combo_index',row_number() OVER(PARTITION BY b.member_ref ORDER BY b.id)) FROM public.bets b WHERE b.round_no=p_round;
 UPDATE public.lotto_sync_jobs SET status='pending',queue_sms=p_queue,
  total=(SELECT count(*) FROM public.lotto_sync_work WHERE round_no=p_round),done=0,winners=0,rank_counts='{"1":0,"2":0,"3":0,"4":0,"5":0}',last_error=NULL,updated_at=now(),completed_at=NULL WHERE round_no=p_round;
 UPDATE public.lotto_rounds SET confirmed_at=NULL WHERE round_no=p_round;
END $$;

CREATE FUNCTION public.lotto_sync_start(p_round jsonb,p_queue_sms boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='3s' SET statement_timeout='45s' AS $$
DECLARE n integer; nums integer[]; dt timestamptz; r public.lotto_rounds; existing public.lotto_rounds; j public.lotto_sync_jobs; x text;
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_round)<>'object' OR coalesce(p_round->>'round_no','')!~'^[0-9]+$' OR NOT lotto_sync_private.valid_balls(p_round->'numbers') OR coalesce(p_round->>'bonus','')!~'^[0-9]+$' THEN RAISE EXCEPTION 'ROUND_INVALID' USING ERRCODE='22023'; END IF;
 n:=(p_round->>'round_no')::integer;
 IF n<1 OR n>lotto_sync_private.expected_round() THEN RAISE EXCEPTION 'ROUND_INVALID' USING ERRCODE='22023'; END IF;
 nums:=ARRAY(SELECT value::text::integer FROM jsonb_array_elements(p_round->'numbers'));
 dt:=(p_round->>'draw_date')::timestamptz;
 IF dt IS NULL OR (dt AT TIME ZONE 'Asia/Seoul')::date<>date '2002-12-07'+(n-1)*7 OR (p_round->>'bonus')::integer NOT BETWEEN 1 AND 45 OR (p_round->>'bonus')::integer=ANY(nums) THEN RAISE EXCEPTION 'ROUND_INVALID' USING ERRCODE='22023'; END IF;
 FOREACH x IN ARRAY ARRAY['prize_1','prize_2','prize_3','total_sales'] LOOP
  IF coalesce(p_round->>x,'')!~'^[0-9]+$' THEN RAISE EXCEPTION 'ROUND_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM (p_round->>x)::bigint;
 END LOOP;
 PERFORM pg_advisory_xact_lock(8141244,n);
 SELECT * INTO existing FROM public.lotto_rounds WHERE round_no=n FOR UPDATE;
 IF FOUND THEN
  IF existing.numbers<>nums OR existing.bonus<>(p_round->>'bonus')::integer OR existing.prize_1 IS DISTINCT FROM (p_round->>'prize_1')::bigint OR existing.prize_2 IS DISTINCT FROM (p_round->>'prize_2')::bigint OR existing.prize_3 IS DISTINCT FROM (p_round->>'prize_3')::bigint OR existing.total_sales IS DISTINCT FROM (p_round->>'total_sales')::bigint OR (existing.draw_date AT TIME ZONE 'Asia/Seoul')::date<>(dt AT TIME ZONE 'Asia/Seoul')::date THEN RAISE EXCEPTION 'ROUND_CONFLICT' USING ERRCODE='23505'; END IF;
  SELECT * INTO j FROM public.lotto_sync_jobs WHERE round_no=n;
  RETURN jsonb_build_object('ok',true,'created',false,'round_no',n,'status',coalesce(j.status,'existing'));
 END IF;
 INSERT INTO public.lotto_rounds(round_no,draw_date,numbers,bonus,sum,odd_even,prize_1,prize_2,prize_3,total_sales,confirmed_at)
 VALUES(n,dt,nums,(p_round->>'bonus')::integer,(SELECT sum(v) FROM unnest(nums) v),
  format('홀%s:짝%s',(SELECT count(*) FROM unnest(nums) v WHERE v%2=1),(SELECT count(*) FROM unnest(nums) v WHERE v%2=0)),
  (p_round->>'prize_1')::bigint,(p_round->>'prize_2')::bigint,(p_round->>'prize_3')::bigint,(p_round->>'total_sales')::bigint,NULL);
 INSERT INTO public.lotto_sync_jobs(round_no) VALUES(n);
 PERFORM lotto_sync_private.snapshot(n,p_queue_sms AND n=lotto_sync_private.expected_round() AND lotto_sync_private.sms_enabled());
 RETURN jsonb_build_object('ok',true,'created',true,'round_no',n,'status','pending');
END $$;

CREATE FUNCTION public.lotto_sync_batch(p_limit integer DEFAULT 100) RETURNS jsonb
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
    IF FOUND THEN
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

CREATE FUNCTION public.lotto_sync_request_recount(p_round_no integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='45s' AS $$
DECLARE j public.lotto_sync_jobs;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.staff WHERE auth_user_id=auth.uid() AND is_active AND role IN ('admin','manager')) THEN RAISE EXCEPTION 'admin or manager required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(8141244,0);
 PERFORM pg_advisory_xact_lock(8141244,p_round_no);
 PERFORM 1 FROM public.lotto_rounds WHERE round_no=p_round_no FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ROUND_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT * INTO j FROM public.lotto_sync_jobs WHERE round_no=p_round_no FOR UPDATE;
 UPDATE public.lotto_sync_sms_outbox SET status='skipped',finished_at=now(),result_code='RECOUNT_NOSMS' WHERE round_no=p_round_no AND status='pending';
 UPDATE public.lotto_sync_jobs SET queue_sms=false WHERE round_no=p_round_no;
 IF j.status IN ('pending','running') THEN RETURN jsonb_build_object('ok',true,'round_no',p_round_no,'status',j.status); END IF;
 INSERT INTO public.lotto_sync_jobs(round_no) VALUES(p_round_no) ON CONFLICT(round_no) DO NOTHING;
 PERFORM lotto_sync_private.snapshot(p_round_no,false);
 INSERT INTO public.logs(id,kind,actor,action,target_type,target_id,meta,created_at)
 SELECT 'log_lotto_recount_'||gen_random_uuid()::text,'admin',id,'lotto.recount_requested','lotto_round',p_round_no::text,jsonb_build_object('sms',false),now() FROM public.staff WHERE auth_user_id=auth.uid();
 RETURN jsonb_build_object('ok',true,'round_no',p_round_no,'status','pending');
END $$;

CREATE FUNCTION public.lotto_sync_claim_sms(p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='3s' SET statement_timeout='30s' AS $$
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
   AND CASE WHEN m.grade IN ('gold','goldp','vip','royal') THEN cfg->'win_sms'->>'paid'='true' ELSE cfg->'win_sms'->>'free'='true' END
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
END $$;

CREATE FUNCTION public.lotto_sync_finish_sms(p_id bigint,p_claim_token uuid,p_status text,p_provider_result jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='3s' SET statement_timeout='30s' AS $$
DECLARE o public.lotto_sync_sms_outbox; code text;
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
 IF p_status NOT IN ('accepted','failed','unknown','skipped') THEN RAISE EXCEPTION 'SMS_STATUS_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM public.lotto_sync_sms_outbox WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR o.claim_token IS DISTINCT FROM p_claim_token THEN RAISE EXCEPTION 'SMS_CLAIM_INVALID' USING ERRCODE='22023'; END IF;
 IF o.status=p_status THEN RETURN jsonb_build_object('ok',true,'status',o.status,'repeated',true); END IF;
 IF o.status<>'claimed' THEN RAISE EXCEPTION 'SMS_ALREADY_FINALIZED' USING ERRCODE='22023'; END IF;
 code:=left(regexp_replace(coalesce(p_provider_result->>'code',p_status),'[^a-zA-Z0-9_:-]','','g'),80);
 UPDATE public.lotto_sync_sms_outbox SET status=p_status,finished_at=now(),result_code=code,provider_receipt_id=left(regexp_replace(p_provider_result->>'cmid','[[:cntrl:]]','','g'),128),provider_http_status=CASE WHEN p_provider_result->>'httpStatus'~'^[1-5][0-9][0-9]$' THEN (p_provider_result->>'httpStatus')::integer ELSE NULL END WHERE id=p_id;
 UPDATE public.sms_sends SET body=coalesce(p_provider_result->>'body',body),status=CASE WHEN p_status='accepted' THEN '발송완료' WHEN p_status='skipped' THEN '발송보류(당첨알림)' ELSE '접수확인필요(당첨알림:'||code||')' END WHERE id='sms_lotto_outbox_'||p_id;
 RETURN jsonb_build_object('ok',true,'status',p_status,'repeated',false);
END $$;

CREATE FUNCTION public.lotto_sync_record_tick(p_ok boolean,p_code text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
 UPDATE public.lotto_sync_tick SET last_attempt_at=now(),last_success_at=CASE WHEN p_ok THEN now() ELSE last_success_at END,last_error=CASE WHEN p_ok THEN NULL ELSE left(regexp_replace(coalesce(p_code,'UNKNOWN'),'[^a-zA-Z0-9_:-]','','g'),80) END WHERE id;
END $$;
CREATE FUNCTION public.lotto_sync_health() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF current_setting('role',true) IS DISTINCT FROM 'service_role' AND (auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.staff WHERE auth_user_id=auth.uid() AND is_active AND role IN ('admin','manager'))) THEN RAISE EXCEPTION 'admin or manager required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('schema_version',1,'checked_at',now(),'expected_round',lotto_sync_private.expected_round(),
  'max_round',(SELECT coalesce(max(round_no),0) FROM public.lotto_rounds),'max_confirmed_round',(SELECT coalesce(max(round_no),0) FROM public.lotto_rounds WHERE confirmed_at IS NOT NULL),
  'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY round_no DESC),'[]') FROM (SELECT round_no,status,total,done,winners,rank_counts,last_error,updated_at,completed_at FROM public.lotto_sync_jobs WHERE status<>'complete' OR round_no IN(SELECT round_no FROM public.lotto_sync_jobs WHERE status='complete' ORDER BY round_no DESC LIMIT 20)) q),
  'sms',jsonb_build_object('pending',(SELECT count(*) FROM public.lotto_sync_sms_outbox WHERE status='pending'),'claimed',(SELECT count(*) FROM public.lotto_sync_sms_outbox WHERE status='claimed'),'accepted',(SELECT count(*) FROM public.lotto_sync_sms_outbox WHERE status='accepted'),'failed',(SELECT count(*) FROM public.lotto_sync_sms_outbox WHERE status='failed'),'unknown',(SELECT count(*) FROM public.lotto_sync_sms_outbox WHERE status='unknown'),'skipped',(SELECT count(*) FROM public.lotto_sync_sms_outbox WHERE status='skipped')),
  'last_attempt_at',t.last_attempt_at,'last_success_at',t.last_success_at,'last_error',t.last_error) INTO result FROM public.lotto_sync_tick t WHERE id;
 RETURN result;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lotto_sync_private FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lotto_sync_private TO service_role;
REVOKE ALL ON FUNCTION public.lotto_sync_start(jsonb,boolean),public.lotto_sync_batch(integer),public.lotto_sync_claim_sms(integer),public.lotto_sync_finish_sms(bigint,uuid,text,jsonb),public.lotto_sync_record_tick(boolean,text),public.lotto_sync_request_recount(integer),public.lotto_sync_health() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lotto_sync_start(jsonb,boolean),public.lotto_sync_batch(integer),public.lotto_sync_claim_sms(integer),public.lotto_sync_finish_sms(bigint,uuid,text,jsonb),public.lotto_sync_record_tick(boolean,text),public.lotto_sync_health() TO service_role;
GRANT EXECUTE ON FUNCTION public.lotto_sync_request_recount(integer),public.lotto_sync_health() TO authenticated;
