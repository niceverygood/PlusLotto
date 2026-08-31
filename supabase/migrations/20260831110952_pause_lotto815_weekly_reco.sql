-- 815 레거시 1차 이관분 자동 조합발급/문자 안전 격리.
--
-- 운영 적용 전 확인:
--   select count(*) from public.members
--   where meta->>'source_site' = 'lotto815'
--     and meta->>'import_batch' = 'lotto815-20260831';
-- 기대값은 19,829명이다. 다른 회원은 절대 갱신하지 않는다.
--
-- 이 마이그레이션은 아직 운영 DB에 적용하지 않는다. 표본 검수와 자동발송 설정 확인 후
-- 승인된 배포 절차에서만 적용한다. 이전 값을 별도 키에 보존해 후속 해제도 배치 단위로 제한한다.
do $$
declare
  cohort_count bigint;
  changed_count bigint;
begin
  select count(*)
    into cohort_count
  from public.members
  where meta->>'source_site' = 'lotto815'
    and meta->>'import_batch' = 'lotto815-20260831';

  -- 빈 개발/신규 환경에서는 그대로 통과한다. 운영에 일부만 있거나 대상이 달라졌다면
  -- 잘못된 대량 갱신을 피하기 위해 전체 트랜잭션을 실패시킨다.
  if cohort_count <> 0 and cohort_count <> 19829 then
    raise exception
      'lotto815-20260831 cohort mismatch: expected 19829, actual %',
      cohort_count;
  end if;

  update public.members
  set meta = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          coalesce(meta, '{}'::jsonb),
          '{legacy_reco_pause_previous}',
          coalesce(meta->'reco_paused', 'null'::jsonb),
          true
        ),
        '{reco_paused}',
        'true'::jsonb,
        true
      ),
      '{reco_pause_reason}',
      '"legacy_import_review"'::jsonb,
      true
    ),
    '{legacy_reco_pause_batch}',
    '"lotto815-20260831"'::jsonb,
    true
  )
  where meta->>'source_site' = 'lotto815'
    and meta->>'import_batch' = 'lotto815-20260831'
    and meta->>'legacy_reco_pause_batch' is distinct from 'lotto815-20260831';

  get diagnostics changed_count = row_count;

  raise notice 'lotto815-20260831 reco paused: cohort %, changed %', cohort_count, changed_count;
end
$$;
