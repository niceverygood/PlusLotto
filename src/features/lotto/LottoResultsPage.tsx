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
import { useConfirmRound, useRounds, type RoundFilter } from './api'
import { lottoColumns } from './columns'
import { RoundFormModal } from './RoundFormModal'

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

  const { data: rows = [], isLoading } = useRounds(filter)
  const { data: allRows = [] } = useRounds('all')
  const confirmRound = useConfirmRound()

  const columns = useMemo(() => lottoColumns({ onConfirm: setConfirmNo }), [])

  const counts = useMemo(() => {
    const pending = allRows.filter((r) => r.confirmed_at == null).length
    return { all: allRows.length, pending, confirmed: allRows.length - pending }
  }, [allRows])

  const tabs: TabItem[] = FILTER_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] }))

  // 로또기록 엑셀(CSV) 다운로드 — 현재 필터 기준, 등수별(1~5등) 누적 건수 포함.
  const onDownloadCsv = () => {
    downloadCsv(
      `로또기록_${new Date().toISOString().slice(0, 10)}.csv`,
      ['회차', '추첨일', '당첨번호', '보너스', '합', '홀짝', '1등 당첨금', '2등 당첨금', '3등 당첨금',
       '총판매금액', '베팅수', '당첨수', '1등', '2등', '3등', '4등', '5등', '상태'],
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
      { onSuccess: () => setConfirmNo(null) },
    )
  }

  return (
    <div>
      <PageHeader
        title="로또기록"
        description="회차별 당첨번호 · 1·2·3등 당첨금 · 총판매금액. 당첨 확정 시 베팅 등수/당첨금 산정(§8)."
        actions={
          <>
            <Button
              variant="gho"
              icon={<Download className="h-4 w-4" />}
              onClick={onDownloadCsv}
              disabled={rows.length === 0}
            >
              엑셀 다운로드
            </Button>
            <Button variant="pri" icon={<Plus className="h-4 w-4" />} onClick={() => setRegisterOpen(true)}>
              회차 등록
            </Button>
          </>
        }
      />

      <Tabs tabs={tabs} value={filter} onChange={(k) => set('f', k === 'all' ? null : k)} className="mb-3" />

      <DataTable
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
      />

      <RoundFormModal open={registerOpen} onClose={() => setRegisterOpen(false)} />

      <ConfirmModal
        open={confirmNo != null}
        onClose={() => setConfirmNo(null)}
        onConfirm={onConfirmRound}
        loading={confirmRound.isPending}
        title={`${confirmNo ?? ''}회차 당첨 확정`}
        confirmText="당첨 확정"
        description={
          <>
            해당 회차의 모든 베팅 등수·당첨금을 당첨번호 기준으로 산정합니다. 1~3등 당첨자는 당첨자
            세그먼트(회원 당첨이력)에 반영됩니다. 이미 확정된 회차는 재산정됩니다.
          </>
        }
      />
    </div>
  )
}
