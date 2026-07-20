import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useRole } from '@/lib/auth'
import { useNavAccess } from '@/lib/navAccess'
import { canAccessWith, type NavKey } from '@/lib/permissions'

/**
 * 메뉴 노출 매트릭스(nav_access) 기반 라우트 가드(§5 메뉴+데이터 이중 통제).
 * 권한관리에서 모듈 접근을 끄면 사이드바뿐 아니라 직접 URL 진입도 차단한다.
 * 허용되지 않으면 항상 접근 가능한 대시보드로 보낸다(리다이렉트 루프 방지: 대시보드는 가드하지 않음).
 */
export function RequireNav({ navKey, children }: { navKey: NavKey; children: ReactNode }) {
  const role = useRole()
  const { data: navMap } = useNavAccess()
  if (!canAccessWith(navMap, role, navKey)) {
    return <Navigate to="/admin/dashboard" replace />
  }
  return <>{children}</>
}
