// 사이트별 약관 게시판 공용 규칙(현장 10/14) — 관리자 편집 화면과 고객 약관 화면이 함께 쓴다(§2 lib 경유).
import type { Grade, TermsPost } from '@/types/db'
import { GRADE_LABEL } from '@/design-system/labels'
import { CUSTOMER_SITES } from './customerSites'
import { PORTAL_SITES, type PortalSourceSite } from './portalScope'

export const TERMS_SITES = PORTAL_SITES

/** 한국 날짜(yyyy-MM-dd). 시행일 비교 기준. */
export function kstToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10)
}

export type TermsPostState = 'current' | 'scheduled' | 'previous'

/**
 * 글마다 현행/시행예정/이전 표시. 등급 전용과 공통(grade=null)을 따로 본다 — 각 범위에서 시행일이 오늘 이전인
 * 가장 최근 글이 현행, 시행일이 미래면 시행 예정, 나머지는 이전 약관(이력).
 */
export function termsPostStates(posts: readonly Pick<TermsPost, 'id' | 'grade' | 'effective_on' | 'created_at'>[], today = kstToday()): Map<string, TermsPostState> {
  const out = new Map<string, TermsPostState>()
  const sorted = [...posts].sort((a, b) => b.effective_on.localeCompare(a.effective_on) || b.created_at.localeCompare(a.created_at))
  const seenCurrent = new Set<string>()
  for (const p of sorted) {
    const scope = p.grade ?? '__common'
    if (p.effective_on > today) out.set(p.id, 'scheduled')
    else if (!seenCurrent.has(scope)) {
      seenCurrent.add(scope)
      out.set(p.id, 'current')
    } else out.set(p.id, 'previous')
  }
  return out
}

export const TERMS_STATE_LABEL: Record<TermsPostState, string> = { current: '현행', scheduled: '시행 예정', previous: '이전 약관' }

/** 사이트별로 약관을 둘 등급. 플러스는 고객 노출 등급, 이관 사이트는 전달받은 홈페이지 상품 등급. */
export function termsGradesForSite(site: PortalSourceSite): Grade[] {
  if (site === 'pluslotto') return ['goldp', 'ruby', 'vip', 'royal', 'free']
  return [...(CUSTOMER_SITES.find((s) => s.key === site)?.plans.map((p) => p.grade) ?? [])]
}

/** 등급 표시명 — 이관 사이트는 그 사이트 상품명을 앞에 쓴다(예: "베이직 · 실버"). */
export function termsGradeLabel(site: PortalSourceSite, grade: Grade | null): string {
  if (grade === null) return '공통(전 등급)'
  const plan = CUSTOMER_SITES.find((s) => s.key === site)?.plans.find((p) => p.grade === grade)
  return plan ? `${plan.label} · ${GRADE_LABEL[grade]}` : GRADE_LABEL[grade]
}

export function sortTermsPosts<T extends Pick<TermsPost, 'effective_on' | 'created_at'>>(posts: readonly T[]): T[] {
  return [...posts].sort((a, b) => b.effective_on.localeCompare(a.effective_on) || b.created_at.localeCompare(a.created_at))
}
