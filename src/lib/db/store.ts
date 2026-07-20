// 로컬 mock 데이터 계층 (DECISIONS D1) — Supabase 스키마와 동일한 형태를
// localStorage 에 영속한다. api.ts 훅 뒤에서만 사용하고 컴포넌트는 직접 접근 금지.
// TODO(live-verify): 실 Supabase 전환 시 이 계층은 우회되고 supabase 클라이언트가 대신한다.
import type {
  Assignment,
  Bet,
  CampaignEvent,
  Faq,
  Inquiry,
  LogEntry,
  LottoRound,
  Member,
  Notice,
  Payment,
  Product,
  Role,
  SiteSettings,
  SmsSend,
  SmsTemplate,
  Staff,
  Team,
} from '@/types/db'
import { buildSeed } from './seed'

export interface DbShape {
  staff: Staff[]
  teams: Team[]
  products: Product[]
  members: Member[]
  payments: Payment[]
  sms_sends: SmsSend[]
  sms_templates: SmsTemplate[]
  lotto_rounds: LottoRound[]
  bets: Bet[]
  assignments: Assignment[]
  logs: LogEntry[]
  notices: Notice[]
  events: CampaignEvent[]
  inquiries: Inquiry[]
  faqs: Faq[]
  nav_access: Record<string, Role[]>
  site_settings: SiteSettings
}

const DB_KEY = 'pluslotto-db'
// 시드 구조가 바뀌면 올린다 → 기존 localStorage 가 자동 재시드된다.
// v7: 계정관리 계층 위임(§5) — nav_access.admins 기본값에 manager·leader 추가.
// v8: 자동배분 대상 풀(§V2-1) — staff.auto_assign_enabled 추가.
// v9: 고정/제외 회차별 이력(§V2-5) — site_settings.lotto_exclude_history 추가.
// v10: 고정/제외 등급별 규칙 + 유입구분 콜단계 + 콜메모 리스트 + DB초기화 가입일시 갱신(현장 피드백).
// v11: 무료회원 주간 발급 설정(site_settings.weekly_free_reco) + member.meta.weekly_recos(현장 피드백).
// v12: 유입구분 '구디비' 추가 + member.consult_status(상담상태) 추가(현장 피드백).
// v13: 역할별 메뉴 축소(팀장=이용자·나의고객, 실장=로또 제외) + 등급별 약관(현장 피드백 6/11).
const DB_VERSION = 14

interface Persisted {
  __v: number
  data: DbShape
}

let cache: DbShape | null = null

// 깊은 복제(structuredClone 우선, 폴백 JSON). copy-on-write 에 사용.
function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T)
}

function persist(data: DbShape): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(DB_KEY, JSON.stringify({ __v: DB_VERSION, data } satisfies Persisted))
}

function load(): DbShape {
  if (typeof localStorage === 'undefined') return buildSeed()
  const raw = localStorage.getItem(DB_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Persisted
      if (parsed.__v === DB_VERSION && parsed.data) return parsed.data
    } catch {
      // 손상/구버전 → 재시드로 폴백
    }
  }
  const seed = buildSeed()
  persist(seed)
  return seed
}

/** 현재 DB 스냅샷 (캐시). api 훅의 queryFn 에서 읽는다. */
export function readDb(): DbShape {
  if (!cache) cache = load()
  return cache
}

/**
 * DB 변경 + 영속화. copy-on-write: 캐시를 깊은 복제한 뒤 fn 으로 변경하고 통째로 교체한다.
 * 이렇게 해야 이전 스냅샷(React Query 가 들고 있는 데이터)의 객체 참조가 보존되어,
 * 무효화 후 재조회 시 structural sharing 이 변경을 감지하고 활성 옵저버를 리렌더한다(§8 라이브 반영).
 * fn 내부는 기존처럼 db 인자를 in-place 로 변경하면 된다.
 */
export function mutateDb(fn: (db: DbShape) => void): void {
  const next = clone(readDb())
  fn(next)
  cache = next
  persist(next)
}

/** 시드로 초기화 (개발/설정의 "데모 데이터 리셋"용). */
export function resetDb(): DbShape {
  cache = buildSeed()
  persist(cache)
  return cache
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function genId(prefix = ''): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix ? `${prefix}_${id}` : id
}
