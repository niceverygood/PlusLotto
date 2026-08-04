-- 조합문자 본문 템플릿화 (현장 피드백 8/4, 정의현 차장 — "조합문자 발송 내용을 설정 > 기본문자
-- 템플릿에서 수정하면 변경할수 있도록. 스팸관련해서 지속적으로 문자발송 내용을 변경해야해서")
--
-- 지금까지 조합문자(추천번호) 본문은 코드 하드코딩(recoSmsBody / 크론 formatComboSms)이라
-- 'recommend' 템플릿 행의 body 는 발송에 쓰이지 않는 죽은 텍스트였다. 이번 배포부터 모든 조합문자
-- 경로(회원정보창 수동발급·추천 템플릿 일괄발송·유료회원 자동발송 크론)가 이 행의 body 를 읽는다.
-- 배포 직후 발송 내용이 달라지지 않도록, body 를 현재 실발송 포맷으로 맞춰 둔다.
-- 변수: $round(스팸회피 회차표기 1233→12.33) · $name(회원명) · $num(조합 리스트 [1] n,n,…).
-- 가입환영(join)·약관(terms)은 이미 템플릿 본문으로 발송되고 있어 변경 없음.

insert into public.sms_templates (key, title, body, category)
values ('recommend', '추천번호 안내', E'plus No. $round\n$name님\n$num', 'recommend')
on conflict (key) do update set body = excluded.body;
