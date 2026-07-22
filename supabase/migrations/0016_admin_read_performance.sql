-- 0016 — 운영 콘솔 대량조회 성능 방어
-- 브라우저가 members 전체를 반복 다운로드하던 목록/대시보드/뱃지/결제 조회를
-- 서버 페이지네이션·집계 RPC로 전환한다. 함수는 security invoker 로 RLS를 그대로 적용한다.

create extension if not exists pg_trgm;

-- 자주 쓰는 필터·정렬·RLS 경로. 현재 2천 건에서는 즉시 생성되고, 15만 건에서도
-- 전체 테이블 순차 스캔/정렬이 반복되지 않도록 한다.
create index if not exists members_assigned_registered_idx
  on members (assigned_staff_id, registered_at desc);
create index if not exists members_team_registered_idx
  on members (team_id, registered_at desc);
create index if not exists members_inflow_registered_idx
  on members (inflow_code, registered_at desc);
create index if not exists members_no_outcall_registered_idx
  on members (registered_at desc) where outcall_done = false;
create index if not exists members_phone_digits_idx
  on members ((regexp_replace(phone, '\D', '', 'g')));
create index if not exists members_user_id_trgm_idx
  on members using gin (lower(user_id) gin_trgm_ops);
create index if not exists members_name_trgm_idx
  on members using gin (lower(name) gin_trgm_ops);
create index if not exists members_nickname_trgm_idx
  on members using gin (lower(coalesce(nickname, '')) gin_trgm_ops);
create index if not exists members_phone_digits_trgm_idx
  on members using gin ((regexp_replace(phone, '\D', '', 'g')) gin_trgm_ops);
create index if not exists payments_status_created_idx
  on payments (status, created_at desc);
create index if not exists payments_staff_created_idx
  on payments (staff_id, created_at desc);
create index if not exists inquiries_status_created_idx
  on inquiries (status, created_at desc);

-- RLS 함수는 동일 문장 안에서 호출자별로 고정되는 값이다. SELECT 래핑으로 행마다
-- 재평가하지 않게 해 회원 수 증가 시 RLS 비용을 줄인다.
drop policy if exists members_rw on members;
create policy members_rw on members for all to authenticated
  using (
    (select app_role()) in ('admin','manager','leader')
    or ((select app_role()) = 'rep' and assigned_staff_id = (select app_staff_id()))
  )
  with check (
    (select app_role()) in ('admin','manager','leader')
    or ((select app_role()) = 'rep' and assigned_staff_id = (select app_staff_id()))
  );

create or replace function app_can_see_member(mid text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members m
    where m.id = mid and (
      (select app_role()) in ('admin','manager','leader')
      or ((select app_role()) = 'rep' and m.assigned_staff_id = (select app_staff_id()))
    )
  );
$$;

