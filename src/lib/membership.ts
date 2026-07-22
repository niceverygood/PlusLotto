// 멤버십 등급 카드 — 공유 기본값·헬퍼 (현장 6/30, 정의현 차장).
// 전산(설정 > 멤버십 등급)에서 편집 → site_settings.membership_tiers 저장 →
// 고객 멤버십 페이지가 RPC(portal_membership_tiers)로 연동. 미편집 시 이 기본값으로 폴백.
// feature 간 직접 import 금지(§2)라 customer(site)·admin(settings) 양쪽이 lib 경유로 공유.
import type { Grade, MembershipTier } from '@/types/db'

/** 고객 노출 등급 순서 (simple/ovr/toss 는 내부 분류라 미노출). */
export const TIER_GRADES = ['free', 'gold', 'goldp', 'vip', 'royal'] as const
export type TierGrade = (typeof TIER_GRADES)[number]

export function isTierGrade(g: string): g is TierGrade {
  return (TIER_GRADES as readonly string[]).includes(g)
}

/** 고객 공개 등급 약관 주소. 관리자와 고객 사이트가 같은 origin을 쓰므로 문자에도 그대로 사용한다. */
export function membershipTermsPath(grade: Grade): string {
  return `/terms/${grade}`
}

export function membershipTermsUrl(grade: Grade): string {
  const path = membershipTermsPath(grade)
  return typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString()
}

// 코드 기본값 = 종전 하드코딩 카드 내용(라벨은 GRADE_LABEL 기본값과 동일). 운영자가 저장 전까지 그대로 노출.
export const DEFAULT_MEMBERSHIP_TIERS: MembershipTier[] = [
  {
    grade: 'free',
    label: '무료',
    price: '문의',
    tagline: '부담 없이 시작하는 무료 체험',
    weekly_sets: '주 1조합',
    highlights: ['주간 추천 조합 1세트', '기본 회차 정보 열람', '마이페이지 발급내역 확인'],
    featured: false,
    terms: '',
    hidden: true, // 고객 홈페이지 등급 3종만 노출(현장 피드백 7/20) — 전산 편집은 계속 가능
  },
  {
    grade: 'gold',
    label: '골드',
    price: '문의',
    tagline: '본격적인 번호 관리의 시작',
    weekly_sets: '주 5조합',
    highlights: [
      '주간 추천 조합 5세트',
      '추천 번호 문자(SMS) 발송',
      '회차별 당첨 집계 알림',
      '기본 번호 분석 리포트',
    ],
    featured: false,
    terms: '',
    hidden: true, // 고객 홈페이지 등급 3종만 노출(현장 피드백 7/20) — 전산 편집은 계속 가능
  },
  {
    grade: 'goldp',
    label: '골드플러스',
    price: '문의',
    tagline: '더 많은 조합과 우선 발송',
    weekly_sets: '주 10조합',
    highlights: [
      '주간 추천 조합 10세트',
      '추천 번호 문자(SMS) 우선 발송',
      '회차별 당첨 집계 알림',
      '심화 번호 분석 리포트',
    ],
    featured: true,
    terms: '',
  },
  {
    grade: 'vip',
    label: 'VIP',
    price: '문의',
    tagline: '전담 관리와 프리미엄 분석',
    weekly_sets: '주 20조합',
    highlights: [
      '주간 추천 조합 20세트',
      'VIP 전용 분석 리포트',
      '전담 상담원 1:1 관리',
      '당첨 패턴 맞춤 컨설팅',
    ],
    featured: false,
    terms: '',
  },
  {
    grade: 'royal',
    label: '로얄',
    price: '문의',
    tagline: '최상위 로얄 멤버 전용 혜택',
    weekly_sets: '주 30조합+',
    highlights: [
      '주간 추천 조합 30세트 이상',
      '로얄 전용 프리미엄 분석',
      '최우선 전담 컨설팅',
      '특별 이벤트·당첨 케어',
    ],
    featured: false,
    terms: '',
  },
]

/**
 * 저장된 raw(부분/누락 가능)를 항상 5개·정렬된 완전한 등급 배열로 정규화.
 * 빈/누락 필드는 기본값으로 폴백 → 편집기 프리필·고객 렌더 양쪽이 안전.
 */
export function resolveTiers(raw: MembershipTier[] | null | undefined): MembershipTier[] {
  const byGrade = new Map((raw ?? []).map((t) => [t.grade, t]))
  return DEFAULT_MEMBERSHIP_TIERS.map((def) => {
    const r = byGrade.get(def.grade)
    if (!r) return { ...def }
    return {
      grade: def.grade,
      label: (r.label ?? '').trim() || def.label,
      price: (r.price ?? '').trim() || def.price,
      tagline: r.tagline ?? def.tagline,
      weekly_sets: (r.weekly_sets ?? '').trim() || def.weekly_sets,
      highlights:
        Array.isArray(r.highlights) && r.highlights.length ? r.highlights : def.highlights,
      featured: !!r.featured,
      terms: r.terms ?? '',
      hidden: r.hidden ?? def.hidden ?? false,
    }
  })
}

/** 고객 홈페이지 노출 대상만(§등급 3종 표현, 현장 피드백 7/20) — 카드·비교표 렌더 전 필터. */
export function visibleTiers(tiers: MembershipTier[]): MembershipTier[] {
  return tiers.filter((t) => !t.hidden)
}

/** 정규화된 등급 배열 → grade→label 맵(전산 GRADE_LABEL 전파용). */
export function tierLabelMap(tiers: MembershipTier[]): Partial<Record<Grade, string>> {
  const m: Partial<Record<Grade, string>> = {}
  for (const t of tiers) m[t.grade] = t.label
  return m
}
