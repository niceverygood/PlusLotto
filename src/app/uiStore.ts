import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Density = 'comfortable' | 'compact'

interface UiState {
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (v: boolean) => void
  density: Density
  setDensity: (d: Density) => void
  pageTitle: string
  pageDesc: string
  setPageMeta: (title: string, desc?: string) => void
}

/** 클라이언트 UI 상태만 (서버 상태는 TanStack Query). */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      density: 'comfortable',
      setDensity: (density) => set({ density }),
      pageTitle: '',
      pageDesc: '',
      setPageMeta: (pageTitle, pageDesc = '') => set({ pageTitle, pageDesc }),
    }),
    {
      name: 'pluslotto-ui',
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, density: s.density }),
    },
  ),
)

/** 페이지가 상단바 제목/설명 슬롯을 채운다. */
export function usePageMeta(title: string, desc = ''): void {
  const setPageMeta = useUiStore((s) => s.setPageMeta)
  useEffect(() => {
    setPageMeta(title, desc)
  }, [title, desc, setPageMeta])
}
