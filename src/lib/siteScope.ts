/** 운영 사이트 선택. 기존 출처 없는 회원은 플러스로또로 분류한다. */
export const SITE_SCOPES = [
  { key: 'pluslotto', label: '플러스로또' },
  { key: 'lotto815', label: '815로또' },
  { key: 'infolotto', label: '인포로또' },
  { key: 'cplotto', label: '일행로또' },
  { key: 'lotto88', label: '88로또' },
  { key: 'all', label: '전체 사이트' },
] as const

/**
 * 아직 운영 데이터가 들어오지 않은 사이트 — 운영 화면 사이트 선택에서만 감춘다.
 *
 * 목록 자체에서 빼면 문자 본문의 $brand 가 사이트 이름을 못 찾아 "플러스로또"로 나가고,
 * 회원 출처 필터도 그 사이트를 못 고른다(이관 사이트 회원에게 남의 브랜드가 나가는 사고).
 * 그래서 이름·필터·포털은 전부 살려두고 드롭다운 노출만 막는다.
 *
 * 88로또 전환일(2026-10-05, docs/LOTTO88_MIGRATION_PLAN.md 4단계)에 이 배열을 비운다.
 * 그 전까지 노출하면 현장에는 "88로또 0건"으로만 보여 혼란스럽다.
 */
export const PENDING_SITE_SCOPES: readonly SiteScope[] = ['lotto88']

/** 운영 화면 사이트 선택 드롭다운에 실제로 보여줄 목록. */
export const SELECTABLE_SITE_SCOPES = SITE_SCOPES.filter(
  (site) => !PENDING_SITE_SCOPES.includes(site.key),
)

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

/**
 * 회원 meta 기준 사이트 이름(문자 본문 $brand 용).
 * 알 수 없는 출처값·'all' 은 기본(플러스로또) 이름으로 본다 — 문자 본문에 사이트 키가
 * 그대로 노출되는 일이 없어야 한다.
 */
export function memberSiteLabel(meta: Record<string, unknown> | null | undefined): string {
  const site = memberSite(meta)
  const scope: SiteScope = isSiteScope(site) && site !== 'all' ? site : DEFAULT_SITE_SCOPE
  return siteScopeLabel(scope)
}
