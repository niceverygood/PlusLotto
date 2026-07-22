-- 0018 — 0016 RPC의 부분검색을 pg_trgm 인덱스가 지원하는 LIKE 식으로 교체
-- 함수 전체를 복제하지 않고 직전 마이그레이션의 정의를 안전하게 치환한다.

do $migration$
declare
  original_def text;
  next_def text;
begin
  select pg_get_functiondef('admin_members_page(jsonb,integer,integer,text,boolean,text)'::regprocedure)
    into original_def;
  next_def := original_def;
  next_def := replace(next_def,
    $old$position(lower(p_filter->>'search') in lower(m.user_id)) > 0$old$,
    $new$lower(m.user_id) like '%' || lower(p_filter->>'search') || '%'$new$);
  next_def := replace(next_def,
    $old$position(lower(p_filter->>'search') in lower(m.name)) > 0$old$,
    $new$lower(m.name) like '%' || lower(p_filter->>'search') || '%'$new$);
  next_def := replace(next_def,
    $old$position(lower(p_filter->>'search') in lower(coalesce(m.nickname, ''))) > 0$old$,
    $new$lower(coalesce(m.nickname, '')) like '%' || lower(p_filter->>'search') || '%'$new$);
  next_def := replace(next_def,
    $old$position(
          regexp_replace(p_filter->>'search', '\\D', '', 'g')
          in regexp_replace(m.phone, '\\D', '', 'g')
        ) > 0$old$,
    $new$regexp_replace(m.phone, '\\D', '', 'g') like '%' || regexp_replace(p_filter->>'search', '\\D', '', 'g') || '%'$new$);
  if next_def = original_def then
    raise exception 'admin_members_page search expression was not replaced';
  end if;
  execute next_def;

  select pg_get_functiondef('admin_member_search(text,integer)'::regprocedure)
    into original_def;
  next_def := original_def;
  next_def := replace(next_def,
    $old$position(lower(p_term) in lower(m.name)) > 0$old$,
    $new$lower(m.name) like '%' || lower(p_term) || '%'$new$);
  next_def := replace(next_def,
    $old$position(lower(p_term) in lower(m.user_id)) > 0$old$,
    $new$lower(m.user_id) like '%' || lower(p_term) || '%'$new$);
  next_def := replace(next_def,
    $old$position(regexp_replace(p_term, '\\D', '', 'g') in regexp_replace(m.phone, '\\D', '', 'g')) > 0$old$,
    $new$regexp_replace(m.phone, '\\D', '', 'g') like '%' || regexp_replace(p_term, '\\D', '', 'g') || '%'$new$);
  if next_def = original_def then
    raise exception 'admin_member_search expression was not replaced';
  end if;
  execute next_def;

  select pg_get_functiondef('admin_payments_page(jsonb,integer,integer,text,boolean)'::regprocedure)
    into original_def;
  next_def := original_def;
  next_def := replace(next_def,
    $old$position(lower(p_filter->>'search') in lower(m.name)) > 0$old$,
    $new$lower(m.name) like '%' || lower(p_filter->>'search') || '%'$new$);
  next_def := replace(next_def,
    $old$position(lower(p_filter->>'search') in lower(m.user_id)) > 0$old$,
    $new$lower(m.user_id) like '%' || lower(p_filter->>'search') || '%'$new$);
  next_def := replace(next_def,
    $old$position(lower(p_filter->>'search') in lower(coalesce(p.depositor_name, ''))) > 0$old$,
    $new$lower(coalesce(p.depositor_name, '')) like '%' || lower(p_filter->>'search') || '%'$new$);
  if next_def = original_def then
    raise exception 'admin_payments_page search expression was not replaced';
  end if;
  execute next_def;
end
$migration$;
