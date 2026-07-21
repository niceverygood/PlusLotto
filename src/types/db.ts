// 플러스로또 도메인 타입 — 라이브 Supabase 확정 전 수기 작성한 인터림 모델.
// TODO(live-verify): 실 DB 연결 시 `supabase gen types typescript` 결과로 대체/정합. (DECISIONS D1)

export type Role = 'admin' | 'manager' | 'leader' | 'rep'

export type Grade =
  | 'simple' // 간편가입
  | 'free' // 무료
  | 'gold' // 골드
  | 'goldp' // 골드플러스
  | 'vip' // VIP
  | 'royal' // 로얄
  | 'ovr' // 인반언스 (명칭 미확인)
  | 'toss' // 토스DB

export type MemberStatus = 'active' | 'suspended' | 'deleted' | 'withdrawn'

export type PaymentStatus = 'wait' | 'approved' | 'failed' | 'cancelled'

export type PaymentMethod = 'bank' | 'manual' | 'pg' // 무통장 | 수기 | PG

export type SmsType = 'join' | 'recommend' | 'win' | 'marketing' | 'direct' // 가입·추천·당첨·마케팅·직접입력

export type AssignType = 'manual' | 'auto'

export type LogKind = 'admin' | 'point' | 'sms' | 'payment' | 'inflow'

export interface Team {
  id: string
  name: string
  leader_id: string | null
}

export interface Staff {
  id: string
  login_id: string
  name: string
  role: Role
  team_id: string | null
  is_active: boolean
  auto_assign_enabled: boolean // 자동배분 대상 풀 포함 여부(rep 대상, §V2-1)
  last_login_at: string | null
}

export interface Product {
  id: string
  name: string
  price: number
  duration_months: number
  grade_granted: Grade
  is_active: boolean
}

export interface Member {
  id: string
  user_id: string // 로그인 ID
  name: string
  nickname: string | null
  phone: string
  grade: Grade
  status: MemberStatus
  tendency: string | null // 성향
  consult_status: string | null // 상담상태(신규/결번/부재/가망/승인/통화예약/도입거절/일반거절/기타)
  inflow_code: string | null
  inflow_type: string | null
  assigned_staff_id: string | null
  team_id: string | null
  memo: string | null
  win_history: string | null
  outcall_done: boolean // 아웃콜 처리 여부
  registered_at: string
  last_active_at: string | null
  is_suspended: boolean
  is_deleted: boolean
  is_withdrawn: boolean
  meta: Record<string, unknown>
}

export interface Payment {
  id: string
  member_id: string
  product_id: string | null
  amount: number
  method: PaymentMethod
  pg_provider: string | null
  status: PaymentStatus
  period_start: string | null
  period_end: string | null
  depositor_name: string | null
  staff_id: string | null
  paid_at: string | null
  created_at: string
}

export interface SmsSend {
  id: string
  member_id: string
  template_key: string | null
  phone: string
  body: string
  type: SmsType
  status: string
  sent_at: string | null
}

export interface SmsTemplate {
  key: string
  title: string
  body: string
  category: string
}

export interface LottoRound {
  round_no: number
  draw_date: string
  numbers: number[] // 6개
  bonus: number
  sum: number
  odd_even: string
  appear_rate: number | null
  prize_1: number | null
  prize_2: number | null
  prize_3: number | null
  total_sales: number | null
  confirmed_at: string | null // 당첨 확정(베팅 등수/당첨금 산정) 시각. null=미확정
}

export interface Bet {
  id: string
  round_no: number
  issuer: string | null
  member_ref: string | null
  numbers: number[]
  rank: number | null
  prize: number | null
}

export interface Assignment {
  id: string
  member_id: string
  staff_id: string | null
  assigned_by: string | null
  type: AssignType
  created_at: string
}

export interface LogEntry {
  id: string
  kind: LogKind
  actor: string | null
  action: string
  target_type: string | null
  target_id: string | null
  meta: Record<string, unknown>
  created_at: string
}

// ── 커뮤니티 (공지사항 · 이벤트) ──────────────────────────────────────
export interface Notice {
  id: string
  title: string
  body: string
  pinned: boolean // 상단 고정
  published: boolean // 게시 여부(false=임시저장)
  author_id: string | null // staff.id
  view_count: number
  created_at: string
  updated_at: string
}

export interface CampaignEvent {
  id: string
  title: string
  body: string
  starts_at: string | null
  ends_at: string | null
  published: boolean
  author_id: string | null
  view_count: number
  created_at: string
  updated_at: string
}

// ── 고객센터 (1:1 문의 · FAQ) ─────────────────────────────────────────
export type InquiryStatus = 'open' | 'answered' // 대기 → 답변완료

export interface Inquiry {
  id: string
  member_id: string | null // 회원 연결(있으면)
  author_name: string
  category: string // 문의 유형(결제/번호/계정/기타)
  title: string
  body: string
  status: InquiryStatus
  answer: string | null
  answered_by: string | null // staff.id
  answered_at: string | null
  created_at: string
}

export interface Faq {
  id: string
  category: string
  question: string
  answer: string
  sort_order: number
  published: boolean
}

