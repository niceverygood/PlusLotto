-- 9/14 검수 요청: 실장(leader) 이상이 815 이전 전산 이력을 전체 검토한다.
-- D51/D55의 회원 범위와 일치시킨다. 팀장(rep)은 본인 담당 회원만 조회한다.
-- 비공개 상담메모도 검수 대상에 포함하되 원본 공개 여부 필드는 그대로 보존한다.
-- SELECT 정책만 변경한다. 원본 출처/회원키, 쓰기 권한, INVOKER RPC, 발송 보류는 유지한다.

ALTER POLICY legacy_memos_member_read ON public.legacy_member_memos USING (
  EXISTS (SELECT 1 FROM public.members m WHERE m.id=member_id
    AND public.member_operating_site(m)=source_site AND m.meta->>'legacy_idx'=source_user_idx::text
    AND ((SELECT public.app_role()) IN ('admin','manager','leader')
      OR ((SELECT public.app_role())='rep' AND m.assigned_staff_id=(SELECT public.app_staff_id()))))
);

ALTER POLICY legacy_sms_member_read ON public.legacy_member_sms USING (
  EXISTS (SELECT 1 FROM public.members m WHERE m.id=member_id
    AND public.member_operating_site(m)=source_site AND m.meta->>'legacy_idx'=source_user_idx::text
    AND ((SELECT public.app_role()) IN ('admin','manager','leader')
      OR ((SELECT public.app_role())='rep' AND m.assigned_staff_id=(SELECT public.app_staff_id()))))
);

ALTER POLICY legacy_wins_member_read ON public.legacy_member_wins USING (
  EXISTS (SELECT 1 FROM public.members m WHERE m.id=member_id
    AND public.member_operating_site(m)=source_site AND m.meta->>'legacy_idx'=source_user_idx::text
    AND ((SELECT public.app_role()) IN ('admin','manager','leader')
      OR ((SELECT public.app_role())='rep' AND m.assigned_staff_id=(SELECT public.app_staff_id()))))
);
