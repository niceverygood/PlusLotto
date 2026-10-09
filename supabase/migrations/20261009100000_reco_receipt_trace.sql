-- 조합 문자 접수 영수증에 업체 대조용 발송 사실을 남긴다 (현장 10/9).
--
-- 증상: 10/9 1245회 자동발송에서 3명이 문자를 못 받았다. 원장에는 3명 모두 09:08 업체 접수
--   성공(code 0)으로 남았지만, 업체 전송내역에는 없었다.
-- 원인 추적 한계: 영수증이 code·cmid·httpStatus·body 4개만 남겼다. 업체 응답에 건별 식별값(cmid)이
--   없고, 실제로 쓴 발신번호·요청 시각·추적번호도 남지 않아 업체 내역과 1:1 대조가 불가능했다.
-- 처방: 앱이 업체에 tran_id(원장 UUID 의 36진수)를 실어 보내고, 영수증에 아래 값을 함께 저장한다.
--   tranId · provider · sender(사이트별로 다시 고른 실제 발신번호) · dest · msgType ·
--   providerHttpStatus · requestedAt · respondedAt · message · vendor(업체 응답의 단순 값만)
--   원응답 객체를 통째로 저장하지 않는 원칙은 유지한다 — 형식을 검증한 명시 필드와, 키·값 길이와
--   개수를 제한하고 토큰류 키를 뺀 scalar 값만 남긴다. 함수 시그니처·권한·상태 전이는 그대로다.
-- 배포 순서: 앱 배포 전후 어느 쪽이 먼저여도 안전하다(이전 함수는 새 필드를 무시하고, 새 함수는
--   새 필드가 없으면 기존과 같은 영수증을 만든다).
CREATE OR REPLACE FUNCTION public.reco_issue_finish(p_claim_id uuid,p_claim_token uuid,p_outcome text,p_receipt jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
  SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE l public.reco_issue_ledger; v_receipt jsonb; v_trace jsonb; v_vendor jsonb; code text; updated integer;
BEGIN
  IF current_user <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING ERRCODE='42501'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','unknown','not_requested')
    OR jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR octet_length(p_receipt::text)>65536 THEN
    RAISE EXCEPTION 'INVALID_OUTCOME' USING ERRCODE='22023';
  END IF;
  SELECT * INTO l FROM public.reco_issue_ledger WHERE id=p_claim_id FOR UPDATE;
  IF NOT FOUND OR p_claim_token IS NULL OR l.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'INVALID_CLAIM' USING ERRCODE='22023';
  END IF;
  IF NOT l.should_send AND p_outcome<>'not_requested' THEN RAISE EXCEPTION 'SMS_NOT_REQUESTED' USING ERRCODE='22023'; END IF;
  code:=left(regexp_replace(coalesce(p_receipt->>'code',p_outcome),'[^a-zA-Z0-9_:-]','','g'),80);
  -- Only explicit receipt fields are retained; never persist a raw provider object/tokens.
  v_receipt:=jsonb_build_object('code',code,'cmid',left(regexp_replace(p_receipt->>'cmid','[[:cntrl:]]','','g'),128),
    'httpStatus',CASE WHEN p_receipt->>'httpStatus' ~ '^[1-5][0-9][0-9]$' THEN (p_receipt->>'httpStatus')::integer ELSE NULL END,
    'body',left(coalesce(p_receipt->>'body',''),20000));
  -- 업체 응답의 단순 값(scalar)만: 키 40자 영숫자·값 200자·최대 20개, 토큰류 키 제외.
  SELECT jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value)='string'
      THEN to_jsonb(left(regexp_replace(e.value#>>'{}','[[:cntrl:]]','','g'),200)) ELSE e.value END)
    INTO v_vendor
    FROM (SELECT key, value FROM jsonb_each(CASE WHEN jsonb_typeof(p_receipt->'vendor')='object'
            THEN p_receipt->'vendor' ELSE '{}'::jsonb END)
          WHERE key ~ '^[A-Za-z0-9_]{1,40}$' AND key !~* '(token|secret|key|auth|pass)'
            AND jsonb_typeof(value) IN ('string','number','boolean')
          ORDER BY key LIMIT 20) e;
  v_trace:=jsonb_strip_nulls(jsonb_build_object(
    'tranId',CASE WHEN p_receipt->>'tranId' ~ '^[A-Za-z0-9_-]{1,30}$' THEN p_receipt->>'tranId' END,
    'provider',CASE WHEN p_receipt->>'provider' IN ('oneshot','solapi') THEN p_receipt->>'provider' END,
    'sender',CASE WHEN p_receipt->>'sender' ~ '^[0-9]{1,20}$' THEN p_receipt->>'sender' END,
    'dest',CASE WHEN p_receipt->>'dest' ~ '^[0-9]{1,20}$' THEN p_receipt->>'dest' END,
    'msgType',CASE WHEN p_receipt->>'msgType' IN ('SMS','LMS','MMS') THEN p_receipt->>'msgType' END,
    'providerHttpStatus',CASE WHEN p_receipt->>'providerHttpStatus' ~ '^[1-5][0-9][0-9]$'
      THEN (p_receipt->>'providerHttpStatus')::integer END,
    'requestedAt',CASE WHEN p_receipt->>'requestedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
      THEN p_receipt->>'requestedAt' END,
    'respondedAt',CASE WHEN p_receipt->>'respondedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
      THEN p_receipt->>'respondedAt' END,
    'message',NULLIF(left(regexp_replace(coalesce(p_receipt->>'message',''),'[[:cntrl:]]','','g'),300),''),
    'vendor',NULLIF(v_vendor,'{}'::jsonb)));
  v_receipt:=v_receipt||v_trace;
  IF l.status<>'claimed' THEN
    IF l.status=p_outcome AND l.receipt=v_receipt THEN
      RETURN jsonb_build_object('ok',true,'status',l.status,'outcome',l.status,'repeated',true);
    END IF;
    RAISE EXCEPTION 'ALREADY_FINALIZED' USING ERRCODE='22023';
  END IF;
  IF l.should_send THEN
    UPDATE public.sms_sends SET body=v_receipt->>'body', status=CASE
      WHEN p_outcome='accepted' THEN '발송완료'
      WHEN p_outcome='not_requested' THEN '발송보류(조합요청취소)'
      ELSE '접수확인필요(조합:'||code||')' END
      WHERE id='sms_reco_claim_'||l.id::text AND member_id=l.member_id AND phone=l.phone;
    GET DIAGNOSTICS updated=ROW_COUNT;
    IF updated<>1 THEN RAISE EXCEPTION 'SMS_RECORD_MISSING' USING ERRCODE='22023'; END IF;
  END IF;
  UPDATE public.reco_issue_ledger SET status=p_outcome,receipt=v_receipt,finished_at=now() WHERE id=l.id;
  RETURN jsonb_build_object('ok',true,'status',p_outcome,'outcome',p_outcome,'repeated',false);
END $$;

REVOKE ALL ON FUNCTION public.reco_issue_finish(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reco_issue_finish(uuid,uuid,text,jsonb) TO service_role;
