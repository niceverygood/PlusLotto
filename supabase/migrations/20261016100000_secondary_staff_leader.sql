-- 2차담당자 변경 권한을 실장 이상으로 넓힌다 (현장 10/16, 정의현 차장 —
-- "실장급 아이디 권한에서 2차담당자 변경할 수 있도록 수정 부탁드립니다").
--
-- 10/14(20261014130000)에는 2차담당자도 1차와 같이 최고관리자만 바꿀 수 있었다. 이제
--  · 1차담당(assigned_staff_id)·팀(team_id) 변경 = 그대로 최고관리자만(디비 배분, D55)
--  · 2차담당(secondary_staff_id) 변경 = 실장(leader)·관리자(manager)·최고관리자(admin)
-- 팀장(rep)은 RLS 상 본인 담당 회원을 수정할 수 있으므로 이 트리거가 2차담당 변경을 막는다.
-- 앱의 같은 기준은 lib/permissions.ts canAssignSecondaryStaff — 범위를 바꾸면 양쪽을 함께 고친다.
-- 현재 정의(20261014130000)를 그대로 옮기고 UPDATE 분기만 둘로 나눴다.

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
        or new.team_id is distinct from old.team_id)
       and auth.uid() is not null
       and app_role() is distinct from 'admin' then
      raise exception '담당자 변경(디비 배분)은 최고관리자만 가능합니다';
    end if;
    -- 2차담당자(실장)는 실장 이상이 바꾼다(현장 10/16). 역할 없음(NULL)도 막는다.
    if new.secondary_staff_id is distinct from old.secondary_staff_id
       and auth.uid() is not null
       and coalesce(app_role()::text, '') not in ('admin', 'manager', 'leader') then
      raise exception '2차담당자 변경은 실장 이상만 가능합니다';
    end if;
  end if;
  return new;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.enforce_member_admin_ops() FROM PUBLIC, anon, authenticated;
