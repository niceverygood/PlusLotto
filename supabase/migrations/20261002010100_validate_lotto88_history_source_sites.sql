-- 20261002010000_lotto88_legacy_site.sql 이 lotto88 을 넣어 NOT VALID 로 다시 만든 이력 제약을 검증한다.
-- 기존 행은 이미 더 좁은 4사 목록(20260930075715 에서 검증 완료)을 만족하므로 넓힌 목록도 반드시
-- 만족한다 — 실패할 수 없는 검증이다. 그래도 남겨 두는 이유는 제약이 '미검증' 상태로 남으면
-- 이후 감사에서 같은 질문이 다시 나오기 때문이다. 별도 트랜잭션이라 행 읽기·쓰기를 막지 않는다.
-- 행 수정·권한 변경·문자 발송 없음.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.legacy_member_memos
  VALIDATE CONSTRAINT legacy_member_memos_source_site_check;
ALTER TABLE public.legacy_member_sms
  VALIDATE CONSTRAINT legacy_member_sms_source_site_check;
ALTER TABLE public.legacy_member_wins
  VALIDATE CONSTRAINT legacy_member_wins_source_site_check;
