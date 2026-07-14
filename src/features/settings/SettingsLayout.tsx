// 설정 레이아웃 — 4개 서브페이지 공통 sub-nav + <Outlet/> (CLAUDE §13 설정).
// 라우트: /settings(사이트) · /settings/report · /settings/lotto-exclude · /settings/terms.
import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '@/lib/cn'

const SUB_NAV: readonly { to: string; label: string; end?: boolean }[] = [
  { to: '/settings', label: '사이트 설정', end: true },
  { to: '/settings/membership', label: '멤버십 등급' },
  { to: '/settings/report', label: '리포트' },
  { to: '/settings/lotto-exclude', label: '로또 고정·제외' },
  { to: '/settings/terms', label: '이용약관' },
]

export function SettingsLayout() {
  return (
    <div className="mx-auto max-w-[940px]">
      <nav className="mb-4 flex flex-wrap gap-1.5">
        {SUB_NAV.map((s) => (
          <NavLink
            key={s.to}
            to={s.to}
            end={s.end}
            className={({ isActive }) =>
              cn(
                'rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition',
                isActive
                  ? 'bg-primary-600 text-white'
                  : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
              )
            }
          >
            {s.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
