// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 데이터 훅 (Phase 1 공유 기반, TanStack Query)
// ─────────────────────────────────────────────────────────────────────────
// 전부 anon 클라이언트(supabase)로 RLS 통과 범위만 읽는다. (mock 모드는 readDb)
// 중요: 0002_rls.sql 의 모든 정책이 `to authenticated` 라, 고객 사이트(anon)는
//   notices/faqs/lotto_rounds/inquiries SELECT·INSERT 가 RLS 로 막힐 가능성이 높다.
//   → 모든 훅은 막히면 "빈 배열"·"graceful 에러"로 폴백한다(화면이 죽지 않게).
//   라이브에서 고객 노출이 필요하면 anon SELECT 정책 추가가 별도 작업으로 필요.
//   // TODO(live-verify): anon 용 공개 SELECT 정책(notices/faqs/lotto_rounds published)·
//   //   가입문의 anon INSERT 정책 추가 여부 운영 확정.
//
// ── Phase2 가 쓸 export 시그니처 ─────────────────────────────────────────
//   useRecentRounds(n=10) → UseQueryResult<LottoRound[]>   // round_no desc, 막히면 []
//   useNotices()          → UseQueryResult<Notice[]>       // published=true, pinned→최신순
//   useFaqs()             → UseQueryResult<Faq[]>          // published=true, sort_order asc
//   useSubmitInquiry()    → useMutation, mutateAsync(InquiryInput) → { ok; error? }
//
//   InquiryInput = { name:string; phone?:string; category?:string; title:string; body:string }
// ─────────────────────────────────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { BankTransferSettings, BusinessInfo, Faq, Grade, LottoRound, MembershipTier, Notice, PromoSlide, TermsPost, WinnerStats } from '@/types/db'
import { dataSource, supabase } from '@/lib/supabase'
import { readDb } from '@/lib/db/store'
import { resolveTiers } from '@/lib/membership'
import { siteKeys } from '@/lib/queryKeys'
import { normalizeWinnerStats } from '@/lib/winnerStats'
import { CUSTOMER_BRAND, CUSTOMER_SITE } from '@/lib/customerSiteContext'
import { CUSTOMER_SITES, customerSiteTiers } from '@/lib/customerSites'
import type { PortalSourceSite } from '@/lib/portalScope'
import { sortTermsPosts } from '@/lib/termsPosts'

const digits = (s: string): string => s.replace(/\D/g, '')

export interface PublicSiteInfo {
  bank: BankTransferSettings
  business: BusinessInfo
  winner_stats: WinnerStats
  promo_slides: PromoSlide[]
}

const EMPTY_BANK: BankTransferSettings = { bank_name: '', account_no: '', holder: '', guide: '' }
const EMPTY_BUSINESS: BusinessInfo = { name: '', reg_no: '', address: '', support_phone: '' }

// ── 사업자 정보 · 무통장 계좌 · 당첨자 수(전산 편집 → 고객 홈페이지 노출, 현장 7/20) ────────
// site_settings 에는 PG api_key 비밀이 같이 있어 anon 직접 읽기 금지 → security-definer
// RPC portal_site_public() 이 bank/business/winner_stats 3개 컬럼만 반환(0013 마이그레이션).
export function usePublicSiteInfo(): UseQueryResult<PublicSiteInfo> {
  return useQuery({
    queryKey: [...siteKeys.publicInfo(), CUSTOMER_SITE?.key ?? 'pluslotto'],
    queryFn: async (): Promise<PublicSiteInfo> => {
      if (CUSTOMER_SITE) return {
        bank: CUSTOMER_SITE.bank, business: CUSTOMER_SITE.business,
        winner_stats: normalizeWinnerStats(null), promo_slides: [],
      }
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase.rpc('portal_site_public')
        const d = (!error && data ? data : {}) as Partial<PublicSiteInfo> // RPC 미생성/차단 → 빈 값 폴백
        return {
          bank: { ...EMPTY_BANK, ...d.bank },
          business: { ...EMPTY_BUSINESS, ...d.business },
          winner_stats: normalizeWinnerStats(d.winner_stats),
          promo_slides: Array.isArray(d.promo_slides) ? d.promo_slides : [],
        }
      }
      const s = readDb().site_settings
      return {
        bank: { ...EMPTY_BANK, ...s.bank },
        business: { ...EMPTY_BUSINESS, ...s.business },
        winner_stats: normalizeWinnerStats(s.winner_stats),
        promo_slides: Array.isArray(s.promo_slides) ? s.promo_slides : [],
      }
    },
    staleTime: 10 * 60 * 1000,
  })
}

