-- 전화번호 기준 중복 DB 입력 차단 + 기존 DB 중복 표식 (현장 7/22, 정의현 차장)
-- - 숫자만 남긴 전화번호가 이미 있으면 새 members 행을 만들지 않는다.
-- - 기존 회원 meta에 중복 시도 횟수/최근 시각을 기록해 '중복 DB' 필터에 노출한다.
-- - advisory xact lock으로 단건·엑셀·동시 요청 모두 같은 전화번호를 원자적으로 처리한다.
-- - 과거에 이미 생성된 중복행은 병합/삭제하지 않고 기존 count 기반 필터로 계속 노출한다.

create index if not exists members_dup_phone_marked_idx
  on public.members (registered_at desc)
  where meta @> '{"dup_phone":true}'::jsonb;

create or replace function public.enforce_member_admin_ops() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_phone text;
  v_existing_id text;
  v_actor text;
begin
  if tg_op = 'INSERT' then
    -- 시스템 경로(service_role/SQL Editor)는 권한 검사만 면제하고 중복 차단은 동일 적용한다.
    if auth.uid() is not null and app_role() is distinct from 'admin' then
      raise exception '회원 입력(디비 입력)은 최고관리자만 가능합니다';
    end if;

    v_phone := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
    if v_phone <> '' then
      -- 같은 전화번호의 동시 INSERT가 모두 검사 전에 통과하는 경쟁조건을 차단한다.
      perform pg_advisory_xact_lock(hashtextextended(v_phone, 0));

      select m.id
      into v_existing_id
      from public.members m
      where regexp_replace(coalesce(m.phone, ''), '\D', '', 'g') = v_phone
      order by
        (not m.is_deleted and not m.is_withdrawn) desc,
        m.registered_at asc,
        m.id asc
      limit 1
      for update;

      if v_existing_id is not null then
        update public.members m
        set meta = coalesce(m.meta, '{}'::jsonb) || jsonb_build_object(
          'dup_phone', true,
          'duplicate_attempt_count', coalesce(
            case
              when jsonb_typeof(m.meta->'duplicate_attempt_count') = 'number'
                then (m.meta->>'duplicate_attempt_count')::integer
              else 0
            end,
            0
          ) + 1,
          'duplicate_last_at', now(),
          'duplicate_last_source', case
            when coalesce((new.meta->>'imported')::boolean, false) then 'bulk_import'
            else 'manual'
          end,
          'duplicate_last_inflow_code', new.inflow_code,
          'duplicate_last_inflow_type', new.inflow_type
        )
        where m.id = v_existing_id;

        v_actor := case when auth.uid() is null then null else app_staff_id() end;
        insert into public.logs(id, kind, actor, action, target_type, target_id, meta, created_at)
        values (
          'log_' || replace(gen_random_uuid()::text, '-', ''),
          'inflow',
          v_actor,
          'member.duplicate_rejected',
          'member',
          v_existing_id,
          jsonb_build_object(
            'phone_last4', right(v_phone, 4),
            'attempted_name', new.name,
            'source', case
              when coalesce((new.meta->>'imported')::boolean, false) then 'bulk_import'
              else 'manual'
            end,
            'inflow_code', new.inflow_code,
            'inflow_type', new.inflow_type
          ),
          now()
        );

        -- BEFORE INSERT에서 NULL 반환 → 신규 회원행을 만들지 않는다.
        return null;
      end if;
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.assigned_staff_id is distinct from old.assigned_staff_id
        or new.team_id is distinct from old.team_id)
       and auth.uid() is not null
       and app_role() is distinct from 'admin' then
      raise exception '담당자 변경(디비 배분)은 최고관리자만 가능합니다';
    end if;
  end if;
  return new;
end;
$$;

-- 신규 차단 뒤에는 한 행만 남으므로 기존 count>1 조건과 meta.dup_phone 표식을 함께 본다.
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