// ── 설정 (site_settings — 단일 행, Phase 10) ──────────────────────────
export interface BankTransferSettings {
  bank_name: string
  account_no: string
  holder: string
  guide: string // 입금 안내 문구
}

// PG 다중 설정(웰컴페이먼츠·페이허브·플러스페이·코밴·온미르·하이브플러스 등).
// api_key 는 시크릿 → UI 마스킹. TODO(live-verify): 실 PG 연동 키/TID 체계는 라이브 확정.
export interface PgProvider {
  id: string
  name: string
  enabled: boolean
  mid: string // 상점 ID
  api_key: string // 시크릿(마스킹)
  tids: string[] // 단말기 ID 다수(온미르 등)
  memo: string | null
}

export interface SmsSettings {
  sender_no: string // 발신번호(OneShot send_phone/CALLBACK — 사전등록 필수)
  smtnt_id: string // OneShot 사용자 아이디(매뉴얼 id, 예: lotto_dream_api)
  smtnt_key: string // (미사용) OneShot 은 IP 화이트리스트 인증이라 API 키 없음 — 보존용
  oneshot_enabled: boolean // 실발송 사용(OneShot 경유) §V2-6
  ad_optout: string // 광고성 무료수신거부 번호(있으면 마케팅 문자에 (광고)+번호 자동표기)
}

export interface GradeColor {
  fg: string // 라벨/도트 색
  bg: string // 칩 배경색
}
export type GradeColorMap = Record<Grade, GradeColor>

export interface WinMessage {
  rank: number // 1..5등
  body: string // $변수 사용 가능
}

// 정기 리포트(운영 지표 자동 발송) 설정. TODO(live-verify): 실제 발송 채널/지표 항목 라이브 확정.
export type ReportFrequency = 'daily' | 'weekly' | 'monthly'
export interface ReportSettings {
  enabled: boolean
  frequency: ReportFrequency
  weekday: number // 0=일 … 6=토 (frequency=weekly)
  day_of_month: number // 1..28 (frequency=monthly)
  time: string // HH:mm
  recipients: string[] // 수신 이메일
  sections: string[] // 포함 지표 키(revenue/signup/payment/outcall)
}

// 로또 추천 번호 고정/제외 설정(1..45). TODO(live-verify): 추천 엔진 연동 규칙 미확인.
export interface LottoExcludeSettings {
  fixed: number[] // 항상 포함
  excluded: number[] // 항상 제외
}

// 회차별 고정/제외 이력 + 효력일자(§V2-5). 토요일 입력 → 익주 월요일(effective_from)부터 적용.
// grade=null → 공통(전체 등급). 특정 등급 규칙이 있으면 그 등급은 등급 규칙, 없으면 공통으로 폴백(현장 피드백).
export interface LottoExcludeRule {
  id: string
  round_no: number
  grade: Grade | null // null = 공통(전체 등급 공통)
  fixed: number[]
  excluded: number[]
  effective_from: string // YYYY-MM-DD, 이 날짜부터 적용
  created_at: string
  created_by: string | null
}

// 무료회원 주간 자동발급(현장 피드백) — 매주 금 09:00 N조합 발급(문자발송 X), 홈페이지에서 조회.
export interface WeeklyFreeRecoSettings {
  enabled: boolean
  set_count: number // 발급 조합 수(기본 30) — 회원별 weekly_reco_count 가 우선
  logic_ratio?: number // 로직 적용 비율 %(기본 100) — 나머지는 완전랜덤 조합(현장 피드백)
  paid_sms?: boolean // 유료회원(골드/골드+/VIP/로얄) 지정요일 조합 SMS 자동발송(현장 피드백 6/18). 실발송(oneshot)+발신번호도 필요.
}

// 회원에게 발급된 주간 추천 1회분(member.meta.weekly_recos[]). 홈페이지(전화/뒷4자리)에서 조회.
export interface WeeklyRecoIssue {
  round_no: number
  issued_at: string
  sets: number[][] // 각 6/45 오름차순
}

// 멤버십 등급 카드(고객 멤버십 페이지) — 전산에서 운영자가 직접 편집(명칭·가격·혜택·약관). 현장 6/30.
// 공개 안전 필드만(비밀 없음) → security-definer RPC portal_membership_tiers() 로 anon 공개.
// label 은 전산 GRADE_LABEL 로도 전파(등급명 전역 변경, 6/30 정의현 차장).
export interface MembershipTier {
  grade: Grade // 노출 등급(free/gold/goldp/vip/royal). simple/ovr/toss 는 미노출.
  label: string // 등급 명칭(편집 가능, 예: 골드플러스→88마스터)
  price: string // 월 이용료 표시 텍스트(예: '문의' 또는 '490,000원')
  tagline: string // 한 줄 소개
  weekly_sets: string // 주간 조합 수 표시(예: '주 5조합')
  highlights: string[] // 카드 혜택 목록
  featured: boolean // '인기' 뱃지 강조
  terms: string // 등급별 개별약관(개별약관서) — 비우면 미노출
  hidden?: boolean // true 면 고객 홈페이지(멤버십 카드·비교표)에서 숨김. 전산 편집은 계속 가능(현장 7/20)
}

