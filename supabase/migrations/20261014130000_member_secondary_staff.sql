-- 회원 2차담당자 (현장 10/14, 정의현 차장 — "회원 담당자를 1차담당자, 2차담당자 2명 지정. 1차=팀장, 2차=실장,
-- 우선순위는 1차. 필터링에서도 2차담당자로 검색. 1차/2차 담당자의 궁합 파악").
--
-- 1) members.secondary_staff_id — 2차담당자(실장). 1차(assigned_staff_id)는 그대로 우선 담당이며
--    가시성(RLS)·나의고객·매출 귀속·자동배분은 바뀌지 않는다. 실장은 이미 전 회원을 보므로 RLS 변경이 없다.
-- 2) enforce_member_admin_ops — 2차담당자 변경도 1차와 같이 최고관리자만(D55). 현재 정의를 그대로 옮기고
--    조건 한 줄만 더했다.
-- 3) admin_members_page — p_filter 에 secondaryStaffId / hasSecondary 필터 추가(시그니처 변경 없음).
--    현재 정의(20261008160000)를 그대로 옮기고 조건만 더했다. 행은 to_jsonb 라 새 컬럼이 자동으로 실린다.
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS secondary_staff_id text REFERENCES public.staff(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS members_secondary_staff_idx
  ON public.members (secondary_staff_id) WHERE secondary_staff_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_member_admin_ops()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- 검증된 서비스 전용 원자 이관만 동일 번호의 별도 계약을 보존한다.
    -- 직원은 같은 트랜잭션 설정값을 직접 넣어도 service_role이 아니므로 통과할 수 없다.
    if current_setting('role', true) = 'service_role'
       and current_setting('app.lotto815_collision_batch', true) = new.meta->>'import_batch'
       and new.meta->>'import_batch' ~ '^lotto815-collision-[A-Za-z0-9._-]{1,40}$'
       and new.meta->>'source_site' = 'lotto815'
       and new.meta->'reco_paused' = 'true'::jsonb
       and new.meta->>'reco_pause_reason' = 'legacy_import_review' then
      return new;
    end if;
    if auth.uid() is not null and public.member_operating_site(new) = 'lotto815' then
      raise exception '이전 사이트는 신규가입 대신 검증된 이관 경로를 이용해야 합니다';
    end if;

    v_phone := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
    if v_phone <> '' then
      -- 같은 전화번호의 동시 INSERT가 모두 검사 전에 통과하는 경쟁조건을 차단한다.
      perform pg_advisory_xact_lock(hashtextextended(v_phone, 0));

      select m.id
      into v_existing_id
      from public.members m
      where regexp_replace(m.phone, '\D', '', 'g') = v_phone
        and public.member_operating_site(m) = public.member_operating_site(new)
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
        or new.team_id is distinct from old.team_id
        or new.secondary_staff_id is distinct from old.secondary_staff_id)
       and auth.uid() is not null
       and app_role() is distinct from 'admin' then
      raise exception '담당자 변경(디비 배분)은 최고관리자만 가능합니다';
    end if;
  end if;
  return new;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.enforce_member_admin_ops() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_members_page(p_filter jsonb DEFAULT '{}'::jsonb, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50, p_sort_id text DEFAULT NULL::text, p_sort_desc boolean DEFAULT true, p_assigned_staff_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
 SET random_page_cost TO '1.1'
AS $function$
DECLARE
  v_source_site text := public.admin_validate_source_site(p_filter->>'sourceSite');
  v_role public.role := public.app_role();
  v_staff_id text := public.app_staff_id();
BEGIN
  -- DEFINER 는 RLS 를 우회하므로 로그인·역할이 없으면 즉시 거부한다(20260911040000 결제 목록과 같은 방식).
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'insufficient privilege for members';
  END IF;
  RETURN (
with filtered as not materialized (
  select m.*
  from public.members m
  -- RLS(members_rw)가 하던 가시성: admin·manager·leader 전체 / rep 본인 담당.
  where (v_role::text <> 'rep' or m.assigned_staff_id = v_staff_id)
    and (p_assigned_staff_id is null or m.assigned_staff_id = p_assigned_staff_id)
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
    and (not (p_filter ? 'secondaryStaffId') or m.secondary_staff_id = p_filter->>'secondaryStaffId')
    and (
      not (p_filter ? 'hasSecondary')
      or (m.secondary_staff_id is not null) = ((p_filter->>'hasSecondary')::boolean)
    )
    and (
      not (p_filter ? 'staffRole')
      or exists (
        select 1 from public.staff s
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
    and (v_source_site IS NULL OR coalesce(nullif(btrim(m.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
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
          select count(*) from public.members d
          where d.inflow_code = m.inflow_code
            and (v_role::text <> 'rep' or d.assigned_staff_id = v_staff_id)
            and (v_source_site IS NULL OR coalesce(nullif(btrim(d.meta->>'source_site'), ''), 'pluslotto') = v_source_site)
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
)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_members_page(jsonb,integer,integer,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_members_page(jsonb,integer,integer,text,boolean,text) TO authenticated, service_role;
