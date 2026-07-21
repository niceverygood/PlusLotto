-- 0014 — 고객 홈페이지 로그인 RPC portal_member_recos 신설 (긴급, 현장 7/21)
-- 배경: 코드(src/features/site/auth.tsx)와 문서(DECISIONS D 다수)에 이 RPC 가 이미 있다고
--       전제돼 있었지만, 실제로는 어느 마이그레이션에도 CREATE FUNCTION 이 없었다 — 88lotto 개발
--       당시 Supabase 대시보드에서 수동 생성돼 마이그레이션 이력에 누락된 것으로 추정. PlusLotto
--       신규 프로젝트(D88, 0001~0012 적용)에는 그래서 이 함수가 아예 없었고, 그 결과 고객 홈페이지
--       (무료·유료회원 공통) 로그인이 전부 실패("전화번호 또는 비밀번호가 일치하지 않습니다")했다.
-- 규칙: 전화번호로 회원 조회(삭제·탈퇴 제외, 동일 번호 복수면 최신 가입자) → 비밀번호는
--       meta.homepage_pw 우선, 없으면 전화번호 뒷 4자리(lib/homepage.ts::homepagePw 와 동일 규칙).
--       일치 시 {name, grade, recos} 만 반환(security definer 로 members RLS 우회, 그 외 컬럼 비노출).
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

create or replace function public.portal_member_recos(p_phone text, p_pw text)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  m record;
  expected_pw text;
begin
  select id, name, grade, phone, meta
  into m
  from members
  where regexp_replace(phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')
    and coalesce(is_deleted, false) = false
    and coalesce(is_withdrawn, false) = false
  order by registered_at desc
  limit 1;

  if not found then
    return null;
  end if;

  expected_pw := coalesce(m.meta ->> 'homepage_pw', right(regexp_replace(m.phone, '\D', '', 'g'), 4));

  if p_pw is null or p_pw <> expected_pw then
    return null;
  end if;

  return jsonb_build_object(
    'name', m.name,
    'grade', m.grade,
    'recos', coalesce(m.meta -> 'weekly_recos', '[]'::jsonb)
  );
end;
$$;

grant execute on function public.portal_member_recos(text, text) to anon, authenticated;
