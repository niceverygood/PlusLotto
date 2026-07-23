import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppShell } from './AppShell'
import { RequireAuth } from './RequireAuth'
import { RequireNav } from './RequireNav'
import { LoginPage } from '@/features/auth/LoginPage'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { MembersPage } from '@/features/members/MembersPage'
import { MemberPopupPage } from '@/features/members/MemberPopupPage'
import { MyCustomersPage } from '@/features/members/MyCustomersPage'
import { MySmsPage } from '@/features/members/MySmsPage'
import { CommunityPage } from '@/features/community/CommunityPage'
import { SupportPage } from '@/features/support/SupportPage'
import { PaymentsPage } from '@/features/payments/PaymentsPage'
import { ManualPaymentPage } from '@/features/payments/ManualPaymentPage'
import { RevenuePage } from '@/features/revenue/RevenuePage'
import { LottoResultsPage } from '@/features/lotto/LottoResultsPage'
import { RecommendPage } from '@/features/lotto/RecommendPage'
import { BetsPage } from '@/features/bets/BetsPage'
import { AdminsPage } from '@/features/admins/AdminsPage'
import { RolesPage } from '@/features/admins/RolesPage'
import { UnmatchedRecordingsPage } from '@/features/admins/UnmatchedRecordingsPage'
import { LogsPage } from '@/features/logs/LogsPage'
import { StatsPage } from '@/features/stats/StatsPage'
import { PayrollPage } from '@/features/payroll/PayrollPage'
import { SettingsLayout } from '@/features/settings/SettingsLayout'
import { SiteSettingsPage } from '@/features/settings/SiteSettingsPage'
import { MembershipSettingsPage } from '@/features/settings/MembershipSettingsPage'
import { ReportSettingsPage } from '@/features/settings/ReportSettingsPage'
import { LottoExcludePage } from '@/features/settings/LottoExcludePage'
import { TermsSettingsPage } from '@/features/settings/TermsSettingsPage'
import { ComponentsPage } from '@/features/dev/ComponentsPage'
// 기존 단일 PortalPage(/portal) 는 새 SiteHomePage(로그인/마이페이지로 기능 흡수)로 대체됨.
import { MemberAuthProvider } from '@/features/site/auth'
import { SiteLayout } from '@/features/site/SiteLayout'
import { HomePage as SiteHomePage } from '@/features/site/HomePage'
import { SystemPage as SiteSystemPage } from '@/features/site/SystemPage'
import { DataPage as SiteDataPage } from '@/features/site/DataPage'
import { MembershipPage as SiteMembershipPage } from '@/features/site/MembershipPage'
import { MyPage as SiteMyPage } from '@/features/site/MyPage'
import { LoginPage as SiteLoginPage } from '@/features/site/LoginPage'
import { SignupPage as SiteSignupPage } from '@/features/site/SignupPage'
import { SupportPage as SiteSupportPage } from '@/features/site/SupportPage'
import { TermsPage as SiteTermsPage } from '@/features/site/TermsPage'
import { useRole } from '@/lib/auth'

// 랜딩 분기(현장 피드백 6/11): 팀장(rep)은 메뉴가 이용자·나의고객뿐이라 /admin/members 로 보낸다.
function RoleHome() {
  const role = useRole()
  return <Navigate to={role === 'rep' ? '/admin/members' : '/admin/dashboard'} replace />
}

// 구(舊) /portal/* → 루트 이전 호환(정의현 7/20 도메인 구조 변경). 기존 안내 링크·북마크 보존.
function LegacyPortalRedirect() {
  const location = useLocation()
  const rest = location.pathname.replace(/^\/portal/, '') || '/'
  return <Navigate to={`${rest}${location.search}`} replace />
}

// 구(舊) 루트 직원 경로(/members 등) → /admin 접두 호환. 코드 내 잔존 절대경로 링크·북마크 보존.
function LegacyAdminRedirect() {
  const location = useLocation()
  return <Navigate to={`/admin${location.pathname}${location.search}`} replace />
}

/** 구 루트 직원 경로 최상위 접두 목록 — /support·/login 은 고객 사이트가 차지하므로 제외(직접 스윕 완료). */
const LEGACY_ADMIN_PREFIXES = [
  'dashboard', 'members', 'my', 'community', 'payments', 'revenue',
  'lotto', 'bets', 'admins', 'logs', 'stats', 'payroll', 'settings', 'dev',
] as const

/**
 * 라우트 정의 (정의현 7/20 확정 구조):
 *   루트(/)      = 고객 홈페이지 (구 /portal — MemberAuthProvider + SiteLayout, staff 인증과 분리)
 *   /admin/*     = 직원 운영 콘솔 (RequireAuth + AppShell, 로그인은 /admin/login)
 *   /portal/*    = 구 고객 주소 호환 리다이렉트
 * 모듈 라우트는 권한 매트릭스(nav_access) 기반 RequireNav 로 가드(§5) — 메뉴 숨김과 동일 기준.
 * 대시보드는 리다이렉트 폴백이므로 가드하지 않는다.
 */
