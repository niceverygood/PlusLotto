-- 2026-10-02 approved cutover preparation. Run against PlusLotto only.
-- Only source=lotto815 AND current grade=goldp (legacy level 2).
-- Latest approved payment date in KST + 27 calendar months; never shorten.
-- Zero-won approved records are included, matching the existing member UI rule.
-- No payment/history/identity/status/assignment/SMS-hold fields are changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';

DO $apply$
DECLARE
  receipt_id constant text := 'log_815_silver_27months_20261002_receipt';
  run_key constant text := '815-silver-27months-20261002';
  changed integer;
  logged integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(run_key, 0)) THEN
    RAISE EXCEPTION 'Another 815 term update is running';
  END IF;
  IF EXISTS (SELECT 1 FROM public.logs WHERE id=receipt_id) THEN
    RETURN; -- Idempotency: never recompute an already applied operation.
  END IF;

  CREATE TEMP TABLE term_scope ON COMMIT DROP AS
  SELECT m.id, m.meta->'end_date' old_end_json, (m.meta->>'end_date')::date old_end,
    ((p.paid_at AT TIME ZONE 'Asia/Seoul')::date + interval '27 months')::date requested_end,
    p.id payment_id, p.paid_at, p.amount,
    md5((to_jsonb(m)-'meta')::text) row_hash,
    md5((m.meta-'end_date')::text) other_meta_hash
  FROM public.members m
  LEFT JOIN LATERAL (
    SELECT p.id,p.paid_at,p.amount FROM public.payments p
    WHERE p.member_id=m.id AND p.status='approved'
    ORDER BY p.paid_at DESC NULLS LAST,p.id DESC LIMIT 1
  ) p ON true
  WHERE m.meta->>'source_site'='lotto815' AND m.grade='goldp'
  FOR UPDATE OF m;

  IF (SELECT count(*) FROM term_scope) <> 13982
    OR (SELECT count(*) FROM term_scope WHERE old_end<requested_end) <> 12991
    OR (SELECT count(*) FROM term_scope WHERE old_end=requested_end) <> 953
    OR (SELECT count(*) FROM term_scope WHERE old_end>requested_end) <> 38
    OR EXISTS (SELECT 1 FROM term_scope WHERE payment_id IS NULL OR paid_at IS NULL OR old_end IS NULL)
    OR EXISTS (
      SELECT 1 FROM public.members m JOIN term_scope s USING(id)
      WHERE m.meta->>'legacy_level_num' IS DISTINCT FROM '2'
        OR m.meta->'reco_paused' IS DISTINCT FROM 'true'::jsonb
        OR m.meta->>'reco_pause_reason' IS DISTINCT FROM 'legacy_import_review'
    ) THEN
    RAISE EXCEPTION '815 term preflight drift: re-audit before applying';
  END IF;

  INSERT INTO public.logs(id,kind,actor,action,target_type,target_id,meta)
  SELECT 'log_'||run_key||'_'||s.id,'admin',NULL,'member.legacy_term_extended','member',s.id,
    jsonb_build_object('operation',run_key,'source_site','lotto815',
      'old_end_date',s.old_end_json,'new_end_date',to_char(s.requested_end,'YYYY-MM-DD'),
      'basis_payment_id',s.payment_id,'basis_paid_at',s.paid_at,'basis_amount',s.amount,
      'months',27,'timezone','Asia/Seoul','other_meta_md5',s.other_meta_hash,'other_row_md5',s.row_hash)
  FROM term_scope s WHERE s.old_end<s.requested_end;
  GET DIAGNOSTICS logged = ROW_COUNT;

  UPDATE public.members m
  SET meta=jsonb_set(m.meta,'{end_date}',to_jsonb(to_char(s.requested_end,'YYYY-MM-DD')),true)
  FROM term_scope s WHERE m.id=s.id AND s.old_end<s.requested_end;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed<>12991 OR logged<>changed THEN
    RAISE EXCEPTION '815 term update/log count mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.members m JOIN term_scope s USING(id)
    WHERE m.meta->>'end_date' IS DISTINCT FROM to_char(greatest(s.old_end,s.requested_end),'YYYY-MM-DD')
      OR md5((to_jsonb(m)-'meta')::text) IS DISTINCT FROM s.row_hash
      OR md5((m.meta-'end_date')::text) IS DISTINCT FROM s.other_meta_hash
  ) THEN RAISE EXCEPTION '815 term postcondition failed'; END IF;

  IF EXISTS (
    SELECT 1 FROM term_scope s LEFT JOIN LATERAL (
      SELECT p.id,p.paid_at,p.amount FROM public.payments p
      WHERE p.member_id=s.id AND p.status='approved'
      ORDER BY p.paid_at DESC NULLS LAST,p.id DESC LIMIT 1
    ) p ON true
    WHERE (p.id,p.paid_at,p.amount) IS DISTINCT FROM (s.payment_id,s.paid_at,s.amount)
  ) THEN RAISE EXCEPTION 'Payment changed during term update'; END IF;

  INSERT INTO public.logs(id,kind,actor,action,target_type,target_id,meta)
  SELECT receipt_id,'admin',NULL,'legacy.815_silver_term_27months','legacy_import','lotto815',
    jsonb_build_object('operation',run_key,'eligible',13982,'updated',changed,
      'already_equal',953,'preserved_later',38,'approved_zero_won_basis',4,
      'basis','latest approved paid_at KST date + 27 calendar months',
      'hold_preserved',true,'unrelated_member_fields_unchanged',true,
      'scope_digest',md5(string_agg(s.id||':'||s.old_end||':'||s.requested_end,',' ORDER BY s.id)))
  FROM term_scope s;
END;
$apply$;

SELECT id,action,meta,created_at FROM public.logs
WHERE id='log_815_silver_27months_20261002_receipt';
COMMIT;
