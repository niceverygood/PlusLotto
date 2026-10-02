-- 88로또(`lotto88`)를 이관 사이트로 등록한다. (D197)
--
-- 88로또 회원은 10/12 이관 후 source_site='lotto88' 로 들어온다. 사이트 목록에 없으면
--   · 문자 발송 경로가 그 회원을 'unavailable' 로 판정해 **10/13 첫 발송이 전원 실패**하고,
--   · 이관 검수 중에도 서버가 문자를 막지 못하며,
--   · 사이트 필터·포털에서 88 회원이 통째로 안 잡힌다.
-- 20260929020000_best_legacy_site.sql 과 같은 목록을 같은 방식으로 한 칸 더 늘린다.
-- 적용 순서상 best 가 먼저 들어가 있어야 한다(아래 앵커가 best 를 포함한다).

-- 운영 DDL 잠금은 짧게 제한한다(best 마이그레이션과 같은 방식). 이력 제약은 NOT VALID 로 넓히고
-- 기존 행 검증은 별도 파일(20261002010100_validate_lotto88_history_source_sites.sql)에서 한다 —
-- 같은 트랜잭션에서 VALIDATE 하면 ADD 가 잡은 배타 잠금을 쥔 채 수백만 행을 훑게 된다.
SET LOCAL lock_timeout = '3s';

-- 1) 문자 보류 판정 — src/lib/legacyImportHold.ts 의 목록과 같아야 한다.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.sms_is_legacy_import_held(text)'::regprocedure);
  v_old constant text := $anchor$IN ('lotto815', 'cplotto', 'infolotto', 'best')$anchor$;
  v_new constant text := $replacement$IN ('lotto815', 'cplotto', 'infolotto', 'best', 'lotto88')$replacement$;
BEGIN
  IF position(v_new in v_def) = 0 THEN
    IF position(v_old in v_def) = 0 THEN
      RAISE EXCEPTION 'sms_is_legacy_import_held 의 source_site 목록(best 포함)을 찾지 못했습니다 — best 마이그레이션을 먼저 적용하세요';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
END $$;

-- 2) 회원 이력 테이블 CHECK 제약
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
                     CHECK (source_site IN ('lotto815','cplotto','infolotto','best','lotto88')) NOT VALID$fmt$,
                   v_table, v_table || '_source_site_check');
  END LOOP;
END $$;

-- 3) 사이트 스코프 검증 함수들
DO $$
DECLARE
  v_target record;
  v_def text;
  v_replaced text;
  v_old text[] := ARRAY[
    $a$('pluslotto', 'lotto815', 'infolotto', 'cplotto', 'best')$a$,
    $a$('pluslotto','lotto815','infolotto','cplotto','best')$a$
  ];
  v_new text[] := ARRAY[
    $b$('pluslotto', 'lotto815', 'infolotto', 'cplotto', 'best', 'lotto88')$b$,
    $b$('pluslotto','lotto815','infolotto','cplotto','best','lotto88')$b$
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

-- 4) 결제·매출 화면의 '이전상품' 라벨
--    괄호까지 완전 일치시킨다 — 괄호 없이 치환하면 이미 lotto88 이 붙은 목록에도 다시 걸려
--    재적용할 때마다 'lotto88' 이 하나씩 더 붙는다(best 마이그레이션에서 잡힌 문제).
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
      AND pg_get_functiondef(p.oid) LIKE '%(''lotto815'',''cplotto'',''infolotto'',''best'')%'
  LOOP
    v_def := pg_get_functiondef(v_target.sig);
    v_replaced := replace(v_def, $a$('lotto815','cplotto','infolotto','best')$a$,
                                 $b$('lotto815','cplotto','infolotto','best','lotto88')$b$);
    IF v_replaced <> v_def THEN
      EXECUTE v_replaced;
      RAISE NOTICE '이전상품 라벨 갱신: %', v_target.sig;
    END IF;
  END LOOP;
END $$;

-- 5) 적용 확인 — 빠졌으면 마이그레이션을 실패시킨다.
DO $$
BEGIN
  IF position('''lotto88''' in
        pg_get_functiondef('public.sms_is_legacy_import_held(text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '문자 보류 판정에 lotto88 이 반영되지 않았습니다 — 88 이관 회원 문자가 검수 중에 막히지 않습니다';
  END IF;
END $$;
