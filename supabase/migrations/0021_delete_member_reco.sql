-- 0021 — 잘못 발급·발송한 회원 추천조합을 당첨 집계 대상과 문자내역에서 함께 제거한다.
-- 관리자(admin/manager)만 호출 가능하며, security invoker로 members/sms_sends RLS를 그대로 적용한다.

create or replace function public.admin_delete_member_reco(
  p_member_id text,
  p_round_no integer,
  p_issued_at text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_meta jsonb;
  v_history text;
  v_recos jsonb;
  v_next_recos jsonb;
  v_next_wins jsonb;
  v_deleted_issues integer := 0;
  v_deleted_sms integer := 0;
  v_same_round_remaining integer := 0;
  v_round_digits text := greatest(p_round_no, 0)::text;
  v_safe_round text;
begin
  if (select app_role()) is null or (select app_role()) not in ('admin', 'manager') then
    raise exception '추천조합 삭제 권한이 없습니다.' using errcode = '42501';
  end if;

  select coalesce(meta, '{}'::jsonb), win_history
    into v_meta, v_history
    from members
   where id = p_member_id
   for update;

  if not found then
    raise exception '회원을 찾을 수 없습니다.' using errcode = 'P0002';
  end if;

  v_recos := case
    when jsonb_typeof(v_meta->'weekly_recos') = 'array' then v_meta->'weekly_recos'
    else '[]'::jsonb
  end;

  select
    count(*) filter (
      where issue->>'round_no' = p_round_no::text
        and issue->>'issued_at' = p_issued_at
    ),
    coalesce(
      jsonb_agg(issue order by ord) filter (
        where not (
          issue->>'round_no' = p_round_no::text
          and issue->>'issued_at' = p_issued_at
        )
      ),
      '[]'::jsonb
    )
    into v_deleted_issues, v_next_recos
    from jsonb_array_elements(v_recos) with ordinality as rec(issue, ord);

  if v_deleted_issues = 0 then
    raise exception '삭제할 조합 발급내역을 찾을 수 없습니다.' using errcode = 'P0002';
  end if;

  select count(*)
    into v_same_round_remaining
    from jsonb_array_elements(v_next_recos) as rec(issue)
   where issue->>'round_no' = p_round_no::text;

  v_meta := jsonb_set(v_meta, '{weekly_recos}', v_next_recos, true);

  -- 같은 회차 발급분이 모두 사라졌을 때만 이미 계산된 추천 당첨기록도 제거한다.
  if v_same_round_remaining = 0 then
    select coalesce(
      jsonb_agg(win order by ord) filter (
        where not (win->>'source' = 'reco' and win->>'round_no' = p_round_no::text)
      ),
      '[]'::jsonb
    )
      into v_next_wins
      from jsonb_array_elements(
        case
          when jsonb_typeof(v_meta->'win_records') = 'array' then v_meta->'win_records'
          else '[]'::jsonb
        end
      ) with ordinality as wins(win, ord);
    v_meta := jsonb_set(v_meta, '{win_records}', v_next_wins, true);
  end if;

  update members
     set meta = v_meta,
         win_history = case
           when v_same_round_remaining = 0 and v_history like p_round_no::text || '회%' then null
           else v_history
         end
   where id = p_member_id;

  v_safe_round := case
    when length(v_round_digits) > 2
      then left(v_round_digits, length(v_round_digits) - 2) || '.' || right(v_round_digits, 2)
    else v_round_digits
  end;

  -- 최초 발급과 같은 시각의 문자, 또는 같은 회차가 더 없을 때 회차가 명시된 재발송 문자까지 제거한다.
  delete from sms_sends
   where member_id = p_member_id
     and type = 'recommend'
     and (
       sent_at = p_issued_at::timestamptz
       or (
         v_same_round_remaining = 0
         and position(E'\n' || v_safe_round || '회차' || E'\n' in body) > 0
       )
     );
  get diagnostics v_deleted_sms = row_count;

  insert into logs (id, kind, actor, action, target_type, target_id, meta, created_at)
  values (
    'log_' || gen_random_uuid(),
    'admin',
    (select app_staff_id()),
    'reco.issue_delete',
    'member',
    p_member_id,
    jsonb_build_object(
      'round_no', p_round_no,
      'issued_at', p_issued_at,
      'deleted_issues', v_deleted_issues,
      'deleted_sms', v_deleted_sms
    ),
    now()
  );

  return jsonb_build_object(
    'deleted_issues', v_deleted_issues,
    'deleted_sms', v_deleted_sms
  );
end
$function$;

revoke all on function public.admin_delete_member_reco(text, integer, text) from public;
revoke all on function public.admin_delete_member_reco(text, integer, text) from anon;
grant execute on function public.admin_delete_member_reco(text, integer, text) to authenticated;
