import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useCurrentUser } from '@/lib/auth'

/** 세션 없으면 /login 으로. 로그인 후 원래 위치로 복귀하도록 from 전달. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const user = useCurrentUser()
  const location = useLocation()
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  return <>{children}</>
}
