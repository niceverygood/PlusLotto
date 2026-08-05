-- 결제 목록에 전화번호 노출 (현장 피드백 8/4, 정의현 차장 — "결제>이용자 목록에도 전화번호
-- 보일수 있도록"). admin_payments_page / admin_payment_detail 이 내려주는 member 객체에 phone 추가.
--
-- ★ 전체 본문 재정의 대신 앵커 치환(pg_get_functiondef + replace)을 쓴다 — D130 사고(D127 이
-- admin_members_page 를 옛 본문으로 통째로 재정의해 그 사이 성능 패치를 되돌린 회귀) 재발 방지.
-- admin_payments_page 에는 0018(LIKE 부분검색)·0019/0022(등급 필터) 패치가 누적돼 있어,
-- 여기서 본문을 복사해오면 그 패치들이 사라진다. 아래는 member jsonb 한 줄만 바꾼다.

do $migration$
declare
  original_def text;
  next_def text;
  old_member constant text :=
    $old$jsonb_build_object('id', m.id, 'name', m.name, 'user_id', m.user_id, 'inflow_code', m.inflow_code) as member$old$;
  new_member constant text :=
    $new$jsonb_build_object('id', m.id, 'name', m.name, 'user_id', m.user_id, 'inflow_code', m.inflow_code, 'phone', m.phone) as member$new$;
begin
  -- ① 목록
  select pg_get_functiondef('public.admin_payments_page(jsonb,integer,integer,text,boolean)'::regprocedure)
    into original_def;
  if position(old_member in original_def) = 0 then
    -- 이미 phone 이 들어가 있으면(재실행) 조용히 통과, 아니면 앵커 불일치로 중단.
    if position(new_member in original_def) = 0 then
      raise exception 'admin_payments_page member anchor was not found';
    end if;
  else
    next_def := replace(original_def, old_member, new_member);
    execute next_def;
  end if;

  -- ② 상세(결제 Drawer)
  select pg_get_functiondef('public.admin_payment_detail(text)'::regprocedure)
    into original_def;
  if position(old_member in original_def) = 0 then
    if position(new_member in original_def) = 0 then
      raise exception 'admin_payment_detail member anchor was not found';
    end if;
  else
    next_def := replace(original_def, old_member, new_member);
    execute next_def;
  end if;
end
$migration$;

revoke execute on function public.admin_payments_page(jsonb, integer, integer, text, boolean) from public, anon;
revoke execute on function public.admin_payment_detail(text) from public, anon;
grant execute on function public.admin_payments_page(jsonb, integer, integer, text, boolean) to authenticated;
grant execute on function public.admin_payment_detail(text) to authenticated;
