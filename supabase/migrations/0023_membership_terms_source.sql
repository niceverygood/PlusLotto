-- 0023 — 고객 등급별 약관의 단일 원본 통합 (현장 7/22, 정의현 차장)
-- 원인: 설정 > 이용약관은 terms_by_grade에 저장하지만 /terms/:grade는
--       portal_membership_tiers()의 membership_tiers[].terms만 읽어 홈페이지에 미반영됐다.
-- 원칙: 이용약관 화면의 terms_by_grade를 단일 원본으로 삼고, 등급 전용 약관이 없으면
--       공통 terms를 적용한다. 과거 멤버십 화면에만 입력한 약관은 먼저 안전하게 이관한다.

update public.site_settings as s
set terms_by_grade = coalesce(s.terms_by_grade, '{}'::jsonb) || coalesce(
  (
    select jsonb_object_agg(tier->>'grade', tier->>'terms')
    from jsonb_array_elements(coalesce(s.membership_tiers, '[]'::jsonb)) as tier
    where btrim(coalesce(tier->>'terms', '')) <> ''
      and not (coalesce(s.terms_by_grade, '{}'::jsonb) ? (tier->>'grade'))
  ),
  '{}'::jsonb
)
where s.id = 1;

create or replace function public.portal_membership_tiers()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_set(
        tier,
        '{terms}',
        to_jsonb(
          coalesce(
            nullif(btrim(s.terms_by_grade->>(tier->>'grade')), ''),
            s.terms,
            ''
          )
        ),
        true
      )
      order by ordinality
    ),
    '[]'::jsonb
  )
  from public.site_settings as s
  cross join lateral jsonb_array_elements(coalesce(s.membership_tiers, '[]'::jsonb))
    with ordinality as tiers(tier, ordinality)
  where s.id = 1;
$$;

grant execute on function public.portal_membership_tiers() to anon, authenticated;
