-- 플러스로또 RLS 정책 초안 (CLAUDE §5). 참조/마이그레이션용.
-- TODO(live-verify): `08 권한관리` 화면 확인 후 모듈별 경계 확정. mock 모드에서는 미적용
-- (lib/db/store.ts 로컬 계층 사용). 실 Supabase 전환 시 이 파일을 적용한다.

-- 역할 4종: admin > manager(실장) > leader(팀장) > rep(담당자)
-- 전제: auth.uid() == staff.id 매핑. staff 테이블에 role/team_id 보유.

-- 현재 로그인 staff 의 역할/팀을 꺼내는 헬퍼 ----------------------------------
create or replace function current_staff()
returns staff
language sql stable security definer
as $$
  select * from staff where id = auth.uid();
$$;

create or replace function current_role_name()
returns text
language sql stable security definer
as $$
  select role from staff where id = auth.uid();
$$;

create or replace function current_team_id()
returns text
language sql stable security definer
as $$
  select team_id from staff where id = auth.uid();
$$;

-- members: rep=본인담당 / leader=본인팀 / manager·admin=전체 -------------------
alter table members enable row level security;

create policy members_select on members
for select using (
  case current_role_name()
    when 'admin'   then true
    when 'manager' then true
    when 'leader'  then team_id = current_team_id()
    when 'rep'     then assigned_staff_id = auth.uid()
    else false
  end
);

-- 변경(update/insert/delete)도 동일 범위. manager 일부 제한은 추후 세분화.
create policy members_modify on members
for all using (
  case current_role_name()
    when 'admin'   then true
    when 'manager' then true
    when 'leader'  then team_id = current_team_id()
    when 'rep'     then assigned_staff_id = auth.uid()
    else false
  end
);

-- payments: 회원 가시성에 종속 (보이는 회원의 결제만) --------------------------
alter table payments enable row level security;

create policy payments_select on payments
for select using (
  exists (select 1 from members m where m.id = payments.member_id)
);

-- admin 전용 테이블: 관리자/권한/로그/설정 -----------------------------------
-- TODO(live-verify): manager 에게 logs 읽기 일부 허용 여부 확인.
alter table admin_logs enable row level security;
create policy admin_logs_admin_only on admin_logs
for all using (current_role_name() = 'admin');
