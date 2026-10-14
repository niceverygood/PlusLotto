-- 사이트별 약관 게시판 (현장 10/14, 정의현 차장).
--  1. "회원별 홈페이지에 '약관'은 각각 다르게 설정할 수 있도록" — 사이트(플러스·815·인포·일행·프리미엄)마다 따로.
--  2. "약관이 중간중간 수정/업데이트 되기 때문에 약관보기를 누르면 게시판 형태로, 새로 수정된 약관을
--     업데이트하는 형식" — 덮어쓰기 대신 개정본을 글로 쌓고, 고객 화면은 목록(최신 = 현행)으로 보여 준다.
--
-- 저장 위치: 기존 site_settings.terms / terms_by_grade(단일 행, 사이트 구분·이력 없음) 대신 새 테이블.
--   notices 를 재사용하지 않는 이유: 사이트·등급 열이 없고, anon 공개 정책이 고객센터 공지 목록에 섞인다.
-- 고객(anon) 읽기: 테이블 직접 노출 대신 사이트를 검증하는 SECURITY DEFINER RPC 로 공개 글만 돌려준다.
-- 기존 플러스 약관(공통 + 등급별)은 첫 글로 옮겨 고객 화면이 비지 않게 한다. 이관 4사이트는 받은 약관 원문이
-- 없으므로(ASSUMPTIONS 2026-10-02) 아무것도 넣지 않는다 — 비어 있으면 화면은 고객센터 안내를 보여 준다.
CREATE TABLE IF NOT EXISTS public.terms_posts (
  id text PRIMARY KEY DEFAULT ('trm_' || replace(gen_random_uuid()::text, '-', '')),
  source_site text NOT NULL CHECK (source_site IN ('pluslotto', 'lotto815', 'infolotto', 'cplotto', 'best')),
  grade public.grade, -- NULL = 전 등급 공통 약관
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 200000),
  effective_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Seoul')::date), -- 시행일
  published boolean NOT NULL DEFAULT true,
  author_id text REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terms_posts_board_idx
  ON public.terms_posts (source_site, grade, effective_on DESC, created_at DESC);

ALTER TABLE public.terms_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terms_posts_read ON public.terms_posts;
CREATE POLICY terms_posts_read ON public.terms_posts FOR SELECT TO authenticated
  USING (public.app_role() IS NOT NULL);
-- 작성·수정·삭제는 설정 화면과 같은 권한(최고관리자·관리자).
DROP POLICY IF EXISTS terms_posts_write ON public.terms_posts;
CREATE POLICY terms_posts_write ON public.terms_posts FOR ALL TO authenticated
  USING (public.app_role() IN ('admin', 'manager'))
  WITH CHECK (public.app_role() IN ('admin', 'manager'));
REVOKE ALL ON public.terms_posts FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.terms_posts TO authenticated;
GRANT ALL ON public.terms_posts TO service_role;

-- 고객 공개 약관 목록: 해당 사이트의 공개 글 중 그 등급 전용 + 공통(grade NULL). 최신 시행일 순.
-- 작성자 등 내부 정보는 돌려주지 않는다. 알 수 없는 사이트·등급은 22023.
CREATE OR REPLACE FUNCTION public.portal_terms_posts(p_source_site text, p_grade text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_source_site IS NULL OR p_source_site NOT IN ('pluslotto', 'lotto815', 'infolotto', 'cplotto', 'best') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid terms site';
  END IF;
  IF p_grade IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_enum e
    JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'grade' AND e.enumlabel = p_grade
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid terms grade';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', p.id, 'grade', p.grade, 'title', p.title, 'body', p.body,
      'effective_on', p.effective_on, 'created_at', p.created_at
    ) ORDER BY p.effective_on DESC, p.created_at DESC, p.id DESC)
    FROM public.terms_posts p
    WHERE p.published
      AND p.source_site = p_source_site
      AND (p.grade IS NULL OR p.grade::text = p_grade)
  ), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.portal_terms_posts(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_terms_posts(text, text) TO anon, authenticated, service_role;

-- 기존 플러스 약관을 첫 글로 옮긴다(공통 + 등급별). 플러스 글이 하나도 없을 때만 — 재실행해도 중복되지 않는다.
-- 원래 작성일을 알 수 없어 시행일은 적용일로 둔다. 한 문장으로 넣어 NOT EXISTS 가 적용 전 상태를 본다.
INSERT INTO public.terms_posts (source_site, grade, title, body)
SELECT 'pluslotto', src.grade, src.title, src.body
FROM (
  SELECT NULL::public.grade AS grade, '이용약관 (공통)' AS title, s.terms AS body
  FROM public.site_settings s
  WHERE s.id = 1 AND btrim(coalesce(s.terms, '')) <> ''
  UNION ALL
  SELECT e.key::public.grade, '이용약관 (등급별)', e.value
  FROM public.site_settings s
  CROSS JOIN LATERAL jsonb_each_text(coalesce(s.terms_by_grade, '{}'::jsonb)) e
  WHERE s.id = 1 AND btrim(coalesce(e.value, '')) <> ''
    AND e.key IN (
      SELECT en.enumlabel FROM pg_catalog.pg_enum en
      JOIN pg_catalog.pg_type t ON t.oid = en.enumtypid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'grade')
) src
WHERE NOT EXISTS (SELECT 1 FROM public.terms_posts WHERE source_site = 'pluslotto');
