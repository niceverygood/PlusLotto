-- 결제차수 라벨 (현장 피드백 8/7, 정의현 차장 — "1차결제, 2차결제, 3차결제, 2차미수, 3차미수로
-- 구분하여 결제요청을 할때, 선택할수 있도록")
--
-- 기존에는 차수를 저장하지 않고 '회원의 첫 승인 결제인가'(conversionIds)로만 자동 판정했다.
-- 그 자동 판정으로는 '미수' 구분을 표현할 수 없어, 요청 시 운영자가 고른 값을 그대로 저장한다.
-- 매출 집계의 전환(1차결제) 판정은 종전대로 승인 이력 기준을 유지한다 — 이 컬럼은 표시·분류용.
--
-- admin_payments_page / admin_payment_detail 은 `select p.*` 라 컬럼이 자동 포함된다(함수 수정 불필요).
alter table public.payments add column if not exists round_label text;

comment on column public.payments.round_label is
  '결제차수 라벨(1차결제/2차결제/3차결제/2차미수/3차미수). null=차수 도입 이전 결제.';
