// 로또기록 (BUILD_PROMPTS Phase 6 — 스샷 있음, 원본 구조 재현).
// 회차 리스트(최신순) + 확정/미확정 필터 탭 + 회차 등록 + 행별 '당첨 확정'(§8 베팅 채점·당첨자 갱신).
// 행 클릭 → /bets?round=N 으로 이동해 해당 회차 베팅을 필터링(검수 항목).
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, Plus } from 'lucide-react'
import { Button, ConfirmModal, DataTable, PageHeader, Tabs, type TabItem } from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useUrlFilters } from '@/lib/useUrlFilters'
import { date, num } from '@/lib/format'
import { downloadCsv } from '@/lib/csv'
import { useConfirmRound, useLottoHealth, useRounds, type RoundFilter } from './api'
import { lottoColumns } from './columns'
import { RoundFormModal } from './RoundFormModal'
import { LottoHealthPanel } from './LottoHealthPanel'
import { useCurrentUser } from '@/lib/auth'

const FILTER_TABS: { key: RoundFilter; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'pending', label: '미확정' },
  { key: 'confirmed', label: '확정' },
]

export function LottoResultsPage() {
  usePageMeta('로또기록', '회차별 당첨번호 · 당첨금 · 당첨 확정')
  const navigate = useNavigate()
  const { get, set } = useUrlFilters()
  const filter = (get('f') ?? 'all') as RoundFilter

  const [registerOpen, setRegisterOpen] = useState(false)
  const [confirmNo, setConfirmNo] = useState<number | null>(null)

  const roundQuery = useRounds(filter)
  const allRoundQuery = useRounds('all')
  const { data: rows = [], isLoading } = roundQuery
  const { data: allRows = [] } = allRoundQuery
  const confirmRound = useConfirmRound()
  const health = useLottoHealth()
  const user = useCurrentUser()
  const [queuedRound, setQueuedRound] = useState<number | null>(null)

  const columns = useMemo(() => lottoColumns({
    onConfirm: setConfirmNo,
    canConfirm: user?.role === 'admin' || user?.role === 'manager',
    pendingRounds: new Set(health.data?.jobs.filter((job) => job.status === 'pending' || job.status === 'running').map((job) => job.round_no)),
  }), [health.data, user?.role])

  const counts = useMemo(() => {
    const pending = allRows.filter((r) => r.confirmed_at == null).length
    return { all: allRows.length, pending, confirmed: allRows.length - pending }
  }, [allRows])

  const tabs: TabItem[] = FILTER_TABS.map((t) => ({ key: t.key, label: t.label, count: allRoundQuery.isError || allRoundQuery.isLoading ? undefined : counts[t.key] }))

  // 로또기록 엑셀(CSV) 다운로드 — 현재 필터 기준, 등수별(1~5등) 누적 건수 포함.
  const onDownloadCsv = () => {
    downloadCsv(
      `로또기록_${new Date().toISOString().slice(0, 10)}.csv`,
      ['회차', '추첨일', '당첨번호', '보너스', '합', '홀짝', '1등 당첨금', '2등 당첨금', '3등 당첨금',
       '총판매금액', '베팅수', '베팅 당첨수', '베팅 1등', '베팅 2등', '베팅 3등', '베팅 4등', '베팅 5등', '상태'],
      rows.map((r) => [
        r.round_no,
        date(r.draw_date),
        r.numbers.join(' '),
        r.bonus,
        r.sum,
        r.odd_even,
        r.prize_1 ?? 0,
        r.prize_2 ?? 0,
        r.prize_3 ?? 0,
        r.total_sales ?? 0,
        r.betCount,
        r.winnerCount,
        ...r.rankCounts,
        r.confirmed_at ? '확정' : '미확정',
      ]),
    )
  }

  const onConfirmRound = () => {
    if (confirmNo == null) return
    confirmRound.mutate(
      { roundNo: confirmNo },
      { onSuccess: () => { setQueuedRound(confirmNo); setConfirmNo(null) } },
    )
  }

  return (
    <div>
      <PageHeader
        title="로또기록"
        description="회차별 당첨번호와 집계 진행 상태를 확인합니다. 표의 당첨 건수는 베팅 기준이며, 추천조합 당첨회원은 상단 집계와 이용자 메뉴에서 확인합니다."
        actions={
          <>
            <Button
              variant="gho"
              icon={<Download className="h-4 w-4" />}
              onClick={onDownloadCsv}
              disabled={rows.length === 0 || roundQuery.isError}
            >
              엑셀 다운로드
            </Button>
            <Button variant="pri" icon={<Plus className="h-4 w-4" />} onClick={() => setRegisterOpen(true)}>
              회차 등록
            </Button>
          </>
        }
      />

      <LottoHealthPanel />
      {queuedRound !== null && (
        <p role="status" className="mb-3 rounded-md border border-info-bd bg-info-bg p-3 text-sm text-gray-700">
          {queuedRound}회차 집계 요청이 접수됐습니다. 자동 처리 후 상단 집계 현황에서 완료 여부를 확인해 주세요. 이 요청으로 안내문자를 발송하지 않습니다.
        </p>
      )}
      {confirmRound.isError && <p role="alert" className="mb-3 rounded-md border border-danger-bd bg-danger-bg p-3 text-sm text-danger">집계 요청을 접수하지 못했습니다. 상태를 새로고침한 뒤 확인해 주세요.</p>}
      <Tabs tabs={tabs} value={filter} onChange={(k) => set('f', k === 'all' ? null : k)} className="mb-3" />

      {roundQuery.isError ? (
        <div role="alert" className="rounded-lg border border-danger-bd bg-danger-bg p-4 text-sm text-gray-700">
          <p className="font-bold text-danger">회차 목록을 불러오지 못했습니다.</p>
          <p className="mt-1">회차가 0건이라는 뜻이 아닙니다. 조회 상태를 확인한 뒤 다시 시도해 주세요.</p>
          <Button className="mt-3" variant="sec" size="sm" disabled={roundQuery.isFetching} onClick={() => void roundQuery.refetch()}>목록 다시 조회</Button>
        </div>
      ) : <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.round_no)}
        isLoading={isLoading}
        onRowClick={(r) => navigate(`/bets?round=${r.round_no}`)}
        resultLabel={(total) => (
          <>
            회차 <b className="font-mono text-ink-800 tnum">{num(total)}</b>건
          </>
        )}
      />}

      <RoundFormModal open={registerOpen} onClose={() => setRegisterOpen(false)} />

      <ConfirmModal
        open={confirmNo != null}
        onClose={() => { setConfirmNo(null); confirmRound.reset() }}
        onConfirm={onConfirmRound}
        loading={confirmRound.isPending}
        title={`${confirmNo ?? ''}회차 당첨 집계 요청`}
        confirmText="집계 요청"
        description={
          <>
            해당 회차의 베팅·추천조합을 채점하는 작업을 등록합니다. 자동 처리 후 회원별 <b>당첨이력(회차·등수)</b>과
            이용자 목록의 <b>당첨회차·당첨등수 필터</b>에 반영됩니다.
            <br />
            요청 접수 후에도 집계가 끝날 때까지 시간이 걸릴 수 있습니다. 진행 중인 회차는 중복 요청하지 않으며, 수동 집계 요청으로 안내문자를 발송하지 않습니다.
            {confirmRound.isError && <span role="alert" className="mt-3 block text-danger">집계 요청을 접수하지 못했습니다. 창을 닫고 상태를 새로고침한 뒤 확인해 주세요.</span>}
          </>
        }
      />
    </div>
  )
}
