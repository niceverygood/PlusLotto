-- 기존 레거시 매핑에서 확인한 인포 상품 3개만 이력용 비활성 상품으로 추가한다.
-- 개별 과거 결제액/기간은 payments 원본을 따르며 여기의 기준 상품값으로 덮어쓰지 않는다.
-- 등급이 미확정인 원본 family는 등록하지 않는다. 결제의 NULL 참조+원본 meta로 보존한다.
SET LOCAL lock_timeout = '3s';
DO $block$
DECLARE
  v_products constant jsonb := '[
    {"id":"legacy_infolotto_basic","name":"인포로또 베이직","price":431900,"duration_months":18,"grade_granted":"goldp","is_active":false},
    {"id":"legacy_infolotto_smart","name":"인포로또 스마트","price":3800000,"duration_months":36,"grade_granted":"vip","is_active":false},
    {"id":"legacy_infolotto_signature","name":"인포로또 시그니쳐","price":0,"duration_months":36,"grade_granted":"royal","is_active":false}
  ]'::jsonb;
BEGIN
  LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_populate_recordset(NULL::public.products,v_products) expected
    JOIN public.products actual ON actual.id=expected.id
    WHERE (actual.name,actual.price,actual.duration_months,actual.grade_granted,actual.is_active)
      IS DISTINCT FROM (expected.name,expected.price,expected.duration_months,expected.grade_granted,expected.is_active)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Existing infolotto product differs from reviewed seed; no overwrite';
  END IF;
  INSERT INTO public.products(id,name,price,duration_months,grade_granted,is_active)
  SELECT id,name,price,duration_months,grade_granted,is_active
  FROM pg_catalog.jsonb_populate_recordset(NULL::public.products,v_products)
  ON CONFLICT(id) DO NOTHING;
END;
$block$;
