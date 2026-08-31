-- D175 후속: 회원 INSERT 중복검사가 기존 members_phone_digits_idx를 타지 못해
-- 신규 1행마다 전체 회원을 순차 스캔하던 성능 회귀를 수정한다.
-- members.phone은 NOT NULL이므로 조회식의 coalesce 제거는 의미를 바꾸지 않는다.

do $$
declare
  definition text := pg_get_functiondef('public.enforce_member_admin_ops()'::regprocedure);
  old_lookup constant text := $anchor$where regexp_replace(coalesce(m.phone, ''), '\D', '', 'g') = v_phone$anchor$;
  new_lookup constant text := $replacement$where regexp_replace(m.phone, '\D', '', 'g') = v_phone$replacement$;
begin
  if position(new_lookup in definition) = 0 then
    if position(old_lookup in definition) = 0 then
      raise exception 'enforce_member_admin_ops phone lookup anchor was not found';
    end if;
    definition := replace(definition, old_lookup, new_lookup);
    execute definition;
  end if;
end $$;

-- 트리거 전용 함수는 REST RPC로 직접 호출할 이유가 없다.
revoke execute on function public.enforce_member_admin_ops() from public, anon, authenticated;
