-- 20260916024915과 별도 트랜잭션으로 적용한다.
-- VALIDATE는 일반 SELECT/INSERT/UPDATE/DELETE와 호환되는 잠금으로 기존 이력을 검사한다.
SET LOCAL lock_timeout = '3s';
ALTER TABLE public.legacy_member_memos VALIDATE CONSTRAINT legacy_member_memos_source_site_check;
ALTER TABLE public.legacy_member_sms VALIDATE CONSTRAINT legacy_member_sms_source_site_check;
ALTER TABLE public.legacy_member_wins VALIDATE CONSTRAINT legacy_member_wins_source_site_check;
