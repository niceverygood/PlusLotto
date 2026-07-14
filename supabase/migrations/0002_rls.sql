-- 플러스로또 RLS 정책 (CLAUDE §5). 0001_schema.sql 이후 실행.
-- 역할: admin > manager(실장) > leader(팀장) > rep(담당자)
-- 매핑: auth.uid() → staff.auth_user_id 로 현재 staff 행을 찾는다.
-- 데이터 경계: rep=본인담당 / leader=본인팀 / manager·admin=전체.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. 권한: 로그인(authenticated)만 접근. 익명(anon)은 차단. 행 게이팅은 아래 정책.
-- ─────────────────────────────────────────────────────────────────────────
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. 현재 staff 해석 헬퍼 (security definer → staff RLS 우회, 재귀 방지)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function app_staff_id() returns text
  language sql stable security definer set search_path = public as $$
  select id from staff where auth_user_id = auth.uid();
$$;

create or replace function app_role() returns role
  language sql stable security definer set search_path = public as $$
  select role from staff where auth_user_id = auth.uid();
$$;

create or replace function app_team() returns text
  language sql stable security definer set search_path = public as $$
  select team_id from staff where auth_user_id = auth.uid();
$$;

-- 회원 가시성(결제·문자·배정이 종속). definer 로 members 를 직접 평가.
create or replace function app_can_see_member(mid text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members m
    where m.id = mid and (
      app_role() in ('admin','manager')
      or (app_role() = 'leader' and m.team_id = app_team())
      or (app_role() = 'rep'    and m.assigned_staff_id = app_staff_id())
    )
  );
$$;

-- 로그인 부수효과(§8): 본인 staff.last_login_at 갱신 + 로그인 로그.
-- staff write 정책은 admin 전용이므로, security definer 로 호출자(auth.uid()) 본인 행만 안전하게 처리.
-- 앱은 로그인 직후 supabase.rpc('app_touch_login') 으로 호출한다.
create or replace function app_touch_login() returns void
  language plpgsql security definer set search_path = public as $$
declare sid text;
begin
  select id into sid from staff where auth_user_id = auth.uid();
  if sid is null then return; end if;
  update staff set last_login_at = now() where id = sid;
  insert into logs (id, kind, actor, action, target_type, target_id, meta, created_at)
  values ('log_' || gen_random_uuid(), 'admin', sid, 'auth.login', 'staff', sid, '{}'::jsonb, now());
