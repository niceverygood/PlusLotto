// 실패 기록만으로는 업체 미접수가 확인되지 않는다. 접수 대조 경로가 마련될 때까지
// 자동 크론과 수동 일괄 재발송을 모두 중지한다(D207). 최초 문자 발송 경로는 그대로다.
// 충전 후에도 자동 재발송하지 않는다. 동일 실패 행/동시 호출도 업체·DB에 접근하지 않는다.
// UI 안내와는 별도의 서버 경계이며, 임의 query/body/metadata로 해제할 수 없다.

interface RetryRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  query?: Record<string, unknown>
}
interface RetryResponse {
  status(code: number): RetryResponse
  json(body: Record<string, unknown>): unknown
}

export default async function handler(req: RetryRequest, res: RetryResponse) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, code: 'METHOD' })
  const secret = process.env.CRON_SECRET
  if (!secret) return res.status(500).json({ ok: false, code: 'CONFIG', message: 'CRON_SECRET 미설정' })
  if (req.headers?.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false, code: 'AUTH' })

  return res.status(200).json({
    ok: true,
    skipped: 'receipt_confirmation_required',
    code: 'RECEIPT_CONFIRMATION_REQUIRED',
    automaticRetryEnabled: false,
    dryRun: String(req.query?.dryRun ?? '') === '1',
    attempted: 0,
    sent: 0,
    wouldSend: 0,
    message: '업체 접수 여부 확인 전 자동·일괄 재발송을 중지했습니다. 충전 후에도 자동 재발송하지 않습니다. 미접수 확인 후 해당 회원에게 개별 1회 처리해 주세요.',
  })
}
