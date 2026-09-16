-- 기존 815 이력 저장소에 검증된 일행로또 출처만 추가한다.
-- 출처+원본키 PK, 회원 출처 대조 트리거, 실장 이상/담당자 RLS와 쓰기 권한은 유지한다.
-- 제약 재생성은 기존 이력의 값이나 운영 발송큐를 변경하지 않는다.
-- 이미 검증된 815 제약을 넓히므로 기존 행은 새 조건도 충족한다. 전체 이력 재검사는
-- 다음 migration에서 별도 트랜잭션으로 실행해 강한 DDL 잠금 시간을 줄인다.
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.legacy_member_memos
  DROP CONSTRAINT legacy_member_memos_source_site_check,
  ADD CONSTRAINT legacy_member_memos_source_site_check CHECK (source_site IN ('lotto815','cplotto')) NOT VALID;

ALTER TABLE public.legacy_member_sms
  DROP CONSTRAINT legacy_member_sms_source_site_check,
  ADD CONSTRAINT legacy_member_sms_source_site_check CHECK (source_site IN ('lotto815','cplotto')) NOT VALID;

ALTER TABLE public.legacy_member_wins
  DROP CONSTRAINT legacy_member_wins_source_site_check,
  ADD CONSTRAINT legacy_member_wins_source_site_check CHECK (source_site IN ('lotto815','cplotto')) NOT VALID;
