-- 이전 전산 이력 '당첨기록' 요약표 (현장 10/14, 정의현 차장 — "1등 00개 / 2등 00개 / … / 전체 당첨금 00원").
--
-- 목록 RPC(member_legacy_history_page)는 50건씩 페이지로만 돌려줘 화면에서 합계를 낼 수 없다
-- (815 회원은 당첨 행이 수백 건). 회원 1명의 전 행을 등수별 개수·당첨금 합계로 묶어 돌려준다.
--
-- 권한: SECURITY INVOKER — legacy_member_wins RLS(legacy_wins_member_read)가 목록과 똑같이 적용된다
-- (admin·manager·leader 전체, rep 본인 담당만, 권한 없으면 0건 → 전부 0). anon 은 실행 불가.
-- 범위: 목록과 같은 행을 센다. 원본에서 삭제 표시(source_status='remove')된 행도 목록에 보이므로
-- 합계에 포함하고, 화면이 따로 알릴 수 있게 그 건수를 함께 돌려준다.
-- 당첨금은 bigint 합계라 JS 안전 정수를 넘을 수 있어 목록의 prize 와 같이 문자열로 돌려준다.
CREATE OR REPLACE FUNCTION public.member_legacy_win_summary(p_member_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF p_member_id IS NULL OR length(p_member_id) = 0 OR length(p_member_id) > 256 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid legacy win summary request';
  END IF;
  SELECT jsonb_build_object(
    'rank_counts', jsonb_build_object(
      '1', count(*) FILTER (WHERE h.rank = 1),
      '2', count(*) FILTER (WHERE h.rank = 2),
      '3', count(*) FILTER (WHERE h.rank = 3),
      '4', count(*) FILTER (WHERE h.rank = 4),
      '5', count(*) FILTER (WHERE h.rank = 5)),
    'total_count', count(*),
    'total_prize', coalesce(sum(h.prize), 0)::text,
    'removed_count', count(*) FILTER (WHERE h.source_status = 'remove'))
  INTO result
  FROM public.legacy_member_wins h
  WHERE h.member_id = p_member_id;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.member_legacy_win_summary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_legacy_win_summary(text) TO authenticated, service_role;