// ── 멤버십 등급(전산 편집 → 고객 연동) ─────────────────────────────────────
// site_settings 에는 PG api_key 비밀이 같이 있어 anon 직접 읽기 금지 → security-definer
// RPC portal_membership_tiers() 가 membership_tiers 컬럼만 반환(0008 마이그레이션). 항상 5개로 정규화.
export function useMembershipTiers(sourceSite: PortalSourceSite | null = CUSTOMER_SITE?.key ?? null): UseQueryResult<MembershipTier[]> {
  const customerSite = CUSTOMER_SITES.find((site) => site.key === sourceSite)
  return useQuery({
    queryKey: [...siteKeys.tiers(), sourceSite ?? 'pluslotto'],
    queryFn: async (): Promise<MembershipTier[]> => {
      if (customerSite) return customerSiteTiers(customerSite)
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase.rpc('portal_membership_tiers')
        if (error || !data) return resolveTiers(null) // RPC 미생성/차단 → 코드 기본값
        return resolveTiers(data as MembershipTier[])
      }
      return resolveTiers(readDb().site_settings.membership_tiers)
    },
    // 운영자가 다른 탭에서 약관을 저장한 뒤 홈페이지로 돌아오면 즉시 재조회한다.
    staleTime: 0,
  })
}

// ── 약관보기(사이트별 약관 게시판, 현장 10/14) ─────────────────────────────────
// 고객(anon)은 terms_posts 를 직접 못 읽는다 → 사이트를 검증하는 RPC portal_terms_posts 가 공개 글만 준다.
// 그 등급 전용 글 + 공통(grade=null) 글, 시행일 최신순.
export type PublicTermsPost = Pick<TermsPost, 'id' | 'grade' | 'title' | 'body' | 'effective_on' | 'created_at'>

export function useTermsPosts(sourceSite: PortalSourceSite | null, grade: Grade | null): UseQueryResult<PublicTermsPost[]> {
  return useQuery({
    queryKey: [...siteKeys.terms(), sourceSite ?? 'none', grade ?? 'common'],
    enabled: !!sourceSite,
    queryFn: async (): Promise<PublicTermsPost[]> => {
      if (!sourceSite) return []
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase.rpc('portal_terms_posts', { p_source_site: sourceSite, p_grade: grade })
        if (error) throw new Error('약관을 불러오지 못했습니다.')
        return Array.isArray(data) ? (data as PublicTermsPost[]) : []
      }
      return sortTermsPosts((readDb().terms_posts ?? []).filter((p) =>
        p.published && p.source_site === sourceSite && (p.grade === null || p.grade === grade)))
    },
    staleTime: 0,
  })
}

// ── 최근 회차(자료 페이지) ────────────────────────────────────────────────
export function useRecentRounds(n = 10): UseQueryResult<LottoRound[]> {
  return useQuery({
    queryKey: siteKeys.rounds(n),
    queryFn: async (): Promise<LottoRound[]> => {
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase
          .from('lotto_rounds')
          .select('*')
          .order('round_no', { ascending: false })
          .limit(n)
        if (error || !data) return [] // RLS(anon) 차단 등 → graceful 빈배열
        return data as LottoRound[]
      }
      return [...readDb().lotto_rounds]
        .sort((a, b) => b.round_no - a.round_no)
        .slice(0, n)
    },
    staleTime: 5 * 60 * 1000,
  })
}

// ── 공지(커뮤니티) ────────────────────────────────────────────────────────
function sortNotices(rows: Notice[]): Notice[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.created_at.localeCompare(a.created_at)
  })
}

export function useNotices(): UseQueryResult<Notice[]> {
  return useQuery({
    queryKey: [...siteKeys.notices(), CUSTOMER_SITE?.key ?? 'pluslotto'],
    queryFn: async (): Promise<Notice[]> => {
      // Notices currently have no source-site field. Do not publish another site's content.
      if (CUSTOMER_SITE) return []
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase
          .from('notices')
          .select('*')
          .eq('published', true)
        if (error || !data) return []
        return sortNotices(data as Notice[])
      }
      return sortNotices(readDb().notices.filter((n) => n.published))
    },
    staleTime: 5 * 60 * 1000,
  })
}

// ── FAQ(고객센터) ─────────────────────────────────────────────────────────
function sortFaqs(rows: Faq[]): Faq[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order)
}

export function useFaqs(): UseQueryResult<Faq[]> {
  return useQuery({
    queryKey: [...siteKeys.faqs(), CUSTOMER_SITE?.key ?? 'pluslotto'],
    queryFn: async (): Promise<Faq[]> => {
      if (CUSTOMER_SITE) return []
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase
          .from('faqs')
          .select('*')
          .eq('published', true)
        if (error || !data) return []
        return sortFaqs(data as Faq[])
      }
      return sortFaqs(readDb().faqs.filter((f) => f.published))
    },
    staleTime: 5 * 60 * 1000,
  })
}

// ── 1:1 문의(고객센터) — 접수·비밀글 (현장 10/16) ─────────────────────────────
// anon 은 inquiries 를 직접 못 쓰고 못 읽는다. 사이트·길이·연락처를 검증하는 RPC 로만 접수하고,
// 작성자는 연락처 + 접수 때 정한 비밀번호로 자기 글과 답변만 본다. 목록은 가린 행(이름·날짜·상태)뿐.
export interface InquiryInput {
  name: string
  phone: string
  /** 문의 유형(결제/번호/계정/기타 등). 미지정 시 '기타'. */
  category?: string
  title: string
  body: string
  /** 비밀글 열람 비밀번호(4~20자). */
  password: string
}

