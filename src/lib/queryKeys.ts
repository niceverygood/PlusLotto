// 교차 모듈 쿼리 키 단일 출처 (CLAUDE §2·§8). 한 모듈의 뮤테이션이 다른 모듈의
// 캐시를 무효화해야 하므로(예: 결제 승인 → 회원 등급/목록 갱신) 키는 feature 간
// 직접 import 대신 lib 에서 공유한다.

export const memberKeys = {
  all: ['members'] as const,
  facets: (scope: string) => ['members', 'facets', scope] as const,
  list: (p: Record<string, unknown>) => ['members', 'list', p] as const,
  counts: (scope: string) => ['members', 'counts', scope] as const,
  detail: (id: string) => ['member', id] as const,
  payments: (id: string) => ['member', id, 'payments'] as const,
  sms: (id: string) => ['member', id, 'sms'] as const,
  assignments: (id: string) => ['member', id, 'assignments'] as const,
}

export const paymentKeys = {
  all: ['payments'] as const,
  list: (p: Record<string, unknown>) => ['payments', 'list', p] as const,
  counts: (scope: string) => ['payments', 'counts', scope] as const,
  detail: (id: string) => ['payment', id] as const,
}

// 매출은 payments(status='approved') 파생 집계 → 결제 승인/취소 시 함께 무효화(§8).
export const revenueKeys = {
  all: ['revenue'] as const,
  summary: (p: Record<string, unknown>) => ['revenue', 'summary', p] as const,
}

export const lottoKeys = {
  all: ['lotto'] as const,
  rounds: (p: Record<string, unknown>) => ['lotto', 'rounds', p] as const,
  round: (no: number) => ['lotto', 'round', no] as const,
}

// 베팅은 회차(당첨 확정) 시 등수/당첨금이 갱신됨 → 확정 뮤테이션이 함께 무효화(§8).
export const betKeys = {
  all: ['bets'] as const,
  list: (p: Record<string, unknown>) => ['bets', 'list', p] as const,
}

// 커뮤니티(공지·이벤트). 고객센터가 공지를 함께 노출 → 공지 뮤테이션이 supportKeys 도 무효화.
export const communityKeys = {
  all: ['community'] as const,
  notices: (p: Record<string, unknown>) => ['community', 'notices', p] as const,
  notice: (id: string) => ['community', 'notice', id] as const,
  events: (p: Record<string, unknown>) => ['community', 'events', p] as const,
  event: (id: string) => ['community', 'event', id] as const,
}

export const supportKeys = {
  all: ['support'] as const,
  inquiries: (p: Record<string, unknown>) => ['support', 'inquiries', p] as const,
  inquiry: (id: string) => ['support', 'inquiry', id] as const,
  faqs: (p: Record<string, unknown>) => ['support', 'faqs', p] as const,
}

// 설정(site_settings 단일 행). 등급색 저장 시 전 화면 Badge 토큰이 갱신됨(§3·gradeTheme).
export const settingsKeys = {
  all: ['settings'] as const,
  site: () => ['settings', 'site'] as const,
  winnerHistory: () => ['settings', 'winner-history'] as const,
}

// 고객 홈페이지 공개 데이터. 설정 저장 시 운영 콘솔과 고객 화면 캐시를 함께 무효화한다(§8).
export const siteKeys = {
  rounds: (n: number) => ['site', 'rounds', n] as const,
  notices: () => ['site', 'notices'] as const,
  faqs: () => ['site', 'faqs'] as const,
  tiers: () => ['site', 'membership-tiers'] as const,
  publicInfo: () => ['site', 'public-info'] as const,
}

// SMS 템플릿: members(드로어·일괄·나의문자)와 settings(편집)가 공유 → lib 단일 출처(§2·§8).
export const smsTemplateKeys = {
  all: ['sms_templates'] as const,
}

// 앱 진입 시 항상 보이는 서버 집계. 회원/결제/문의 뮤테이션이 함께 무효화한다.
export const operationalKeys = {
  all: ['operational'] as const,
  dashboard: (scope: string) => ['operational', 'dashboard', scope] as const,
  navBadges: (scope: string) => ['operational', 'nav-badges', scope] as const,
}

// 급여(커미션)·상담원 매칭분석 — payments(결제건별 담당자·차수) 파생 집계(현장 7/9).
export const payrollKeys = {
  all: ['payroll'] as const,
  month: (m: string) => ['payroll', 'month', m] as const,
  matching: (p: Record<string, unknown>) => ['payroll', 'matching', p] as const,
}
