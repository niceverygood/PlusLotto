import { useState } from 'react'
import { Button, LottoBalls, Tabs } from '@/design-system/components'
import { krw } from '@/lib/format'
import { useLegacyMemberHistory } from './api'
import { formatLegacySourceDatetime, type LegacyHistoryKind } from './legacyHistory'

const tabs = [{ key: 'memo', label: '상담메모' }, { key: 'sms', label: '문자기록' }, { key: 'win', label: '당첨기록' }]

export function LegacyHistorySection({ memberId }: { memberId: string }) {
  const [kind, setKind] = useState<LegacyHistoryKind>('memo')
  const query = useLegacyMemberHistory(memberId, kind)
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? []
  return <section aria-label="815 이전 전산 이력" className="space-y-4">
    <p className="text-sm text-gray-500">815 이전 전산에 기록된 내용입니다. 아래 시각은 원본 기록 시각이며, 문자 접수·도달 여부와 다를 수 있습니다.</p>
    <Tabs tabs={tabs} value={kind} onChange={(value) => setKind(value as LegacyHistoryKind)} />
    {query.isPending && <p role="status" className="py-6 text-center text-sm text-gray-500">이력을 불러오는 중입니다.</p>}
    {query.isError && <div role="alert" className="rounded-lg border border-gray-200 p-4 text-sm text-gray-700">
      과거 이력을 불러오지 못했습니다.
      <Button variant="sec" size="sm" className="ml-3" onClick={() => void query.refetch()}>다시 시도</Button>
    </div>}
    {!query.isPending && !query.isError && rows.length === 0 && <p className="py-6 text-center text-sm text-gray-500">조회할 수 있는 과거 이력이 없습니다.</p>}
    <div className="space-y-3">{rows.map((row) => <article key={`${row.kind}:${row.legacy_idx}:${row.kind === 'win' ? row.round_no : ''}`} className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="mb-2 font-mono text-xs tabular-nums text-gray-500">{formatLegacySourceDatetime(row.source_insert_datetime)}</p>
      {row.kind === 'memo' && <p className="whitespace-pre-wrap break-words text-sm text-gray-800">{row.body || '내용 없음'}</p>}
      {row.kind === 'sms' && <>
        {row.subject && <p className="mb-1 font-semibold text-gray-800">{row.subject}</p>}
        <p className="whitespace-pre-wrap break-words text-sm text-gray-800">{row.body_policy === 'body_preserved' ? row.body || '내용 없음' : '본문은 원본 자료에 별도 보관되어 있습니다.'}</p>
      </>}
      {row.kind === 'win' && <div className="space-y-2">
        <div className="flex items-center justify-between text-sm text-gray-800"><span>{row.round_no}회 · {row.rank}등</span><span className="font-mono tabular-nums">{krw(Number(row.prize))}</span></div>
        <LottoBalls numbers={row.numbers} />
      </div>}
    </article>)}</div>
    {query.hasNextPage && <Button variant="sec" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '불러오는 중…' : '이전 기록 더 보기'}</Button>}
  </section>
}
