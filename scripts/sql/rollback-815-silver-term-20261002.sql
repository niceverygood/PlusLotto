-- Recovery only, never part of normal cutover execution.
-- Compare-and-set: refuse to undo if an operator has since edited an end date.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='45s';
DO $rollback$
DECLARE n integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('815-silver-27months-20261002',0)) THEN
    RAISE EXCEPTION 'Term update is running';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.logs WHERE id='log_815_silver_27months_20261002_receipt') THEN
    RAISE EXCEPTION 'No applied operation receipt';
  END IF;
  IF EXISTS(SELECT 1 FROM public.logs WHERE id='log_815_silver_27months_20261002_rollback') THEN RETURN; END IF;
  PERFORM m.id FROM public.members m JOIN public.logs l ON l.target_id=m.id
    WHERE l.action='member.legacy_term_extended' AND l.meta->>'operation'='815-silver-27months-20261002'
    FOR UPDATE OF m;
  IF (SELECT count(*) FROM public.logs WHERE action='member.legacy_term_extended'
    AND meta->>'operation'='815-silver-27months-20261002')<>12991
    OR EXISTS(SELECT 1 FROM public.logs l LEFT JOIN public.members m ON m.id=l.target_id
      WHERE l.action='member.legacy_term_extended' AND l.meta->>'operation'='815-silver-27months-20261002'
      AND (m.id IS NULL OR m.meta->>'source_site' IS DISTINCT FROM 'lotto815'
        OR m.meta->'end_date' IS DISTINCT FROM l.meta->'new_end_date')) THEN
    RAISE EXCEPTION 'Rollback scope or current end date drift; manual reconciliation required';
  END IF;
  UPDATE public.members m SET meta=jsonb_set(m.meta,'{end_date}',l.meta->'old_end_date',true)
    FROM public.logs l WHERE l.target_id=m.id AND l.action='member.legacy_term_extended'
    AND l.meta->>'operation'='815-silver-27months-20261002';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>12991 THEN RAISE EXCEPTION 'Rollback count mismatch'; END IF;
  INSERT INTO public.logs(id,kind,action,target_type,target_id,meta)
    VALUES('log_815_silver_27months_20261002_rollback','admin','legacy.815_silver_term_rollback',
      'legacy_import','lotto815',jsonb_build_object('restored',n));
END;
$rollback$;
COMMIT;
