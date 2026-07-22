-- 0019 — 결제 목록 상품등급 필터(실버/골드/다이아 매출 구분)
-- 0016 admin_payments_page 정의에 products.grade_granted 조건만 추가한다.

do $migration$
declare
  original_def text;
  next_def text;
  anchor text := $anchor$    and (not (p_filter ? 'pg') or p.pg_provider = p_filter->>'pg')$anchor$;
begin
  select pg_get_functiondef('admin_payments_page(jsonb,integer,integer,text,boolean)'::regprocedure)
    into original_def;
  next_def := replace(
    original_def,
    anchor,
    anchor || E'\n    and (not (p_filter ? ''grade'') or pr.grade_granted::text = p_filter->>''grade'')'
  );
  if next_def = original_def then
    raise exception 'admin_payments_page grade filter anchor was not found';
  end if;
  execute next_def;
end
$migration$;
