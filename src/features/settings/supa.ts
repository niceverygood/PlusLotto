// 설정(site_settings·sms_templates) — supabase 쓰기 경로 (M7). mock 의 mutateDb + adminLog 미러링.
// site_settings 는 단일행(id=1) 업데이트, sms_templates 는 key 기준 upsert.
// 읽기는 api.ts 가 fetchSiteSettings/fetchTables 로 분기(여기선 쓰기만).
import type { AppDownload, Member, PromoSlide, SiteSettings, SmsTemplate } from '@/types/db'
import { fetchSiteSettings, insertLog, paginateAll, sb, selectByIds } from '@/lib/db/remote'
import { mapPool } from '@/lib/async'
import { endDateForGrade } from '@/lib/membershipTerm'
import { DEFAULT_RECO_DAY, PAID_RECO_GRADES } from '@/lib/recoSchedule'
import { genId } from '@/lib/db/store'
import { normalizeWinnerStats } from '@/lib/winnerStats'
import { DEFAULT_WIN_SMS } from '@/lib/winSms'
import { defaultStatusColors } from '@/lib/statusColors'

/** 사이트 설정 전체 저장(단일행 id=1). 등급색 변경은 gradeTheme 가 토큰으로 전파(§3). */
export async function saveSiteSettings(next: SiteSettings, actor: string | null): Promise<void> {
  const beforeWinner = normalizeWinnerStats((await fetchSiteSettings()).winner_stats).current
  const afterWinner = normalizeWinnerStats(next.winner_stats).current
  // 실 컬럼만 명시 picking(D68 #6). update({...next}) 는 폼이 실은 여분키(id 등)·신규 타입필드를
  // 그대로 PATCH 해 D60 처럼 마이그레이션 누락 시 PGRST204 로 전 설정 저장이 통째 실패하던 구조를 방지.
  // auto_assign_cursor(자동배분 라운드로빈, 현장 7/28)·promo_slides(홍보 슬라이드, 현장 7/29)·
  // app_download(동반앱 APK 메타, 현장 8/3)는 이 폼이 다루지 않는다 — 여기서 빼야 설정 저장할
  // 때마다 조용히 null/빈 값으로 덮어쓰지 않는다(D117 에서 실제로 겪은 유형).
  const payload: Record<
    Exclude<keyof SiteSettings, 'auto_assign_cursor' | 'promo_slides' | 'app_download'>,
    unknown
  > = {
    bank: next.bank,
    grade_colors: next.grade_colors,
    status_colors: next.status_colors ?? defaultStatusColors(),
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
    'status_colors',
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

// ── 회원 종료일 결제기록 기준 일괄 반영 (현장 8/13, 정의현 차장) ─────────────────
// "종료일은 결제기록 기준으로 일괄적으로 넣어주시는걸로 부탁드리겠습니다."
//
// 종료일(members.meta.end_date)은 원래 회원정보창에서 수기로 지정하는 값이라, 그동안 지정하지
// 않은 유료회원은 목록에서 만료 판정 근거가 없었다(D155·D156). 결제 승인 시 자동 기록은 8/13
// 배포분부터 적용되므로 **그 이전 결제만 있는 기존 회원**을 여기서 한 번 채운다.
//
// SQL 마이그레이션이 아니라 화면 실행 작업으로 만든 이유: 라이브 DB 반영 경로가 막혀 미적용
// 마이그레이션이 4건 쌓여 있어(D153·D154) 현장이 오늘 쓸 수 없다. 이 경로는 전산에서 바로 돈다.
//
// 규칙
//   · 대상 = 승인(approved) 결제가 있는 회원. 기준일 = **가장 최근 승인 결제의 결제일**.
//   · 종료일 = 기준일 + 등급별 연수(실버 1년 / 골드·다이아 3년, lib/membershipTerm).
//   · **이미 종료일이 들어 있는 회원은 건너뛴다** — 운영진이 수기로 지정한 값을 덮어쓰지 않는다.

export interface EndDateBackfillResult {
  scanned: number // 승인 결제가 있는 회원 수
  filled: number // 이번에 채운 수
  skipped: number // 이미 종료일이 있어 건너뛴 수
  failed: number
}

export async function backfillMemberEndDates(
  actor: string | null,
  onProgress?: (done: number, total: number) => void,
): Promise<EndDateBackfillResult> {
  // ① 승인 결제 전량에서 회원별 최신 결제일을 뽑는다(회원 15만 중 유료는 일부라 결제 기준이 가볍다).
  const payments = await paginateAll<{ member_id: string; paid_at: string | null; created_at: string }>(
    (from, to) =>
      sb().from('payments').select('member_id, paid_at, created_at').eq('status', 'approved').range(from, to),
  )
  const latestByMember = new Map<string, string>()
  for (const p of payments) {
    const at = p.paid_at ?? p.created_at
    if (!at) continue
    const cur = latestByMember.get(p.member_id)
    if (!cur || cur < at) latestByMember.set(p.member_id, at)
  }
  const memberIds = [...latestByMember.keys()]
  if (memberIds.length === 0) return { scanned: 0, filled: 0, skipped: 0, failed: 0 }

  // ② 대상 회원의 등급·기존 meta 를 가져온다(청크 — URL 길이 한계 회피).
  const members = await selectByIds<Pick<Member, 'id' | 'grade' | 'meta'>>('members', 'id, grade, meta', memberIds)

  const targets: { id: string; meta: Record<string, unknown> }[] = []
  let skipped = 0
  for (const m of members) {
    const cur = m.meta?.['end_date']
    if (typeof cur === 'string' && cur.trim() !== '') {
      skipped++ // 수기 지정값 보존
      continue
    }
    const base = latestByMember.get(m.id)
    const end = base ? endDateForGrade(base, m.grade) : ''
    if (!end) continue
    targets.push({ id: m.id, meta: { ...(m.meta ?? {}), end_date: end } })
  }

  // ③ meta 는 회원마다 값이 달라 한 건씩 갱신해야 한다 — 동시 8개로 제한(레이트리밋·풀 보호).
  let filled = 0
  let failed = 0
  let done = 0
  await mapPool(targets, 8, async (t) => {
    const { error } = await sb().from('members').update({ meta: t.meta }).eq('id', t.id)
    if (error) failed++
    else filled++
    done++
    if (done % 25 === 0 || done === targets.length) onProgress?.(done, targets.length)
  })

  await insertLog({
    kind: 'admin',
    actor,
    action: 'member.end_date_backfill',
    target_type: 'member',
    target_id: null,
    meta: { scanned: memberIds.length, filled, skipped, failed },
  })
  return { scanned: memberIds.length, filled, skipped, failed }
}

// ── 유료회원 조합발송요일 일괄 복구 (현장 8/14, 정의현 차장) ─────────────────────
// "7/31 가입회원 / 8/7, 8/14 자동발송 되었어야하나 자동발송 안됨."
//
// 원인: 크론(api/weekly-reco)은 **유료등급은 `meta.weekly_reco_day` 가 설정된 회원만** 자동발급·
// 발송한다(무료회원만 기본 금요일). 결제로 유료가 돼도 발송요일을 손으로 넣어주지 않으면 조합문자가
// 영영 나가지 않았다. 8/14 배포분부터는 결제 승인 시 기본요일이 자동으로 들어가지만(D158),
// 그 이전에 결제한 기존 유료회원은 여전히 비어 있어 여기서 한 번 채운다.
//
// 규칙: 유료등급(gold/goldp/vip/royal) + 발송요일 미설정 + 정지/삭제/탈퇴 아님 → 금요일 지정.
// 이미 요일이 있는 회원은 건드리지 않는다(운영진이 다른 요일로 지정한 값 보존).

export interface RecoDayBackfillResult {
  scanned: number // 대상 유료회원 수
  filled: number
  skipped: number // 이미 요일이 있어 건너뜀
  failed: number
}

export async function backfillRecoDays(
  actor: string | null,
  onProgress?: (done: number, total: number) => void,
): Promise<RecoDayBackfillResult> {
  const grades = [...PAID_RECO_GRADES]
  const rows = await paginateAll<Pick<Member, 'id' | 'meta'>>((from, to) =>
    sb()
      .from('members')
      .select('id, meta')
      .in('grade', grades)
      .eq('is_suspended', false)
      .eq('is_deleted', false)
      .eq('is_withdrawn', false)
      .range(from, to),
  )

  const targets: { id: string; meta: Record<string, unknown> }[] = []
  let skipped = 0
  for (const m of rows) {
    const meta = (m.meta ?? {}) as Record<string, unknown>
    if (typeof meta.weekly_reco_day === 'number') {
      skipped++
      continue
    }
    targets.push({ id: m.id, meta: { ...meta, weekly_reco_day: DEFAULT_RECO_DAY } })
  }

  let filled = 0
  let failed = 0
  let done = 0
  await mapPool(targets, 8, async (t) => {
    const { error } = await sb().from('members').update({ meta: t.meta }).eq('id', t.id)
    if (error) failed++
    else filled++
    done++
    if (done % 25 === 0 || done === targets.length) onProgress?.(done, targets.length)
  })

  await insertLog({
    kind: 'admin',
    actor,
    action: 'member.reco_day_backfill',
    target_type: 'member',
    target_id: null,
    meta: { scanned: rows.length, filled, skipped, failed, day: DEFAULT_RECO_DAY },
  })
  return { scanned: rows.length, filled, skipped, failed }
}

// ── 통화녹음 동반앱(APK) 배포 (현장 피드백 8/3) ─────────────────────────────────
// APK 파일은 비공개 버킷(app-downloads)에 두고 site_settings.app_download 에는 경량 메타만.
// 다운로드는 매번 서명 URL 을 발급한다(call-recordings 와 동일 패턴) — 사내 앱이 공개 URL 로
// 노출되지 않게. 활성 staff 면 누구나 받을 수 있고(상담원이 본인 폰에 설치), 업로드는 최고관리자만.

/** 현재 배포본 다운로드용 서명 URL(10분 유효). 배포본이 없으면 null. */
export async function signAppDownloadUrl(path: string): Promise<string> {
  const { data, error } = await sb().storage.from('app-downloads').createSignedUrl(path, 600)
  if (error) throw error
  return data.signedUrl
}

/** 새 APK 업로드(같은 경로로 덮어쓰기) + 메타 갱신. 최고관리자만(스토리지 정책으로도 이중 통제). */
export async function uploadAppDownload(
  file: File,
  version: string,
  actor: string | null,
): Promise<AppDownload> {
  const path = 'pluslotto-call-uploader.apk'
  const { error: upErr } = await sb()
    .storage
    .from('app-downloads')
    .upload(path, file, { upsert: true, contentType: 'application/vnd.android.package-archive' })
  if (upErr) throw upErr

  const meta: AppDownload = {
    path,
    name: '플러스로또 통화녹음 업로더',
    version: version.trim() || '0.1.0',
    size: file.size,
    uploaded_at: new Date().toISOString(),
    uploaded_by: actor,
  }
  const { error } = await sb().from('site_settings').update({ app_download: meta }).eq('id', 1)
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'settings.app_download_upload',
    target_type: 'site_settings',
    target_id: null,
    meta: { version: meta.version, size: meta.size },
  })
  return meta
}
