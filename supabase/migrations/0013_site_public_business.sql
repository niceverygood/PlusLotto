-- 0013 — 사업자 정보 · 당첨자 수 · 무통장 계좌를 고객 홈페이지에 공개 (현장 7/20, 정의현 차장)
-- 배경: 고객 홈페이지 하단(상호·사업자등록번호·주소·고객센터번호)과 누적 당첨자 수(수동 입력),
--       무통장 입금 계좌(bank, 이미 존재)를 고객(anon)에게 노출해야 하는데 site_settings 는
--       pg_providers.api_key 등 비밀이 같이 있어 anon SELECT 를 절대 열지 않는다(0002/0008 참조).
--       → 신규 컬럼 2개 추가 + security-definer RPC 로 안전 필드(bank/business/winner_stats)만 반환.
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

-- ① 컬럼 추가 — 공개 안전 필드만.
alter table site_settings
  add column if not exists business jsonb not null default '{}'::jsonb,
  add column if not exists winner_stats jsonb not null default '{"enabled":false,"count":0}'::jsonb;

-- ② 공개 조회 RPC — bank·business·winner_stats 3개 컬럼만 반환(select * 금지).
--    anon·authenticated 실행 허용. security definer 라 site_settings RLS(authenticated 전용) 우회.
create or replace function public.portal_site_public()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public
as $$
  select jsonb_build_object(
    'bank', coalesce(bank, '{}'::jsonb),
    'business', coalesce(business, '{}'::jsonb),
    'winner_stats', coalesce(winner_stats, '{"enabled":false,"count":0}'::jsonb)
  )
  from site_settings
  where id = 1;
$$;

grant execute on function public.portal_site_public() to anon, authenticated;
