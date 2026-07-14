-- 0009 — 추천조합 생성 과정 기록 (현장 7/3, 정의현 차장 "녹화기능")
-- 배경: 제외수 세팅 작업 시 "번호 생성 과정"을 증빙(특허·불기소이유서 근거자료)으로 남기고 싶다는
--       요청. 화면 녹화 대신, 실제로 어떤 규칙으로 어떤 번호가 제외됐고 어떤 조합이 나왔는지를
--       빠짐없이 기록하는 편이 더 확실한 증빙이 된다 — [추천번호] 화면에서 미리보기 생성 시
--       "기록 저장"을 누르면 규칙 스냅샷·번호별 제외사유·남은 풀·최종 조합을 통째로 남긴다.
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

alter table site_settings
  add column if not exists generation_records jsonb not null default '[]'::jsonb;
