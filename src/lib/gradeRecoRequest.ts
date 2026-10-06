/** 등급 일괄 발급은 추가 발급 UUID 없이 서버의 기존 회차당 1회 원장을 사용한다. */
export async function requestGradeRecoBatch(memberIds: string[], accessToken: string, fetcher: typeof fetch = fetch): Promise<{ issued: number; skipped: number; round_no: number }> {
  if (!accessToken || memberIds.length < 1 || memberIds.length > 50 || new Set(memberIds).size !== memberIds.length) {
    throw new Error('로그인과 발급 대상 명단을 확인해 주세요.')
  }
  const review = '발급 처리 결과를 확인하지 못했습니다. 자동 재시도하지 않았으므로 발급 내역을 확인해 주세요.'
  let response: Response
  let value: unknown
  try {
    response = await fetcher('/api/weekly-reco', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ memberIds, mode: 'manual', alsoSms: false, dryRun: false }),
    })
    value = await response.json()
  } catch { throw new Error(review) }
  if (!response.ok || !value || typeof value !== 'object') throw new Error(review)
  const data = value as Record<string, unknown>
  if (data.ok !== true || !Number.isInteger(data.round_no) || Number(data.round_no) < 1
    || data.smsSent !== 0 || data.smsFail !== 0 || data.reviewRequired !== 0 || data.errors !== 0
    || data.remaining !== 0 || !Array.isArray(data.results) || data.results.length !== memberIds.length) throw new Error(review)
  const seen = new Set<string>()
  let issued = 0
  for (const raw of data.results) {
    if (!raw || typeof raw !== 'object') throw new Error(review)
    const row = raw as Record<string, unknown>
    if (typeof row.member_id !== 'string' || !memberIds.includes(row.member_id) || seen.has(row.member_id)
      || row.round_no !== data.round_no) throw new Error(review)
    seen.add(row.member_id)
    if (row.status === 'issued' && row.sms_outcome === 'not_requested') issued++
    else if (row.status !== 'skipped') throw new Error(review)
  }
  if (data.issued !== issued) throw new Error(review)
  return { issued, skipped: memberIds.length - issued, round_no: data.round_no as number }
}
