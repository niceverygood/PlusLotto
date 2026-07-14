// 커뮤니티(공지·이벤트) — supabase 쓰기 경로 (M7). mock 의 mutateDb + adminLog 를 미러링한다.
// 읽기(useNotices/useEvents)는 fetchTables 스냅샷으로 api.ts 가 정렬/필터를 재사용.
import { genId, nowIso } from '@/lib/db/store'
import { insertLog, sb } from '@/lib/db/remote'
import type { EventInput, NoticeInput } from './api'

export async function saveNotice(
  v: { id?: string; input: NoticeInput },
  actor: string | null,
): Promise<string> {
  const ts = nowIso()
  if (v.id) {
    const { error } = await sb().from('notices').update({ ...v.input, updated_at: ts }).eq('id', v.id)
    if (error) throw error
    await insertLog({
      kind: 'admin',
      actor,
      action: 'notice.update',
      target_type: 'notice',
      target_id: v.id,
      meta: { title: v.input.title },
    })
    return v.id
  }
  const id = genId('ntc')
  const { error } = await sb()
    .from('notices')
    .insert({ id, ...v.input, author_id: actor, view_count: 0, created_at: ts, updated_at: ts })
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'notice.create',
    target_type: 'notice',
    target_id: id,
    meta: { title: v.input.title },
  })
  return id
}

export async function deleteNotice(id: string, actor: string | null): Promise<string> {
  const { data } = await sb().from('notices').select('title').eq('id', id).maybeSingle()
  const title = (data as { title: string } | null)?.title ?? ''
  const { error } = await sb().from('notices').delete().eq('id', id)
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'notice.delete',
    target_type: 'notice',
    target_id: id,
    meta: { title },
  })
  return id
}

export async function saveEvent(
  v: { id?: string; input: EventInput },
  actor: string | null,
): Promise<string> {
  const ts = nowIso()
  if (v.id) {
    const { error } = await sb().from('events').update({ ...v.input, updated_at: ts }).eq('id', v.id)
    if (error) throw error
    await insertLog({
      kind: 'admin',
      actor,
      action: 'event.update',
      target_type: 'event',
      target_id: v.id,
      meta: { title: v.input.title },
    })
    return v.id
  }
  const id = genId('evt')
  const { error } = await sb()
    .from('events')
    .insert({ id, ...v.input, author_id: actor, view_count: 0, created_at: ts, updated_at: ts })
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'event.create',
    target_type: 'event',
    target_id: id,
    meta: { title: v.input.title },
  })
  return id
}

export async function deleteEvent(id: string, actor: string | null): Promise<string> {
  const { data } = await sb().from('events').select('title').eq('id', id).maybeSingle()
  const title = (data as { title: string } | null)?.title ?? ''
  const { error } = await sb().from('events').delete().eq('id', id)
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'event.delete',
    target_type: 'event',
    target_id: id,
    meta: { title },
  })
  return id
}