export function AppRoutes() {
  return (
    <Routes>
      {/* 직원 로그인 (셸 밖) */}
      <Route path="/admin/login" element={<LoginPage />} />

      {/* 회원상세 팝업(새창, 현장 피드백 7/23) — AppShell 밖, 여러 창을 동시에 띄우기 위함 */}
      <Route
        path="/admin/members/popup/:id"
        element={
          <RequireAuth>
            <MemberPopupPage />
          </RequireAuth>
        }
      />

      {/* 고객 홈페이지(공개) = 루트 — 전화번호/뒷4자리 로그인, 본인 발급번호 조회(현장 피드백). */}
      <Route
        path="/"
        element={
          <MemberAuthProvider>
            <SiteLayout />
          </MemberAuthProvider>
        }
      >
        <Route index element={<SiteHomePage />} />
        <Route path="system" element={<SiteSystemPage />} />
        <Route path="data" element={<SiteDataPage />} />
        <Route path="membership" element={<SiteMembershipPage />} />
        <Route path="mypage" element={<SiteMyPage />} />
        <Route path="login" element={<SiteLoginPage />} />
        <Route path="signup" element={<SiteSignupPage />} />
        <Route path="support" element={<SiteSupportPage />} />
        <Route path="terms/:grade" element={<SiteTermsPage />} />
      </Route>

      {/* 구 /portal 주소 호환 (문자·안내 링크 보존) */}
      <Route path="/portal" element={<LegacyPortalRedirect />} />
      <Route path="/portal/*" element={<LegacyPortalRedirect />} />

      {/* 직원 운영 콘솔 = /admin */}
      <Route
        path="/admin"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<RoleHome />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="members" element={<RequireNav navKey="members"><MembersPage /></RequireNav>} />
        <Route path="my/customers" element={<RequireNav navKey="myCustomers"><MyCustomersPage /></RequireNav>} />
        <Route path="my/sms" element={<RequireNav navKey="myCustomers"><MySmsPage /></RequireNav>} />
        <Route path="community" element={<RequireNav navKey="community"><CommunityPage /></RequireNav>} />
        <Route path="support" element={<RequireNav navKey="support"><SupportPage /></RequireNav>} />
        <Route path="payments" element={<RequireNav navKey="payments"><PaymentsPage /></RequireNav>} />
        <Route path="payments/manual" element={<RequireNav navKey="payments"><ManualPaymentPage /></RequireNav>} />
        <Route path="revenue" element={<RequireNav navKey="revenue"><RevenuePage /></RequireNav>} />
        <Route path="lotto/results" element={<RequireNav navKey="lotto"><LottoResultsPage /></RequireNav>} />
        <Route path="lotto/recommend" element={<RequireNav navKey="lotto"><RecommendPage /></RequireNav>} />
        <Route path="bets" element={<RequireNav navKey="bets"><BetsPage /></RequireNav>} />
        <Route path="admins" element={<RequireNav navKey="admins"><AdminsPage /></RequireNav>} />
        <Route path="admins/roles" element={<RequireNav navKey="admins"><RolesPage /></RequireNav>} />
        <Route
          path="admins/recordings"
          element={
            <RequireNav navKey="admins">
              <UnmatchedRecordingsPage />
            </RequireNav>
          }
        />
        <Route path="logs" element={<Navigate to="/admin/logs/admin" replace />} />
        <Route path="logs/:kind" element={<RequireNav navKey="logs"><LogsPage /></RequireNav>} />
        <Route path="stats" element={<RequireNav navKey="stats"><StatsPage /></RequireNav>} />
        <Route path="payroll" element={<RequireNav navKey="payroll"><PayrollPage /></RequireNav>} />
        <Route path="settings" element={<RequireNav navKey="settings"><SettingsLayout /></RequireNav>}>
          <Route index element={<SiteSettingsPage />} />
          <Route path="membership" element={<MembershipSettingsPage />} />
          <Route path="report" element={<ReportSettingsPage />} />
          <Route path="lotto-exclude" element={<LottoExcludePage />} />
          <Route path="terms" element={<TermsSettingsPage />} />
        </Route>
        <Route path="dev/components" element={<ComponentsPage />} />
        <Route path="*" element={<Navigate to="/admin/dashboard" replace />} />
      </Route>

      {/* 구 루트 직원 경로 호환 (구 북마크·코드 내 잔존 절대경로) */}
      {LEGACY_ADMIN_PREFIXES.map((p) => (
        <Route key={p} path={`/${p}/*`} element={<LegacyAdminRedirect />} />
      ))}
      {LEGACY_ADMIN_PREFIXES.map((p) => (
        <Route key={`${p}-exact`} path={`/${p}`} element={<LegacyAdminRedirect />} />
      ))}

      {/* 그 외 알 수 없는 경로 → 고객 홈 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
