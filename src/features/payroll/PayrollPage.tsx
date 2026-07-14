// 급여(커미션) 계산 + 1차/2차 상담원 매칭분석 (/payroll, 현장 피드백 7/9 정의현 차장).
// 탭1 급여계산: 결제건별 담당자(§7/6)·차수 기준 월별 1차/2차 커미션 집계.
// 탭2 매칭분석: 1차→2차 담당자 조합별 업셀 성공률 랭킹(궁합).
// TODO(live-verify): 요율표 해석(요율 인상 시행월 기준) + 매칭분석 표 형식(예시 이미지 미확인)은
// lib/payroll.ts 주석 + docs/ASSUMPTIONS.md 참조. 최고관리자·실장만 접근(급여=민감정보).
import { useState } from 'react'
import { format, subDays } from 'date-fns'
import { Trophy, Wallet } from 'lucide-react'
import {
  DateRangeFilter,
  EmptyState,
  KpiCard,
  PageHeader,
  Skeleton,
  Tabs,
  type DateRange,
  type TabItem,
} from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useUrlFilters } from '@/lib/useUrlFilters'
import { krw, num } from '@/lib/format'
import { usePayrollMonth, useStaffMatching } from './api'

type PayrollTab = 'commission' | 'matching'
const TABS: TabItem[] = [
  { key: 'commission', label: '급여 계산' },
  { key: 'matching', label: '상담원 매칭분석' },
]

const thisMonth = () => format(new Date(), 'yyyy-MM')

function CommissionTab() {
  const [month, setMonth] = useState(thisMonth())
  const { data, isLoading } = usePayrollMonth(month)
  const rows = data ?? []
  const totalPay = rows.reduce((s, r) => s + r.total, 0)
  const totalFirst = rows.reduce((s, r) => s + r.firstCount, 0)
  const totalSecond = rows.reduce((s, r) => s + r.secondCount, 0)

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-[12.5px] font-semibold text-gray-600" htmlFor="payroll-month">
          정산 월
        </label>
        <input
          id="payroll-month"
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="h-9 rounded-md border border-gray-300 bg-white px-2.5 font-mono text-[12.5px] text-gray-700 outline-none focus:border-primary-500"
        />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="총 지급액" value={krw(totalPay)} icon={<Wallet className="h-4 w-4" />} accent />
        <KpiCard label="대상 담당자" value={`${rows.length}명`} />
        <KpiCard label="1차 판매(건)" value={num(totalFirst)} />
        <KpiCard label="2차 성공(건)" value={num(totalSecond)} />
      </div>

      {isLoading ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <EmptyState title="해당 월 커미션 대상 결제가 없습니다" description="정산 월을 다시 선택해보세요." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-2.5 text-[12px] font-bold text-gray-600">담당자</th>
                <th className="px-3 py-2.5 text-right text-[12px] font-bold text-gray-600">1차 건수</th>
                <th className="px-3 py-2.5 text-right text-[12px] font-bold text-gray-600">1차 금액</th>
                <th className="px-3 py-2.5 text-right text-[12px] font-bold text-gray-600">2차 건수</th>
                <th className="px-3 py-2.5 text-right text-[12px] font-bold text-gray-600">2차 단가</th>
                <th className="px-3 py-2.5 text-right text-[12px] font-bold text-gray-600">2차 금액</th>
                <th className="px-4 py-2.5 text-right text-[12px] font-bold text-gray-600">합계</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.staff_id} className={i % 2 === 1 ? 'bg-gray-50/40' : ''}>
                  <td className="px-4 py-2.5 text-[13px] font-semibold text-gray-800">{r.staff_name}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-gray-700">
                    {num(r.firstCount)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-gray-700">
                    {krw(r.firstAmount)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-gray-700">
                    {num(r.secondCount)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-gray-400">
                    {r.secondUnitRate ? krw(r.secondUnitRate) : '-'}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-gray-700">
                    {krw(r.secondAmount)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[13.5px] font-bold tabular-nums text-ink-900">
                    {krw(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11.5px] leading-relaxed text-gray-400">
        * 1차/2차는 회원의 결제 발생 순서(회원정보창 결제내역과 동일 기준)이며, 결제건마다 지정된
        담당자에게 커미션이 집계됩니다. 2차 성공 10건↑/15건↑ 시 그 달 전체 2차 건에 상위 단가가
        적용됩니다. 요율은 2026-06 결제분부터 인상표가 적용되도록 반영했습니다 — 산정 기준(판매월
        vs 담당자 개인 입사월)이 다르면 말씀해 주세요.
      </p>
    </div>
  )
}

function MatchingTab() {
  const [range, setRange] = useState<DateRange>({
    from: format(subDays(new Date(), 89), 'yyyy-MM-dd'),
    to: format(new Date(), 'yyyy-MM-dd'),
  })
  const { data, isLoading } = useStaffMatching(range)
  const rows = data ?? []

  return (
    <div>
      <div className="mb-4">
        <DateRangeFilter value={range} onChange={setRange} />
      </div>

      {isLoading ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="집계할 2차 성공 사례가 없습니다"
          description="기간을 넓혀서 다시 확인해보세요."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-2.5 text-[12px] font-bold text-gray-600">궁합 랭킹</th>
                <th className="px-3 py-2.5 text-[12px] font-bold text-gray-600">1차 담당자</th>
                <th className="px-3 py-2.5 text-[12px] font-bold text-gray-600">2차 담당자</th>
                <th className="px-3 py-2.5 text-right text-[12px] font-bold text-gray-600">1차 판매</th>
                <th className="px-3 py-2.5 text-right text-[12px] font-bold text-gray-600">2차 업셀 성공</th>
                <th className="px-4 py-2.5 text-right text-[12px] font-bold text-gray-600">성공률</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.firstStaffId}-${r.secondStaffId}`}
                  className={i % 2 === 1 ? 'bg-gray-50/40' : ''}
                >
                  <td className="px-4 py-2.5 text-[13px] font-bold text-gray-500 tabular-nums">
                    {i === 0 ? <Trophy className="h-4 w-4 text-accent-500" /> : i + 1}
                  </td>
                  <td className="px-3 py-2.5 text-[13px] font-semibold text-gray-800">
                    {r.firstStaffName}
                  </td>
                  <td className="px-3 py-2.5 text-[13px] font-semibold text-gray-800">
                    {r.secondStaffName}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-gray-700">
                    {num(r.firstTotal)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-gray-700">
                    {num(r.successCount)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[13.5px] font-bold tabular-nums text-primary-700">
                    {(r.rate * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11.5px] leading-relaxed text-gray-400">
        * 성공률 = (해당 1차→2차 조합의 2차 업셀 성공 건수) ÷ (그 1차 담당자의 전체 1차 판매 건수).
        1차 판매 건수가 적은 조합은 성공률 변동폭이 커 참고용으로 봐주세요.
      </p>
    </div>
  )
}

export function PayrollPage() {
  usePageMeta('급여', '급여 계산 · 상담원 매칭분석')
  const { get, setMany } = useUrlFilters()
  const tab = (get('tab') ?? 'commission') as PayrollTab

  return (
    <div>
      <PageHeader title="급여" description="담당자별 커미션 계산과 1차·2차 상담원 매칭분석" />
      <Tabs tabs={TABS} value={tab} onChange={(k) => setMany({ tab: k })} className="mb-4" />
      {tab === 'commission' ? <CommissionTab /> : <MatchingTab />}
    </div>
  )
}
