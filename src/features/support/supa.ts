// 고객센터(문의·FAQ) — supabase 쓰기 경로 (M7). mock 의 mutateDb + adminLog 를 미러링한다.
// 읽기(useInquiries/useFaqs/useSupportNotices)는 fetchTables 스냅샷으로 api.ts 가 정렬을 재사용.
import { genId, nowIso } from '@/lib/db/store'
import { insertLog, sb } from '@/lib/db/remote'
import type { FaqInput } from './api'

/** 문의 답변 등록 — 대기→답변완료 전이 + admin 로그(§8). */
export async function answerInquiry(
  id: string,
  answer: string,
  actor: string | null,
): Promise<string> {
  const { data } = await sb().from('inquiries').select('category').eq('id', id).maybeSingle()
  const category = (data as { category: string } | null)?.category ?? null
  const { error } = await sb()
    .from('inquiries')
    .update({ answer, status: 'answered', answered_by: actor, answered_at: nowIso() })
    .eq('id', id)
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'inquiry.answer',
    target_type: 'inquiry',
    target_id: id,
    meta: { category },
  })
  return id
}

export async function saveFaq(
  v: { id?: string; input: FaqInput },
  actor: string | null,
): Promise<string> {
  if (v.id) {
    const { error } = await sb().from('faqs').update({ ...v.input }).eq('id', v.id)
    if (error) throw error
    await insertLog({ kind: 'admin', actor, action: 'faq.update', target_type: 'faq', target_id: v.id, meta: {} })
    return v.id
  }
  const id = genId('faq')
  const { error } = await sb().from('faqs').insert({ id, ...v.input })
  if (error) throw error
  await insertLog({ kind: 'admin', actor, action: 'faq.create', target_type: 'faq', target_id: id, meta: {} })
  return id
}

export async function deleteFaq(id: string, actor: string | null): Promise<string> {
  const { error } = await sb().from('faqs').delete().eq('id', id)
  if (error) throw error
  await insertLog({ kind: 'admin', actor, action: 'faq.delete', target_type: 'faq', target_id: id, meta: {} })
  return id
}
