-- 0008 — 멤버십 등급(고객 페이지) 운영자 편집 (현장 6/30, 정의현 차장)
-- 배경: 고객 멤버십 페이지의 등급 카드(명칭·가격·혜택·개별약관)가 코드 하드코딩이라
--       운영자가 못 바꿨다. site_settings.membership_tiers(공개 안전 필드만) 로 옮겨
--       전산(설정 > 멤버십 등급)에서 직접 편집 → 고객 페이지에 RPC 로 연동한다.
-- 보안: site_settings 에는 pg_providers.api_key 비밀이 같이 있어 anon SELECT 를 절대 열지 않는다(0002 유지).
--       고객(anon)은 아래 security-definer RPC 로 membership_tiers 컬럼만 조회한다.
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

-- ① 컬럼 추가 — 공개 안전 필드만 적재(명칭·가격·혜택·약관). api_key 등 비밀은 절대 넣지 말 것.
alter table site_settings
  add column if not exists membership_tiers jsonb not null default '[]'::jsonb;

-- ② 공개 조회 RPC — membership_tiers 컬럼만 반환(select * 금지). anon·authenticated 실행 허용.
--    security definer 라 site_settings RLS(authenticated 전용)를 우회해 그 컬럼만 안전하게 노출.
create or replace function public.portal_membership_tiers()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public
as $$
  select coalesce(membership_tiers, '[]'::jsonb)
  from site_settings
  where id = 1;
$$;

grant execute on function public.portal_membership_tiers() to anon, authenticated;

-- 참고: 등급 명칭(label)은 고객 페이지 + 전산 전역(GRADE_LABEL)에 함께 전파된다.
--       내부 등급 enum 키(goldp 등)는 그대로라 데이터/필터/RLS 에 영향 없다.
