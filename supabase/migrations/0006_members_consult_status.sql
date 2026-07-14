-- D68 #1 — members.consult_status 컬럼 (레포↔라이브 스키마 드리프트 교정)
-- 코드/타입(types/db.ts)·인라인 상담상태 편집·회원 생성/임포트는 이미 consult_status 를 최상위 컬럼으로
-- 쓰는데 0001~0005 마이그레이션엔 ALTER 가 누락돼 있었다(라이브엔 수기로 추가돼 동작 중).
-- 새 환경 재구축/마이그레이션 재적용 시 PGRST204 가 나지 않도록 멱등 ALTER 로 동기화한다.
-- (라이브엔 이미 존재 → if not exists 로 안전한 no-op.)
alter table members
  add column if not exists consult_status text default '신규';

update members set consult_status = '신규' where consult_status is null;

create index if not exists members_consult_idx on members (consult_status);
