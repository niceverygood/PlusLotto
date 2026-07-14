-- 0003 — 등급별 권한 서버측 강제 (현장 피드백 v0.3 / DECISIONS D55)
-- ① 실장(leader) = 모든 이용자의 '종속 데이터'(결제·문자·배정이력)까지 전체 열람
--    (D51 마이그레이션이 members 정책만 전체로 풀고 app_can_see_member 는 팀 스코프로 남아
--     실장이 회원 329명 중 결제 41/67건만 보이던 불일치 수정)
-- ② 디비 입력(INSERT)·디비 배분/담당자 변경(assigned_staff_id·team_id UPDATE) = 최고관리자(admin)만
--    — 기존엔 UI 가드만 있고 RLS 는 manager/leader/rep 도 쓰기 허용(직접 API 호출로 우회 가능)을 트리거로 차단.
-- ③ assignments(배정 이력) 쓰기 = admin 전용, 이력은 불변(update/delete 정책 없음 → 거부).
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).
-- 주의: service_role(크론 api/weekly-reco·시드)·SQL Editor 는 auth.uid() 가 null 이라 트리거 면제.

-- ── ① 실장 = 회원 종속 데이터 전체 열람 ─────────────────────────────────
create or replace function app_can_see_member(mid text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members m
    where m.id = mid and (
      app_role() in ('admin','manager','leader')
      or (app_role() = 'rep' and m.assigned_staff_id = app_staff_id())
    )
  );
$$;

-- ── members 정책 정합(라이브 D51 leader-전체와 동일 형태로 수렴, 멱등) ────
drop policy if exists members_rw on members;
create policy members_rw on members for all to authenticated
  using (
    app_role() in ('admin','manager','leader')
    or (app_role() = 'rep' and assigned_staff_id = app_staff_id())
  )
  with check (
    app_role() in ('admin','manager','leader')
    or (app_role() = 'rep' and assigned_staff_id = app_staff_id())
  );

-- ── ② 디비 입력/배분/담당변경 = 최고관리자만 (트리거 강제) ────────────────
-- RLS 는 행 단위라 '특정 컬럼 변경만 차단'이 불가 → BEFORE 트리거로 강제.
-- 상태변경·메모·문자·회원설정 등 일반 UPDATE 는 영향 없음(담당/팀 변경시에만 검사).
create or replace function enforce_member_admin_ops() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- 시스템 경로(service_role 크론/시드, SQL Editor)는 auth.uid() 없음 → 면제.
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if app_role() is distinct from 'admin' then
      raise exception '회원 입력(디비 입력)은 최고관리자만 가능합니다';
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.assigned_staff_id is distinct from old.assigned_staff_id
        or new.team_id is distinct from old.team_id)
       and app_role() is distinct from 'admin' then
      raise exception '담당자 변경(디비 배분)은 최고관리자만 가능합니다';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists members_admin_ops on members;
create trigger members_admin_ops
  before insert or update on members
  for each row execute function enforce_member_admin_ops();

-- ── ③ 배정 이력 — 열람은 가시 회원분, 생성은 admin 만, 수정/삭제 불가 ──────
drop policy if exists assignments_rw on assignments;
drop policy if exists assignments_select on assignments;
drop policy if exists assignments_write on assignments;
create policy assignments_select on assignments for select to authenticated
  using (app_can_see_member(member_id));
create policy assignments_write on assignments for insert to authenticated
  with check (app_role() = 'admin');
