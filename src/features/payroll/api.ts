// 급여(커미션)·상담원 매칭분석 데이터 훅 (CLAUDE §1·§8). 전부 TanStack Query 경유.
// payments·staff 는 회원 스코프 없이 전체가 필요해(집계 대상 전 담당자) selectAll 로 전량 조회(§8 D69).
import { useQuery } from '@tanstack/react-query'
import { readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchTables } from '@/lib/db/remote'
import { payrollKeys } from '@/lib/queryKeys'
import { computeMatching, computePayroll, type MatchRow, type PayrollRow } from '@/lib/payroll'

async function loadBase() {
  return dataSource === 'supabase' ? await fetchTables(['payments', 'staff']) : readDb()
}

/** month('yyyy-MM') 기준 담당자별 급여(1차/2차 커미션) 계산. */
export function usePayrollMonth(month: string) {
  return useQuery({
    queryKey: payrollKeys.month(month),
    queryFn: async (): Promise<PayrollRow[]> => {
      const db = await loadBase()
      return computePayroll(db.payments, db.staff, month)
    },
  })
}

/** 기간(from~to) 내 1차→2차 담당자 조합별 업셀 성공률 랭킹. */
export function useStaffMatching(range: { from: string | null; to: string | null }) {
  return useQuery({
    queryKey: payrollKeys.matching(range),
    queryFn: async (): Promise<MatchRow[]> => {
      const db = await loadBase()
      return computeMatching(db.payments, db.staff, {
        from: range.from ?? undefined,
        to: range.to ?? undefined,
      })
    },
  })
}
