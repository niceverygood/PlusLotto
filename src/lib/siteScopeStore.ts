import { create } from 'zustand'
import { DEFAULT_SITE_SCOPE, isSiteScope, type SiteScope } from './siteScope'

function initialScope(): SiteScope {
  if (typeof window === 'undefined') return DEFAULT_SITE_SCOPE
  const params = new URLSearchParams(window.location.search)
  const value = params.get('site') ?? params.get('src')
  return isSiteScope(value) ? value : DEFAULT_SITE_SCOPE
}

// 브라우저 간/계정 간 선택을 공유하지 않는다. 공유 URL은 ?site=로 선택을 전달한다.
export const useSiteScopeStore = create<{
  siteScope: SiteScope
  setSiteScope: (siteScope: SiteScope) => void
}>((set) => ({ siteScope: initialScope(), setSiteScope: (siteScope) => set({ siteScope }) }))

export function useSiteScope(): SiteScope {
  return useSiteScopeStore((state) => state.siteScope)
}
