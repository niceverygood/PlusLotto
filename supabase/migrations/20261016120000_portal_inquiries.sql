-- 고객 홈페이지 1:1 문의 — 접수 복구 + 비밀글(작성자만 열람) (현장 10/16, 정의현 차장 —
-- "회원용 홈페이지 게시판에 문의글 작성이 안되고 있습니다. 문의글은 작성자외에는 다른사람은 볼 수 없도록
-- 블라인드 처리 부탁드리겠습니다").
--
-- 원인: inquiries.id 에 기본값이 없는데(0001) 홈페이지(anon)가 id 없이 INSERT 해 매번 NOT NULL 위반으로
-- 실패했다(1:1 문의·홈페이지 가입문의 둘 다). 또 anon 직접 INSERT 정책(0007)은 status·answer·member_id 까지
-- 마음대로 넣을 수 있었다.
--
-- 바꾼 것:
--  1) id 기본값('inq_'+uuid). 직원 화면 등 다른 INSERT 경로도 id 를 빼먹어도 실패하지 않는다.
--  2) anon 직접 쓰기를 닫고(정책 삭제 + 권한 회수), 사이트·길이·연락처를 검증하는 SECURITY DEFINER RPC
--     portal_submit_inquiry 로만 접수한다. 상태는 항상 'open', 답변·회원 연결은 직원만.
--  3) 비밀글: 작성자가 정한 비밀번호의 솔트+SHA-256 을 별도 테이블 inquiry_secrets 에 둔다(anon·직원 모두
--     직접 접근 불가 — 직원 화면 select('*') 에도 실리지 않는다). 작성자는 연락처+비밀번호로
--     portal_my_inquiries 를 불러 자기 글과 답변만 본다. 비밀번호 대입을 막기 위해 연락처별 실패 10회/10분 제한.
--  4) 목록(portal_inquiry_board)은 그 사이트 글의 날짜·답변상태·가린 이름(홍*동)만 준다 — 제목·내용·연락처 없음.
-- source_site 는 어느 홈페이지에서 들어온 문의인지 남긴다(기존 행은 NULL).
ALTER TABLE public.inquiries ALTER COLUMN id SET DEFAULT ('inq_' || replace(gen_random_uuid()::text, '-', ''));
ALTER TABLE public.inquiries ADD COLUMN IF NOT EXISTS source_site text;
ALTER TABLE public.inquiries ADD COLUMN IF NOT EXISTS author_phone text;
CREATE INDEX IF NOT EXISTS inquiries_author_phone_idx ON public.inquiries (author_phone, created_at DESC)
  WHERE author_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS inquiries_site_created_idx ON public.inquiries (source_site, created_at DESC);

DROP POLICY IF EXISTS inquiries_public_insert ON public.inquiries;
REVOKE ALL ON public.inquiries FROM anon;

CREATE TABLE IF NOT EXISTS public.inquiry_secrets (
  inquiry_id text PRIMARY KEY REFERENCES public.inquiries(id) ON DELETE CASCADE,
  salt text NOT NULL,
  hash text NOT NULL
);
ALTER TABLE public.inquiry_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inquiry_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inquiry_secrets TO service_role;

