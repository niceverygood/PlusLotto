-- Post-deploy check: read-only transaction; outputs aggregate pass/fail, never member PII.
-- Run as the DB administrator. A transaction-local active admin identity exercises RLS.
-- Each site uses a separate DO statement so the 30s timeout covers one scope, not all 65 RPC calls.
-- Any exception aborts verification; ROLLBACK also clears the temporary role/JWT settings.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
DO $verify$
DECLARE v_uid uuid;
BEGIN
  SELECT auth_user_id INTO v_uid FROM public.staff
  WHERE role = 'admin' AND is_active AND auth_user_id IS NOT NULL
  ORDER BY id LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'verification requires an active admin'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
END;
$verify$;
SET LOCAL ROLE authenticated;

-- Independent statement timeout: all
DO $verify$
DECLARE
  v_site text := NULL;
  v_filter jsonb;
  v_members bigint;
  v_payments bigint;
  v_approved bigint;
  v_amount bigint;
  v_report jsonb;
  v_daily jsonb;
  v_day date := (now() AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
    v_filter := CASE WHEN v_site IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceSite',v_site) END;
    SELECT count(*) INTO v_members FROM public.members m
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    SELECT count(*), count(*) FILTER (WHERE p.status='approved') INTO v_payments,v_approved
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    IF (public.admin_members_page(v_filter,0,1)->>'total')::bigint <> v_members
      OR (public.admin_member_facets(NULL,v_site)->'counts'->>'all')::bigint <> v_members
      OR (public.admin_payments_page(v_filter,0,1)->>'total')::bigint <> v_payments
      OR (public.admin_payment_counts(v_site)->>'approved')::bigint <> v_approved THEN
      RAISE EXCEPTION 'site list/count mismatch for %',coalesce(v_site,'all');
    END IF;

    SELECT coalesce(sum(p.amount),0) INTO v_amount
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE p.status='approved'
        AND (coalesce(p.paid_at,p.created_at) AT TIME ZONE 'Asia/Seoul')::date BETWEEN v_day-30 AND v_day
        AND (v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site);
    v_report := public.admin_revenue('real',v_day-30,v_day,'staff',v_site);
    v_daily := public.admin_revenue_daily_summary(v_day-30,v_day,v_site);
    IF (v_report->'summary'->>'total')::bigint <> v_amount
      OR (SELECT coalesce(sum((r->>'total')::bigint),0) FROM jsonb_array_elements(v_daily) r) <> v_amount THEN
      RAISE EXCEPTION 'site revenue aggregate mismatch for %',coalesce(v_site,'all');
    END IF;
    PERFORM public.admin_dashboard(v_site);
    PERFORM public.admin_nav_badges(v_site);
    PERFORM public.admin_member_search('',1,v_site);
    PERFORM public.admin_revenue_calendar(v_day,'real',v_site);
    PERFORM public.admin_revenue_day_payments(v_day,'real',v_site);
    PERFORM public.admin_stats_snapshot('signup',v_day-30,v_day,v_site);
    PERFORM public.admin_consult_report('staff','week',v_day-30,v_day,v_site);
END;
$verify$;

-- Independent statement timeout: pluslotto
DO $verify$
DECLARE
  v_site text := 'pluslotto';
  v_filter jsonb;
  v_members bigint;
  v_payments bigint;
  v_approved bigint;
  v_amount bigint;
  v_report jsonb;
  v_daily jsonb;
  v_day date := (now() AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
    v_filter := CASE WHEN v_site IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceSite',v_site) END;
    SELECT count(*) INTO v_members FROM public.members m
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    SELECT count(*), count(*) FILTER (WHERE p.status='approved') INTO v_payments,v_approved
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    IF (public.admin_members_page(v_filter,0,1)->>'total')::bigint <> v_members
      OR (public.admin_member_facets(NULL,v_site)->'counts'->>'all')::bigint <> v_members
      OR (public.admin_payments_page(v_filter,0,1)->>'total')::bigint <> v_payments
      OR (public.admin_payment_counts(v_site)->>'approved')::bigint <> v_approved THEN
      RAISE EXCEPTION 'site list/count mismatch for %',coalesce(v_site,'all');
    END IF;

    SELECT coalesce(sum(p.amount),0) INTO v_amount
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE p.status='approved'
        AND (coalesce(p.paid_at,p.created_at) AT TIME ZONE 'Asia/Seoul')::date BETWEEN v_day-30 AND v_day
        AND (v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site);
    v_report := public.admin_revenue('real',v_day-30,v_day,'staff',v_site);
    v_daily := public.admin_revenue_daily_summary(v_day-30,v_day,v_site);
    IF (v_report->'summary'->>'total')::bigint <> v_amount
      OR (SELECT coalesce(sum((r->>'total')::bigint),0) FROM jsonb_array_elements(v_daily) r) <> v_amount THEN
      RAISE EXCEPTION 'site revenue aggregate mismatch for %',coalesce(v_site,'all');
    END IF;
    PERFORM public.admin_dashboard(v_site);
    PERFORM public.admin_nav_badges(v_site);
    PERFORM public.admin_member_search('',1,v_site);
    PERFORM public.admin_revenue_calendar(v_day,'real',v_site);
    PERFORM public.admin_revenue_day_payments(v_day,'real',v_site);
    PERFORM public.admin_stats_snapshot('signup',v_day-30,v_day,v_site);
    PERFORM public.admin_consult_report('staff','week',v_day-30,v_day,v_site);
END;
$verify$;

-- Independent statement timeout: lotto815
DO $verify$
DECLARE
  v_site text := 'lotto815';
  v_filter jsonb;
  v_members bigint;
  v_payments bigint;
  v_approved bigint;
  v_amount bigint;
  v_report jsonb;
  v_daily jsonb;
  v_day date := (now() AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
    v_filter := CASE WHEN v_site IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceSite',v_site) END;
    SELECT count(*) INTO v_members FROM public.members m
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    SELECT count(*), count(*) FILTER (WHERE p.status='approved') INTO v_payments,v_approved
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    IF (public.admin_members_page(v_filter,0,1)->>'total')::bigint <> v_members
      OR (public.admin_member_facets(NULL,v_site)->'counts'->>'all')::bigint <> v_members
      OR (public.admin_payments_page(v_filter,0,1)->>'total')::bigint <> v_payments
      OR (public.admin_payment_counts(v_site)->>'approved')::bigint <> v_approved THEN
      RAISE EXCEPTION 'site list/count mismatch for %',coalesce(v_site,'all');
    END IF;

    SELECT coalesce(sum(p.amount),0) INTO v_amount
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE p.status='approved'
        AND (coalesce(p.paid_at,p.created_at) AT TIME ZONE 'Asia/Seoul')::date BETWEEN v_day-30 AND v_day
        AND (v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site);
    v_report := public.admin_revenue('real',v_day-30,v_day,'staff',v_site);
    v_daily := public.admin_revenue_daily_summary(v_day-30,v_day,v_site);
    IF (v_report->'summary'->>'total')::bigint <> v_amount
      OR (SELECT coalesce(sum((r->>'total')::bigint),0) FROM jsonb_array_elements(v_daily) r) <> v_amount THEN
      RAISE EXCEPTION 'site revenue aggregate mismatch for %',coalesce(v_site,'all');
    END IF;
    PERFORM public.admin_dashboard(v_site);
    PERFORM public.admin_nav_badges(v_site);
    PERFORM public.admin_member_search('',1,v_site);
    PERFORM public.admin_revenue_calendar(v_day,'real',v_site);
    PERFORM public.admin_revenue_day_payments(v_day,'real',v_site);
    PERFORM public.admin_stats_snapshot('signup',v_day-30,v_day,v_site);
    PERFORM public.admin_consult_report('staff','week',v_day-30,v_day,v_site);
END;
$verify$;

-- Independent statement timeout: infolotto
DO $verify$
DECLARE
  v_site text := 'infolotto';
  v_filter jsonb;
  v_members bigint;
  v_payments bigint;
  v_approved bigint;
  v_amount bigint;
  v_report jsonb;
  v_daily jsonb;
  v_day date := (now() AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
    v_filter := CASE WHEN v_site IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceSite',v_site) END;
    SELECT count(*) INTO v_members FROM public.members m
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    SELECT count(*), count(*) FILTER (WHERE p.status='approved') INTO v_payments,v_approved
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    IF (public.admin_members_page(v_filter,0,1)->>'total')::bigint <> v_members
      OR (public.admin_member_facets(NULL,v_site)->'counts'->>'all')::bigint <> v_members
      OR (public.admin_payments_page(v_filter,0,1)->>'total')::bigint <> v_payments
      OR (public.admin_payment_counts(v_site)->>'approved')::bigint <> v_approved THEN
      RAISE EXCEPTION 'site list/count mismatch for %',coalesce(v_site,'all');
    END IF;

    SELECT coalesce(sum(p.amount),0) INTO v_amount
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE p.status='approved'
        AND (coalesce(p.paid_at,p.created_at) AT TIME ZONE 'Asia/Seoul')::date BETWEEN v_day-30 AND v_day
        AND (v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site);
    v_report := public.admin_revenue('real',v_day-30,v_day,'staff',v_site);
    v_daily := public.admin_revenue_daily_summary(v_day-30,v_day,v_site);
    IF (v_report->'summary'->>'total')::bigint <> v_amount
      OR (SELECT coalesce(sum((r->>'total')::bigint),0) FROM jsonb_array_elements(v_daily) r) <> v_amount THEN
      RAISE EXCEPTION 'site revenue aggregate mismatch for %',coalesce(v_site,'all');
    END IF;
    PERFORM public.admin_dashboard(v_site);
    PERFORM public.admin_nav_badges(v_site);
    PERFORM public.admin_member_search('',1,v_site);
    PERFORM public.admin_revenue_calendar(v_day,'real',v_site);
    PERFORM public.admin_revenue_day_payments(v_day,'real',v_site);
    PERFORM public.admin_stats_snapshot('signup',v_day-30,v_day,v_site);
    PERFORM public.admin_consult_report('staff','week',v_day-30,v_day,v_site);
END;
$verify$;

-- Independent statement timeout: cplotto
DO $verify$
DECLARE
  v_site text := 'cplotto';
  v_filter jsonb;
  v_members bigint;
  v_payments bigint;
  v_approved bigint;
  v_amount bigint;
  v_report jsonb;
  v_daily jsonb;
  v_day date := (now() AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
    v_filter := CASE WHEN v_site IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceSite',v_site) END;
    SELECT count(*) INTO v_members FROM public.members m
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    SELECT count(*), count(*) FILTER (WHERE p.status='approved') INTO v_payments,v_approved
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site;
    IF (public.admin_members_page(v_filter,0,1)->>'total')::bigint <> v_members
      OR (public.admin_member_facets(NULL,v_site)->'counts'->>'all')::bigint <> v_members
      OR (public.admin_payments_page(v_filter,0,1)->>'total')::bigint <> v_payments
      OR (public.admin_payment_counts(v_site)->>'approved')::bigint <> v_approved THEN
      RAISE EXCEPTION 'site list/count mismatch for %',coalesce(v_site,'all');
    END IF;

    SELECT coalesce(sum(p.amount),0) INTO v_amount
      FROM public.payments p JOIN public.members m ON m.id=p.member_id
      WHERE p.status='approved'
        AND (coalesce(p.paid_at,p.created_at) AT TIME ZONE 'Asia/Seoul')::date BETWEEN v_day-30 AND v_day
        AND (v_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'),''),'pluslotto')=v_site);
    v_report := public.admin_revenue('real',v_day-30,v_day,'staff',v_site);
    v_daily := public.admin_revenue_daily_summary(v_day-30,v_day,v_site);
    IF (v_report->'summary'->>'total')::bigint <> v_amount
      OR (SELECT coalesce(sum((r->>'total')::bigint),0) FROM jsonb_array_elements(v_daily) r) <> v_amount THEN
      RAISE EXCEPTION 'site revenue aggregate mismatch for %',coalesce(v_site,'all');
    END IF;
    PERFORM public.admin_dashboard(v_site);
    PERFORM public.admin_nav_badges(v_site);
    PERFORM public.admin_member_search('',1,v_site);
    PERFORM public.admin_revenue_calendar(v_day,'real',v_site);
    PERFORM public.admin_revenue_day_payments(v_day,'real',v_site);
    PERFORM public.admin_stats_snapshot('signup',v_day-30,v_day,v_site);
    PERFORM public.admin_consult_report('staff','week',v_day-30,v_day,v_site);
END;
$verify$;

DO $verify$
BEGIN

  IF public.admin_dashboard() IS DISTINCT FROM public.admin_dashboard(NULL) THEN
    RAISE EXCEPTION 'legacy default-argument mismatch';
  END IF;
  BEGIN
    PERFORM public.admin_member_search('not-present',1,'unrecognized-site');
    RAISE EXCEPTION 'unknown site was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$verify$;
SELECT 'site scope read-only verification passed' AS result;
ROLLBACK;
