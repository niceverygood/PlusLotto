-- 디비 일괄 임포트 실패 근본 원인 (현장 8/12, 정의현 차장 — "디비 일괄 임포트가 안되고 있습니다")
--
-- enforce_member_admin_ops() 의 전화 중복 검사는 이렇게 생겼다:
--   where regexp_replace(coalesce(m.phone,''), '\D','','g') = v_phone
-- 좌변이 표현식이라 phone 컬럼 인덱스를 못 탄다 → **행 하나 INSERT 할 때마다 members 전체를
-- 순차 스캔**한다. 회원이 15만 명이면 100행짜리 청크 한 번에 1,500만 행을 훑는 셈이라, 회원이
-- 늘수록 요청이 게이트웨이/문장 타임아웃을 넘겨 임포트가 통째로 실패한다.
-- (7/30 에 청크를 500→100 으로 줄여 한 번 넘겼고, 8/12 에 같은 이유로 다시 터졌다.)
--
-- 같은 표현식에 함수 인덱스를 만들면 스캔이 인덱스 조회로 바뀐다. 트리거 본문은 건드리지 않는다
-- (D130 교훈 — 누적 패치된 함수는 재정의하지 않는다).
--
-- immutable 로 표시된 regexp_replace(text,text,text,text) 4인자 형태를 그대로 써야 인덱스에 쓸 수
-- 있다. coalesce 는 immutable 이므로 표현식 전체가 인덱스 가능하다.
create index if not exists members_phone_digits_idx
  on public.members ((regexp_replace(coalesce(phone, ''), '\D', '', 'g')));

-- 중복 필터(admin_members_page 의 dupPhone)가 쓰는 count(*) 서브쿼리도 같은 표현식이라 함께 빨라진다.
comment on index public.members_phone_digits_idx is
  '전화번호 숫자만 추출한 값 인덱스 — 중복 회원 검사 트리거(enforce_member_admin_ops)와 중복DB 필터가 사용. 없으면 임포트가 회원 수에 비례해 느려져 타임아웃난다.';