// 조합 생성 과정 기록(현장 피드백 7/3 "녹화기능") — 제외수 세팅 검토 중 [추천번호] 미리보기에서
// 저장하면, 규칙 스냅샷·번호별 제외사유·남은 풀·최종 조합을 통째로 남긴다(특허·불기소이유서 근거자료).
export interface GenerationRecord {
  id: string
  created_at: string
  created_by: string | null
  grade: Grade | null // 대상 등급(null=공통)
  target_round: number
  mode: number // 제외수 개수
  fixed: number[]
  excluded: number[]
  reasons: { number: number; rule: string }[] // 번호별 제외 사유(규칙 키)
  pool: number[] // 남은 풀
  sets: number[][] // 생성된 추천 조합
  note?: string // 운영자 메모(선택)
}

// 통화 녹음 1건(현장 피드백 7/3, 김형준 이사) — member.meta.call_recordings[] 에 적재.
// 1단계: 법인폰/PBX 자동연동 정보가 없어 상담원 수동 업로드로 시작(Storage 버킷 call-recordings).
export interface CallRecording {
  id: string
  created_at: string
  uploaded_by: string | null
  file_path: string // storage 'call-recordings' 버킷 내 경로
  file_name: string
  transcript?: string | null // STT 전사본(요청 시 생성)
  transcribed_at?: string | null
  keyword_hits?: { keyword: string; count: number }[] // 설정된 특정 단어(예: '보장') 탐지 결과
  source?: 'manual' | 'auto' // 수동 업로드 vs Android 앱 자동업로드(현장 피드백 7/6) — 미설정=manual 취급
  ai_analysis?: CallAiAnalysis | null // AI 통화분석(현장 피드백 7/10, 정의현 차장) — 전사본 필요
  analyzed_at?: string | null
}

// 통화녹음 AI 분석 결과(현장 피드백 7/10) — 전사본을 LLM 에 보내 구조화된 분석을 받는다.
// scriptMatch 는 site_settings.call_script(기준 스크립트)가 설정된 경우에만 채워진다.
export interface CallAiAnalysis {
  successFactors: string[] // 성공요인
  failFactors: string[] // 실패요인
  scriptMatch: string | null // 스크립트와의 유사성(기준 스크립트 미설정 시 null)
  summary: string // 한줄 요약
}

export interface SiteSettings {
  bank: BankTransferSettings
  grade_colors: GradeColorMap
  pg_providers: PgProvider[]
  sms: SmsSettings
  win_messages: WinMessage[] // 1~5등 당첨문자
  report: ReportSettings
  lotto_exclude: LottoExcludeSettings // 현재 적용 스냅샷(폴백)
  lotto_exclude_history: LottoExcludeRule[] // 회차별 이력 + 효력일자(§V2-5)
  call_keywords?: string[] // 통화 녹음 자동탐지 특정 단어(예: '보장') — 현장 피드백 7/3
  call_volume_alert_threshold?: number // 월 발신 통화량(상담상태 변경 건수) 경고 기준 — 현장 피드백 7/3, 기본 1000
  call_script?: string // AI 통화분석의 기준 스크립트(현장 피드백 7/10) — 비우면 유사성 비교 생략
  weekly_free_reco: WeeklyFreeRecoSettings // 무료회원 주간 자동발급(현장 피드백)
  terms: string // 이용약관 본문(공통/기본)
  terms_by_grade?: Partial<Record<Grade, string>> // 등급별 약관(현장 피드백 6/11) — 미설정 등급은 공통 폴백
  membership_tiers?: MembershipTier[] // 멤버십 등급 카드(전산 편집 → 고객 연동, 6/30) — 미설정 시 코드 기본값 폴백
  generation_records?: GenerationRecord[] // 조합 생성 과정 기록(현장 피드백 7/3) — 미설정 시 빈 배열
  business?: BusinessInfo // 사업자 정보(고객 홈페이지 하단 노출, 현장 피드백 7/20) — 미설정 시 공란
  winner_stats?: WinnerStats // 누적 당첨자 수 수동 표시(고객 홈페이지, 현장 피드백 7/20) — 미설정 시 미노출
}

// 공개 안전 필드 — security-definer RPC portal_site_public() 로 anon 공개(bank·winner_stats 와 동행).
export interface BusinessInfo {
  name: string // 상호(회사명)
  reg_no: string // 사업자등록번호
  address: string // 주소
  support_phone: string // 고객센터 번호(표시용 — 실제 문자 발신번호와 별개)
}

// 누적이 아니라 "직전 확정 회차"의 등수별 당첨자 수(운영자 수동 입력, 현장 피드백 7/20 재확정).
// 회차 라벨(제N회)은 lotto_rounds 최신 확정 회차를 자동 사용 — 등수별 인원만 운영자가 채운다.
export interface WinnerStats {
  enabled: boolean // 고객 홈페이지 노출 여부
  rank1: number
  rank2: number
  rank3: number
  rank4: number
  rank5: number
}
