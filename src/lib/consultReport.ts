// 상담 리포트 — 유입코드별·상담원별 상담상태(결번/부재/가망/승인 등) 주차별·월별 집계
// (현장 피드백 7/10, 정의현 차장). 전산엔 '상담상태 변경 시각'을 별도 저장하지 않으므로,
// admin_logs 의 member.update 이벤트(meta.patch.consult_status 포함)를 '그 시점의 상담 결과'로
// 집계한다 — callVolume.ts(월 통화량 근사)와 같은 데이터 출처. 순수 함수(React/fetch 비의존).
// TODO(live-verify): 상담원별 집계는 로그의 actor(변경 실행자)를 담당자로 본다 — 다른 담당자가
//   대신 입력한 경우 실제 상담원과 다를 수 있음(확인 필요, docs/ASSUMPTIONS.md).
import { startOfMonth, startOfWeek } from 'date-fns'
import type { LogEntry, Member, Staff } from '@/types/db'
import { CONSULT_STATUSES, type ConsultStatus } from './consultStatus'

export type ReportDimension = 'code' | 'staff'
export type ReportPeriod = 'week' | 'month'

export interface ConsultReportRow {
  periodKey: string // 정렬용(주 시작일 또는 월초 yyyy-MM-dd)
  periodLabel: string
  dimKey: string
  dimLabel: string
  counts: Partial<Record<ConsultStatus, number>>
  total: number
}

interface ConsultEvent {
  createdAt: string
  memberId: string
  actorId: string | null
  status: ConsultStatus
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function periodOf(iso: string, period: ReportPeriod): { key: string; label: string } {
  const d = new Date(iso)
  if (period === 'month') {
    const s = startOfMonth(d)
    return { key: toDateKey(s), label: `${s.getFullYear()}년 ${s.getMonth() + 1}월` }
  }
  const s = startOfWeek(d, { weekStartsOn: 1 }) // 월요일 시작
  return { key: toDateKey(s), label: `${toDateKey(s)} 주` }
}

/** member.update(+bulk_update) 로그에서 consult_status 변경 이벤트만 추출. */
function extractConsultEvents(logs: readonly LogEntry[]): ConsultEvent[] {
  const out: ConsultEvent[] = []
  for (const l of logs) {
    if (l.action === 'member.update') {
      const patch = l.meta?.patch as Record<string, unknown> | undefined
      const status = patch?.consult_status
      if (typeof status === 'string' && l.target_id) {
        out.push({ createdAt: l.created_at, memberId: l.target_id, actorId: l.actor, status: status as ConsultStatus })
      }
    } else if (l.action === 'member.bulk_update') {
      const patch = l.meta?.patch as Record<string, unknown> | undefined
      const status = patch?.consult_status
      const ids = l.meta?.ids as string[] | undefined
      if (typeof status === 'string' && Array.isArray(ids)) {
        for (const id of ids) out.push({ createdAt: l.created_at, memberId: id, actorId: l.actor, status: status as ConsultStatus })
      }
    }
  }
  return out
}

/** 유입코드별·상담원별 상담상태 주차/월별 집계. from/to 는 yyyy-MM-dd(포함, 생략 시 무제한). */
export function computeConsultReport(
  logs: readonly LogEntry[],
  members: readonly Member[],
  staff: readonly Staff[],
  opts: { dimension: ReportDimension; period: ReportPeriod; from?: string | null; to?: string | null },
): ConsultReportRow[] {
  const memberById = new Map(members.map((m) => [m.id, m]))
  const staffNameById = new Map(staff.map((s) => [s.id, s.name]))
  const from = opts.from ?? null
  const to = opts.to ?? null

  const events = extractConsultEvents(logs).filter((e) => {
    const day = e.createdAt.slice(0, 10)
    if (from && day < from) return false
    if (to && day > to) return false
    return true
  })

  const rows = new Map<string, ConsultReportRow>()
  for (const e of events) {
    // 스코프 경계: members 에 없는(=역할 스코프 밖) 회원 이벤트는 집계 제외 — 팀장/담당이
    // 본인 스코프 밖 상담상태 변경을 보지 못하게 한다(§5 계층 위임과 동일 경계).
    if (!memberById.has(e.memberId)) continue
    const { key: periodKey, label: periodLabel } = periodOf(e.createdAt, opts.period)
    let dimKey: string
    let dimLabel: string
    if (opts.dimension === 'code') {
      const m = memberById.get(e.memberId)
      dimKey = m?.inflow_code ?? '(미상)'
      dimLabel = dimKey
    } else {
      dimKey = e.actorId ?? '(미배정)'
      dimLabel = e.actorId ? (staffNameById.get(e.actorId) ?? e.actorId) : '(미배정)'
    }
    const rowKey = `${periodKey}::${dimKey}`
    let row = rows.get(rowKey)
    if (!row) {
      row = { periodKey, periodLabel, dimKey, dimLabel, counts: {}, total: 0 }
      rows.set(rowKey, row)
    }
    if (!CONSULT_STATUSES.includes(e.status)) continue
    row.counts[e.status] = (row.counts[e.status] ?? 0) + 1
    row.total += 1
  }

  return [...rows.values()].sort(
    (a, b) => b.periodKey.localeCompare(a.periodKey) || b.total - a.total || a.dimLabel.localeCompare(b.dimLabel),
  )
}
