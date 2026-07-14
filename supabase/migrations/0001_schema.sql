-- 플러스로또 운영 콘솔 — 라이브 스키마 (Phase 12 마이그레이션)
-- 근거: src/types/db.ts 도메인 모델 + src/lib/db/store.ts DbShape (CLAUDE §4)
-- 실행: Supabase 대시보드 SQL Editor 에 통째로 붙여넣거나 `supabase db push`.
-- 주의: PK 는 TEXT (앱 genId('prefix_uuid') 호환). staff 만 auth.users 연결용 auth_user_id 보유.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. ENUM 타입 (TS union 과 1:1)
-- ─────────────────────────────────────────────────────────────────────────
create type role            as enum ('admin','manager','leader','rep');
create type grade           as enum ('simple','free','gold','goldp','vip','royal','ovr','toss');
create type member_status   as enum ('active','suspended','deleted','withdrawn');
create type payment_status  as enum ('wait','approved','failed','cancelled');
create type payment_method  as enum ('bank','manual','pg');
create type sms_type        as enum ('join','recommend','win','marketing');
create type assign_type     as enum ('manual','auto');
create type log_kind        as enum ('admin','point','sms','payment','inflow');
create type inquiry_status  as enum ('open','answered');
create type report_frequency as enum ('daily','weekly','monthly');

-- ─────────────────────────────────────────────────────────────────────────
-- 1. 조직 (staff · teams) — 상호 참조이므로 FK 는 테이블 생성 후 추가
-- ─────────────────────────────────────────────────────────────────────────
create table staff (
  id            text primary key,
  login_id      text not null unique,
  name          text not null,
  role          role not null default 'rep',
  team_id       text,
  is_active     boolean not null default true,
  -- 자동배분 대상 풀 포함 여부(rep 한정, §V2-1). 자동할당 라운드로빈은 이 플래그가 켜진 rep 만.
  auto_assign_enabled boolean not null default false,
  last_login_at timestamptz,
  -- 라이브 인증: Supabase auth.users 와 1:1 연결 (RLS 의 auth.uid() 해석 기준)
  auth_user_id  uuid unique references auth.users(id) on delete set null
);

create table teams (
  id        text primary key,
  name      text not null,
  leader_id text
);

alter table staff add constraint staff_team_fk
  foreign key (team_id) references teams(id) on delete set null;
alter table teams add constraint teams_leader_fk
  foreign key (leader_id) references staff(id) on delete set null;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. 상품
