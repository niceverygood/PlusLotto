-- 루비 등급 추가 — 실버(goldp)와 골드(vip) 사이 유료등급 (현장 10/12, 정의현 차장).
-- 별도 트랜잭션으로 먼저 적용한다. 새 enum 값은 커밋 전에는 쓸 수 없으므로 이 파일 안에서는
-- 'ruby'를 사용하지 않는다(유료 판정 갱신은 다음 마이그레이션 20261012100100).
ALTER TYPE public.grade ADD VALUE IF NOT EXISTS 'ruby' AFTER 'goldp';
