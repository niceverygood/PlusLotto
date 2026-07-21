// 설정(site_settings·sms_templates) — supabase 쓰기 경로 (M7). mock 의 mutateDb + adminLog 미러링.
// site_settings 는 단일행(id=1) 업데이트, sms_templates 는 key 기준 upsert.
// 읽기는 api.ts 가 fetchSiteSettings/fetchTables 로 분기(여기선 쓰기만).
import type { SiteSettings, SmsTemplate } from '@/types/db'
import { fetchSiteSettings, insertLog, sb } from '@/lib/db/remote'
import { normalizeWinnerStats } from '@/lib/winnerStats'

/** 사이트 설정 전체 저장(단일행 id=1). 등급색 변경은 gradeTheme 가 토큰으로 전파(§3). */
export async function saveSiteSettings(next: SiteSettings, actor: string | null): Promise<void> {
  const beforeWinner = normalizeWinnerStats((await fetchSiteSettings()).winner_stats).current
  const afterWinner = normalizeWinnerStats(next.winner_stats).current
  // 실 컬럼만 명시 picking(D68 #6). update({...next}) 는 폼이 실은 여분키(id 등)·신규 타입필드를
  // 그대로 PATCH 해 D60 처럼 마이그레이션 누락 시 PGRST204 로 전 설정 저장이 통째 실패하던 구조를 방지.
  const payload: Record<keyof SiteSettings, unknown> = {
    bank: next.bank,
    grade_colors: next.grade_colors,
    pg_providers: next.pg_providers,
    sms: next.sms,
    win_messages: next.win_messages,
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
