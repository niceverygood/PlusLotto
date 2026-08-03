-- 회원·결제 상태 뱃지 색 설정 (현장 피드백 8/3, 정의현 차장 — "회원 상태별 색깔 지정도 설정에서
-- 변경할 수 있도록 부탁드리겠습니다. 예) 취소 > 빨강")
-- grade_colors(등급색)와 동일 패턴이지만, 상태값끼리 톤(success/danger/gray 등)을 공유하므로(§3)
-- 톤이 아니라 상태값(active/suspended/.../cancelled) 8개 키로 독립 저장한다.
-- 빈 객체 기본값 → 클라이언트(lib/statusColors.ts normalizeStatusColors)가 미설정 키를 톤 기본색으로
-- 채운다(app_download·promo_slides 와 동일한 점진 배포 안전장치).

alter table public.site_settings
  add column if not exists status_colors jsonb not null default '{}'::jsonb;
