-- 815 과거 이력 전용 저장소. 운영 발송큐/예약/베팅/회원 meta 이력에 쓰지 않는다.
-- 현재 members RLS에 추가로 역할 범위를 제한한다. 기존 members 정책은 변경하지 않는다.
-- 원본 시각은 시간대가 확정되지 않은 wall time과 원문을 함께 보존한다.

CREATE OR REPLACE FUNCTION public.legacy_815_source_datetime(p_raw text)
RETURNS timestamp without time zone
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
     OR p_raw = '0000-00-00 00:00:00' THEN RETURN NULL; END IF;
  IF substring(p_raw,12,2)::integer > 23 OR substring(p_raw,15,2)::integer > 59
     OR substring(p_raw,18,2)::integer > 59 THEN RETURN NULL; END IF;
  RETURN pg_catalog.make_timestamp(
    substring(p_raw,1,4)::integer, substring(p_raw,6,2)::integer,
    substring(p_raw,9,2)::integer, substring(p_raw,12,2)::integer,
    substring(p_raw,15,2)::integer, substring(p_raw,18,2)::double precision);
EXCEPTION WHEN datetime_field_overflow THEN RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.legacy_815_source_datetime(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.legacy_815_source_datetime(text) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.legacy_member_memos (
  source_site text NOT NULL CHECK (source_site = 'lotto815'),
  legacy_idx bigint NOT NULL CHECK (legacy_idx > 0),
  source_user_idx bigint NOT NULL CHECK (source_user_idx > 0),
  member_id text NOT NULL REFERENCES public.members(id) ON DELETE RESTRICT,
  body text,
  source_status text,
  source_consult_status text,
  source_type text,
  source_team_open_yn text CHECK (source_team_open_yn IN ('Y','N') OR source_team_open_yn IS NULL),
  source_author_idx bigint CHECK (source_author_idx >= 0),
  source_updater_idx bigint CHECK (source_updater_idx >= 0),
  source_reserved_yn text CHECK (source_reserved_yn IN ('Y','N') OR source_reserved_yn IS NULL),
  source_reservation_checked_yn text CHECK (source_reservation_checked_yn IN ('Y','N') OR source_reservation_checked_yn IS NULL),
  source_reserve_datetime text,
  source_insert_datetime text,
  source_update_datetime text,
  occurred_at timestamp without time zone GENERATED ALWAYS AS (public.legacy_815_source_datetime(source_insert_datetime)) STORED,
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  prepared_record_sha256 text NOT NULL CHECK (prepared_record_sha256 ~ '^[0-9a-f]{64}$'),
  import_batch text NOT NULL CHECK (import_batch ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_site,legacy_idx)
);

CREATE TABLE IF NOT EXISTS public.legacy_member_sms (
  source_site text NOT NULL CHECK (source_site = 'lotto815'),
  legacy_idx bigint NOT NULL CHECK (legacy_idx > 0),
  source_user_idx bigint NOT NULL CHECK (source_user_idx > 0),
  member_id text NOT NULL REFERENCES public.members(id) ON DELETE RESTRICT,
  contents_type text NOT NULL,
  source_type text,
  source_status text,
  source_result_yn text,
  source_result_code text,
  source_author_idx bigint CHECK (source_author_idx >= 0),
  source_updater_idx bigint CHECK (source_updater_idx >= 0),
  body_policy text NOT NULL CHECK (body_policy IN
    ('body_preserved','credential_type_omitted','credential_pattern_omitted','unreviewed_type_omitted')),
  body text,
  subject text,
  from_phone text,
  to_phone text,
  source_reserve_datetime text,
  source_insert_datetime text,
  source_update_datetime text,
  occurred_at timestamp without time zone GENERATED ALWAYS AS (public.legacy_815_source_datetime(source_insert_datetime)) STORED,
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  prepared_record_sha256 text NOT NULL CHECK (prepared_record_sha256 ~ '^[0-9a-f]{64}$'),
  import_batch text NOT NULL CHECK (import_batch ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_site,legacy_idx),
  CONSTRAINT legacy_sms_body_policy CHECK (
    (body_policy = 'body_preserved' AND body IS NOT NULL
      AND (contents_type IN ('autoPick','adminPickSend','autoPickReSend','autoPickRecovery')
           OR contents_type ~ '^nlottoWin[0-9]+$')
      AND (coalesce(subject,'') || E'\n' || body) !~*
        '비밀번호|비번|인증번호|인증코드|임시[[:space:]]*번호|password|passwd|\motp\M|api[_-]?key[[:space:]]*[:=]|access[_-]?token[[:space:]]*[:=]|[?&](token|key|auth)=')
    OR (body_policy <> 'body_preserved' AND body IS NULL AND subject IS NULL
        AND from_phone IS NULL AND to_phone IS NULL
        AND source_status IS NULL AND source_result_yn IS NULL AND source_result_code IS NULL
        AND source_author_idx IS NULL AND source_updater_idx IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.legacy_member_wins (
  source_site text NOT NULL CHECK (source_site = 'lotto815'),
  legacy_idx bigint NOT NULL CHECK (legacy_idx > 0),
  round_no integer NOT NULL CHECK (round_no > 0),
  source_user_idx bigint NOT NULL CHECK (source_user_idx > 0),
  member_id text NOT NULL REFERENCES public.members(id) ON DELETE RESTRICT,
  source_status text,
  source_checked_yn text CHECK (source_checked_yn IN ('Y','N') OR source_checked_yn IS NULL),
  source_pick_type text,
  source_pick_from text,
  source_pick_string text NOT NULL,
  numbers integer[] NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 5),
  prize bigint NOT NULL CHECK (prize >= 0),
  source_insert_datetime text,
  source_update_datetime text,
  occurred_at timestamp without time zone GENERATED ALWAYS AS (public.legacy_815_source_datetime(source_insert_datetime)) STORED,
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  prepared_record_sha256 text NOT NULL CHECK (prepared_record_sha256 ~ '^[0-9a-f]{64}$'),
  import_batch text NOT NULL CHECK (import_batch ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  -- 원본 gameBettingNlotto는 num(회차)별 partition이고 PK는 (idx,num)이다.
  PRIMARY KEY (source_site,legacy_idx,round_no),
  CHECK (array_ndims(numbers) = 1 AND array_lower(numbers,1) = 1 AND cardinality(numbers) = 6
    AND numbers[1] BETWEEN 1 AND 45 AND numbers[2] BETWEEN 1 AND 45
    AND numbers[3] BETWEEN 1 AND 45 AND numbers[4] BETWEEN 1 AND 45
    AND numbers[5] BETWEEN 1 AND 45 AND numbers[6] BETWEEN 1 AND 45
    AND numbers[1] <> ALL(numbers[2:6]) AND numbers[2] <> ALL(numbers[3:6])
    AND numbers[3] <> ALL(numbers[4:6]) AND numbers[4] <> ALL(numbers[5:6])
    AND numbers[5] <> numbers[6]),
  CHECK (array_position(numbers,NULL) IS NULL),
  CHECK (CASE WHEN source_pick_string ~ '^\|*[0-9]{1,2}(\|[0-9]{1,2}){5}\|*$'
    THEN string_to_array(btrim(source_pick_string,'|'),'|')::integer[] = numbers ELSE false END)
);

CREATE INDEX IF NOT EXISTS legacy_member_memos_page_idx ON public.legacy_member_memos
  (member_id,(coalesce(occurred_at,'-infinity'::timestamp)) DESC,legacy_idx DESC);
CREATE INDEX IF NOT EXISTS legacy_member_sms_page_idx ON public.legacy_member_sms
  (member_id,(coalesce(occurred_at,'-infinity'::timestamp)) DESC,legacy_idx DESC);
CREATE INDEX IF NOT EXISTS legacy_member_wins_page_idx ON public.legacy_member_wins
  (member_id,(coalesce(occurred_at,'-infinity'::timestamp)) DESC,legacy_idx DESC,round_no DESC);

-- 각 불변 적재 청크의 재시도/응답 대조를 전체 테이블 스캔 없이 조회한다.
CREATE INDEX IF NOT EXISTS legacy_member_memos_import_batch_idx ON public.legacy_member_memos (import_batch);
CREATE INDEX IF NOT EXISTS legacy_member_sms_import_batch_idx ON public.legacy_member_sms (import_batch);
CREATE INDEX IF NOT EXISTS legacy_member_wins_import_batch_idx ON public.legacy_member_wins (import_batch);

-- service_role도 FK 외에 출처/원본 회원 연결을 검증한다.
-- FOR SHARE는 source metadata의 동시 UPDATE와 충돌하여 확인 직후 출처 변경을 막는다.
CREATE OR REPLACE FUNCTION public.legacy_history_check_member_source()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE source_site_value text; source_idx_value text;
BEGIN
  SELECT public.member_operating_site(m), m.meta->>'legacy_idx'
    INTO source_site_value,source_idx_value FROM public.members m WHERE m.id = NEW.member_id FOR SHARE;
  IF NOT FOUND OR source_site_value IS DISTINCT FROM NEW.source_site
     OR source_idx_value IS DISTINCT FROM NEW.source_user_idx::text THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='legacy history member source mismatch';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.legacy_history_check_member_source() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.legacy_history_check_member_source() TO service_role;

DROP TRIGGER IF EXISTS legacy_memos_source_guard ON public.legacy_member_memos;
CREATE TRIGGER legacy_memos_source_guard BEFORE INSERT OR UPDATE ON public.legacy_member_memos
  FOR EACH ROW EXECUTE FUNCTION public.legacy_history_check_member_source();
DROP TRIGGER IF EXISTS legacy_sms_source_guard ON public.legacy_member_sms;
CREATE TRIGGER legacy_sms_source_guard BEFORE INSERT OR UPDATE ON public.legacy_member_sms
  FOR EACH ROW EXECUTE FUNCTION public.legacy_history_check_member_source();
DROP TRIGGER IF EXISTS legacy_wins_source_guard ON public.legacy_member_wins;
CREATE TRIGGER legacy_wins_source_guard BEFORE INSERT OR UPDATE ON public.legacy_member_wins
  FOR EACH ROW EXECUTE FUNCTION public.legacy_history_check_member_source();

-- 숨겨진 비공개 이력도 참조 무결성의 대상이다. 이 함수만 테이블 소유자 권한으로
-- 존재 여부를 확인하며, 고객/이력 값을 반환하거나 수정하지 않는다.
CREATE OR REPLACE FUNCTION public.legacy_history_preserve_member_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF public.member_operating_site(OLD) IS NOT DISTINCT FROM public.member_operating_site(NEW)
     AND OLD.meta->>'legacy_idx' IS NOT DISTINCT FROM NEW.meta->>'legacy_idx' THEN RETURN NEW; END IF;
  -- 오래된 snapshot은 직전에 적재된 이력도 놓칠 수 있다. 출처 변경만 새 snapshot에서 허용한다.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='member source identity changes require read committed isolation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.legacy_member_memos h WHERE h.member_id=OLD.id)
     OR EXISTS (SELECT 1 FROM public.legacy_member_sms h WHERE h.member_id=OLD.id)
     OR EXISTS (SELECT 1 FROM public.legacy_member_wins h WHERE h.member_id=OLD.id) THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='member source identity has preserved legacy history';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.legacy_history_preserve_member_identity() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS members_legacy_history_identity_guard ON public.members;
CREATE TRIGGER members_legacy_history_identity_guard BEFORE UPDATE OF meta ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.legacy_history_preserve_member_identity();

ALTER TABLE public.legacy_member_memos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_member_sms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_member_wins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legacy_memos_member_read ON public.legacy_member_memos;
CREATE POLICY legacy_memos_member_read ON public.legacy_member_memos FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.members m WHERE m.id=member_id
    AND public.member_operating_site(m)=source_site AND m.meta->>'legacy_idx'=source_user_idx::text
    AND ((SELECT public.app_role()) IN ('admin','manager')
      OR ((SELECT public.app_role())='leader' AND m.team_id=(SELECT public.app_team()))
      OR ((SELECT public.app_role())='rep' AND m.assigned_staff_id=(SELECT public.app_staff_id())))
    -- 작성자 원본 번호를 staff로 임의 변환하지 않는다. 확정 매핑 전에는 작성자 예외 없음.
    AND (source_team_open_yn='Y' OR (SELECT public.app_role())='admin'
         OR m.assigned_staff_id=(SELECT public.app_staff_id())))
);
DROP POLICY IF EXISTS legacy_sms_member_read ON public.legacy_member_sms;
CREATE POLICY legacy_sms_member_read ON public.legacy_member_sms FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.members m WHERE m.id=member_id
    AND public.member_operating_site(m)=source_site AND m.meta->>'legacy_idx'=source_user_idx::text
    AND ((SELECT public.app_role()) IN ('admin','manager')
      OR ((SELECT public.app_role())='leader' AND m.team_id=(SELECT public.app_team()))
      OR ((SELECT public.app_role())='rep' AND m.assigned_staff_id=(SELECT public.app_staff_id()))))
);
DROP POLICY IF EXISTS legacy_wins_member_read ON public.legacy_member_wins;
CREATE POLICY legacy_wins_member_read ON public.legacy_member_wins FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.members m WHERE m.id=member_id
    AND public.member_operating_site(m)=source_site AND m.meta->>'legacy_idx'=source_user_idx::text
    AND ((SELECT public.app_role()) IN ('admin','manager')
      OR ((SELECT public.app_role())='leader' AND m.team_id=(SELECT public.app_team()))
      OR ((SELECT public.app_role())='rep' AND m.assigned_staff_id=(SELECT public.app_staff_id()))))
);
-- 0002의 authenticated 기본 CRUD 권한을 명시 회수한다. 서비스도 INSERT만 허용한다.
REVOKE ALL ON public.legacy_member_memos,public.legacy_member_sms,public.legacy_member_wins
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.legacy_member_memos,public.legacy_member_sms,public.legacy_member_wins TO authenticated;
GRANT SELECT,INSERT ON public.legacy_member_memos,public.legacy_member_sms,public.legacy_member_wins TO service_role;