-- 이용자 목록: 필터·검색·정렬·페이지를 DB에서 처리하고 현재 페이지 행만 반환한다.
create or replace function admin_members_page(
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

-- 이용자 26개 saved view 건수와 유입코드 목록을 한 번의 서버 집계로 반환한다.
create or replace function admin_member_facets(
  p_assigned_staff_id text default null
) returns jsonb
language sql stable security invoker set search_path = public as $$
with raw as materialized (
  select m.*, s.role::text as assigned_role
  from members m
  left join staff s on s.id = m.assigned_staff_id
  where p_assigned_staff_id is null or m.assigned_staff_id = p_assigned_staff_id
), base as materialized (
  select r.*,
    count(*) filter (where r.inflow_code is not null)
      over (partition by r.inflow_code) as inflow_all_count,
    count(*) filter (
      where r.inflow_code is not null
        and (r.registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
    ) over (partition by r.inflow_code) as inflow_today_count
  from raw r
)
select jsonb_build_object(
  'counts', jsonb_build_object(
    'all', count(*),
    'today-join', count(*) filter (where (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'paid', count(*) filter (where grade::text in ('gold','goldp','vip','royal')),
    'no-staff', count(*) filter (where assigned_staff_id is null),
    'no-outcall-new', count(*) filter (where not outcall_done and (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'winner', count(*) filter (where nullif(btrim(coalesce(win_history, '')), '') is not null),
    'normal', count(*) filter (where status::text = 'active'),
    'suspended', count(*) filter (where is_suspended),
    'deleted', count(*) filter (where is_deleted),
    'withdrawn', count(*) filter (where is_withdrawn),
    'free', count(*) filter (where grade::text = 'free'),
    'simple', count(*) filter (where grade::text = 'simple'),
    'gold', count(*) filter (where grade::text in ('gold','goldp')),
    'vip-royal', count(*) filter (where grade::text in ('vip','royal')),
    'ovr', count(*) filter (where grade::text = 'ovr'),
    'toss', count(*) filter (where grade::text = 'toss'),
    'manager-own', count(*) filter (where assigned_role = 'manager'),
    'leader-own', count(*) filter (where assigned_role = 'leader'),
    'dup-today', count(*) filter (where inflow_code is not null and inflow_today_count > 1 and (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'dup-all', count(*) filter (where inflow_code is not null and inflow_all_count > 1),
    'today-dabi', count(*) filter (where assigned_staff_id is not null and (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'retry', count(*) filter (where outcall_done and grade::text in ('free','simple')),
    'has-memo', count(*) filter (where nullif(btrim(coalesce(memo, '')), '') is not null),
    'tendency-active', count(*) filter (where tendency = '적극'),
    'no-outcall-all', count(*) filter (where not outcall_done),
    'long-inactive', count(*) filter (where last_active_at is null or last_active_at <= now() - interval '30 days')
  ),
  'inflowCodes', coalesce((
    select jsonb_agg(c.code order by c.code)
    from (select distinct inflow_code as code from base where inflow_code is not null and btrim(inflow_code) <> '') c
  ), '[]'::jsonb)
)
from base;
$$;

-- 수기결제 대상 회원 자동완성. 회원 전체를 키 입력마다 내려받지 않는다.
create or replace function admin_member_search(
  p_term text default '',
  p_limit integer default 20
) returns jsonb
language sql stable security invoker set search_path = public as $$
select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
from (
  select m.id, m.name, m.user_id, m.phone, m.grade
  from members m
  where nullif(btrim(p_term), '') is null
    or position(lower(p_term) in lower(m.name)) > 0
    or position(lower(p_term) in lower(m.user_id)) > 0
    or (
      nullif(regexp_replace(p_term, '\D', '', 'g'), '') is not null
      and position(regexp_replace(p_term, '\D', '', 'g') in regexp_replace(m.phone, '\D', '', 'g')) > 0
    )
  order by m.registered_at desc, m.id asc
  limit greatest(1, least(coalesce(p_limit, 20), 50))
) x;
$$;

-- 결제 목록/탭/상세. 회원·상품 조인은 DB 한 번에 처리한다.
create or replace function admin_payments_page(
  p_filter jsonb default '{}'::jsonb,
  p_offset integer default 0,
  p_limit integer default 50,
  p_sort_id text default null,
  p_sort_desc boolean default true
) returns jsonb
language sql stable security invoker set search_path = public as $$
with filtered as not materialized (
  select p.*,
    jsonb_build_object('id', m.id, 'name', m.name, 'user_id', m.user_id, 'inflow_code', m.inflow_code) as member,
    case when pr.id is null then null else jsonb_build_object('id', pr.id, 'name', pr.name, 'grade_granted', pr.grade_granted) end as product
  from payments p
  join members m on m.id = p.member_id
  left join products pr on pr.id = p.product_id
  where (not (p_filter ? 'status') or p_filter->>'status' = 'all' or p.status::text = p_filter->>'status')
    and (not (p_filter ? 'method') or nullif(p_filter->>'method', '') is null or p.method::text = p_filter->>'method')
    and (not (p_filter ? 'pg') or p.pg_provider = p_filter->>'pg')
    and (not (p_filter ? 'staffId') or p.staff_id = p_filter->>'staffId')
    and (not (p_filter ? 'dateFrom') or (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date >= (p_filter->>'dateFrom')::date)
    and (not (p_filter ? 'dateTo') or (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date <= (p_filter->>'dateTo')::date)
    and (
      nullif(btrim(coalesce(p_filter->>'search', '')), '') is null
      or position(lower(p_filter->>'search') in lower(m.name)) > 0
      or position(lower(p_filter->>'search') in lower(m.user_id)) > 0
      or position(lower(p_filter->>'search') in lower(coalesce(p.depositor_name, ''))) > 0
    )
), page_rows as (
  select f.* from filtered f
  order by
    case when p_sort_id = 'amount' and not p_sort_desc then f.amount end asc nulls last,
    case when p_sort_id = 'amount' and p_sort_desc then f.amount end desc nulls last,
    case when p_sort_id = 'status' and not p_sort_desc then f.status::text end asc nulls last,
    case when p_sort_id = 'status' and p_sort_desc then f.status::text end desc nulls last,
    case when p_sort_id = 'method' and not p_sort_desc then f.method::text end asc nulls last,
    case when p_sort_id = 'method' and p_sort_desc then f.method::text end desc nulls last,
    case when p_sort_id = 'paid_at' and not p_sort_desc then f.paid_at end asc nulls last,
    case when p_sort_id = 'paid_at' and p_sort_desc then f.paid_at end desc nulls last,
    case when p_sort_id = 'created_at' and not p_sort_desc then f.created_at end asc nulls last,
    case when p_sort_id = 'created_at' and p_sort_desc then f.created_at end desc nulls last,
    f.created_at desc,
    f.id asc
  offset greatest(0, p_offset)
  limit greatest(1, least(coalesce(p_limit, 50), 1000))
)
select jsonb_build_object(
  'rows', coalesce((select jsonb_agg(to_jsonb(p)) from page_rows p), '[]'::jsonb),
  'total', (select count(*) from filtered)
);
$$;

create or replace function admin_payment_counts() returns jsonb
language sql stable security invoker set search_path = public as $$
select jsonb_build_object(
  'all', count(*),
  'wait', count(*) filter (where status::text = 'wait'),
  'approved', count(*) filter (where status::text = 'approved'),
  'failed', count(*) filter (where status::text = 'failed'),
  'cancelled', count(*) filter (where status::text = 'cancelled')
) from payments;
$$;

create or replace function admin_payment_detail(p_id text) returns jsonb
language sql stable security invoker set search_path = public as $$
select to_jsonb(x) from (
  select p.*,
    jsonb_build_object('id', m.id, 'name', m.name, 'user_id', m.user_id, 'inflow_code', m.inflow_code) as member,
    case when pr.id is null then null else jsonb_build_object('id', pr.id, 'name', pr.name, 'grade_granted', pr.grade_granted) end as product
  from payments p
  join members m on m.id = p.member_id
  left join products pr on pr.id = p.product_id
  where p.id = p_id
  limit 1
) x;
$$;

-- 대시보드: 회원/결제 전체 대신 KPI·14일 추이·최근 6건만 반환한다.
create or replace function admin_dashboard() returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id, (select app_staff_id()) as staff_id
), scoped_members as materialized (
  select m.* from members m, ctx c
  where c.role in ('admin','manager')
    or (c.role = 'leader' and m.team_id = c.team_id)
    or (c.role = 'rep' and m.assigned_staff_id = c.staff_id)
), scoped_payments as materialized (
  select p.* from payments p join scoped_members m on m.id = p.member_id
), trend as (
  select d::date as day, count(m.id) as value
  from generate_series(
    (now() at time zone 'Asia/Seoul')::date - 13,
    (now() at time zone 'Asia/Seoul')::date,
    interval '1 day'
  ) d
  left join scoped_members m on (m.registered_at at time zone 'Asia/Seoul')::date = d::date
  group by d::date
  order by d::date
)
select jsonb_build_object(
  'kpis', jsonb_build_object(
    'todayJoin', (select count(*) from scoped_members where (registered_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'weekJoin', (select count(*) from scoped_members where (registered_at at time zone 'Asia/Seoul')::date between (now() at time zone 'Asia/Seoul')::date - 6 and (now() at time zone 'Asia/Seoul')::date),
    'noOutcall', (select count(*) from scoped_members where not outcall_done),
    'paymentWait', (select count(*) from scoped_payments where status::text = 'wait'),
    'paymentWaitAmount', (select coalesce(sum(amount), 0) from scoped_payments where status::text = 'wait'),
    'todayRevenue', (select coalesce(sum(amount), 0) from scoped_payments where status::text = 'approved' and (paid_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'todayApproved', (select count(*) from scoped_payments where status::text = 'approved' and (paid_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date)
  ),
  'trend', coalesce((select jsonb_agg(jsonb_build_object('date', day::text, 'label', to_char(day, 'MM-DD'), 'value', value) order by day) from trend), '[]'::jsonb),
  'pendingOutcall', coalesce((
    select jsonb_agg(to_jsonb(x)) from (
      select id, name, grade, phone, registered_at as "registeredAt"
      from scoped_members where not outcall_done
      order by registered_at desc limit 6
    ) x
  ), '[]'::jsonb),
  'pendingPayment', coalesce((
    select jsonb_agg(to_jsonb(x)) from (
      select p.id, m.name as "memberName", p.amount,
        case when p.method::text = 'pg' then coalesce(p.pg_provider, 'PG')
             when p.method::text = 'bank' then '무통장' else '수기' end as "methodLabel",
        p.created_at as "createdAt"
      from scoped_payments p join scoped_members m on m.id = p.member_id
      where p.status::text = 'wait'
      order by p.created_at desc limit 6
    ) x
  ), '[]'::jsonb),
  'outcallMore', greatest(0, (select count(*) from scoped_members where not outcall_done) - 6),
  'paymentMore', greatest(0, (select count(*) from scoped_payments where status::text = 'wait') - 6)
);
$$;

-- 사이드바 상주 뱃지: 앱 진입마다 회원 전체를 받지 않고 숫자 두 개만 반환한다.
create or replace function admin_nav_badges() returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id, (select app_staff_id()) as staff_id
), scoped_members as materialized (
  select m.id from members m, ctx c
  where c.role in ('admin','manager')
    or (c.role = 'leader' and m.team_id = c.team_id)
    or (c.role = 'rep' and m.assigned_staff_id = c.staff_id)
)
select jsonb_build_object(
  'payments', (select count(*) from payments p join scoped_members m on m.id = p.member_id where p.status::text = 'wait'),
  'support', (select count(*) from inquiries where status::text = 'open')
);
$$;

-- 베팅 목록: 회차/검색/요약/회원명 조인을 서버에서 처리하고 현재 페이지 행만 반환한다.
create or replace function admin_bets_page(
  p_round integer default null,
  p_search text default '',
  p_offset integer default 0,
  p_limit integer default 50
) returns jsonb
language sql stable security invoker set search_path = public as $$
with filtered as not materialized (
  select b.*,
    m.name as "memberName",
    r.numbers as win,
    r.bonus as "winBonus",
    (r.confirmed_at is not null) as confirmed
  from bets b
  left join members m on m.id = b.member_ref
  join lotto_rounds r on r.round_no = b.round_no
  where (p_round is null or b.round_no = p_round)
    and (
      nullif(btrim(p_search), '') is null
      or position(lower(p_search) in lower(b.id)) > 0
      or position(lower(p_search) in lower(coalesce(b.issuer, ''))) > 0
      or position(lower(p_search) in lower(coalesce(b.member_ref, ''))) > 0
      or position(lower(p_search) in lower(coalesce(m.name, ''))) > 0
      or position(lower(p_search) in b.round_no::text) > 0
    )
), page_rows as (
  select * from filtered
  order by round_no desc, id asc
  offset greatest(0, p_offset)
  limit greatest(1, least(coalesce(p_limit, 50), 1000))
)
select jsonb_build_object(
  'rows', coalesce((select jsonb_agg(to_jsonb(p)) from page_rows p), '[]'::jsonb),
  'total', (select count(*) from filtered),
  'summary', jsonb_build_object(
    'count', (select count(*) from filtered),
    'winners', (select count(*) from filtered where rank is not null),
    'prizeSum', (select coalesce(sum(prize), 0) from filtered)
  )
);
$$;

-- 매출: 전체 결제/회원 행을 브라우저에 보내지 않고 전환 판정·기간·그룹 집계를 DB에서 끝낸다.
create or replace function admin_revenue(
  p_view text,
  p_from date,
  p_to date,
  p_group text default 'staff'
) returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id
), scoped_members as materialized (
  select m.id, m.team_id
  from members m, ctx c
  where c.role in ('admin','manager')
    or (c.role = 'leader' and m.team_id = c.team_id)
), approved as materialized (
  select p.*, m.team_id,
    coalesce(p.paid_at, p.created_at) as recognized_at
  from payments p
  join scoped_members m on m.id = p.member_id
  where p.status::text = 'approved'
), first_paid as (
  select distinct on (member_id) id
  from approved
  where product_id is not null
  order by member_id, recognized_at, id
), period as materialized (
  select a.*,
    (f.id is not null) as is_conversion,
    case when p_view = 'team' then 'team'
         when p_view = 'conversion' then 'staff'
         else p_group end as group_dim
  from approved a
  left join first_paid f on f.id = a.id
  where (a.recognized_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), active as materialized (
  select p.*,
    case p.group_dim
      when 'team' then coalesce(p.team_id, 'none')
      when 'product' then coalesce(p.product_id, 'none')
      when 'pg' then case when p.method::text = 'pg' then 'pg:' || coalesce(p.pg_provider, 'PG(미지정)') else 'm:' || p.method::text end
      else coalesce(p.staff_id, 'none')
    end as group_key,
    case p.group_dim
      when 'team' then coalesce(t.name, '미배정')
      when 'product' then coalesce(pr.name, '기타')
      when 'pg' then case when p.method::text = 'pg' then coalesce(p.pg_provider, 'PG(미지정)')
                          when p.method::text = 'bank' then '무통장' else '수기' end
      else coalesce(s.name, '미배정')
    end as group_label
  from period p
  left join staff s on s.id = p.staff_id
  left join teams t on t.id = p.team_id
  left join products pr on pr.id = p.product_id
  where p_view <> 'conversion' or p.is_conversion
), day_series as (
  select d::date as day
  from generate_series(
    greatest(least(p_from, p_to), greatest(p_from, p_to) - 369),
    greatest(p_from, p_to),
    interval '1 day'
  ) d
), day_totals as (
  select (recognized_at at time zone 'Asia/Seoul')::date as day,
    sum(amount)::bigint as amount, count(*)::bigint as count
  from active group by 1
), grouped as (
  select group_key as key, group_label as label,
    sum(amount)::bigint as amount, count(*)::bigint as count
  from active group by group_key, group_label
), totals as (
  select coalesce(sum(amount), 0)::bigint as total, count(*)::bigint as count from active
), period_totals as (
  select count(*)::bigint as count,
    count(*) filter (where is_conversion)::bigint as conversions,
    coalesce(sum(amount) filter (where is_conversion), 0)::bigint as conversion_revenue
  from period
)
select jsonb_build_object(
  'summary', jsonb_build_object(
    'total', t.total,
    'count', t.count,
    'avg', case when t.count > 0 then round(t.total::numeric / t.count)::bigint else 0 end,
    'conversions', pt.conversions,
    'conversionRevenue', pt.conversion_revenue,
    'conversionRate', case when pt.count > 0 then pt.conversions::numeric / pt.count else 0 end
  ),
  'trend', coalesce((
    select jsonb_agg(jsonb_build_object(
      'date', ds.day::text,
      'label', to_char(ds.day, 'MM-DD'),
      'amount', coalesce(dt.amount, 0),
      'count', coalesce(dt.count, 0)
    ) order by ds.day)
    from day_series ds left join day_totals dt on dt.day = ds.day
  ), '[]'::jsonb),
  'breakdown', coalesce((
    select jsonb_agg(jsonb_build_object(
      'key', g.key,
      'label', g.label,
      'amount', g.amount,
      'count', g.count,
      'share', case when t.total > 0 then g.amount::numeric / t.total else 0 end
    ) order by g.amount desc)
    from grouped g
  ), '[]'::jsonb),
  'groupDim', case when p_view = 'team' then 'team' when p_view = 'conversion' then 'staff' else p_group end
)
from totals t cross join period_totals pt;
$$;

-- 가입·유입·결제 통계: 차트/표에 필요한 작은 집계만 반환한다.
create or replace function admin_stats_snapshot(
  p_view text,
  p_from date,
  p_to date
) returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id, (select app_staff_id()) as staff_id
), scoped_members as materialized (
  select m.id, m.grade, m.registered_at, m.inflow_type, m.inflow_code
  from members m, ctx c
  where c.role in ('admin','manager')
    or (c.role = 'leader' and m.team_id = c.team_id)
    or (c.role = 'rep' and m.assigned_staff_id = c.staff_id)
), member_period as materialized (
  select * from scoped_members
  where (registered_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), scoped_payments as materialized (
  select p.* from payments p join scoped_members m on m.id = p.member_id
), approved_period as materialized (
  select * from scoped_payments
  where status::text = 'approved' and paid_at is not null
    and (paid_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), created_period as materialized (
  select * from scoped_payments
  where (created_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
)
select case when p_view in ('signup','inflow') then jsonb_build_object(
  'kind', 'members',
  'total', (select count(*) from scoped_members),
  'paid', (select count(*) from scoped_members where grade::text in ('gold','goldp','vip','royal')),
  'period', (select count(*) from member_period),
  'periodPaid', (select count(*) from member_period where grade::text in ('gold','goldp','vip','royal')),
  'distinctTypes', (select count(distinct coalesce(inflow_type, '미상')) from scoped_members),
  'days', coalesce((
    select jsonb_agg(jsonb_build_object('date', x.day::text, 'value', x.value) order by x.day)
    from (
      select (registered_at at time zone 'Asia/Seoul')::date as day, count(*)::bigint as value
      from member_period group by 1
    ) x
  ), '[]'::jsonb),
  'grades', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count) order by x.count desc)
    from (select grade::text as key, count(*)::bigint as count from scoped_members group by 1) x
  ), '[]'::jsonb),
  'inflowTypes', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count, 'paid', x.paid) order by x.count desc)
    from (
      select coalesce(inflow_type, '미상') as key, count(*)::bigint as count,
        count(*) filter (where grade::text in ('gold','goldp','vip','royal'))::bigint as paid
      from member_period group by 1
    ) x
  ), '[]'::jsonb),
  'inflowCodes', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count) order by x.count desc)
    from (
      select coalesce(inflow_code, '미상') as key, count(*)::bigint as count
      from member_period group by 1
    ) x
  ), '[]'::jsonb)
) else jsonb_build_object(
  'kind', 'payments',
  'total', (select coalesce(sum(amount), 0) from approved_period),
  'approvedCount', (select count(*) from approved_period),
  'createdCount', (select count(*) from created_period),
  'days', coalesce((
    select jsonb_agg(jsonb_build_object('date', x.day::text, 'value', x.value) order by x.day)
    from (
      select (paid_at at time zone 'Asia/Seoul')::date as day, sum(amount)::bigint as value
      from approved_period group by 1
    ) x
  ), '[]'::jsonb),
  'products', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'label', x.label, 'value', x.value, 'count', x.count) order by x.value desc)
    from (
      select coalesce(ap.product_id, 'none') as key, coalesce(pr.name, '기타') as label,
        sum(ap.amount)::bigint as value, count(*)::bigint as count
      from approved_period ap left join products pr on pr.id = ap.product_id
      group by 1, 2
    ) x
  ), '[]'::jsonb),
  'methods', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'label', x.label, 'value', x.value, 'count', x.count) order by x.value desc)
    from (
      select case when method::text = 'pg' then 'pg:' || coalesce(pg_provider, 'PG') else 'm:' || method::text end as key,
        case when method::text = 'pg' then coalesce(pg_provider, 'PG(미지정)')
             when method::text = 'bank' then '무통장' else '수기' end as label,
        sum(amount)::bigint as value, count(*)::bigint as count
      from approved_period group by 1, 2
    ) x
  ), '[]'::jsonb),
  'statuses', coalesce((
    select jsonb_agg(jsonb_build_object('key', x.key, 'count', x.count) order by x.count desc)
    from (select status::text as key, count(*)::bigint as count from created_period group by 1) x
  ), '[]'::jsonb)
) end;
$$;

