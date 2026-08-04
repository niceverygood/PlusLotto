-- 긴급: 중복 DB 필터링 복구 (현장 피드백 8/4 오전, 정의현 차장 — "중복디비 필터링이 안되고 있습니다")
--
-- 원인: 20260803140000_member_win_filter.sql 이 admin_members_page 를 20260722 시점의 전체 본문으로
-- 재정의하면서, 그 사이에 들어간 두 개의 부분 패치를 되돌렸다.
--   ① 20260723000340 — dupPhone 필터를 meta.dup_phone 표식만 보도록 교체 + duplicate_last_at 정렬.
--      되돌아간 count(*)>1 상관 서브쿼리는 행마다 regexp 전화번호 전수 카운트 → 15만 회원 규모에서
--      statement timeout → '중복 DB' 화면이 비거나 실패 = "필터링이 안되고 있습니다".
--      유입구분 canonical_inflow_type 비교도 함께 유실.
--   ② 0018 — position() 부분검색을 pg_trgm 인덱스를 타는 LIKE 식으로 교체.
--
-- ★ 주의(다음 편집자): 이 함수는 부분 패치가 누적된 함수다. 필터 하나를 추가할 때는 전체 본문을
--   과거 마이그레이션에서 복사하지 말고, 이 파일(최신 전체 정의)을 기준으로 수정하거나
--   20260723000340 처럼 pg_get_functiondef + replace 앵커 방식으로 해당 조건만 치환할 것.
--   이 정의가 포함하는 패치: 0016(본문) + 0018(LIKE 검색) + 20260722(dupPhone)
--   + 20260723000340(meta-only dupPhone·canonical inflow·중복정렬) + 20260803140000(winRound/winRank).

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
    and (not (p_filter ? 'inflowType') or public.canonical_inflow_type(m.inflow_type) = public.canonical_inflow_type(p_filter->>'inflowType'))
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
      or lower(m.user_id) like '%' || lower(p_filter->>'search') || '%'
      or lower(m.name) like '%' || lower(p_filter->>'search') || '%'
      or lower(coalesce(m.nickname, '')) like '%' || lower(p_filter->>'search') || '%'
      or (
        nullif(regexp_replace(p_filter->>'search', '\D', '', 'g'), '') is not null
        and regexp_replace(m.phone, '\D', '', 'g') like '%' || regexp_replace(p_filter->>'search', '\D', '', 'g') || '%'
      )
    )
), page_rows as (
  select f.*
  from filtered f
  order by
    case when coalesce((p_filter->>'dupPhone')::boolean, false) then f.meta->>'duplicate_last_at' end desc nulls last,
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

revoke execute on function public.admin_members_page(jsonb, integer, integer, text, boolean, text)
  from public, anon;
grant execute on function public.admin_members_page(jsonb, integer, integer, text, boolean, text)
  to authenticated;

-- 재발 방지 백필: D127 배포(8/3) 이후 트리거가 표식한 행은 meta 에 이미 기록되어 있어 손실이 없다.
-- 혹시 그 사이 물리 중복행이 생겼다면(트리거 우회 경로 등) 표식을 한 번 더 보정한다. 멱등.
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
where regexp_replace(m.phone, '\D', '', 'g') = d.phone_key
  and not (m.meta @> '{"dup_phone":true}'::jsonb);
