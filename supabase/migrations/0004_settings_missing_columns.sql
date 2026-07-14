-- 0004 — site_settings 누락 컬럼 추가 (문자 설정 저장 실패 버그 / DECISIONS D60)
-- 원인: SiteSettings 타입에 weekly_free_reco(D49)·terms_by_grade(D57) 가 추가됐으나
--       라이브 테이블엔 ALTER 누락. settings/supa.ts 의 saveSiteSettings 가
--       update({ ...next }) 로 SiteSettings 전체를 쓰므로, 없는 컬럼에서
--       PGRST204("Could not find the 'weekly_free_reco' column ... in the schema cache")
--       → 문자 설정(발신번호·실발송 등) 포함 모든 설정 저장이 통째로 실패.
-- 검증: weekly_free_reco 포함 PATCH=PGRST204 실패 / sms 단독 PATCH=성공 (2026-06-18).
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

alter table site_settings
  add column if not exists weekly_free_reco jsonb not null
    default '{"enabled":true,"set_count":30,"logic_ratio":100}';

alter table site_settings
  add column if not exists terms_by_grade jsonb not null default '{}';
