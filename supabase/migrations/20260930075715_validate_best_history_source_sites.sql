-- The four-site CHECKs already enforce new inserts/updates. A read-only audit
-- found zero invalid existing source sites; validate those existing rows now.
-- No row updates, constraint replacement, permission changes, or message sends.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.legacy_member_memos
  VALIDATE CONSTRAINT legacy_member_memos_source_site_check;
ALTER TABLE public.legacy_member_sms
  VALIDATE CONSTRAINT legacy_member_sms_source_site_check;
ALTER TABLE public.legacy_member_wins
  VALIDATE CONSTRAINT legacy_member_wins_source_site_check;
