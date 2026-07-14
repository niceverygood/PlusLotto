// 커뮤니티(공지·이벤트) 데이터 훅 (CLAUDE §1·§8). 전부 TanStack Query 경유.
// 작성/수정/삭제는 mock DB 변경 + admin 로그 생성 후 관련 쿼리 무효화.
// 고객센터가 공지를 함께 노출하므로 공지 뮤테이션은 supportKeys 도 무효화한다.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CampaignEvent, LogEntry, Notice } from '@/types/db'
import { genId, mutateDb, nowIso, readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchTables } from '@/lib/db/remote'
import { useCurrentUser } from '@/lib/auth'
import { communityKeys, supportKeys } from '@/lib/queryKeys'
import * as supa from './supa'

export { communityKeys }

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

// ── 공지 ──────────────────────────────────────────────────────────────
function sortNotices(rows: Notice[]): Notice[] {
  // 고정(pinned) 우선, 그다음 최신순.
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.created_at.localeCompare(a.created_at)
  })
}

export function useNotices(opts: { includeUnpublished?: boolean } = {}) {
  const { includeUnpublished = true } = opts
  return useQuery({
    queryKey: communityKeys.notices({ includeUnpublished }),
    queryFn: async (): Promise<Notice[]> => {
      const db = dataSource === 'supabase' ? await fetchTables(['notices']) : readDb()
      const rows = db.notices.filter((n) => includeUnpublished || n.published)
      return sortNotices(rows)
    },
  })
}

export interface NoticeInput {
  title: string
  body: string
  pinned: boolean
  published: boolean
}

export function useSaveNotice() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    // id 있으면 수정, 없으면 신규.
    mutationFn: async (v: { id?: string; input: NoticeInput }) => {
      if (dataSource === 'supabase') return supa.saveNotice(v, user?.id ?? null)
      const ts = nowIso()
      let id = v.id ?? genId('ntc')
      mutateDb((db) => {
        if (v.id) {
          const n = db.notices.find((x) => x.id === v.id)
          if (!n) return
          Object.assign(n, v.input, { updated_at: ts })
          db.logs.push(adminLog(user?.id ?? null, 'notice.update', 'notice', v.id, { title: v.input.title }))
        } else {
          const n: Notice = {
            id,
            ...v.input,
            author_id: user?.id ?? null,
            view_count: 0,
            created_at: ts,
            updated_at: ts,
          }
          db.notices.push(n)
          db.logs.push(adminLog(user?.id ?? null, 'notice.create', 'notice', id, { title: v.input.title }))
        }
      })
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: communityKeys.all })
      qc.invalidateQueries({ queryKey: supportKeys.all }) // 고객센터 공지 노출(§8)
    },
  })
}

export function useDeleteNotice() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      if (dataSource === 'supabase') return supa.deleteNotice(id, user?.id ?? null)
      mutateDb((db) => {
        const idx = db.notices.findIndex((x) => x.id === id)
        if (idx === -1) return
        const [removed] = db.notices.splice(idx, 1)
        db.logs.push(adminLog(user?.id ?? null, 'notice.delete', 'notice', id, { title: removed.title }))
      })
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: communityKeys.all })
      qc.invalidateQueries({ queryKey: supportKeys.all })
    },
  })
}

// ── 이벤트 ────────────────────────────────────────────────────────────
export function useEvents(opts: { includeUnpublished?: boolean } = {}) {
  const { includeUnpublished = true } = opts
  return useQuery({
    queryKey: communityKeys.events({ includeUnpublished }),
    queryFn: async (): Promise<CampaignEvent[]> =>
      (dataSource === 'supabase' ? await fetchTables(['events']) : readDb()).events
        .filter((e) => includeUnpublished || e.published)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
  })
}

export interface EventInput {
  title: string
  body: string
  starts_at: string | null
  ends_at: string | null
  published: boolean
}

export function useSaveEvent() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id?: string; input: EventInput }) => {
      if (dataSource === 'supabase') return supa.saveEvent(v, user?.id ?? null)
      const ts = nowIso()
      const id = v.id ?? genId('evt')
      mutateDb((db) => {
        if (v.id) {
          const e = db.events.find((x) => x.id === v.id)
          if (!e) return
          Object.assign(e, v.input, { updated_at: ts })
          db.logs.push(adminLog(user?.id ?? null, 'event.update', 'event', v.id, { title: v.input.title }))
        } else {
          const e: CampaignEvent = {
            id,
            ...v.input,
            author_id: user?.id ?? null,
            view_count: 0,
            created_at: ts,
            updated_at: ts,
          }
          db.events.push(e)
          db.logs.push(adminLog(user?.id ?? null, 'event.create', 'event', id, { title: v.input.title }))
        }
      })
      return id
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: communityKeys.all }),
  })
}

export function useDeleteEvent() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      if (dataSource === 'supabase') return supa.deleteEvent(id, user?.id ?? null)
      mutateDb((db) => {
        const idx = db.events.findIndex((x) => x.id === id)
        if (idx === -1) return
        const [removed] = db.events.splice(idx, 1)
        db.logs.push(adminLog(user?.id ?? null, 'event.delete', 'event', id, { title: removed.title }))
      })
      return id
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: communityKeys.all }),
  })
}
