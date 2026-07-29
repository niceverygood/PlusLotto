// 설정(site_settings·sms_templates) — supabase 쓰기 경로 (M7). mock 의 mutateDb + adminLog 미러링.
// site_settings 는 단일행(id=1) 업데이트, sms_templates 는 key 기준 upsert.
// 읽기는 api.ts 가 fetchSiteSettings/fetchTables 로 분기(여기선 쓰기만).
import type { PromoSlide, SiteSettings, SmsTemplate } from '@/types/db'
import { fetchSiteSettings, insertLog, sb } from '@/lib/db/remote'
import { genId } from '@/lib/db/store'
import { normalizeWinnerStats } from '@/lib/winnerStats'
import { DEFAULT_WIN_SMS } from '@/lib/winSms'

/** 사이트 설정 전체 저장(단일행 id=1). 등급색 변경은 gradeTheme 가 토큰으로 전파(§3). */
export async function saveSiteSettings(next: SiteSettings, actor: string | null): Promise<void> {
  const beforeWinner = normalizeWinnerStats((await fetchSiteSettings()).winner_stats).current
  const afterWinner = normalizeWinnerStats(next.winner_stats).current
  // 실 컬럼만 명시 picking(D68 #6). update({...next}) 는 폼이 실은 여분키(id 등)·신규 타입필드를
  // 그대로 PATCH 해 D60 처럼 마이그레이션 누락 시 PGRST204 로 전 설정 저장이 통째 실패하던 구조를 방지.
  // auto_assign_cursor(자동배분 라운드로빈, 현장 7/28)·promo_slides(홍보 슬라이드, 현장 7/29)는
  // 이 폼이 다루지 않는다 — 여기서 빼야 설정 저장할 때마다 조용히 null/빈 배열로 덮어쓰지 않는다.
  const payload: Record<Exclude<keyof SiteSettings, 'auto_assign_cursor' | 'promo_slides'>, unknown> = {
    bank: next.bank,
    grade_colors: next.grade_colors,
    pg_providers: next.pg_providers,
    sms: next.sms,
    win_messages: next.win_messages,
    win_sms: next.win_sms ?? DEFAULT_WIN_SMS,
    join_sms_auto: next.join_sms_auto ?? false,
    report: next.report,
    lotto_exclude: next.lotto_exclude,
    lotto_exclude_history: next.lotto_exclude_history,
    weekly_free_reco: next.weekly_free_reco,
    terms: next.terms,
    terms_by_grade: next.terms_by_grade,
    membership_tiers: next.membership_tiers ?? [],
    generation_records: next.generation_records ?? [],
    call_keywords: next.call_keywords ?? ['보장'],
    call_volume_alert_threshold: next.call_volume_alert_threshold ?? 1000,
    call_script: next.call_script ?? '',
    business: next.business ?? { name: '', reg_no: '', address: '', support_phone: '' },
    winner_stats: next.winner_stats ?? { enabled: false, current: null },
  }
  // 신규 컬럼(membership_tiers 0008 · generation_records 0009 · call_keywords/call_volume_alert_threshold
  // 0010 · call_script 0012 · business/winner_stats 0013) 마이그레이션 전이면 PGRST204 → 그 키만 빼고
  // 재시도해 다른 설정 저장(무통장·약관 등)이 통째로 막히지 않게 한다(D68 방어구조).
  const OPTIONAL_COLUMNS = [
    'membership_tiers',
    'generation_records',
    'call_keywords',
    'call_volume_alert_threshold',
    'call_script',
    'business',
    'winner_stats',
    'win_sms',
    'join_sms_auto',
  ] as const
  let attempt: Record<string, unknown> = payload
  for (let i = 0; i <= OPTIONAL_COLUMNS.length; i++) {
    const { error } = await sb().from('site_settings').update(attempt).eq('id', 1)
    if (!error) break
    const missing = OPTIONAL_COLUMNS.find((k) => k in attempt && String(error.message).includes(k))
    if (!missing) throw error
    attempt = { ...attempt }
    delete attempt[missing]
  }
  if (afterWinner && afterWinner.updated_at !== beforeWinner?.updated_at) {
    await insertLog({
      kind: 'admin',
      actor,
      action: 'settings.winner_stats.upsert',
      target_type: 'winner_stats',
      target_id: String(afterWinner.round_no),
      meta: { winner_stats: afterWinner },
    })
  }
  await insertLog({
    kind: 'admin',
    actor,
    action: 'settings.update',
    target_type: 'site_settings',
    target_id: null,
    meta: { pg: next.pg_providers.length },
  })
}

