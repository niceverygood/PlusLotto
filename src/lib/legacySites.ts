// 레거시 회원 이관 원본. members.meta.source_site 에 저장하는 안정적인 키와
// 운영 화면에 노출할 한국어 라벨을 한 곳에서 관리한다.
export const LEGACY_SITES = [
  { key: 'lotto815', label: '815로또' },
  { key: 'cplotto', label: '일행로또' },
  { key: 'infolotto', label: '인포로또' },
] as const

export type LegacySiteKey = (typeof LEGACY_SITES)[number]['key']

/** 과거 이력 저장소까지 지원하는 출처. 사이트 선택 목록과 별도로 관리한다. */
export type LegacyHistorySite = 'lotto815' | 'cplotto' | 'infolotto'

export function supportedLegacyHistorySite(site: string): LegacyHistorySite | null {
  return site === 'lotto815' || site === 'cplotto' || site === 'infolotto' ? site : null
}

export function legacySiteLabel(key: string): string {
  return LEGACY_SITES.find((site) => site.key === key)?.label ?? key
}
