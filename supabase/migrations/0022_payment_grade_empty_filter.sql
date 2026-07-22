-- 0022 — 결제 등급 필터가 미선택('')일 때 전체 결제를 반환한다.
-- 0019는 JSON key 존재 여부만 검사해 { grade: '' } 요청을 실제 빈 등급 조건으로 처리했다.

do $migration$
declare
  original_def text;
  next_def text;
  anchor text := $anchor$and (not (p_filter ? 'grade') or pr.grade_granted::text = p_filter->>'grade')$anchor$;
begin
  select pg_get_functiondef('admin_payments_page(jsonb,integer,integer,text,boolean)'::regprocedure)
    into original_def;
  next_def := replace(
    original_def,
    anchor,
    $replacement$and (coalesce(p_filter->>'grade', '') = '' or pr.grade_granted::text = p_filter->>'grade')$replacement$
  );
  if next_def = original_def then
    raise exception 'admin_payments_page grade filter anchor was not found';
  end if;
  execute next_def;
end
$migration$;