end;
$$;
grant execute on function app_touch_login() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. members — 역할 범위 (읽기/쓰기 동일 경계)
-- ─────────────────────────────────────────────────────────────────────────
alter table members enable row level security;
create policy members_rw on members for all to authenticated
  using (
    app_role() in ('admin','manager')
    or (app_role() = 'leader' and team_id = app_team())
    or (app_role() = 'rep'    and assigned_staff_id = app_staff_id())
  )
  with check (
    app_role() in ('admin','manager')
    or (app_role() = 'leader' and team_id = app_team())
    or (app_role() = 'rep'    and assigned_staff_id = app_staff_id())
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 회원 종속 테이블 — 가시 회원의 레코드만
-- ─────────────────────────────────────────────────────────────────────────
alter table payments enable row level security;
create policy payments_rw on payments for all to authenticated
  using (app_can_see_member(member_id)) with check (app_can_see_member(member_id));

alter table sms_sends enable row level security;
create policy sms_sends_rw on sms_sends for all to authenticated
  using (app_can_see_member(member_id)) with check (app_can_see_member(member_id));

alter table assignments enable row level security;
create policy assignments_rw on assignments for all to authenticated
  using (app_can_see_member(member_id)) with check (app_can_see_member(member_id));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. 전역 참조 테이블 — 전원 읽기, 쓰기는 역할 제한
-- ─────────────────────────────────────────────────────────────────────────
-- staff: 전원 읽기(담당자 이름 표시 필요), admin 만 쓰기
-- TODO(live-verify, D38): 계정관리 계층 위임을 라이브에도 반영하려면 staff_write 를 계층 정책으로 교체.
--   실장(manager)=대상 role in ('leader','rep'), 팀장(leader)=대상 role='rep' and team_id=app_team_id().
--   본인 역할 변경 차단은 순수 RLS 로 표현이 어려워 트리거(before update, old.role<>new.role and id=app_staff_id() → 거부) 동반 필요.
--   현재는 mock 전용으로 위임 동작(features/admins). 라이브 전환(M8) 전까지 admin 전용 유지.
alter table staff enable row level security;
create policy staff_read on staff for select to authenticated using (true);
create policy staff_write on staff for all to authenticated
  using (app_role() = 'admin') with check (app_role() = 'admin');

-- teams: 전원 읽기, admin 쓰기
alter table teams enable row level security;
create policy teams_read on teams for select to authenticated using (true);
create policy teams_write on teams for all to authenticated
  using (app_role() = 'admin') with check (app_role() = 'admin');

-- products: 전원 읽기, admin·manager 쓰기
alter table products enable row level security;
create policy products_read on products for select to authenticated using (true);
create policy products_write on products for all to authenticated
  using (app_role() in ('admin','manager')) with check (app_role() in ('admin','manager'));

-- 로또 회차/베팅: 전원 읽기(§ 베팅은 전역 데이터), admin·manager 쓰기
alter table lotto_rounds enable row level security;
create policy lotto_read on lotto_rounds for select to authenticated using (true);
create policy lotto_write on lotto_rounds for all to authenticated
  using (app_role() in ('admin','manager')) with check (app_role() in ('admin','manager'));

alter table bets enable row level security;
create policy bets_read on bets for select to authenticated using (true);
create policy bets_write on bets for all to authenticated
  using (app_role() in ('admin','manager')) with check (app_role() in ('admin','manager'));

-- 문자 템플릿: 전원 읽기, admin·manager 쓰기
alter table sms_templates enable row level security;
create policy tmpl_read on sms_templates for select to authenticated using (true);
create policy tmpl_write on sms_templates for all to authenticated
  using (app_role() in ('admin','manager')) with check (app_role() in ('admin','manager'));

-- 커뮤니티(공지·이벤트): 전원 읽기, admin·manager 쓰기
alter table notices enable row level security;
create policy notices_read on notices for select to authenticated using (true);
create policy notices_write on notices for all to authenticated
  using (app_role() in ('admin','manager')) with check (app_role() in ('admin','manager'));

alter table events enable row level security;
create policy events_read on events for select to authenticated using (true);
create policy events_write on events for all to authenticated
  using (app_role() in ('admin','manager')) with check (app_role() in ('admin','manager'));

-- FAQ: 전원 읽기, admin·manager 쓰기
alter table faqs enable row level security;
create policy faqs_read on faqs for select to authenticated using (true);
create policy faqs_write on faqs for all to authenticated
  using (app_role() in ('admin','manager')) with check (app_role() in ('admin','manager'));

-- 1:1 문의: 전원 읽기/답변(가정 — 고객센터 전 역할 응대)
alter table inquiries enable row level security;
create policy inquiries_rw on inquiries for all to authenticated
  using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. admin 전용 / 시스템 테이블
-- ─────────────────────────────────────────────────────────────────────────
-- 로그: 적재는 전원(액션 감사), 열람은 admin 전용
alter table logs enable row level security;
create policy logs_insert on logs for insert to authenticated with check (true);
create policy logs_select on logs for select to authenticated using (app_role() = 'admin');

-- 권한 매트릭스: 전원 읽기(라우트 가드 필요), admin 만 수정
alter table nav_access enable row level security;
create policy nav_read on nav_access for select to authenticated using (true);
create policy nav_write on nav_access for all to authenticated
  using (app_role() = 'admin') with check (app_role() = 'admin');

-- 설정: 전원 읽기(등급색·약관 등 전 화면 필요), admin·manager 수정
alter table site_settings enable row level security;
create policy settings_read on site_settings for select to authenticated using (true);
create policy settings_write on site_settings for all to authenticated
  using (app_role() in ('admin','manager')) with check (app_role() in ('admin','manager'));
