import { useEffect, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { useGradeColorSync } from '@/lib/gradeTheme'
import { useSessionStore } from '@/lib/auth'

/** 저장된 등급색을 토큰에 적용(전 화면 Badge 반영). QueryClientProvider 내부에서만 동작. */
function GradeThemeSync() {
  useGradeColorSync()
  return null
}

/** 부팅 시 1회 세션 복원 — supabase 모드에서 새로고침 후 auth 세션→staff 재확인. mock 은 no-op. */
function SessionRestore() {
  useEffect(() => {
    void useSessionStore.getState().restoreSession()
  }, [])
  return null
}

/** 앱 전역 프로바이더: TanStack Query + Router. (서버상태는 전부 Query — CLAUDE §1) */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <SessionRestore />
      <GradeThemeSync />
      <BrowserRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        {children}
      </BrowserRouter>
    </QueryClientProvider>
  )
}
