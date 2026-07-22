// 고객센터(1:1 문의·FAQ·공지) 데이터 훅 (CLAUDE §1·§8). 전부 TanStack Query 경유.
// 공지는 커뮤니티가 소유하지만 고객센터도 함께 노출 → feature import 대신 lib store 를
// 직접 읽고 communityKeys 로 캐시를 공유한다(공지 변경 시 함께 무효화됨, §2·§8).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Faq, Inquiry, LogEntry, Notice } from '@/types/db'
import { genId, mutateDb, nowIso, readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchTables } from '@/lib/db/remote'
import { useCurrentUser } from '@/lib/auth'
import { communityKeys, operationalKeys, supportKeys } from '@/lib/queryKeys'
import * as supa from './supa'

function adminLog(
  actor: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  meta: Record<string, unknown> = {},
): LogEntry {
  return {
    id: genId('log'),
    kind: 'admin',
    actor,
    action,
    target_type: targetType,
    target_id: targetId,
    meta,
    created_at: nowIso(),
  }
}

// ── 1:1 문의 ──────────────────────────────────────────────────────────
export function useInquiries() {
  return useQuery({
    queryKey: supportKeys.inquiries({}),
    queryFn: async (): Promise<Inquiry[]> =>
      [...(dataSource === 'supabase' ? await fetchTables(['inquiries']) : readDb()).inquiries].sort(
        (a, b) => b.created_at.localeCompare(a.created_at),
      ),
  })
}

/** 문의 답변 등록 — status 대기→답변완료 전이 + admin 로그(§8). */
export function useAnswerInquiry() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; answer: string }) => {
      if (dataSource === 'supabase') return supa.answerInquiry(v.id, v.answer, user?.id ?? null)
      const ts = nowIso()
      mutateDb((db) => {
        const inq = db.inquiries.find((x) => x.id === v.id)
        if (!inq) return
        inq.answer = v.answer
        inq.status = 'answered'
        inq.answered_by = user?.id ?? null
        inq.answered_at = ts
        db.logs.push(adminLog(user?.id ?? null, 'inquiry.answer', 'inquiry', v.id, { category: inq.category }))
      })
      return v.id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: supportKeys.all })
      qc.invalidateQueries({ queryKey: operationalKeys.all })
    },
  })
}

// ── FAQ ───────────────────────────────────────────────────────────────
export function useFaqs() {
  return useQuery({
    queryKey: supportKeys.faqs({}),
    queryFn: async (): Promise<Faq[]> =>
      [...(dataSource === 'supabase' ? await fetchTables(['faqs']) : readDb()).faqs].sort(
        (a, b) => a.sort_order - b.sort_order,
      ),
  })
}

export interface FaqInput {
  category: string
  question: string
  answer: string
  sort_order: number
  published: boolean
}

export function useSaveFaq() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id?: string; input: FaqInput }) => {
      if (dataSource === 'supabase') return supa.saveFaq(v, user?.id ?? null)
      const id = v.id ?? genId('faq')
      mutateDb((db) => {
        if (v.id) {
          const f = db.faqs.find((x) => x.id === v.id)
          if (!f) return
          Object.assign(f, v.input)
          db.logs.push(adminLog(user?.id ?? null, 'faq.update', 'faq', v.id, {}))
        } else {
          db.faqs.push({ id, ...v.input })
          db.logs.push(adminLog(user?.id ?? null, 'faq.create', 'faq', id, {}))
        }
      })
      return id
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supportKeys.all }),
  })
}

export function useDeleteFaq() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      if (dataSource === 'supabase') return supa.deleteFaq(id, user?.id ?? null)
      mutateDb((db) => {
        const idx = db.faqs.findIndex((x) => x.id === id)
        if (idx === -1) return
        db.faqs.splice(idx, 1)
        db.logs.push(adminLog(user?.id ?? null, 'faq.delete', 'faq', id, {}))
      })
      return id
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: supportKeys.all }),
  })
}

// ── 공지(커뮤니티 소유, 고객센터 읽기 전용) ────────────────────────────
// 게시중인 공지만 노출. communityKeys 로 키를 공유 → 공지 작성/수정 시 함께 무효화.
export function useSupportNotices() {
  return useQuery({
    queryKey: communityKeys.notices({ support: true }),
    queryFn: async (): Promise<Notice[]> =>
      (dataSource === 'supabase' ? await fetchTables(['notices']) : readDb()).notices
        .filter((n) => n.published)
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          return b.created_at.localeCompare(a.created_at)
        }),
  })
}
