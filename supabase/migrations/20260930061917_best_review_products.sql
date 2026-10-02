-- 기존 레거시 매핑에서 확인한 프리미엄 상품 4개만 이력용 비활성 상품으로 추가한다.
-- 개별 과거 결제액/기간은 payments 원본을 따르며 여기의 기준 상품값으로 덮어쓰지 않는다.
SET LOCAL lock_timeout = '3s';
DO $block$
DECLARE
  v_products constant jsonb := '[
    {"id":"legacy_best_premium","name":"프리미엄로또 프리미엄 플러스","price":431900,"duration_months":18,"grade_granted":"goldp","is_active":false},
    {"id":"legacy_best_vip","name":"프리미엄로또 VIP","price":6160000,"duration_months":36,"grade_granted":"vip","is_active":false},
    {"id":"legacy_best_royal","name":"프리미엄로또 로얄 퍼스트","price":4900000,"duration_months":36,"grade_granted":"royal","is_active":false},
    {"id":"legacy_best_unbalance","name":"언발란스","price":999000,"duration_months":36,"grade_granted":"vip","is_active":false}
  ]'::jsonb;
BEGIN
  LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_populate_recordset(NULL::public.products,v_products) expected
    JOIN public.products actual ON actual.id=expected.id
    WHERE (actual.name,actual.price,actual.duration_months,actual.grade_granted,actual.is_active)
      IS DISTINCT FROM (expected.name,expected.price,expected.duration_months,expected.grade_granted,expected.is_active)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Existing best product differs from reviewed seed; no overwrite';
  END IF;
  INSERT INTO public.products(id,name,price,duration_months,grade_granted,is_active)
  SELECT id,name,price,duration_months,grade_granted,is_active
  FROM pg_catalog.jsonb_populate_recordset(NULL::public.products,v_products)
  ON CONFLICT(id) DO NOTHING;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_populate_recordset(NULL::public.products,v_products) expected
    LEFT JOIN public.products actual ON actual.id=expected.id
    WHERE actual.id IS NULL OR (actual.name,actual.price,actual.duration_months,actual.grade_granted,actual.is_active)
      IS DISTINCT FROM (expected.name,expected.price,expected.duration_months,expected.grade_granted,expected.is_active)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Best review product seed verification failed';
  END IF;
END;
$block$;