/** 문자 템플릿 일괄 저장(key 기준 upsert). members 쪽 useSmsTemplates 와 키 공유 → 함께 갱신(§8). */
export async function saveSmsTemplates(
  templates: SmsTemplate[],
  actor: string | null,
): Promise<void> {
  const { error } = await sb().from('sms_templates').upsert(templates, { onConflict: 'key' })
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'settings.sms_template',
    target_type: 'sms_template',
    target_id: null,
    meta: { keys: templates.map((t) => t.key) },
  })
}

// ── 고객 홈페이지 홍보 슬라이드(현장 피드백 7/29) ────────────────────────────
// 특허사진·1등당첨자 사진 등을 어드민에서 업로드 → Storage 공개버킷(promo-slides) +
// site_settings.promo_slides(경량 목록만). 이미지 자체는 Storage 에 두고 site_settings 에는
// 완성 공개 URL 만 저장해, 고객 홈페이지(anon, portal_site_public RPC)가 그대로 쓸 수 있게 한다.
async function readPromoSlides(): Promise<PromoSlide[]> {
  const { data, error } = await sb().from('site_settings').select('promo_slides').eq('id', 1).maybeSingle()
  if (error) throw error
  const list = (data as { promo_slides: PromoSlide[] | null } | null)?.promo_slides
  return Array.isArray(list) ? list : []
}

async function writePromoSlides(list: PromoSlide[], actor: string | null, action: string): Promise<void> {
  const { error } = await sb().from('site_settings').update({ promo_slides: list }).eq('id', 1)
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action,
    target_type: 'site_settings',
    target_id: null,
    meta: { count: list.length },
  })
}

/** 홍보 슬라이드 이미지 업로드 — Storage 에 올리고 공개 URL 을 목록 끝에 추가. */
export async function uploadPromoSlide(file: File, actor: string | null): Promise<PromoSlide[]> {
  const id = genId('slide')
  const path = `${id}_${file.name}`
  const { error: upErr } = await sb().storage.from('promo-slides').upload(path, file)
  if (upErr) throw upErr
  const { data: pub } = sb().storage.from('promo-slides').getPublicUrl(path)
  const list = await readPromoSlides()
  const next = [...list, { id, url: pub.publicUrl, caption: null }]
  await writePromoSlides(next, actor, 'settings.promo_slide_add')
  return next
}

/** 홍보 슬라이드 삭제 — 목록에서 제거만 한다(Storage 원본 파일은 실수 복구 여지를 위해 남겨둔다). */
export async function deletePromoSlide(id: string, actor: string | null): Promise<PromoSlide[]> {
  const list = await readPromoSlides()
  const next = list.filter((s) => s.id !== id)
  await writePromoSlides(next, actor, 'settings.promo_slide_delete')
  return next
}

/** 홍보 슬라이드 캡션 수정. */
export async function updatePromoSlideCaption(
  id: string,
  caption: string,
  actor: string | null,
): Promise<PromoSlide[]> {
  const list = await readPromoSlides()
  const next = list.map((s) => (s.id === id ? { ...s, caption: caption.trim() || null } : s))
  await writePromoSlides(next, actor, 'settings.promo_slide_update')
  return next
}

/** 홍보 슬라이드 순서 변경 — 배열 순서 그대로가 노출 순서라 통째로 다시 쓴다. */
export async function reorderPromoSlides(ids: string[], actor: string | null): Promise<PromoSlide[]> {
  const list = await readPromoSlides()
  const byId = new Map(list.map((s) => [s.id, s]))
  const next = ids.map((id) => byId.get(id)).filter((s): s is PromoSlide => !!s)
  await writePromoSlides(next, actor, 'settings.promo_slide_reorder')
  return next
}
