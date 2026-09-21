// 레거시 회원 이관 원본. members.meta.source_site 에 저장하는 안정적인 키와
// 운영 화면에 노출할 한국어 라벨을 한 곳에서 관리한다.
export const LEGACY_SITES = [
  { key: 'lotto815', label: '815로또' },
  { key: 'cplotto', label: '일행로또' },
  { key: 'infolotto', label: '인포로또' },
  { key: 'lotto88', label: '88로또' },
] as const

/** 회원 출처 키 집합 — 이관 검수 보류 판정에 쓴다(legacyImportHold.ts 가 이걸 참조한다). */
export const LEGACY_SITE_KEYS: ReadonlySet<string> = new Set(LEGACY_SITES.map((site) => site.key))

export type LegacySiteKey = (typeof LEGACY_SITES)[number]['key']

/**
 * 과거 이력 저장소까지 지원하는 출처. 사이트 선택 목록과 별도로 관리한다.
 *
 * 88로또는 여기 없다 — 옛 PHP 전산 덤프였던 셋과 달리 신전산과 같은 스키마라 회원·결제·문자가
 * 본 테이블로 그대로 들어온다. 별도 이력 저장소가 필요한 자료가 없다
 * (docs/LOTTO88_MIGRATION_PLAN.md §0).
 */
export type LegacyHistorySite = 'lotto815' | 'cplotto' | 'infolotto'

export function supportedLegacyHistorySite(site: string): LegacyHistorySite | null {
  return site === 'lotto815' || site === 'cplotto' || site === 'infolotto' ? site : null
}

export function legacySiteLabel(key: string): string {
  return LEGACY_SITES.find((site) => site.key === key)?.label ?? key
}
