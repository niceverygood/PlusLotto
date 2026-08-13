import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Bell, BellOff, LogOut, PanelLeft, RefreshCw, X } from 'lucide-react'
import { navIcons } from '@/design-system/icons'
import { useUiStore } from '@/app/uiStore'
import { useCurrentUser, useSignOut } from '@/lib/auth'
import { useCallPopupEnabled, useCallReservationAlerts } from '@/lib/callReservations'
import { useNewVersionAvailable } from '@/lib/versionCheck'
import { useMemberDrawerStore } from '@/lib/memberDrawerStore'
import { usePaymentDrawerStore } from '@/lib/paymentDrawerStore'
import { useNavAccess } from '@/lib/navAccess'
import { useNavBadges } from '@/lib/navBadges'
import { canAccessWith, ROLE_LABEL, type NavKey } from '@/lib/permissions'
import { BRAND } from '@/lib/brand'
import { cn } from '@/lib/cn'
import { datetime } from '@/lib/format'
import { MemberDrawer } from '@/features/members/MemberDrawer'
import { PaymentDrawer } from '@/features/payments/PaymentDrawer'

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
      { key: 'dashboard', label: '대시보드', to: '/admin/dashboard' },
      { key: 'members', label: '이용자', to: '/admin/members' },
      { key: 'payments', label: '결제', to: '/admin/payments' },
      { key: 'revenue', label: '매출', to: '/admin/revenue' },
    ],
  },
  {
    title: '고객 · 세일즈',
    items: [
      { key: 'myCustomers', label: '나의고객', to: '/admin/my/customers' },
      { key: 'community', label: '커뮤니티', to: '/admin/community' },
      { key: 'support', label: '고객센터', to: '/admin/support' },
    ],
  },
  {
    title: '로또',
    items: [
      { key: 'lotto', label: '로또기록', to: '/admin/lotto/results' },
      { key: 'lotto', label: '추천번호', to: '/admin/lotto/recommend' },
      { key: 'bets', label: '베팅', to: '/admin/bets' },
    ],
  },
  {
    title: '시스템',
    items: [
      { key: 'admins', label: '관리자', to: '/admin/admins' },
      { key: 'logs', label: '로그', to: '/admin/logs/admin', adminOnly: true },
      { key: 'stats', label: '통계', to: '/admin/stats' },
      { key: 'payroll', label: '급여', to: '/admin/payroll' },
      { key: 'settings', label: '설정', to: '/admin/settings' },
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
  const [notifOpen, setNotifOpen] = useState(false)
  const { data: callAlerts } = useCallReservationAlerts()
  const alerts = callAlerts ?? []
  // 우측하단 고정 팝업만 닫기(현장 피드백 7/29) — 상단바 벨 배지/목록은 계속 전체를 보여준다.
  // 닫아도 새로 도래한 예약이 있으면(=id 다름) 팝업이 다시 노출된다.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const [popupEnabled, setPopupEnabled] = useCallPopupEnabled()
  const popupAlerts = popupEnabled ? alerts.filter((a) => !dismissedIds.has(a.member_id)) : []
  const drawerMemberIds = useMemberDrawerStore((s) => s.memberIds)
  const closeMemberDrawer = useMemberDrawerStore((s) => s.close)
  const openMemberDrawer = useMemberDrawerStore((s) => s.open)
  const drawerPaymentId = usePaymentDrawerStore((s) => s.paymentId)
  const closePaymentDrawer = usePaymentDrawerStore((s) => s.close)
  const newVersionAvailable = useNewVersionAvailable()

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
    navigate('/admin/login', { replace: true })
  }

  return (
    <>
      {/* 새 버전 배포 안내(현장 피드백 7/31) — "자동발송은 새 포맷인데 수동발송은 옛 포맷"의 실제
          원인이 배포 전부터 열려있던 탭의 캐시된 JS였음이 확인돼, SPA 특성상 새로고침 없이는
          새 배포를 알 수 없는 문제를 보완한다. */}
      {newVersionAvailable && (
        <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 bg-primary-600 px-3 py-1.5 text-[12px] font-semibold text-white">
          <RefreshCw className="h-3.5 w-3.5" />
          새 버전이 배포되었습니다. 새로고침해야 최신 기능(예: 문자 발송 형식)이 정확히 적용됩니다.
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="ml-1 rounded bg-white/20 px-2 py-0.5 font-bold transition-colors hover:bg-white/30"
          >
            새로고침
          </button>
        </div>
      )}
      <div
        // 높이는 h-screen(100vh) 이 아니라 배율 보정된 --app-vh (tokens.css) — 전산 확대(zoom 1.12)에서
        // 100vh 가 창보다 12% 커져 사이드바 최하단 메뉴가 화면 밖으로 밀려나던 문제(현장 7/28).
        className="grid overflow-hidden bg-white text-[13px]"
        style={{
          height: 'var(--app-vh)',
          gridTemplateColumns: `${collapsed ? 64 : 248}px 1fr`,
          gridTemplateRows: 'minmax(0, 1fr)',
        }}
      >
      {/* ── 사이드바 ───────────────────────────── */}
      {/* 세로 여백을 줄여 최고관리자(전 메뉴 15개)도 1280×720 확대 화면에서 스크롤 없이 다 보이게 한다.
          그래도 넘치는 저해상도에서는 overflow-y-auto 로 최하단까지 닿을 수 있다(현장 7/28). */}
      <aside className="flex flex-col overflow-y-auto bg-[color:var(--nav-bg)] py-2 text-white">
        <div
          className={cn(
            'flex items-center gap-2 px-4 pb-2.5 font-extrabold',
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
                <div className="px-4 pb-1 pt-2.5 text-[9px] font-bold uppercase tracking-[1px] text-[color:var(--nav-grp)]">
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
                        'relative flex items-center gap-2.5 px-4 py-[5px] text-[color:var(--nav-fg)] transition-colors',
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

          {/* 통화예약 알림(현장 피드백 7/23) — 예약시각 도래한 건을 벨 배지로 표시. */}
          <div className="relative ml-auto">
            <button
              type="button"
              onClick={() => setNotifOpen((o) => !o)}
              aria-label="통화예약 알림"
              className="relative grid h-8 w-8 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <Bell className="h-[18px] w-[18px]" />
              {alerts.length > 0 && (
                <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">
                  {alerts.length}
                </span>
              )}
            </button>
            {notifOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setNotifOpen(false)} />
                <div className="absolute right-0 top-10 z-20 w-72 rounded-lg border border-gray-200 bg-white p-1.5 shadow-md">
                  <div className="px-2 py-1.5 text-[11px] font-bold text-gray-400">통화예약 알림</div>
                  {alerts.length === 0 ? (
                    <div className="px-2.5 py-4 text-center text-[12px] text-gray-400">도래한 예약이 없습니다.</div>
                  ) : (
                    <div className="max-h-80 overflow-y-auto">
                      {alerts.map((a) => (
                        <button
                          key={a.member_id}
                          type="button"
                          onClick={() => {
                            setNotifOpen(false)
                            openMemberDrawer(a.member_id)
                          }}
                          className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-gray-50"
                        >
                          <span className="text-[12.5px] font-semibold text-ink-900">{a.member_name}</span>
                          <span className="font-mono text-[11px] tabular-nums text-gray-500">
                            예약 {datetime(a.reserved_at)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* 계정 메뉴 */}
          <div className="relative">
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
                <div className="absolute right-0 top-10 z-20 w-52 rounded-lg border border-gray-200 bg-white p-1.5 shadow-md">
                  {/* 우측하단 고정 팝업 켜기/끄기(현장 피드백 7/30) — 브라우저별 개인 설정. */}
                  <button
                    type="button"
                    onClick={() => setPopupEnabled(!popupEnabled)}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    {popupEnabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                    통화예약 알림팝업 {popupEnabled ? '끄기' : '켜기'}
                  </button>
                  {/* 통화녹음 앱 다운로드 버튼은 계정메뉴에서 제거(현장 피드백 8/4, 정의현 차장 —
                      "다운로드 버튼은 없애주시고"). 배포는 설정 > 통화녹음 앱 카드(관리자 이상)에서만. */}
                  <div className="my-1 border-t border-gray-100" />
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

      {/* 회원상세 Drawer 전역 인스턴스(현장 피드백 7/23) — 어느 화면이든 memberDrawerStore.open() 만
          호출하면 라우트 이동 없이 여기서 뜬다(§8 허브를 화면 전환 없이 공유).
          여러 개 동시 오픈(현장 피드백 8/4) — 열린 회원마다 창 하나씩, 두 번째부터는 계단식으로
          비껴 띄운다. Esc 는 맨 위(마지막에 연) 창만 닫는다. */}
      {drawerMemberIds.map((mid, i) => (
        <MemberDrawer
          key={mid}
          memberId={mid}
          onClose={() => closeMemberDrawer(mid)}
          cascadeIndex={i}
          closeOnEsc={i === drawerMemberIds.length - 1}
        />
      ))}

      {/* 결제상세 Drawer 전역 인스턴스(현장 8/13 — 회원정보창 '수기수정'). 회원창 위에 겹쳐 뜬다. */}
      <PaymentDrawer paymentId={drawerPaymentId} onClose={closePaymentDrawer} />

      {/* 통화예약 알림 — 화면 우측 하단 고정 팝업(현장 피드백 7/29: "최상단 알람을 실무자들이
          놓치는 경우가 많다"). 상단바 벨(클릭해야 보임)과 별개로, 도래한 예약이 있으면 클릭 없이도
          항상 눈에 띄는 위치에 노출한다. 회원상세 Drawer(z-50)보다 위(z-60)라 열려 있어도 가려지지
          않는다. 닫기버튼(현장 피드백 7/29 — 계속 고정돼 있어 불편하다는 후속 요청)으로 현재 목록만
          닫을 수 있고, 새로 도래한 예약이 생기면(=다른 회원) 다시 노출된다. */}
      {popupAlerts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[60] w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2.5">
            <Bell className="h-4 w-4 text-danger" />
            <span className="text-[12.5px] font-bold text-ink-900">통화예약 알림</span>
            <span className="ml-2 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
              {popupAlerts.length}
            </span>
            <button
              type="button"
              aria-label="닫기"
              onClick={() => setDismissedIds((prev) => new Set([...prev, ...popupAlerts.map((a) => a.member_id)]))}
              className="ml-auto grid h-6 w-6 place-items-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5">
            {popupAlerts.map((a) => (
              <button
                key={a.member_id}
                type="button"
                onClick={() => openMemberDrawer(a.member_id)}
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-gray-50"
              >
                <span className="text-[12.5px] font-semibold text-ink-900">{a.member_name}</span>
                <span className="font-mono text-[11px] tabular-nums text-gray-500">예약 {datetime(a.reserved_at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      </div>
    </>
  )
}
