-- 유입구분 공백 표기 정규화 + 중복 DB 최신 입력순/성능 개선 (운영 7/23)

create or replace function public.canonical_inflow_type(p_value text) returns text
language sql immutable strict parallel safe security invoker
set search_path = pg_catalog
as $$
  select case regexp_replace(btrim(p_value), '\s', '', 'g')
    when '신규' then '신규'
    when '하루전부재' then '하루전부재'
    when '하루전거절' then '하루전거절'
    when '이틀전' then '이틀전'
    when '삼일전' then '삼일전'
    when '구디비' then '구디비'
    else btrim(p_value)
  end;
$$;

revoke execute on function public.canonical_inflow_type(text) from public, anon;
grant execute on function public.canonical_inflow_type(text) to authenticated, service_role;

create or replace function public.normalize_member_inflow_type_trigger() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  new.inflow_type := public.canonical_inflow_type(new.inflow_type);
  return new;
end;
$$;

revoke execute on function public.normalize_member_inflow_type_trigger() from public, anon, authenticated;

drop trigger if exists members_00_normalize_inflow_type on public.members;
create trigger members_00_normalize_inflow_type
before insert or update of inflow_type on public.members
for each row execute function public.normalize_member_inflow_type_trigger();

-- 현재 운영 데이터의 '하루전 부재/거절'처럼 공백만 다른 값을 표준 라벨로 합친다.
update public.members
set inflow_type = public.canonical_inflow_type(inflow_type)
where inflow_type is distinct from public.canonical_inflow_type(inflow_type);

create index if not exists members_inflow_type_canonical_registered_idx
  on public.members (public.canonical_inflow_type(inflow_type), registered_at desc);

-- 과거 물리 중복행을 1회 표식해 이후 화면 조회마다 전화번호 전체를 다시 세지 않게 한다.
with latest_rejections as (
  select target_id, max(created_at) as duplicate_at
  from public.logs
  where action = 'member.duplicate_rejected' and target_id is not null
  group by target_id
)
update public.members m
set meta = coalesce(m.meta, '{}'::jsonb) || jsonb_build_object(
  'dup_phone', true,
  'duplicate_last_at', r.duplicate_at
)
from latest_rejections r
where r.target_id = m.id
  and not (coalesce(m.meta, '{}'::jsonb) ? 'duplicate_last_at');

with duplicate_groups as (
  select regexp_replace(phone, '\D', '', 'g') as phone_key,
    max(registered_at) as duplicate_at
  from public.members
  where nullif(regexp_replace(phone, '\D', '', 'g'), '') is not null
  group by 1
  having count(*) > 1
)
update public.members m
set meta = coalesce(m.meta, '{}'::jsonb) || jsonb_build_object(
  'dup_phone', true,
  'duplicate_last_at', greatest(
    coalesce((m.meta->>'duplicate_last_at')::timestamptz, '-infinity'::timestamptz),
    d.duplicate_at
  )
)
from duplicate_groups d
where regexp_replace(m.phone, '\D', '', 'g') = d.phone_key;

-- 예전 앱 표식만 있고 정확한 중복 로그가 없는 행은 가입일시를 보수적 폴백으로 사용한다.
update public.members
set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('duplicate_last_at', registered_at)
where meta @> '{"dup_phone":true}'::jsonb
  and not (meta ? 'duplicate_last_at');

create index if not exists members_duplicate_last_at_idx
  on public.members ((meta->>'duplicate_last_at') desc, id)
  where meta @> '{"dup_phone":true}'::jsonb;

-- 기존 admin_members_page 본문은 유지하고 세 개의 확정된 조건만 원자적으로 교체한다.
do $$
declare
  definition text := pg_get_functiondef(
    'public.admin_members_page(jsonb,integer,integer,text,boolean,text)'::regprocedure
  );
  old_inflow constant text := 'and (not (p_filter ? ''inflowType'') or m.inflow_type = p_filter->>''inflowType'')';
  new_inflow constant text := 'and (not (p_filter ? ''inflowType'') or public.canonical_inflow_type(m.inflow_type) = public.canonical_inflow_type(p_filter->>''inflowType''))';
  old_duplicate constant text := E'and (\n      not coalesce((p_filter->>''dupPhone'')::boolean, false)\n      or m.meta @> ''{"dup_phone":true}''::jsonb\n      or (\n        nullif(regexp_replace(m.phone, ''\\D'', '''', ''g''), '''') is not null\n        and (\n          select count(*) from members d\n          where regexp_replace(d.phone, ''\\D'', '''', ''g'') = regexp_replace(m.phone, ''\\D'', '''', ''g'')\n        ) > 1\n      )\n    )';
  new_duplicate constant text := E'and (\n      not coalesce((p_filter->>''dupPhone'')::boolean, false)\n      or m.meta @> ''{"dup_phone":true}''::jsonb\n    )';
  old_order constant text := E'order by\n    case when p_sort_id = ''name''';
  new_order constant text := E'order by\n    case when coalesce((p_filter->>''dupPhone'')::boolean, false) then f.meta->>''duplicate_last_at'' end desc nulls last,\n    case when p_sort_id = ''name''';
begin
  if position(old_inflow in definition) = 0 then
    raise exception 'admin_members_page inflow filter anchor was not found';
  end if;
  definition := replace(definition, old_inflow, new_inflow);

  if position(old_duplicate in definition) = 0 then
    raise exception 'admin_members_page duplicate filter anchor was not found';
  end if;
  definition := replace(definition, old_duplicate, new_duplicate);

  if position(old_order in definition) = 0 then
    raise exception 'admin_members_page order anchor was not found';
  end if;
  definition := replace(definition, old_order, new_order);

  execute definition;
end $$;

revoke execute on function public.admin_members_page(jsonb, integer, integer, text, boolean, text)
  from public, anon;
grant execute on function public.admin_members_page(jsonb, integer, integer, text, boolean, text)
  to authenticated;