export interface SubmitInquiryResult {
  ok: boolean
  error?: string
}

export interface InquiryBoardRow {
  id: string
  author: string // 가린 이름(홍*동)
  status: 'open' | 'answered'
  created_at: string
}

export interface MyInquiry {
  id: string
  category: string
  title: string
  body: string
  status: 'open' | 'answered'
  answer: string | null
  answered_at: string | null
  created_at: string
}

const INQUIRY_SITE: PortalSourceSite = CUSTOMER_SITE?.key ?? 'pluslotto'
const INQUIRY_FAIL = '문의 접수가 일시적으로 어렵습니다. 고객센터 전화로 문의해주시면 도와드리겠습니다.'

/** 실패 시 throw 하지 않고 안내문구를 돌려준다(UI 가 그대로 표시). */
export function useSubmitInquiry() {
  const qc = useQueryClient()
  return useMutation<SubmitInquiryResult, never, InquiryInput>({
    mutationFn: async (input): Promise<SubmitInquiryResult> => {
      const name = input.name.trim()
      const title = input.title.trim()
      const body = input.body.trim()
      const phone = digits(input.phone)
      const password = input.password.trim()
      if (!name) return { ok: false, error: '이름을 입력해주세요.' }
      if (phone.length < 9) return { ok: false, error: '연락처를 정확히 입력해주세요.' }
      if (password.length < 4 || password.length > 20) return { ok: false, error: '비밀번호는 4~20자로 입력해주세요.' }
      if (!title) return { ok: false, error: '제목을 입력해주세요.' }
      if (!body) return { ok: false, error: '문의 내용을 입력해주세요.' }

      // 직원 화면은 본문만 보므로 연락처·가입 서비스를 본문 끝에 함께 남긴다(기존 형식 유지).
      const contactBody = `${body}\n\n연락처: ${phone}`
      const fullBody = CUSTOMER_SITE ? `${contactBody}\n\n가입 서비스: ${CUSTOMER_BRAND.name}` : contactBody

      if (dataSource === 'supabase' && supabase) {
        try {
          const { error } = await supabase.rpc('portal_submit_inquiry', {
            p_source_site: INQUIRY_SITE, p_name: name, p_phone: phone,
            p_category: input.category?.trim() || '기타', p_title: title, p_body: fullBody, p_password: password,
          })
          if (error) {
            if (error.code === '54000') return { ok: false, error: '짧은 시간에 문의가 많이 접수되었습니다. 잠시 후 다시 시도해주세요.' }
            return { ok: false, error: INQUIRY_FAIL }
          }
          void qc.invalidateQueries({ queryKey: siteKeys.inquiryBoard() })
          return { ok: true }
        } catch {
          return { ok: false, error: INQUIRY_FAIL }
        }
      }

      // mock: 접수 성공으로 간주(데모)
      return { ok: true }
    },
  })
}

/** 문의 목록(가림) — 그 사이트 최근 문의의 가린 이름·날짜·답변상태. */
export function useInquiryBoard(): UseQueryResult<InquiryBoardRow[]> {
  return useQuery({
    queryKey: [...siteKeys.inquiryBoard(), INQUIRY_SITE],
    queryFn: async (): Promise<InquiryBoardRow[]> => {
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase.rpc('portal_inquiry_board', { p_source_site: INQUIRY_SITE, p_limit: 20 })
        if (error) throw new Error('문의 목록을 불러오지 못했습니다.')
        return Array.isArray(data) ? (data as unknown as InquiryBoardRow[]) : []
      }
      return [...readDb().inquiries]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 20)
        .map((q) => ({ id: q.id, author: maskName(q.author_name), status: q.status, created_at: q.created_at }))
    },
    staleTime: 30_000,
  })
}

/** 내 문의 확인 — 연락처 + 비밀번호가 맞는 글(제목·내용·답변)만. 맞는 글이 없으면 빈 목록. */
export function useMyInquiries() {
  return useMutation<MyInquiry[], Error, { phone: string; password: string }>({
    mutationFn: async ({ phone, password }) => {
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase.rpc('portal_my_inquiries', {
          p_source_site: INQUIRY_SITE, p_phone: digits(phone), p_password: password.trim(),
        })
        if (error) {
          throw new Error(error.code === '54000'
            ? '확인 시도가 너무 많습니다. 10분 뒤 다시 시도해주세요.'
            : '문의 내역을 불러오지 못했습니다.')
        }
        return Array.isArray(data) ? (data as unknown as MyInquiry[]) : []
      }
      return [] // mock: 비밀번호를 저장하지 않으므로 열람 대상 없음
    },
  })
}

/** 이름 가리기 — 홍길동→홍*동, 이영→이*. 서버 portal_inquiry_board 와 같은 규칙(mock 용). */
export function maskName(name: string): string {
  const chars = [...name.trim()]
  if (chars.length <= 1) return '*'
  if (chars.length === 2) return `${chars[0]}*`
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`
}
