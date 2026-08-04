import type { Role } from '@/types/db'
import { navIcons } from '@/design-system/icons'

export type NavKey = keyof typeof navIcons
export type NavAccessMap = Record<string, Role[]>

// 모듈(메뉴) 평면 목록 — 권한 매트릭스 행 순서.
export const NAV_KEYS = Object.keys(navIcons) as NavKey[]

export const MODULE_LABEL: Record<NavKey, string> = {
  dashboard: '대시보드',
  members: '이용자',
  payments: '결제',
  revenue: '매출',
  myCustomers: '나의고객',
  community: '커뮤니티',
  support: '고객센터',
  lotto: '로또기록',
  bets: '베팅',
  admins: '관리자',
  logs: '로그',
  stats: '통계',
  settings: '설정',
  payroll: '급여',
}

export const ROLE_ORDER: Role[] = ['admin', 'manager', 'leader', 'rep']

// 명칭변경(현장 피드백 2026-06): admin=최고관리자 > manager=관리자 > leader=실장 > rep=팀장.
// 내부 role 키(admin/manager/leader/rep)는 그대로, 표시 라벨만 변경한다.
export const ROLE_LABEL: Record<Role, string> = {
  admin: '최고관리자',
  manager: '관리자',
  leader: '실장',
  rep: '팀장',
}

// 자기잠금 방지: admin 은 이 모듈 접근을 항상 보유(매트릭스에서 해제 불가).
export const ADMIN_LOCKED: NavKey[] = ['admins', 'logs']

// 통화녹음 열람 권한(현장 피드백 8/4, 정의현 차장 — "통화녹음 관련 내용은 관리자 이상급 아이디만").
// 라벨 기준 관리자(manager) 이상 = admin·manager. 회원상세 '통화녹음' 탭, 미매칭 통화녹음 화면,
// 설정의 앱 배포 카드가 이 한 함수를 공유한다 — 범위 조정은 여기 한 곳만 고치면 된다.
export function canViewCallRecordings(role: Role | null): boolean {
  return role === 'admin' || role === 'manager'
}

// 메뉴 노출 기본 매트릭스 (CLAUDE §5). 권한관리(/admins/roles)에서 편집 → DB nav_access 로 영속.
// 데이터 접근은 RLS(lib/rls/policies.sql)로 이중 통제.
// TODO(live-verify): `08 권한관리` 화면 미확인 → 아래는 합리적 기본값. ASSUMPTIONS 기록.
// 현장 피드백(6/11 메인메뉴): 팀장(rep)=이용자·나의고객만, 실장(leader)=로또기록·추천번호 제외.
export const DEFAULT_NAV_ACCESS: Record<NavKey, Role[]> = {
  dashboard: ['admin', 'manager', 'leader'],
  members: ['admin', 'manager', 'leader', 'rep'],
  payments: ['admin', 'manager', 'leader'],
  revenue: ['admin', 'manager', 'leader'],
  myCustomers: ['admin', 'manager', 'leader', 'rep'],
  community: ['admin', 'manager', 'leader'],
  support: ['admin', 'manager', 'leader'],
  lotto: ['admin', 'manager'],
  bets: ['admin', 'manager', 'leader'],
  // 계정관리(/admins)는 계층 위임(§5)으로 실장도 접근 — 본인 하위 직원만 스코프(AdminsPage).
  // 단, 권한 매트릭스(/admins/roles)는 RolesPage 내부에서 admin 전용으로 별도 가드.
  admins: ['admin', 'manager', 'leader'],
  logs: ['admin'],
  stats: ['admin', 'manager', 'leader'],
  settings: ['admin', 'manager'],
  // 급여(커미션 금액)는 민감정보라 최고관리자·관리자만 노출(현장 7/9).
  payroll: ['admin', 'manager'],
}

/** 주어진 매트릭스(없으면 기본값)로 접근 판정. admin 의 잠금 모듈은 항상 허용. */
export function canAccessWith(map: NavAccessMap | undefined, role: Role | null, key: NavKey): boolean {
  if (!role) return false
  if (role === 'admin' && ADMIN_LOCKED.includes(key)) return true
  const roles = map?.[key] ?? DEFAULT_NAV_ACCESS[key]
  return roles.includes(role)
}

/** 정적 폴백 — 기본 매트릭스 기준(맵 미주입 호출용). */
export function canAccess(role: Role | null, key: NavKey): boolean {
  return canAccessWith(DEFAULT_NAV_ACCESS, role, key)
}

// ── 계정관리 계층 위임(§5) ────────────────────────────────────────────
// admin(총괄) > manager(실장) > leader(팀장) > rep(담당자). 상위만 하위를 관리한다.
// admin 은 전원(자신 포함) 관리·역할부여 가능. 실장은 팀장·담당 전체, 팀장은 본인 팀 담당자만.
// 동급·상위는 관리 불가, 본인 역할 변경 불가(호출부에서 id 비교로 별도 차단).

/** actor 역할이 생성·부여할 수 있는 역할 목록. admin 은 전원, 그 외는 자신보다 하위만. */
export function assignableRoles(actor: Role | null): Role[] {
  if (!actor) return []
  if (actor === 'admin') return [...ROLE_ORDER]
  return ROLE_ORDER.slice(ROLE_ORDER.indexOf(actor) + 1)
}

/** actor(현재 사용자)가 target(직원)을 생성·수정·정지할 수 있는가. */
export function canManageStaff(
  actor: { role: Role; id: string; teamId: string | null } | null,
  target: { role: Role; team_id: string | null },
): boolean {
  if (!actor) return false
  if (actor.role === 'admin') return true
  // 동급·상위 불가 — 자신보다 하위 역할만.
  if (ROLE_ORDER.indexOf(actor.role) >= ROLE_ORDER.indexOf(target.role)) return false
  // 팀장은 본인 팀 소속만.
  if (actor.role === 'leader') return actor.teamId != null && actor.teamId === target.team_id
  return true
}
