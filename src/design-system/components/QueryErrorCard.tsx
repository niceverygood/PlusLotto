// 조회 실패를 화면에 드러내는 카드.
//
// 목록 화면이 오류를 무시하면 `data` 가 undefined 가 되고, 표는 "데이터가 없습니다"를 그린다.
// 현장은 그것을 '조회 실패'가 아니라 '실제로 건수가 0'으로 읽는다. 매출 화면에서 이 문제가
// 8/31에 실제로 났고(D176 — RPC 시간초과를 0원으로 표시), 결제 화면에서 9/11에 다시 났다
// (탭 건수는 1,519인데 목록만 비어 있었다).
//
// 그래서 오류는 반드시 오류로 보이게 하고, 재시도 버튼을 함께 준다.
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

/** unknown 에서 사람이 읽을 메시지만 뽑는다. 없으면 null. */
export function queryErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message.trim() || null
  if (typeof error !== 'object' || error === null || !('message' in error)) return null
  const message = (error as { message: unknown }).message
  return typeof message === 'string' ? message.trim() || null : null
}

export function QueryErrorCard({
  title,
  description,
  error,
  isRetrying,
  onRetry,
}: {
  title: string
  /** 왜 0 이 아닌지 한 줄로. 현장이 '실제 0건'으로 오해하지 않게 한다. */
  description: string
  error: unknown
  isRetrying: boolean
  onRetry: () => void
}) {
  const detail = queryErrorMessage(error)

  return (
    <section role="alert" className="rounded-xl border border-danger-bd bg-danger-bg px-5 py-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-danger">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold text-ink-900">{title}</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-gray-600">{description}</p>
          {detail && (
            <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-danger">조회 오류: {detail}</p>
          )}
        </div>
        <Button
          variant="sec"
          icon={<RefreshCw className={cn('h-3.5 w-3.5', isRetrying && 'animate-spin')} />}
          disabled={isRetrying}
          onClick={onRetry}
        >
          {isRetrying ? '재시도 중' : '다시 시도'}
        </Button>
      </div>
    </section>
  )
}