CREATE TABLE IF NOT EXISTS public.inquiry_lookup_failures (
  phone text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inquiry_lookup_failures_idx ON public.inquiry_lookup_failures (phone, failed_at DESC);
ALTER TABLE public.inquiry_lookup_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inquiry_lookup_failures FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inquiry_lookup_failures TO service_role;

-- 국내 휴대전화 숫자형(0으로 시작 9~11자리)으로 맞춘다. 82/0082 국가번호도 받는다. 아니면 NULL.
CREATE OR REPLACE FUNCTION public.portal_normalize_phone(p_phone text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v text := pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
BEGIN
  IF pg_catalog.left(v, 4) = '0082' THEN v := '0' || pg_catalog.ltrim(pg_catalog.substr(v, 5), '0');
  ELSIF pg_catalog.left(v, 2) = '82' AND pg_catalog.length(v) >= 11 THEN v := '0' || pg_catalog.ltrim(pg_catalog.substr(v, 3), '0');
  END IF;
  IF v !~ '^0[0-9]{8,10}$' THEN RETURN NULL; END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.portal_normalize_phone(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.portal_inquiry_hash(p_salt text, p_password text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_salt || ':' || p_password, 'UTF8')), 'hex')
$$;
REVOKE ALL ON FUNCTION public.portal_inquiry_hash(text, text) FROM PUBLIC, anon, authenticated;

-- 문의 접수. p_password 가 있으면 비밀글 열람용 비밀번호(4~20자)로 저장한다(홈페이지 가입문의는 없음).
-- 같은 연락처는 1시간에 5건까지. 반환 {id}. 검증 실패는 22023, 과다 접수는 54000.
CREATE OR REPLACE FUNCTION public.portal_submit_inquiry(
  p_source_site text, p_name text, p_phone text, p_category text, p_title text, p_body text,
  p_password text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_phone text := public.portal_normalize_phone(p_phone);
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_title text := pg_catalog.btrim(coalesce(p_title, ''));
  v_body text := pg_catalog.btrim(coalesce(p_body, ''));
  v_category text := coalesce(nullif(pg_catalog.btrim(coalesce(p_category, '')), ''), '기타');
  v_id text;
  v_salt text;
BEGIN
  IF p_source_site IS NULL OR p_source_site NOT IN ('pluslotto', 'lotto815', 'infolotto', 'cplotto', 'best') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid inquiry site';
  END IF;
  IF v_phone IS NULL THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid inquiry phone'; END IF;
  IF pg_catalog.length(v_name) NOT BETWEEN 1 AND 50
     OR pg_catalog.length(v_title) NOT BETWEEN 1 AND 200
     OR pg_catalog.length(v_body) NOT BETWEEN 1 AND 5000
     OR pg_catalog.length(v_category) > 30 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid inquiry fields';
  END IF;
  IF p_password IS NOT NULL AND pg_catalog.length(p_password) NOT BETWEEN 4 AND 20 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid inquiry password';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inquiry:' || v_phone, 0));
  IF (SELECT count(*) FROM public.inquiries i
      WHERE i.author_phone = v_phone AND i.created_at > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'too many inquiries';
  END IF;
  INSERT INTO public.inquiries (author_name, category, title, body, status, source_site, author_phone)
  VALUES (v_name, v_category, v_title, v_body, 'open', p_source_site, v_phone)
  RETURNING id INTO v_id;
  IF p_password IS NOT NULL THEN
    v_salt := pg_catalog.replace(gen_random_uuid()::text, '-', '');
    INSERT INTO public.inquiry_secrets (inquiry_id, salt, hash)
    VALUES (v_id, v_salt, public.portal_inquiry_hash(v_salt, p_password));
  END IF;
  RETURN pg_catalog.jsonb_build_object('id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.portal_submit_inquiry(text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_submit_inquiry(text, text, text, text, text, text, text) TO anon, authenticated, service_role;

-- 문의 목록(가림): 그 사이트 최근 글의 번호·날짜·답변상태·가린 이름만. 제목·내용·연락처는 주지 않는다.
CREATE OR REPLACE FUNCTION public.portal_inquiry_board(p_source_site text, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_source_site IS NULL OR p_source_site NOT IN ('pluslotto', 'lotto815', 'infolotto', 'cplotto', 'best') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid inquiry site';
  END IF;
  RETURN coalesce((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', x.id,
      'author', CASE
        WHEN pg_catalog.length(x.author_name) <= 1 THEN '*'
        WHEN pg_catalog.length(x.author_name) = 2 THEN pg_catalog.left(x.author_name, 1) || '*'
        ELSE pg_catalog.left(x.author_name, 1) || pg_catalog.repeat('*', pg_catalog.length(x.author_name) - 2)
             || pg_catalog.right(x.author_name, 1)
      END,
      'status', x.status, 'created_at', x.created_at) ORDER BY x.created_at DESC, x.id DESC)
    FROM (
      SELECT i.id, i.author_name, i.status, i.created_at FROM public.inquiries i
      WHERE i.source_site = p_source_site AND i.category <> '가입문의'
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)
    ) x
  ), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.portal_inquiry_board(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_inquiry_board(text, integer) TO anon, authenticated, service_role;

-- 내 문의 확인: 연락처 + 접수 때 정한 비밀번호가 맞는 글만(제목·내용·답변 포함) 돌려준다.
-- 맞는 글이 없으면 실패로 기록하고 빈 목록. 연락처별 최근 10분 실패 10회 이상이면 54000(잠시 후 재시도).
CREATE OR REPLACE FUNCTION public.portal_my_inquiries(p_source_site text, p_phone text, p_password text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_phone text := public.portal_normalize_phone(p_phone);
  v_result jsonb;
BEGIN
  IF p_source_site IS NULL OR p_source_site NOT IN ('pluslotto', 'lotto815', 'infolotto', 'cplotto', 'best') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid inquiry site';
  END IF;
  IF v_phone IS NULL OR p_password IS NULL OR pg_catalog.length(p_password) NOT BETWEEN 4 AND 20 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF (SELECT count(*) FROM public.inquiry_lookup_failures f
      WHERE f.phone = v_phone AND f.failed_at > now() - interval '10 minutes') >= 10 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'too many inquiry lookups';
  END IF;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', i.id, 'category', i.category, 'title', i.title, 'body', i.body, 'status', i.status,
    'answer', i.answer, 'answered_at', i.answered_at, 'created_at', i.created_at)
    ORDER BY i.created_at DESC, i.id DESC)
  INTO v_result
  FROM public.inquiries i
  JOIN public.inquiry_secrets s ON s.inquiry_id = i.id
  WHERE i.source_site = p_source_site AND i.author_phone = v_phone
    AND s.hash = public.portal_inquiry_hash(s.salt, p_password);
  IF v_result IS NULL THEN
    INSERT INTO public.inquiry_lookup_failures (phone) VALUES (v_phone);
    DELETE FROM public.inquiry_lookup_failures WHERE failed_at < now() - interval '1 day';
    RETURN '[]'::jsonb;
  END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.portal_my_inquiries(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_my_inquiries(text, text, text) TO anon, authenticated, service_role;