-- ─────────────────────────────────────────────────────────────────────────
create table products (
  id              text primary key,
  name            text not null,
  price           integer not null default 0,
  duration_months integer not null default 1,
  grade_granted   grade not null,
  is_active       boolean not null default true
);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 회원 (핵심)
-- ─────────────────────────────────────────────────────────────────────────
create table members (
  id                text primary key,
  user_id           text not null,
  name              text not null,
  nickname          text,
  phone             text not null default '',
  grade             grade not null default 'free',
  status            member_status not null default 'active',
  tendency          text,
  inflow_code       text,
  inflow_type       text,
  assigned_staff_id text references staff(id) on delete set null,
  team_id           text references teams(id) on delete set null,
  memo              text,
  win_history       text,
  outcall_done      boolean not null default false,
  registered_at     timestamptz not null default now(),
  last_active_at    timestamptz,
  is_suspended      boolean not null default false,
  is_deleted        boolean not null default false,
  is_withdrawn      boolean not null default false,
  meta              jsonb not null default '{}'
);
create index members_assigned_idx on members(assigned_staff_id);
create index members_team_idx     on members(team_id);
create index members_status_idx   on members(status);
create index members_grade_idx    on members(grade);
create index members_inflow_idx   on members(inflow_code);
create index members_registered_idx on members(registered_at);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. 결제
-- ─────────────────────────────────────────────────────────────────────────
create table payments (
  id            text primary key,
  member_id     text not null references members(id) on delete cascade,
  product_id    text references products(id) on delete set null,
  amount        integer not null default 0,
  method        payment_method not null,
  pg_provider   text,
  status        payment_status not null default 'wait',
  period_start  timestamptz,
  period_end    timestamptz,
  depositor_name text,
  staff_id      text references staff(id) on delete set null,
  paid_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index payments_member_idx on payments(member_id);
create index payments_status_idx on payments(status);
create index payments_staff_idx  on payments(staff_id);
create index payments_paid_idx   on payments(paid_at);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. 문자 (발송 이력 · 템플릿)
-- ─────────────────────────────────────────────────────────────────────────
create table sms_sends (
  id           text primary key,
  member_id    text not null references members(id) on delete cascade,
  template_key text,
  phone        text not null default '',
  body         text not null default '',
  type         sms_type not null default 'recommend',
  status       text not null default 'sent',
  sent_at      timestamptz
);
create index sms_sends_member_idx on sms_sends(member_id);
create index sms_sends_sent_idx   on sms_sends(sent_at);

create table sms_templates (
  key      text primary key,
  title    text not null,
  body     text not null,
  category text not null default ''
);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. 로또 (회차 · 베팅)
-- ─────────────────────────────────────────────────────────────────────────
create table lotto_rounds (
  round_no     integer primary key,
  draw_date    timestamptz not null,
  numbers      integer[] not null,
  bonus        integer not null,
  sum          integer not null default 0,
  odd_even     text not null default '',
  appear_rate  numeric,
  prize_1      bigint,
  prize_2      bigint,
  prize_3      bigint,
  total_sales  bigint,
  confirmed_at timestamptz
);

create table bets (
  id         text primary key,
  round_no   integer not null references lotto_rounds(round_no) on delete cascade,
  issuer     text,
  member_ref text,           -- 회원 id 또는 외부 발행(EXT-#####) — FK 아님(의도적)
  numbers    integer[] not null,
  rank       integer,
  prize      bigint
);
create index bets_round_idx on bets(round_no);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. 배정 이력
-- ─────────────────────────────────────────────────────────────────────────
create table assignments (
  id          text primary key,
  member_id   text not null references members(id) on delete cascade,
  staff_id    text references staff(id) on delete set null,
  assigned_by text references staff(id) on delete set null,
  type        assign_type not null default 'manual',
  created_at  timestamptz not null default now()
);
create index assignments_member_idx on assignments(member_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 8. 감사 로그 (5종 단일 테이블 + kind 필터, DECISIONS D29)
-- ─────────────────────────────────────────────────────────────────────────
create table logs (
  id          text primary key,
  kind        log_kind not null,
  actor       text references staff(id) on delete set null,
  action      text not null,
  target_type text,
  target_id   text,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index logs_kind_idx    on logs(kind);
create index logs_created_idx on logs(created_at);

-- ─────────────────────────────────────────────────────────────────────────
-- 9. 커뮤니티 (공지 · 이벤트)
-- ─────────────────────────────────────────────────────────────────────────
create table notices (
  id         text primary key,
  title      text not null,
  body       text not null default '',
  pinned     boolean not null default false,
  published  boolean not null default true,
  author_id  text references staff(id) on delete set null,
  view_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table events (
  id         text primary key,
  title      text not null,
  body       text not null default '',
  starts_at  timestamptz,
  ends_at    timestamptz,
  published  boolean not null default true,
  author_id  text references staff(id) on delete set null,
  view_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- 10. 고객센터 (1:1 문의 · FAQ)
-- ─────────────────────────────────────────────────────────────────────────
create table inquiries (
  id          text primary key,
  member_id   text references members(id) on delete set null,
  author_name text not null default '',
  category    text not null default '기타',
  title       text not null,
  body        text not null default '',
  status      inquiry_status not null default 'open',
  answer      text,
  answered_by text references staff(id) on delete set null,
  answered_at timestamptz,
  created_at  timestamptz not null default now()
);
create index inquiries_status_idx on inquiries(status);

create table faqs (
  id         text primary key,
  category   text not null default '기타',
  question   text not null,
  answer     text not null default '',
  sort_order integer not null default 0,
  published  boolean not null default true
);

-- ─────────────────────────────────────────────────────────────────────────
-- 11. 권한 매트릭스 (nav_access) — nav_key → 허용 역할 (DECISIONS D26/D27)
-- ─────────────────────────────────────────────────────────────────────────
create table nav_access (
  nav_key text primary key,
  roles   role[] not null default '{}'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 12. 설정 (site_settings) — 단일 행(id=1), 슬라이스는 jsonb (DECISIONS D34)
-- ─────────────────────────────────────────────────────────────────────────
create table site_settings (
  id            integer primary key default 1,
  bank          jsonb not null default '{}',
  grade_colors  jsonb not null default '{}',
  pg_providers  jsonb not null default '[]',
  sms           jsonb not null default '{}',
  win_messages  jsonb not null default '[]',
  report        jsonb not null default '{}',
  lotto_exclude jsonb not null default '{"fixed":[],"excluded":[]}',
  lotto_exclude_history jsonb not null default '[]', -- 회차별 고정/제외 이력(§V2-5)
  terms         text not null default '',
  constraint site_settings_singleton check (id = 1)
);