-- 한 회원의 한 종류만 최대 100건. 전체 count(*) 없이 limit+1로 has_more를 판단한다.
-- 커서는 원시 wall time 정렬값 + 원본키이며 bigints는 JSON 문자열로 전달한다.
CREATE OR REPLACE FUNCTION public.member_legacy_history_page(
  p_member_id text, p_kind text, p_limit integer DEFAULT 50,
  p_before_at timestamp without time zone DEFAULT NULL,
  p_before_idx bigint DEFAULT NULL, p_before_round integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE rows_json jsonb; selected_count integer; last_row jsonb; page_json jsonb;
BEGIN
  IF p_member_id IS NULL OR length(p_member_id)=0 OR p_kind IS NULL OR p_kind NOT IN ('memo','sms','win')
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR (p_before_at IS NULL) <> (p_before_idx IS NULL)
     OR (p_before_at IS NULL) <> (p_before_round IS NULL)
     OR (p_before_idx IS NOT NULL AND p_before_idx <= 0)
     OR (p_before_round IS NOT NULL AND ((p_kind='win' AND p_before_round<=0) OR (p_kind<>'win' AND p_before_round<>0))) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid legacy history page request';
  END IF;
  IF p_kind='memo' THEN
    SELECT coalesce(jsonb_agg(x.row_json ORDER BY x.sort_at DESC,x.legacy_idx DESC),'[]'::jsonb) INTO rows_json
    FROM (SELECT to_jsonb(h)||jsonb_build_object('legacy_idx',h.legacy_idx::text,'source_user_idx',h.source_user_idx::text,
        'source_author_idx',h.source_author_idx::text,'source_updater_idx',h.source_updater_idx::text,
        'cursor_at',coalesce(h.occurred_at,'-infinity'::timestamp)::text,'cursor_round',0) AS row_json,
        coalesce(h.occurred_at,'-infinity'::timestamp) AS sort_at,h.legacy_idx
      FROM public.legacy_member_memos h WHERE h.member_id=p_member_id
        AND (p_before_at IS NULL OR (coalesce(h.occurred_at,'-infinity'::timestamp),h.legacy_idx)<(p_before_at,p_before_idx))
      ORDER BY coalesce(h.occurred_at,'-infinity'::timestamp) DESC,h.legacy_idx DESC LIMIT p_limit+1) x;
  ELSIF p_kind='sms' THEN
    SELECT coalesce(jsonb_agg(x.row_json ORDER BY x.sort_at DESC,x.legacy_idx DESC),'[]'::jsonb) INTO rows_json
    FROM (SELECT to_jsonb(h)||jsonb_build_object('legacy_idx',h.legacy_idx::text,'source_user_idx',h.source_user_idx::text,
        'source_author_idx',h.source_author_idx::text,'source_updater_idx',h.source_updater_idx::text,
        'cursor_at',coalesce(h.occurred_at,'-infinity'::timestamp)::text,'cursor_round',0) AS row_json,
        coalesce(h.occurred_at,'-infinity'::timestamp) AS sort_at,h.legacy_idx
      FROM public.legacy_member_sms h WHERE h.member_id=p_member_id
        AND (p_before_at IS NULL OR (coalesce(h.occurred_at,'-infinity'::timestamp),h.legacy_idx)<(p_before_at,p_before_idx))
      ORDER BY coalesce(h.occurred_at,'-infinity'::timestamp) DESC,h.legacy_idx DESC LIMIT p_limit+1) x;
  ELSE
    SELECT coalesce(jsonb_agg(x.row_json ORDER BY x.sort_at DESC,x.legacy_idx DESC,x.round_no DESC),'[]'::jsonb) INTO rows_json
    FROM (SELECT to_jsonb(h)||jsonb_build_object('legacy_idx',h.legacy_idx::text,'source_user_idx',h.source_user_idx::text,
        'prize',h.prize::text,'cursor_at',coalesce(h.occurred_at,'-infinity'::timestamp)::text,'cursor_round',h.round_no) AS row_json,
        coalesce(h.occurred_at,'-infinity'::timestamp) AS sort_at,h.legacy_idx,h.round_no
      FROM public.legacy_member_wins h WHERE h.member_id=p_member_id
        AND (p_before_at IS NULL OR (coalesce(h.occurred_at,'-infinity'::timestamp),h.legacy_idx,h.round_no)<(p_before_at,p_before_idx,p_before_round))
      ORDER BY coalesce(h.occurred_at,'-infinity'::timestamp) DESC,h.legacy_idx DESC,h.round_no DESC LIMIT p_limit+1) x;
  END IF;
  selected_count := jsonb_array_length(rows_json);
  SELECT coalesce(jsonb_agg(value ORDER BY ordinal),'[]'::jsonb) INTO page_json
    FROM jsonb_array_elements(rows_json) WITH ORDINALITY items(value,ordinal) WHERE ordinal<=p_limit;
  last_row := page_json->(jsonb_array_length(page_json)-1);
  RETURN jsonb_build_object('rows',page_json,'has_more',selected_count>p_limit,
    'next_cursor',CASE WHEN selected_count>p_limit THEN jsonb_build_object(
       'at',last_row->>'cursor_at','idx',last_row->>'legacy_idx','round',last_row->'cursor_round') ELSE NULL END);
END;
$$;
REVOKE ALL ON FUNCTION public.member_legacy_history_page(text,text,integer,timestamp,bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.member_legacy_history_page(text,text,integer,timestamp,bigint,integer) TO authenticated,service_role;
