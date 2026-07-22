-- 0020 — 약관 SMS는 전문이 아니라 회원 등급의 공개 약관 페이지 링크를 발송한다.
update sms_templates
set body = '[플러스로또] $name님, 가입하신 등급의 이용약관을 확인해 주세요.' || chr(10) || '$link'
where key = 'terms';
