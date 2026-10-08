-- 통화예약 알림(상단 벨)이 회원 전체를 30초마다 읽던 것을 예약 있는 회원만 읽도록 바꾼다 (현장 10/8).
--
-- 증상: 10/8 오후 DB CPU 100% 고정 → 이용자·결제 목록이 statement timeout.
-- 근거(운영 pg_stat_statements, 누적): 1위가 이 조회였다.
--   members 직접 조회(id, name, phone, assigned_staff_id, meta) — 호출 559,742회 · 평균 828ms · 누적 463,674초.
--   같은 조회의 담당자/사이트 변형들이 4·8·9위(호출 83만·68만·116만 회).
-- 원인: useCallReservationAlerts 가 열린 관리자 탭마다(백그라운드 포함) 30초마다
--   `meta->>'call_reservation_at' is not null` 로 members 를 조회한다. RLS 아래에서는 이 조건이
--   인덱스를 못 써서(leakproof 아님) 매번 전 회원의 meta(발급 이력 포함)를 풀어 보고,
--   걸린 회원의 meta 전체를 내려보냈다.
--
-- 처방: 예약이 있는 회원만 담는 부분 인덱스 + 필요한 4개 값만 돌려주는 SECURITY DEFINER RPC.
--   가시성은 members_rw(0016)와 같다: admin·manager·leader 전체 / rep 본인 담당.
--   사이트 조건은 member_operating_site 와 같은 식이다. 도래 여부(예약시각 <= 지금) 판단은
--   기존과 같이 화면(dueReservations)에서 한다.
--   DEFINER 이므로 로그인·직원 역할이 없으면 42501 로 거부하고 search_path 는 '' 로 고정한다.
--   로컬 PG16(RLS 동일, 회원 20,000·예약 654): admin·rep 2명 × 사이트 5종 결과가 기존 조회와 같았다.

CREATE INDEX IF NOT EXISTS members_call_reservation_idx
  ON public.members ((meta->>'call_reservation_at'))
  WHERE (meta->>'call_reservation_at') IS NOT NULL;
-- 새 인덱스 식의 통계를 바로 만든다(없으면 플래너가 '거의 모든 행이 예약 있음'으로 추정한다).
ANALYZE public.members;

CREATE OR REPLACE FUNCTION public.admin_call_reservations(p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
 -- 이 함수의 조회는 위 부분 인덱스 하나로 끝난다. 순차 스캔은 전 회원 meta 를 다시 풀게 되므로 막는다.
 SET enable_seqscan TO 'off'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
  v_role public.role := public.app_role();
  v_staff_id text := public.app_staff_id();
BEGIN
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'insufficient privilege for call reservations';
  END IF;
  RETURN (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'name', m.name,
      'phone', m.phone,
      'assigned_staff_id', m.assigned_staff_id,
      'meta', jsonb_build_object('call_reservation_at', m.meta->'call_reservation_at')
    )), '[]'::jsonb)
    from public.members m
    where (m.meta->>'call_reservation_at') IS NOT NULL
      and (v_role::text <> 'rep' or m.assigned_staff_id = v_staff_id)
      and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_call_reservations(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_call_reservations(text) TO authenticated, service_role;

-- 끝(이 줄까지 붙여넣어야 합니다).