-- 상담 리포트: 기간 로그만 펼쳐 역할 스코프 안에서 서버 그룹 집계한다.
create or replace function admin_consult_report(
  p_dimension text,
  p_period text,
  p_from date,
  p_to date
) returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role, (select app_team()) as team_id, (select app_staff_id()) as staff_id
), scoped_members as materialized (
  select m.id, m.inflow_code
  from members m, ctx c
  where c.role in ('admin','manager')
    or (c.role = 'leader' and m.team_id = c.team_id)
    or (c.role = 'rep' and m.assigned_staff_id = c.staff_id)
), relevant_logs as materialized (
  select l.* from logs l
  where l.action in ('member.update','member.bulk_update')
    and (l.created_at at time zone 'Asia/Seoul')::date between least(p_from, p_to) and greatest(p_from, p_to)
), events as (
  select l.created_at, l.actor, l.target_id as member_id, l.meta->'patch'->>'consult_status' as status
  from relevant_logs l
  where l.action = 'member.update' and l.target_id is not null
  union all
  select l.created_at, l.actor, ids.member_id, l.meta->'patch'->>'consult_status' as status
  from relevant_logs l
  cross join lateral jsonb_array_elements_text(coalesce(l.meta->'ids', '[]'::jsonb)) ids(member_id)
  where l.action = 'member.bulk_update'
), normalized as (
  select
    case when p_period = 'month'
      then date_trunc('month', e.created_at at time zone 'Asia/Seoul')::date
      else date_trunc('week', e.created_at at time zone 'Asia/Seoul')::date end as period_key,
    case when p_dimension = 'staff' then coalesce(e.actor, '(미배정)') else coalesce(m.inflow_code, '(미상)') end as dim_key,
    case when p_dimension = 'staff' then coalesce(s.name, e.actor, '(미배정)') else coalesce(m.inflow_code, '(미상)') end as dim_label,
    e.status
  from events e
  join scoped_members m on m.id = e.member_id
  left join staff s on s.id = e.actor
  where e.status in ('신규','결번','부재','가망','승인','통화예약','도입거절','일반거절','기타')
), counts as (
  select period_key, dim_key, dim_label, status, count(*)::bigint as count
  from normalized group by 1, 2, 3, 4
), grouped as (
  select period_key, dim_key, dim_label,
    jsonb_object_agg(status, count) as counts,
    sum(count)::bigint as total
  from counts group by 1, 2, 3
)
select coalesce(jsonb_agg(jsonb_build_object(
  'periodKey', period_key::text,
  'periodLabel', case when p_period = 'month'
    then extract(year from period_key)::integer || '년 ' || extract(month from period_key)::integer || '월'
    else period_key::text || ' 주' end,
  'dimKey', dim_key,
  'dimLabel', dim_label,
  'counts', counts,
  'total', total
) order by period_key desc, total desc, dim_label), '[]'::jsonb)
from grouped;
$$;

