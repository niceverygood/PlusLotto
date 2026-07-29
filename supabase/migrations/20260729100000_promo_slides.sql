-- 고객 홈페이지 홍보 슬라이드 (현장 피드백 7/29, 정의현 차장)
-- "고객용 홈페이지에 특허사진, 1등당첨자 사진 등 홍보자료를 슬라이드 형식으로 보여줄수 있도록
--  수정 부탁드립니다. 이미지 파일은 어드민에서 업로드 할수 있도록 부탁드리겠습니다."
-- 구성: ① Storage 공개버킷(promo-slides, 0010 call-recordings 와 동일 패턴이나 이번엔 공개버킷 —
--       고객 홈페이지가 로그인 없이 봐야 하므로 public=true 로 anon GET 이 RLS 없이 바로 통과)
--      ② site_settings.promo_slides jsonb — [{id, url, caption}] 경량 목록만(이미지 자체는 Storage)
--      ③ portal_site_public() 에 promo_slides 추가 — 기존 bank/business/winner_stats 와 동행 노출.
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

-- ① Storage 버킷 — 공개(anon 이 공개 URL로 직접 GET, RLS 는 업로드/삭제만 통제).
insert into storage.buckets (id, name, public)
values ('promo-slides', 'promo-slides', true)
on conflict (id) do update set public = true;

drop policy if exists promo_slides_staff_all on storage.objects;
create policy promo_slides_staff_all on storage.objects
for all
using (
  bucket_id = 'promo-slides'
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active)
)
with check (
  bucket_id = 'promo-slides'
  and exists (select 1 from staff where auth_user_id = auth.uid() and is_active)
);

-- ② site_settings 목록 컬럼.
alter table site_settings
  add column if not exists promo_slides jsonb not null default '[]'::jsonb;

-- ③ 공개 조회 RPC에 promo_slides 추가(0013 portal_site_public 재정의 — select * 여전히 금지).
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
    'winner_stats', coalesce(winner_stats, '{"enabled":false,"count":0}'::jsonb),
    'promo_slides', coalesce(promo_slides, '[]'::jsonb)
  )
  from site_settings
  where id = 1;
$$;

grant execute on function public.portal_site_public() to anon, authenticated;
