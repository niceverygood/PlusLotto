-- 루비 결제 상품 (현장 10/16, 정의현 차장 — "루비등급 결제요청시 메뉴에 없습니다").
-- 결제요청·수기결제의 상품 목록은 판매중(is_active) 상품이다. 10/12 루비 등급만 추가하고 상품은 만들지 않아
-- 루비를 고를 수 없었다. 루비 가격은 아직 정해지지 않아 기본 금액 없이(0원) 등록한다 — 결제요청·수기결제
-- 화면에서 금액을 직접 입력한다(0원은 요청 버튼이 막혀 있어 0원 결제는 생기지 않는다).
-- duration_months 는 결제 건의 커버 기간(period_end)에만 쓰인다. 회원 종료일은 등급별 연수(루비 1년,
-- lib/membershipTerm)로 따로 정해진다. TODO(live-verify): 루비 정가·기간이 정해지면 이 행을 고친다.
-- 이미 있으면 건드리지 않는다(재실행 안전, 나중에 바꾼 가격을 덮어쓰지 않음).
INSERT INTO public.products (id, name, price, duration_months, grade_granted, is_active)
VALUES ('prod-ruby', '루비', 0, 1, 'ruby', true)
ON CONFLICT (id) DO NOTHING;
