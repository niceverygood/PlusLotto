-- D51/D55에서 실장(leader)의 회원 및 종속데이터 조회 범위는 전체로 확정됐다.
-- 0016 성능 RPC가 이전 팀 스코프를 다시 삽입해 team_id가 없는 실장에게
-- 매출·대시보드·뱃지·통계·상담 집계를 모두 0건으로 반환하는 회귀를 바로잡는다.

do $$
declare
  target regprocedure;
  definition text;
  old_scope constant text := E'where c.role in (''admin'',''manager'')\n    or (c.role = ''leader'' and m.team_id = c.team_id)';
  new_scope constant text := 'where c.role in (''admin'',''manager'',''leader'')';
begin
  foreach target in array array[
    'admin_dashboard()'::regprocedure,
    'admin_nav_badges()'::regprocedure,
    'admin_revenue(text,date,date,text)'::regprocedure,
    'admin_stats_snapshot(text,date,date)'::regprocedure,
    'admin_consult_report(text,text,date,date)'::regprocedure
  ] loop
    definition := pg_get_functiondef(target);

    if position(old_scope in definition) = 0 then
      raise exception 'legacy leader scope was not found in %', target;
    end if;

    execute replace(definition, old_scope, new_scope);
  end loop;
end $$;

-- 함수 소유자/실행권한·security invoker 속성은 CREATE OR REPLACE로 보존된다.
-- 그래도 공개 실행권한이 생기지 않도록 회귀 방어를 명시한다.
revoke execute on function admin_dashboard() from public, anon;
revoke execute on function admin_nav_badges() from public, anon;
revoke execute on function admin_revenue(text, date, date, text) from public, anon;
revoke execute on function admin_stats_snapshot(text, date, date) from public, anon;
revoke execute on function admin_consult_report(text, text, date, date) from public, anon;

grant execute on function admin_dashboard() to authenticated;
grant execute on function admin_nav_badges() to authenticated;
grant execute on function admin_revenue(text, date, date, text) to authenticated;
grant execute on function admin_stats_snapshot(text, date, date) to authenticated;
grant execute on function admin_consult_report(text, text, date, date) to authenticated;
