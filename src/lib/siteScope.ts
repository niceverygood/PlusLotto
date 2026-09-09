/** 운영 사이트 선택. 기존 출처 없는 회원은 플러스로또로 분류한다. */
export const SITE_SCOPES = [
  { key: 'pluslotto', label: '플러스로또' },
  { key: 'lotto815', label: '815로또' },
  { key: 'infolotto', label: '인포로또' },
  { key: 'cplotto', label: '일행로또' },
  { key: 'all', label: '전체 사이트' },
] as const

export type SiteScope = (typeof SITE_SCOPES)[number]['key']
export const DEFAULT_SITE_SCOPE: SiteScope = 'pluslotto'

export function isSiteScope(value: unknown): value is SiteScope {
  return SITE_SCOPES.some((site) => site.key === value)
}

export function memberSite(meta: Record<string, unknown> | null | undefined): string {
  const source = meta?.source_site
  return typeof source === 'string' && source.trim() ? source.trim() : 'pluslotto'
}

export function matchesSiteScope(meta: Record<string, unknown> | null | undefined, scope: SiteScope): boolean {
  return scope === 'all' || memberSite(meta) === scope
}

export function rpcSourceSite(scope: SiteScope): Exclude<SiteScope, 'all'> | null {
  return scope === 'all' ? null : scope
}

export function siteScopeLabel(scope: SiteScope): string {
  return SITE_SCOPES.find((site) => site.key === scope)?.label ?? scope
}

/** PostgREST 회원 출처 필터. 값은 고정된 사이트 키만 사용한다. */
export function siteScopeOrFilter(scope: Exclude<SiteScope, 'all'>): string {
  // DB computed field와 집계 RPC가 같은 공백/누락 정규화를 사용한다.
  return `member_operating_site.eq.${scope}`
}
