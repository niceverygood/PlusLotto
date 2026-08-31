-- D175: 레거시 4사 데이터 이관을 위한 출처/원본키 보존과 이용자 출처 필터.
--
-- 회원·결제·문자는 각각 원본 PK를 (source_site, legacy_idx)로 보존한다. 이 조합을
-- 유일하게 만들어 대용량 적재가 중간에 끊겨도 같은 명령으로 안전하게 재개할 수 있다.
-- 원본의 비밀번호·API 키·접속 IP 등 업무에 불필요한 비밀정보는 meta에 넣지 않는다.

alter table public.payments
  add column if not exists meta jsonb not null default '{}'::jsonb;

alter table public.sms_sends
  add column if not exists meta jsonb not null default '{}'::jsonb;

create unique index if not exists members_legacy_source_idx
  on public.members ((meta->>'source_site'), (meta->>'legacy_idx'))
  where meta ? 'source_site' and meta ? 'legacy_idx';

create unique index if not exists payments_legacy_source_idx
  on public.payments ((meta->>'source_site'), (meta->>'legacy_idx'))
  where meta ? 'source_site' and meta ? 'legacy_idx';

create unique index if not exists sms_sends_legacy_source_idx
  on public.sms_sends ((meta->>'source_site'), (meta->>'legacy_idx'))
  where meta ? 'source_site' and meta ? 'legacy_idx';

create index if not exists members_source_site_registered_idx
  on public.members ((meta->>'source_site'), registered_at desc, id)
  where meta ? 'source_site';

-- 과거 결제도 매출/결제 화면에서 등급·상품별로 집계되도록 안정적인 상품 ID를 쓴다.
-- price/duration은 대응표의 표준값이고, 실제 결제액/기간은 payments의 원본값을 보존한다.
insert into public.products (id, name, price, duration_months, grade_granted, is_active)
values
  ('legacy_lotto815_family', '815로또 패밀리', 488000, 18, 'goldp', false),
  ('legacy_lotto815_mania', '815로또 매니아', 7880000, 36, 'vip', false),
  ('legacy_lotto815_first', '815로또 퍼스트', 11880000, 36, 'royal', false),
  ('legacy_cplotto_gold', '일행로또 골드', 176000, 18, 'goldp', false),
  ('legacy_cplotto_goldplus', '일행로또 골드플러스', 198000, 18, 'goldp', false),
  ('legacy_cplotto_vipgold', '일행로또 VIP', 1485000, 36, 'vip', false),
  ('legacy_cplotto_first', '일행로또 로얄', 2980000, 36, 'royal', false)
on conflict (id) do update set
  name = excluded.name,
  price = excluded.price,
  duration_months = excluded.duration_months,
  grade_granted = excluded.grade_granted,
  is_active = excluded.is_active;

-- 최신 함수 정의를 통째로 과거 버전으로 되돌리지 않고 sourceSite 조건만 삽입한다.
-- admin_members_page는 여러 성능/검색 패치가 누적된 함수이므로 앵커가 다르면 즉시 실패한다.
do $$
declare
  definition text := pg_get_functiondef(
    'public.admin_members_page(jsonb,integer,integer,text,boolean,text)'::regprocedure
  );
  anchor constant text := 'and (not (p_filter ? ''inflowType'') or public.canonical_inflow_type(m.inflow_type) = public.canonical_inflow_type(p_filter->>''inflowType''))';
  source_filter constant text := 'and (not (p_filter ? ''sourceSite'') or m.meta->>''source_site'' = p_filter->>''sourceSite'')';
begin
  if position(source_filter in definition) = 0 then
    if position(anchor in definition) = 0 then
      raise exception 'admin_members_page source-site anchor was not found';
    end if;
    definition := replace(definition, anchor, anchor || E'\n    ' || source_filter);
    execute definition;
  end if;
end $$;

revoke execute on function public.admin_members_page(jsonb, integer, integer, text, boolean, text)
  from public, anon;
grant execute on function public.admin_members_page(jsonb, integer, integer, text, boolean, text)
  to authenticated;

comment on column public.payments.meta is
  '레거시 원본 provenance 등 비정형 결제 메타. 비밀번호/API 자격증명 저장 금지.';
comment on column public.sms_sends.meta is
  '레거시 원본 provenance 등 비정형 문자 메타. API 자격증명/IP/UA 저장 금지.';
