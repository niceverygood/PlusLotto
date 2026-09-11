-- admin_member_search 전화번호 검색이 인덱스를 못 쓰는 형태로 되돌아간 것을 복구한다.
--
-- 0018_trigram_search_paths 는 `position(a in b) > 0` 을 `b like '%a%'` 로 바꾸려고 만든
-- 마이그레이션이다. GIN trigram 인덱스(members_phone_digits_trgm_idx)는 LIKE 만 받고
-- position() 은 받지 못하기 때문이다. 20260909001521_admin_site_scope 가 이 함수를 다시 쓰면서
-- 전화번호 조건만 position() 으로 되돌렸다(해당 마이그레이션 전체에서 유일한 `position(` 이고,
-- 나머지 9곳은 모두 LIKE 로 옳게 남아 있다. admin_members_page 도 LIKE 를 유지했다).
--
-- 한 가지가 통째로 느려지는 이유 — OR 묶음 안에 인덱스를 못 쓰는 가지가 **하나라도** 있으면
-- 비트맵 OR 자체가 성립하지 않는다. 즉 전화번호 한 조건 때문에 이름·아이디 검색까지 같이
-- 순차 스캔이 된다.
--
-- 실측(PG16, members 200,000행 재현 환경, 같은 세션 12회 반복):
--   position() 형태 : 52 ~ 60 ms  (매 호출 전체 스캔)
--   LIKE 형태       :  1.1 ~ 2.2 ms
-- 약 48배. 이 함수는 결제 > 수기결제의 회원 검색이 쓴다.
--
-- 시그니처·권한·RLS·사이트 조건은 그대로다. 바뀌는 것은 전화번호 조건 한 줄뿐이다.

CREATE OR REPLACE FUNCTION public.admin_member_search(p_term text DEFAULT ''::text, p_limit integer DEFAULT 20, p_source_site text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_source_site);
BEGIN
  RETURN (
select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
from (
  select m.id, m.name, m.user_id, m.phone, m.grade
  from members m
  where (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
    and (nullif(btrim(p_term), '') is null
    or lower(m.name) like '%' || lower(p_term) || '%'
    or lower(m.user_id) like '%' || lower(p_term) || '%'
    or (
      nullif(regexp_replace(p_term, '\D', '', 'g'), '') is not null
      -- members_phone_digits_trgm_idx 가 받는 형태는 LIKE 뿐이다. position() 으로 바꾸지 말 것(0018).
      and regexp_replace(m.phone, '\D', '', 'g') like '%' || regexp_replace(p_term, '\D', '', 'g') || '%'
    )
    )
  order by m.registered_at desc, m.id asc
  limit greatest(1, least(coalesce(p_limit, 20), 50))
) x
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_member_search(text,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_member_search(text,integer,text) TO authenticated, service_role;
