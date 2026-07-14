// 급여(커미션) 계산 + 1차/2차 상담원 매칭분석 (현장 피드백 7/9, 정의현 차장).
// 결제건별 담당자·차수(§7/6 구현)를 그대로 사용 — 스키마 변경 없이 계산만 추가.
// 순수 계산 로직만(React/데이터 fetch 없음) — features/payroll/api.ts 가 이 함수들을 감싼다.
import type { Payment, Staff } from '@/types/db'

export interface PayrollRateTable {
  first: number // 1차 판매 건당
  second: number // 2차 성공 건당(기본)
  secondTier10: number // 2차 성공 10건↑ 시 그 달 전체 2차 건당
  secondTier15: number // 2차 성공 15건↑ 시 그 달 전체 2차 건당
}

// TODO(live-verify): 정의현 차장이 준 두 요율표가 "입사일 2025.12월~2026.5월까지" /
// "입사일 2025.12월~2026.6월부터" 로 표기돼 있어 문구상 개인별 입사일 코호트로도 읽힌다.
// 여기서는 더 일반적인 "요율 인상 시행월" 로 해석해 판매(결제)월 기준으로 표를 골랐다
// (2026-06 결제분부터 인상표 적용). 상담원 개별 입사일 코호트가 맞다면 staff.hire_date 필드를
// 추가하고 이 로직을 코호트 기준으로 교체해야 한다 — docs/ASSUMPTIONS.md 기록, 확인 필요.
const RATE_SCHEDULE: { from: string; table: PayrollRateTable }[] = [
  { from: '2025-12', table: { first: 90_000, second: 100_000, secondTier10: 110_000, secondTier15: 120_000 } },
  { from: '2026-06', table: { first: 93_000, second: 105_000, secondTier10: 115_000, secondTier15: 125_000 } },
]

/** month('yyyy-MM') 시점에 적용되는 요율표(가장 최근 시행월 기준). */
export function resolveRateTable(month: string): PayrollRateTable {
  let cur = RATE_SCHEDULE[0].table
  for (const s of RATE_SCHEDULE) if (s.from <= month) cur = s.table
  return cur
}

/** 그 달 2차 성공 건수에 따른 2차 단가(10건↑/15건↑ 시 그 달 전체 건에 상위 단가 소급 적용). */
export function secondUnitRate(table: PayrollRateTable, countInMonth: number): number {
  if (countInMonth >= 15) return table.secondTier15
  if (countInMonth >= 10) return table.secondTier10
  return table.second
}

/**
 * 결제 회차(1차/2차/3차…) — 회원별 전체 결제(상태 무관)를 생성시각순으로 매김.
 * MemberDrawer 의 회차 계산(§7/6)과 동일 규칙을 전역(전 회원)으로 재사용.
 */
export function computePaymentRounds(payments: Payment[]): Map<string, number> {
  const byMember = new Map<string, Payment[]>()
  for (const p of payments) {
    const arr = byMember.get(p.member_id)
    if (arr) arr.push(p)
    else byMember.set(p.member_id, [p])
  }
  const rounds = new Map<string, number>()
  for (const arr of byMember.values()) {
    ;[...arr].sort((a, b) => a.created_at.localeCompare(b.created_at)).forEach((p, i) => rounds.set(p.id, i + 1))
  }
  return rounds
}

export interface PayrollRow {
  staff_id: string
  staff_name: string
  firstCount: number
  firstAmount: number
  secondCount: number
  secondUnitRate: number
  secondAmount: number
  total: number
}

