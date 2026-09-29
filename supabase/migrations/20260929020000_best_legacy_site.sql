-- 프리미엄로또(premiumlotto.co.kr, 업체 DB명 `best`)를 레거시 이관 사이트로 등록한다. (D196)
--
-- 사이트 키가 서버 곳곳에 하드코딩돼 있어 한 곳만 고치면 조용히 어긋난다. 이 파일은 그 목록을
-- 전부 한 번에 맞춘다. 특히 sms_is_legacy_import_held 가 빠지면 **이관 직후 검수 전인 프리미엄
-- 회원에게 조합문자가 그대로 나간다** — 화면 차단은 통과해도 최종 차단은 서버 담당이다.
--
-- 값만 바꾸는 수정이라 기존 세 사이트의 동작은 그대로다.

-- 1) 문자 보류 판정 — 가장 치명적. src/lib/legacyImportHold.ts 의 목록과 같아야 한다.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.sms_is_legacy_import_held(text)'::regprocedure);
  v_old constant text := $anchor$IN ('lotto815', 'cplotto', 'infolotto')$anchor$;
  v_new constant text := $replacement$IN ('lotto815', 'cplotto', 'infolotto', 'best')$replacement$;
BEGIN
  IF position(v_new in v_def) = 0 THEN
    IF position(v_old in v_def) = 0 THEN
      RAISE EXCEPTION 'sms_is_legacy_import_held 의 source_site 목록을 찾지 못했습니다';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
END $$;

-- 2) 회원 이력 테이블 CHECK 제약 — 프리미엄 메모/문자/당첨 이력을 넣을 수 있게 한다.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['legacy_member_memos', 'legacy_member_sms', 'legacy_member_wins'] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
                   v_table, v_table || '_source_site_check');
    EXECUTE format($fmt$ALTER TABLE public.%I ADD CONSTRAINT %I
                     CHECK (source_site IN ('lotto815','cplotto','infolotto','best')) NOT VALID$fmt$,
                   v_table, v_table || '_source_site_check');
  END LOOP;
END $$;

-- 3) 사이트 스코프 검증 함수들 — 빠지면 프리미엄 회원이 사이트 필터·포털에서 통째로 안 잡힌다.
--    두 함수 모두 'pluslotto' 를 포함한 목록을 쓰므로 그 형태로 치환한다.
DO $$
DECLARE
  v_target record;
  v_def text;
  v_replaced text;
  v_old text[] := ARRAY[
    $a$('pluslotto', 'lotto815', 'infolotto', 'cplotto')$a$,
    $a$('pluslotto','lotto815','infolotto','cplotto')$a$
  ];
  v_new text[] := ARRAY[
    $b$('pluslotto', 'lotto815', 'infolotto', 'cplotto', 'best')$b$,
    $b$('pluslotto','lotto815','infolotto','cplotto','best')$b$
  ];
  i int;
BEGIN
  FOR v_target IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      -- pg_get_functiondef 은 집계·윈도우 함수에서 예외를 던진다. 일반 함수만 본다.
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%lotto815%'
      AND pg_get_functiondef(p.oid) LIKE '%pluslotto%'
  LOOP
    v_def := pg_get_functiondef(v_target.sig);
    v_replaced := v_def;
    FOR i IN 1 .. array_length(v_old, 1) LOOP
      v_replaced := replace(v_replaced, v_old[i], v_new[i]);
    END LOOP;
    IF v_replaced <> v_def THEN
      EXECUTE v_replaced;
      RAISE NOTICE '사이트 목록 갱신: %', v_target.sig;
    END IF;
  END LOOP;
END $$;

-- 4) 결제·매출 화면의 '이전상품' 라벨 — 빠지면 프리미엄 결제가 '기타'로 뭉뚱그려진다.
DO $$
DECLARE
  v_target record;
  v_def text;
  v_replaced text;
BEGIN
  FOR v_target IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%''lotto815'',''cplotto'',''infolotto''%'
  LOOP
    v_def := pg_get_functiondef(v_target.sig);
    v_replaced := replace(v_def, $a$'lotto815','cplotto','infolotto'$a$,
                                 $b$'lotto815','cplotto','infolotto','best'$b$);
    IF v_replaced <> v_def THEN
      EXECUTE v_replaced;
      RAISE NOTICE '이전상품 라벨 갱신: %', v_target.sig;
    END IF;
  END LOOP;
END $$;

-- 5) 적용 확인 — 하나라도 빠졌으면 마이그레이션을 실패시킨다. 조용히 넘어가면 안 된다.
DO $$
BEGIN
  IF position('''best''' in
        pg_get_functiondef('public.sms_is_legacy_import_held(text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '문자 보류 판정에 best 가 반영되지 않았습니다 — 프리미엄 회원 문자가 막히지 않습니다';
  END IF;
END $$;
