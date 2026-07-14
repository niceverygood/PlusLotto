import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LogOut, PanelLeft } from 'lucide-react'
import { navIcons } from '@/design-system/icons'
import { useUiStore } from '@/app/uiStore'
import { useCurrentUser, useSignOut } from '@/lib/auth'
import { useNavAccess } from '@/lib/navAccess'
import { useNavBadges } from '@/lib/navBadges'
import { canAccessWith, ROLE_LABEL, type NavKey } from '@/lib/permissions'
import { BRAND } from '@/lib/brand'
import { cn } from '@/lib/cn'

interface NavItem {
  key: NavKey
  label: string
  to: string
  adminOnly?: boolean
}

interface NavGroup {
  title: string
  items: NavItem[]
}

/** 13개 대분류를 4그룹으로 (CLAUDE §0 / 스펙 App Shell). 노출은 역할별로 필터(§5). */
const NAV: NavGroup[] = [
  {
    title: '운영',
    items: [
      { key: 'dashboard', label: '대시보드', to: '/dashboard' },
      { key: 'members', label: '이용자', to: '/members' },
      { key: 'payments', label: '결제', to: '/payments' },
      { key: 'revenue', label: '매출', to: '/revenue' },
    ],
  },
  {
    title: '고객 · 세일즈',
    items: [
      { key: 'myCustomers', label: '나의고객', to: '/my/customers' },
      { key: 'community', label: '커뮤니티', to: '/community' },
      { key: 'support', label: '고객센터', to: '/support' },
    ],
  },
  {
    title: '로또',
    items: [
      { key: 'lotto', label: '로또기록', to: '/lotto/results' },
      { key: 'lotto', label: '추천번호', to: '/lotto/recommend' },
      { key: 'bets', label: '베팅', to: '/bets' },
    ],
  },
  {
    title: '시스템',
    items: [
      { key: 'admins', label: '관리자', to: '/admins' },
      { key: 'logs', label: '로그', to: '/logs/admin', adminOnly: true },
      { key: 'stats', label: '통계', to: '/stats' },
      { key: 'payroll', label: '급여', to: '/payroll' },
      { key: 'settings', label: '설정', to: '/settings' },
    ],
  },
]

export function AppShell() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const pageTitle = useUiStore((s) => s.pageTitle)
  const pageDesc = useUiStore((s) => s.pageDesc)
  const user = useCurrentUser()
  const signOut = useSignOut()
  const navigate = useNavigate()
  const { data: navMap } = useNavAccess()
  const navCounts = useNavBadges()
  const [menuOpen, setMenuOpen] = useState(false)

  if (!user) return null // RequireAuth 가 /login 으로 보냄
  const roleLabel = ROLE_LABEL[user.role]

  // 역할별 메뉴 노출 (§5) — 권한관리 매트릭스(nav_access) 기준, 저장 시 즉시 반영(§8). 빈 그룹은 숨김.
  const visibleNav = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => canAccessWith(navMap, user.role, i.key)),
  })).filter((g) => g.items.length > 0)

  async function handleLogout() {
    setMenuOpen(false)
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div
      className="grid h-screen overflow-hidden bg-white text-[13px]"
      style={{
        gridTemplateColumns: `${collapsed ? 64 : 248}px 1fr`,
        gridTemplateRows: 'minmax(0, 1fr)',
      }}
    >
      {/* ── 사이드바 ───────────────────────────── */}
      <aside className="flex flex-col overflow-y-auto bg-[color:var(--nav-bg)] py-3.5 text-white">
        <div
          className={cn(
            'flex items-center gap-2 px-4 pb-3.5 font-extrabold',
            collapsed && 'justify-center px-0',
          )}
        >
          <span className="h-2 w-2 shrink-0 rounded-sm bg-[color:var(--accent-500)]" />
          {!collapsed && <span className="text-[15px]">{BRAND.name}</span>}
        </div>

        <nav className="flex-1">
          {visibleNav.map((group) => (
            <div key={group.title}>
              {!collapsed && (
                <div className="px-4 pb-1 pt-3 text-[9px] font-bold uppercase tracking-[1px] text-[color:var(--nav-grp)]">
                  {group.title}
                </div>
              )}
              {group.items.map((item) => {
                const Icon = navIcons[item.key]
                const count = navCounts[item.key]
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'relative flex items-center gap-2.5 px-4 py-[7px] text-[color:var(--nav-fg)] transition-colors',
                        'hover:bg-white/5 hover:text-white',
                        collapsed && 'justify-center px-0',
                        isActive &&
                          'bg-[color:var(--nav-active-bg)] text-white shadow-[inset_3px_0_0_var(--primary-500)]',
                      )
                    }
                  >
                    <Icon className="h-[17px] w-[17px] shrink-0 opacity-90" />
                    {!collapsed && (
                      <>
                        <span className="truncate">{item.label}</span>
                        {count != null && (
                          <span className="ml-auto rounded-full bg-[color:var(--nav-badge-bg)] px-1.5 text-[9px] font-bold text-[color:var(--nav-badge-fg)]">
                            {count}
                          </span>
                        )}
                        {item.adminOnly && count == null && (
                          <span className="ml-auto rounded border border-[color:var(--nav-border)] px-1 font-mono text-[8.5px] text-[color:var(--nav-fg-muted)]">
                            관
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                )
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* ── 메인 (상단바 + 콘텐츠) ───────────────── */}
      <div className="flex min-w-0 flex-col">
        <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="사이드바 토글"
            className="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <PanelLeft className="h-[18px] w-[18px]" />
          </button>
          <div className="min-w-0">
            <span className="text-[15px] font-bold text-ink-900">{pageTitle}</span>
            {pageDesc && <span className="ml-2 text-[12px] text-gray-400">{pageDesc}</span>}
          </div>

          {/* 계정 메뉴 */}
          <div className="relative ml-auto">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-gray-100"
            >
              <span className="text-[12px] text-gray-500">
                {roleLabel} · {user.name}
              </span>
              <span className="grid h-7 w-7 place-items-center rounded-md bg-primary-100 text-[12px] font-bold text-primary-600">
                {roleLabel.charAt(0)}
              </span>
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-10 z-20 w-40 rounded-lg border border-gray-200 bg-white p-1.5 shadow-md">
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    <LogOut className="h-4 w-4" />
                    로그아웃
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="relative min-h-0 flex-1 overflow-auto bg-gray-50 p-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