/** 월별 급여(커미션) 계산 — 1차 판매·2차 성공(인계) 각각 담당자 기준으로 집계. */
export function computePayroll(payments: Payment[], staff: Staff[], month: string): PayrollRow[] {
  const table = resolveRateTable(month)
  const rounds = computePaymentRounds(payments)
  const nameById = new Map(staff.map((s) => [s.id, s.name]))

  const inMonth = payments.filter(
    (p) => p.status === 'approved' && !!p.staff_id && !!p.paid_at && p.paid_at.slice(0, 7) === month,
  )

  const first = new Map<string, number>()
  const second = new Map<string, number>()
  for (const p of inMonth) {
    const r = rounds.get(p.id)
    const sid = p.staff_id as string
    if (r === 1) first.set(sid, (first.get(sid) ?? 0) + 1)
    else if (r === 2) second.set(sid, (second.get(sid) ?? 0) + 1)
    // 3차 이상은 요청된 급여 규정에 명시가 없어 이번 계산에서는 집계 제외(확인 필요).
  }

  const staffIds = new Set<string>([...first.keys(), ...second.keys()])
  const rows: PayrollRow[] = []
  for (const sid of staffIds) {
    const firstCount = first.get(sid) ?? 0
    const secondCount = second.get(sid) ?? 0
    const unitRate = secondCount > 0 ? secondUnitRate(table, secondCount) : 0
    const firstAmount = firstCount * table.first
    const secondAmount = secondCount * unitRate
    rows.push({
      staff_id: sid,
      staff_name: nameById.get(sid) ?? sid,
      firstCount,
      firstAmount,
      secondCount,
      secondUnitRate: unitRate,
      secondAmount,
      total: firstAmount + secondAmount,
    })
  }
  return rows.sort((a, b) => b.total - a.total)
}

// ── 1차/2차 상담원 매칭분석(업셀 성공률 랭킹) — 현장 7/9, 참고 이미지 미확인(ASSUMPTIONS) ──
export interface MatchRow {
  firstStaffId: string
  firstStaffName: string
  secondStaffId: string
  secondStaffName: string
  firstTotal: number // 1차담당자의 전체 1차 판매건수(기간 내)
  successCount: number // 그 중 이 2차담당자가 성공시킨 건수
  rate: number // successCount / firstTotal
}

/**
 * 1차 담당자 → 2차 담당자 조합별 업셀 성공률. rate = (그 조합 성공건수) / (1차담당자 전체 1차판매건수).
 * TODO(live-verify): 정의현 차장이 첨부한 예시 이미지를 확인하지 못해 표 형식은 합리적 추정.
 */
export function computeMatching(
  payments: Payment[],
  staff: Staff[],
  opts?: { from?: string; to?: string }, // yyyy-MM-dd, paid_at 기준
): MatchRow[] {
  const nameById = new Map(staff.map((s) => [s.id, s.name]))
  const rounds = computePaymentRounds(payments)
  const inRange = (p: Payment) => {
    if (!p.paid_at) return false
    if (opts?.from && p.paid_at < opts.from) return false
    if (opts?.to && p.paid_at > `${opts.to}T23:59:59`) return false
    return true
  }
  const approved = payments.filter((p) => p.status === 'approved' && p.staff_id && inRange(p))

  const byMember = new Map<string, { first?: string; second?: string }>()
  for (const p of approved) {
    const r = rounds.get(p.id)
    if (r !== 1 && r !== 2) continue
    const cur = byMember.get(p.member_id) ?? {}
    if (r === 1) cur.first = p.staff_id as string
    if (r === 2) cur.second = p.staff_id as string
    byMember.set(p.member_id, cur)
  }

  const firstTotal = new Map<string, number>()
  for (const { first } of byMember.values()) {
    if (first) firstTotal.set(first, (firstTotal.get(first) ?? 0) + 1)
  }
  const pairSuccess = new Map<string, number>()
  for (const { first, second } of byMember.values()) {
    if (!first || !second) continue
    const key = `${first}::${second}`
    pairSuccess.set(key, (pairSuccess.get(key) ?? 0) + 1)
  }

  const rows: MatchRow[] = []
  for (const [key, successCount] of pairSuccess) {
    const [firstId, secondId] = key.split('::')
    const total = firstTotal.get(firstId) ?? 0
    rows.push({
      firstStaffId: firstId,
      firstStaffName: nameById.get(firstId) ?? firstId,
      secondStaffId: secondId,
      secondStaffName: nameById.get(secondId) ?? secondId,
      firstTotal: total,
      successCount,
      rate: total > 0 ? successCount / total : 0,
    })
  }
  return rows.sort((a, b) => b.rate - a.rate || b.successCount - a.successCount)
}
