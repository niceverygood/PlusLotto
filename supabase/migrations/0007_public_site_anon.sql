-- 0007 — 고객 홈페이지(/portal, anon 키) 공개 접근 (현장 6/29 — 회원용 홈페이지 신설)
-- 배경: 기존 0002_rls.sql 정책이 전부 `to authenticated` 라, 고객 사이트의 anon 키로는
--       회차/공지/FAQ SELECT 와 가입문의/1:1문의 INSERT 가 RLS 로 전부 차단된다.
--       (회원 로그인은 portal_member_recos RPC = security definer 라 anon 에서도 정상.)
-- 이 마이그레이션이 '공개해도 되는 읽기'와 '문의 접수 쓰기'만 anon 에 연다.
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전). authenticated 정책은 그대로(영향 없음).

-- ① 로또 회차 결과 — 공개 정보(자료실/홈 미리보기). anon 읽기 허용.
drop policy if exists lotto_rounds_public_read on lotto_rounds;
create policy lotto_rounds_public_read on lotto_rounds
  for select to anon using (true);

-- ② 공지사항 — 게시(published)된 것만 anon 읽기.
drop policy if exists notices_public_read on notices;
create policy notices_public_read on notices
  for select to anon using (published = true);

-- ③ FAQ — 게시된 것만 anon 읽기.
drop policy if exists faqs_public_read on faqs;
create policy faqs_public_read on faqs
  for select to anon using (published = true);

-- ④ 1:1 문의 / 가입문의 — anon 이 접수(INSERT)만 가능. 열람(SELECT)은 운영자 전용(정책 안 줌).
--    가입은 직접 members INSERT 가 아니라 inquiries(category='가입문의')로 접수 → 운영자 후처리.
drop policy if exists inquiries_public_insert on inquiries;
create policy inquiries_public_insert on inquiries
  for insert to anon with check (true);

-- 참고: 회원 본인 추천번호/등급 조회는 portal_member_recos(전화+비번) RPC 로 처리되어
--       members 테이블에 anon SELECT 를 열지 않는다(개인정보 보호).