revoke execute on function admin_members_page(jsonb, integer, integer, text, boolean, text) from public, anon;
revoke execute on function admin_member_facets(text) from public, anon;
revoke execute on function admin_member_search(text, integer) from public, anon;
revoke execute on function admin_payments_page(jsonb, integer, integer, text, boolean) from public, anon;
revoke execute on function admin_payment_counts() from public, anon;
revoke execute on function admin_payment_detail(text) from public, anon;
revoke execute on function admin_dashboard() from public, anon;
revoke execute on function admin_nav_badges() from public, anon;
revoke execute on function admin_bets_page(integer, text, integer, integer) from public, anon;
revoke execute on function admin_revenue(text, date, date, text) from public, anon;
revoke execute on function admin_stats_snapshot(text, date, date) from public, anon;
revoke execute on function admin_consult_report(text, text, date, date) from public, anon;

grant execute on function admin_members_page(jsonb, integer, integer, text, boolean, text) to authenticated;
grant execute on function admin_member_facets(text) to authenticated;
grant execute on function admin_member_search(text, integer) to authenticated;
grant execute on function admin_payments_page(jsonb, integer, integer, text, boolean) to authenticated;
grant execute on function admin_payment_counts() to authenticated;
grant execute on function admin_payment_detail(text) to authenticated;
grant execute on function admin_dashboard() to authenticated;
grant execute on function admin_nav_badges() to authenticated;
grant execute on function admin_bets_page(integer, text, integer, integer) to authenticated;
grant execute on function admin_revenue(text, date, date, text) to authenticated;
grant execute on function admin_stats_snapshot(text, date, date) to authenticated;
grant execute on function admin_consult_report(text, text, date, date) to authenticated;
