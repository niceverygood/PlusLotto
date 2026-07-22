-- 0015 — sms_type enum 에 'terms'(약관 안내) 추가 (현장 7/22, 정의현 차장)
-- 배경: 등급별 개별약관(site_settings.membership_tiers[].terms)을 문자로 발송하는 신규 템플릿
--       'terms' 추가 요청 — sms_sends.type 컬럼이 sms_type enum(0001_schema.sql)이라 값을 먼저
--       추가하지 않으면 D63(0005) 때와 동일하게 INSERT 가 22P02 로 실패한다.
-- ⚠️ 실행: Supabase SQL Editor 에서 이 한 줄만 단독 실행(ALTER TYPE ADD VALUE 는 트랜잭션 블록 안에서
--    실행 불가). 멱등(IF NOT EXISTS).

alter type sms_type add value if not exists 'terms';
