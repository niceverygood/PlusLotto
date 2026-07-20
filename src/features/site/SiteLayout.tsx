// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 공통 레이아웃 (Phase 1 공유 기반)
// ─────────────────────────────────────────────────────────────────────────
// sticky 헤더(로고 + 네비 6개 + 로그인 상태별 우측 액션) + <Outlet/> + 푸터.
// 데스크탑은 가로 네비, 모바일은 햄버거 토글. 브랜드 토큰만 사용(임의 hex 금지).
// 라우트 등록은 Phase3(routes.tsx)가 담당 — 이 컴포넌트는 <Outlet/>로 자식 페이지를 렌더한다.
//
// ── Phase2 가 쓸 export 시그니처 ─────────────────────────────────────────
//   <SiteLayout />        // props 없음. <Route element={<SiteLayout/>}> 하위에 페이지 라우트 중첩.
//   SITE_NAV: { to:string; label:string }[]   // 네비 정의(재사용·테스트용 export)
//
//   ※ <MemberAuthProvider> 는 상위(app/providers)에서 1회 래핑되어 있어야 한다(useMemberAuth 사용).
// ─────────────────────────────────────────────────────────────────────────
import { useState } from 'react'
import { BRAND } from '@/lib/brand'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LogIn, LogOut, Menu, User, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useMemberAuth } from './auth'

export interface SiteNavItem {
  to: string
  label: string
}

/** 데스크탑/모바일 공통 네비 정의. */
export const SITE_NAV: SiteNavItem[] = [
  { to: '/', label: '홈' },
  { to: '/system', label: `${BRAND.short}시스템` },
  { to: '/data', label: `${BRAND.name}자료` },
  { to: '/membership', label: `${BRAND.short}멤버십` },
  { to: '/mypage', label: '마이페이지' },
  { to: '/support', label: '고객센터' },
]

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'rounded-md px-3 py-2 text-[14px] font-semibold transition-colors',
    isActive
      ? 'bg-primary-50 text-primary-700'
      : 'text-gray-600 hover:bg-gray-100 hover:text-ink-900',
  )
}

function BrandLogo() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-1.5" aria-label={`${BRAND.name} 홈`}>
      <span className="text-[20px] font-extrabold leading-none tracking-tight text-ink-900">
        {BRAND.short}<span className="text-accent-500">{BRAND.rest}</span>
      </span>
    </Link>
  )
}

export function SiteLayout() {
  const { member, logout } = useMemberAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  function handleLogout() {
    logout()
    setMenuOpen(false)
    navigate('/')
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 font-sans text-ink-900">
      {/* ── 헤더 ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-4 px-4 sm:px-6">
          <BrandLogo />

          {/* 데스크탑 네비 */}
          <nav className="ml-2 hidden items-center gap-0.5 lg:flex">
            {SITE_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={navLinkClass}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* 우측 액션(데스크탑) */}
          <div className="ml-auto hidden items-center gap-2 lg:flex">
            {member ? (
              <>
                <Link
                  to="/mypage"
                  className="flex items-center gap-1.5 rounded-md px-3 py-2 text-[14px] font-semibold text-gray-700 hover:bg-gray-100"
                >
                  <User className="h-4 w-4" />
                  마이페이지
                </Link>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-[14px] font-semibold text-gray-600 transition-colors hover:bg-gray-50"
                >
                  <LogOut className="h-4 w-4" />
                  로그아웃
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="flex items-center gap-1.5 rounded-md px-3 py-2 text-[14px] font-semibold text-gray-700 hover:bg-gray-100"
                >
                  <LogIn className="h-4 w-4" />
                  로그인
                </Link>
                <Link
                  to="/signup"
                  className="rounded-md bg-primary-600 px-4 py-2 text-[14px] font-bold text-white transition-colors hover:bg-primary-700"
                >
                  회원가입
                </Link>
              </>
            )}
          </div>

          {/* 모바일 햄버거 */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="ml-auto grid h-10 w-10 place-items-center rounded-md text-gray-600 hover:bg-gray-100 lg:hidden"
            aria-label={menuOpen ? '메뉴 닫기' : '메뉴 열기'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {/* 모바일 토글 메뉴 */}
        {menuOpen && (
          <div className="border-t border-gray-200 bg-white lg:hidden">
            <nav className="mx-auto flex max-w-[1120px] flex-col gap-0.5 px-4 py-3">
              {SITE_NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'rounded-md px-3 py-2.5 text-[15px] font-semibold transition-colors',
                      isActive
                        ? 'bg-primary-50 text-primary-700'
                        : 'text-gray-700 hover:bg-gray-100',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
              <div className="my-2 h-px bg-gray-100" />
              {member ? (
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-[15px] font-semibold text-gray-700 hover:bg-gray-100"
                >
                  <LogOut className="h-4 w-4" />
                  로그아웃 ({member.name}님)
                </button>
              ) : (
                <div className="flex flex-col gap-2 px-1 pt-1">
                  <Link
                    to="/login"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center justify-center gap-1.5 rounded-md border border-gray-300 py-2.5 text-[15px] font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    <LogIn className="h-4 w-4" />
                    로그인
                  </Link>
                  <Link
                    to="/signup"
                    onClick={() => setMenuOpen(false)}
                    className="rounded-md bg-primary-600 py-2.5 text-center text-[15px] font-bold text-white hover:bg-primary-700"
                  >
                    회원가입
                  </Link>
                </div>
              )}
            </nav>
          </div>
        )}
      </header>

      {/* ── 본문 ─────────────────────────────────────────────── */}
      <main className="flex-1">
        <Outlet />
      </main>

      {/* ── 푸터 ─────────────────────────────────────────────── */}
      <footer className="mt-16 border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-[1120px] px-4 py-10 sm:px-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="mb-2 text-[18px] font-extrabold text-ink-900">
                {BRAND.short}<span className="text-accent-500">{BRAND.rest}</span>
              </div>
              <p className="max-w-md text-[13px] leading-relaxed text-gray-500">
                본 서비스는 로또 번호 추천 정보 제공 서비스이며, 당첨을 보장하지 않습니다.
                <br />
                지나친 구매는 사행성을 조장할 수 있으니 적정 구매 한도를 지켜주세요.
              </p>
            </div>
            <div className="text-[12.5px] leading-relaxed text-gray-400">
              {/* TODO(live-verify): 실제 상호/대표/사업자번호/주소/고객센터 번호로 교체 */}
              <p>상호: {BRAND.name} · 대표: -</p>
              <p>사업자등록번호: ----- -----</p>
              <p>주소: -</p>
              <p>고객센터: -</p>
            </div>
          </div>
          <div className="mt-8 border-t border-gray-100 pt-5">
            <p className="text-[12px] text-gray-400">
              © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
            </p>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-gray-400">
              도박 문제 상담: 한국도박문제예방치유원 국번없이 1336
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}
