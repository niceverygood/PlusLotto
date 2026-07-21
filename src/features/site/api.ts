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
import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { BankTransferSettings, BusinessInfo, Faq, LottoRound, MembershipTier, Notice, WinnerStats } from '@/types/db'
import { dataSource, supabase } from '@/lib/supabase'
import { readDb } from '@/lib/db/store'
import { resolveTiers } from '@/lib/membership'

const digits = (s: string): string => s.replace(/\D/g, '')

export const siteKeys = {
  rounds: (n: number) => ['site', 'rounds', n] as const,
  notices: () => ['site', 'notices'] as const,
  faqs: () => ['site', 'faqs'] as const,
  tiers: () => ['site', 'membership-tiers'] as const,
  publicInfo: () => ['site', 'public-info'] as const,
}

export interface PublicSiteInfo {
  bank: BankTransferSettings
  business: BusinessInfo
  winner_stats: WinnerStats
}

const EMPTY_BANK: BankTransferSettings = { bank_name: '', account_no: '', holder: '', guide: '' }
const EMPTY_BUSINESS: BusinessInfo = { name: '', reg_no: '', address: '', support_phone: '' }
const EMPTY_WINNER_STATS: WinnerStats = { enabled: false, rank1: 0, rank2: 0, rank3: 0, rank4: 0, rank5: 0 }

// ── 사업자 정보 · 무통장 계좌 · 당첨자 수(전산 편집 → 고객 홈페이지 노출, 현장 7/20) ────────
// site_settings 에는 PG api_key 비밀이 같이 있어 anon 직접 읽기 금지 → security-definer
// RPC portal_site_public() 이 bank/business/winner_stats 3개 컬럼만 반환(0013 마이그레이션).
export function usePublicSiteInfo(): UseQueryResult<PublicSiteInfo> {
  return useQuery({
    queryKey: siteKeys.publicInfo(),
    queryFn: async (): Promise<PublicSiteInfo> => {
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase.rpc('portal_site_public')
        const d = (!error && data ? data : {}) as Partial<PublicSiteInfo> // RPC 미생성/차단 → 빈 값 폴백
        return {
          bank: { ...EMPTY_BANK, ...d.bank },
          business: { ...EMPTY_BUSINESS, ...d.business },
          winner_stats: { ...EMPTY_WINNER_STATS, ...d.winner_stats },
        }
      }
      const s = readDb().site_settings
      return {
        bank: { ...EMPTY_BANK, ...s.bank },
        business: { ...EMPTY_BUSINESS, ...s.business },
        winner_stats: { ...EMPTY_WINNER_STATS, ...s.winner_stats },
      }
    },
    staleTime: 10 * 60 * 1000,
  })
}

// ── 멤버십 등급(전산 편집 → 고객 연동) ─────────────────────────────────────
// site_settings 에는 PG api_key 비밀이 같이 있어 anon 직접 읽기 금지 → security-definer
// RPC portal_membership_tiers() 가 membership_tiers 컬럼만 반환(0008 마이그레이션). 항상 5개로 정규화.
export function useMembershipTiers(): UseQueryResult<MembershipTier[]> {
  return useQuery({
    queryKey: siteKeys.tiers(),
    queryFn: async (): Promise<MembershipTier[]> => {
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase.rpc('portal_membership_tiers')
        if (error || !data) return resolveTiers(null) // RPC 미생성/차단 → 코드 기본값
        return resolveTiers(data as MembershipTier[])
      }
      return resolveTiers(readDb().site_settings.membership_tiers)
    },
    staleTime: 10 * 60 * 1000,
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
    queryKey: siteKeys.notices(),
    queryFn: async (): Promise<Notice[]> => {
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
    queryKey: siteKeys.faqs(),
    queryFn: async (): Promise<Faq[]> => {
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

// ── 1:1 문의(고객센터) 제출 ───────────────────────────────────────────────
export interface InquiryInput {
  name: string
  phone?: string
  /** 문의 유형(결제/번호/계정/기타 등). 미지정 시 '기타'. */
  category?: string
  title: string
  body: string
}

export interface SubmitInquiryResult {
  ok: boolean
  error?: string
}

/**
 * inquiries insert 뮤테이션. anon RLS(0002: inquiries to authenticated)로 막힐 수 있어
 * 실패 시 graceful 에러 메시지를 반환(throw 하지 않음 — UI 가 안내문구로 처리).
 */
export function useSubmitInquiry() {
  return useMutation<SubmitInquiryResult, never, InquiryInput>({
    mutationFn: async (input): Promise<SubmitInquiryResult> => {
      const name = input.name.trim()
      const title = input.title.trim()
      const body = input.body.trim()
      if (!name) return { ok: false, error: '이름을 입력해주세요.' }
      if (!title) return { ok: false, error: '제목을 입력해주세요.' }
      if (!body) return { ok: false, error: '문의 내용을 입력해주세요.' }

      const phone = input.phone ? digits(input.phone) : ''
      const fullBody = phone ? `${body}\n\n연락처: ${phone}` : body

      if (dataSource === 'supabase' && supabase) {
        try {
          const { error } = await supabase.from('inquiries').insert({
            member_id: null,
            author_name: name,
            category: input.category?.trim() || '기타',
            title,
            body: fullBody,
            status: 'open',
          })
          if (error) {
            return {
              ok: false,
              error:
                '문의 접수가 일시적으로 어렵습니다. 고객센터 전화로 문의해주시면 도와드리겠습니다.',
            }
          }
          return { ok: true }
        } catch {
          return {
            ok: false,
            error:
              '문의 접수가 일시적으로 어렵습니다. 고객센터 전화로 문의해주시면 도와드리겠습니다.',
          }
        }
      }

      // mock: 접수 성공으로 간주(데모)
      return { ok: true }
    },
  })
}
