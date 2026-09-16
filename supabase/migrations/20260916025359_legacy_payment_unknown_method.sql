-- 이전 자료의 미기재 결제수단을 수기/무통장/PG로 추정하지 않는다.
-- 별도 트랜잭션으로 먼저 적용한다. 이 파일 안에서는 새 enum 값을 사용하지 않는다.
-- 원본 payMethodCode와 검수 필요 여부는 결제 meta에 함께 보존한다.
ALTER TYPE public.payment_method ADD VALUE IF NOT EXISTS 'unknown';
