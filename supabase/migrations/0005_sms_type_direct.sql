-- 0005 — sms_type enum 에 'direct' 추가 (직접입력 문자발송 기록 실패 버그 / DECISIONS D63)
-- 원인: D53 에서 '직접 입력 문자발송'(SmsType 'direct')을 추가했으나 DB enum(0001_schema.sql)에는
--       'direct' 가 없어, sendCustomSms 의 sms_sends INSERT 가 런타임 22P02
--       ("invalid input value for enum sms_type: 'direct'") 로 throw.
--       발송 순서가 OneShot 실발송(먼저) → insert(나중) 이라, 문자는 실제 수신되지만
--       insert 가 깨져 sms_sends 행이 생성되지 않음 → 모든 발송내역 화면에서 0건(영구 미표시).
-- 검증(2026-06-18, rep01 라이브): type='direct' INSERT=22P02 / type='join'=201.
-- ⚠️ 실행: Supabase SQL Editor 에서 **이 한 줄만 단독 실행**(ALTER TYPE ADD VALUE 는
--    트랜잭션 블록 안에서 실행 불가). 멱등(IF NOT EXISTS).

alter type sms_type add value if not exists 'direct';
