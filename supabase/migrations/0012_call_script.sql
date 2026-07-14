-- 0012 — 통화 AI 분석 기준 스크립트 (현장 7/10, 정의현 차장)
-- 배경: 1차/2차 영업콜 녹취를 AI 분석해 성공요인/실패요인/스크립트 유사성을 보여달라는 요청.
--       유사성 비교의 기준이 될 회사 상담 스크립트를 설정에서 입력할 수 있게 한다(선택 입력,
--       비워두면 AI 분석에서 유사성 항목은 생략된다).
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

alter table site_settings
  add column if not exists call_script text not null default '';
