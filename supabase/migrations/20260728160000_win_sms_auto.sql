-- 당첨 안내문자 자동발송 설정 (현장 피드백 7/28, 정의현 차장)
-- "당첨안내 문자발송은 자동으로 설정가능하도록 / 각 등수별(1,2,3,4,5) · 유료회원 · 무료회원
--  체크란을 만들어 선택한 분류만 당첨문자가 나갈 수 있도록"
-- 종전에는 자동발송이 없고 담당자가 '당첨 안내' 템플릿을 회원별로 골라 수동 발송하는 방법뿐이었다(D112 조사).
--
-- site_settings.win_sms(jsonb) 한 컬럼에 조건을 담는다.
--   enabled : 자동발송 사용(기본 false — 실제 고객에게 나가는 문자라 운영자가 설정에서 직접 켠다)
--   ranks   : 발송할 등수 배열 (예: [1,2,3])
--   paid    : 유료회원(gold/goldp/vip/royal) 대상 여부
--   free    : 그 외(무료·간편가입 등) 대상 여부
-- 발송 주체: ① 수기 '당첨 확정'(features/lotto/supa.ts) ② 매일 회차 자동적재 크론(api/weekly-lotto-sync.ts).
-- 중복발송 방지: members.meta.win_sms_rounds(발송한 회차 목록) — 재확정해도 같은 회차는 한 번만 나간다.
-- 실행: Supabase SQL Editor. 멱등(여러 번 실행 안전).

alter table site_settings
  add column if not exists win_sms jsonb not null
    default '{"enabled":false,"ranks":[1,2,3,4,5],"paid":true,"free":false}'::jsonb;

-- 기존 단일행(id=1)에 값이 비어 있으면 기본값으로 채운다.
update site_settings
   set win_sms = '{"enabled":false,"ranks":[1,2,3,4,5],"paid":true,"free":false}'::jsonb
 where id = 1
   and (win_sms is null or win_sms = '{}'::jsonb);

-- 가입환영문자 자동발송(현장 7/28) — 회원의 첫 결제 승인 시 1회 발송. 기본 꺼짐.
alter table site_settings
  add column if not exists join_sms_auto boolean not null default false;
