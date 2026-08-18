// site_settings 공용 조회 훅 — feature 간 직접 import 금지(§2)라 설정 화면 밖(회원정보창 등)에서
// 설정을 읽어야 할 때 이 lib 훅을 쓴다. 캐시 키는 설정 모듈과 동일해 저장 시 함께 갱신된다.
import { useQuery } from '@tanstack/react-query'
import type { SiteSettings } from '@/types/db'
import { dataSource } from '@/lib/supabase'
import { fetchSiteSettings } from '@/lib/db/remote'
import { readDb } from '@/lib/db/store'
import { settingsKeys } from '@/lib/queryKeys'

export function useSiteSettingsShared() {
  return useQuery<SiteSettings>({
    queryKey: settingsKeys.site(),
    queryFn: async () => (dataSource === 'supabase' ? await fetchSiteSettings() : readDb().site_settings),
  })
}
