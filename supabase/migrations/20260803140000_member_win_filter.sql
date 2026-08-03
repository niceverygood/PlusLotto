-- <당첨자 조회> 이용자에서 회차별/등수별 필터링 (현장 피드백 8/3, 정의현 차장)
-- admin_members_page 에 winRound/winRank 필터 추가. meta.win_records(회차별 당첨이력, D96)를
-- 조회해 winRound·winRank 가 함께 걸리면 같은 당첨건(round_no·rank 동시일치)만 통과시킨다.

create or replace function public.admin_members_page(
  p_filter jsonb default '{}'::jsonb,
  p_offset integer default 0,
  p_limit integer default 50,
  p_sort_id text default null,
  p_sort_desc boolean default true,
  p_assigned_staff_id text default null
) returns jsonb
language sql stable security invoker set search_path = public as $$
with filtered as not materialized (
  select m.*
  from members m
  where (p_assigned_staff_id is null or m.assigned_staff_id = p_assigned_staff_id)
    and (not (p_filter ? 'status') or m.status::text = p_filter->>'status')
    and (not (p_filter ? 'grade') or m.grade::text = p_filter->>'grade')
    and (
      not (p_filter ? 'gradeIn')
      or exists (
        select 1 from jsonb_array_elements_text(p_filter->'gradeIn') g(value)
        where g.value = m.grade::text
      )
    )
    and (
      not (p_filter ? 'hasStaff')
      or (m.assigned_staff_id is not null) = ((p_filter->>'hasStaff')::boolean)
    )
    and (not (p_filter ? 'assignedStaffId') or m.assigned_staff_id = p_filter->>'assignedStaffId')
    and (
      not (p_filter ? 'staffRole')
      or exists (
        select 1 from staff s
        where s.id = m.assigned_staff_id and s.role::text = p_filter->>'staffRole'
      )
    )
    and (not (p_filter ? 'is_suspended') or m.is_suspended = ((p_filter->>'is_suspended')::boolean))
    and (not (p_filter ? 'is_deleted') or m.is_deleted = ((p_filter->>'is_deleted')::boolean))
    and (not (p_filter ? 'is_withdrawn') or m.is_withdrawn = ((p_filter->>'is_withdrawn')::boolean))
    and (not (p_filter ? 'hasWin') or nullif(btrim(coalesce(m.win_history, '')), '') is not null)
    and (
      not (p_filter ? 'winRound') and not (p_filter ? 'winRank')
      or exists (
        select 1 from jsonb_array_elements(coalesce(m.meta->'win_records', '[]'::jsonb)) w
        where (not (p_filter ? 'winRound') or (w->>'round_no')::numeric = (p_filter->>'winRound')::numeric)
          and (not (p_filter ? 'winRank') or (w->>'rank')::numeric = (p_filter->>'winRank')::numeric)
      )
    )
    and (not (p_filter ? 'hasMemo') or nullif(btrim(coalesce(m.memo, '')), '') is not null)
    and (not (p_filter ? 'outcall') or m.outcall_done = ((p_filter->>'outcall')::boolean))
    and (not (p_filter ? 'tendency') or m.tendency = p_filter->>'tendency')
    and (not (p_filter ? 'inflowCode') or m.inflow_code = p_filter->>'inflowCode')
    and (not (p_filter ? 'inflowType') or m.inflow_type = p_filter->>'inflowType')
    and (not (p_filter ? 'consultStatus') or m.consult_status = p_filter->>'consultStatus')
    and (
      not coalesce((p_filter->>'registeredToday')::boolean, false)
      or (m.registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
    )
    and (
      not (p_filter ? 'registeredFrom')
      or (m.registered_at at time zone 'Asia/Seoul')::date >= (p_filter->>'registeredFrom')::date
    )
    and (
      not (p_filter ? 'registeredTo')
      or (m.registered_at at time zone 'Asia/Seoul')::date <= (p_filter->>'registeredTo')::date
    )
    and (
      not coalesce((p_filter->>'dupPhone')::boolean, false)
      or m.meta @> '{"dup_phone":true}'::jsonb
      or (
        nullif(regexp_replace(m.phone, '\D', '', 'g'), '') is not null
        and (
          select count(*) from members d
          where regexp_replace(d.phone, '\D', '', 'g') = regexp_replace(m.phone, '\D', '', 'g')
        ) > 1
      )
    )
    and (
      not (p_filter ? 'inactiveDays')
      or m.last_active_at is null
      or m.last_active_at <= now() - make_interval(days => (p_filter->>'inactiveDays')::integer)
    )
    and (
      not (p_filter ? 'dupInflow')
      or (
        m.inflow_code is not null
        and (
          select count(*) from members d
          where d.inflow_code = m.inflow_code
            and (
              p_filter->>'dupInflow' = 'all'
              or (d.registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
            )
        ) > 1
      )
    )
    and (
      not coalesce((p_filter->>'retry')::boolean, false)
      or (m.outcall_done and m.grade::text in ('free','simple'))
    )
    and (
      nullif(btrim(coalesce(p_filter->>'search', '')), '') is null
      or position(lower(p_filter->>'search') in lower(m.user_id)) > 0
      or position(lower(p_filter->>'search') in lower(m.name)) > 0
      or position(lower(p_filter->>'search') in lower(coalesce(m.nickname, ''))) > 0
      or (
        nullif(regexp_replace(p_filter->>'search', '\D', '', 'g'), '') is not null
        and position(
          regexp_replace(p_filter->>'search', '\D', '', 'g')
          in regexp_replace(m.phone, '\D', '', 'g')
        ) > 0
      )
    )
), page_rows as (
  select f.*
  from filtered f
  order by
    case when p_sort_id = 'name' and not p_sort_desc then f.name end asc nulls last,
    case when p_sort_id = 'name' and p_sort_desc then f.name end desc nulls last,
    case when p_sort_id = 'user_id' and not p_sort_desc then f.user_id end asc nulls last,
    case when p_sort_id = 'user_id' and p_sort_desc then f.user_id end desc nulls last,
    case when p_sort_id = 'grade' and not p_sort_desc then f.grade::text end asc nulls last,
    case when p_sort_id = 'grade' and p_sort_desc then f.grade::text end desc nulls last,
    case when p_sort_id = 'status' and not p_sort_desc then f.status::text end asc nulls last,
    case when p_sort_id = 'status' and p_sort_desc then f.status::text end desc nulls last,
    case when p_sort_id = 'registered_at' and not p_sort_desc then f.registered_at end asc nulls last,
    case when p_sort_id = 'registered_at' and p_sort_desc then f.registered_at end desc nulls last,
    case when p_sort_id = 'last_active_at' and not p_sort_desc then f.last_active_at end asc nulls last,
    case when p_sort_id = 'last_active_at' and p_sort_desc then f.last_active_at end desc nulls last,
    f.registered_at desc,
    f.id asc
  offset greatest(0, p_offset)
  limit greatest(1, least(coalesce(p_limit, 50), 1000))
)
select jsonb_build_object(
  'rows', coalesce((select jsonb_agg(to_jsonb(p)) from page_rows p), '[]'::jsonb),
  'total', (select count(*) from filtered)
);
$$;
