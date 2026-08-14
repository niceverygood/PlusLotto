// 설정(site_settings · sms_templates) 데이터 훅 (CLAUDE §1·§8). 전부 TanStack Query 경유.
// 저장은 mock DB 변경 + admin 로그 적재 후 무효화. 등급색 저장 시 settingsKeys.site 무효화로
// gradeTheme(useGradeColorSync)가 재적용 → 전 화면 <Badge grade> 토큰이 즉시 바뀐다(§3 검수).
// sms_templates 는 members(드로어·일괄·나의문자)와 공유 키 → 저장 시 그쪽도 함께 갱신(§8).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AppDownload,
  LogEntry,
  LottoRound,
  PromoSlide,
  SiteSettings,
  SmsTemplate,
  WinnerRoundStats,
} from '@/types/db'
import { genId, mutateDb, nowIso, readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchSiteSettings, fetchTables, sb, selectAll } from '@/lib/db/remote'
import { useCurrentUser } from '@/lib/auth'
import { lottoKeys, memberKeys, settingsKeys, siteKeys, smsTemplateKeys } from '@/lib/queryKeys'
import { mergeWinnerHistory, normalizeWinnerRoundStats, normalizeWinnerStats } from '@/lib/winnerStats'
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

// 폼 객체 참조를 DB 캐시와 분리하기 위한 plain JSON 복제(SiteSettings 는 직렬화 가능).
function jsonClone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T)
}

export function useSiteSettings() {
  return useQuery({
    queryKey: settingsKeys.site(),
    queryFn: async () =>
      dataSource === 'supabase' ? await fetchSiteSettings() : readDb().site_settings,
  })
}

/** 회차별 당첨자 수 과거 이력. logs 는 RLS 로 최고관리자에게만 열리고 anon 공개 RPC에는 포함되지 않는다. */
export function useWinnerHistory() {
  return useQuery({
    queryKey: settingsKeys.winnerHistory(),
    queryFn: async (): Promise<WinnerRoundStats[]> => {
      if (dataSource === 'supabase') {
        const settings = await fetchSiteSettings()
        const { data, error } = await sb()
          .from('logs')
          .select('meta, created_at')
          .eq('action', 'settings.winner_stats.upsert')
          .order('created_at', { ascending: false })
        const logged = error
          ? []
          : ((data ?? []) as { meta: Record<string, unknown>; created_at: string }[]).map((log) => {
              const row = normalizeWinnerRoundStats(log.meta.winner_stats)
              return row ? { ...row, updated_at: row.updated_at || log.created_at } : null
            })
        return mergeWinnerHistory([normalizeWinnerStats(settings.winner_stats).current, ...logged])
      }
      const db = readDb()
      const logged = db.logs
        .filter((log) => log.action === 'settings.winner_stats.upsert')
        .map((log) => normalizeWinnerRoundStats(log.meta.winner_stats))
      return mergeWinnerHistory([normalizeWinnerStats(db.site_settings.winner_stats).current, ...logged])
    },
  })
}

/** 사이트 설정 전체 저장(무통장·등급색·PG·문자·당첨문자). 등급색 변경은 토큰으로 전파(§3). */
export function useSaveSiteSettings() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (next: SiteSettings) => {
      if (dataSource === 'supabase') return supa.saveSiteSettings(next, user?.id ?? null)
      const value = jsonClone(next)
      mutateDb((db) => {
        const before = normalizeWinnerStats(db.site_settings.winner_stats).current
        const after = normalizeWinnerStats(value.winner_stats).current
        // auto_assign_cursor(자동배분 라운드로빈, 현장 7/28)·promo_slides(홍보 슬라이드, 현장 7/29)·
        // app_download(동반앱 APK 메타, 현장 8/3)는 이 폼이 다루지 않는 필드라 next 에는 없다 —
        // 통째로 교체하면 조용히 사라지므로 이어받는다(supa.ts saveSiteSettings 도 같은 이유로
        // 이 필드들을 update 페이로드에서 뺀다).
        const preservedCursor = db.site_settings.auto_assign_cursor
        const preservedSlides = db.site_settings.promo_slides
        const preservedApp = db.site_settings.app_download
        db.site_settings = {
          ...value,
          auto_assign_cursor: preservedCursor,
          promo_slides: preservedSlides,
          app_download: preservedApp,
        }
        if (after && after.updated_at !== before?.updated_at) {
          db.logs.push(
            adminLog(user?.id ?? null, 'settings.winner_stats.upsert', 'winner_stats', String(after.round_no), {
              winner_stats: after,
            }),
          )
        }
        db.logs.push(
          adminLog(user?.id ?? null, 'settings.update', 'site_settings', null, {
            pg: value.pg_providers.length,
          }),
        )
      })
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: settingsKeys.all }),
        qc.invalidateQueries({ queryKey: siteKeys.tiers() }),
      ])
    },
  })
}

/** 전 회차(고정수 추천 점수 계산용, lib/lottoFixedScore) — lottoKeys 공유로 lotto 모듈과 캐시 동일. */
export function useAllLottoRounds() {
  return useQuery({
    queryKey: lottoKeys.rounds({ scope: 'all' }),
    queryFn: async (): Promise<LottoRound[]> =>
      dataSource === 'supabase' ? await selectAll<LottoRound>('lotto_rounds') : readDb().lotto_rounds,
    staleTime: 10 * 60 * 1000,
  })
}

export function useSmsTemplates() {
  return useQuery({
    queryKey: smsTemplateKeys.all,
    queryFn: async () =>
      (dataSource === 'supabase' ? await fetchTables(['sms_templates']) : readDb()).sms_templates,
  })
}

/** 문자 템플릿 일괄 저장. members 쪽 useSmsTemplates 도 같은 키라 함께 갱신된다(§8). */
export function useSaveSmsTemplates() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (templates: SmsTemplate[]) => {
      if (dataSource === 'supabase') return supa.saveSmsTemplates(templates, user?.id ?? null)
      const value = jsonClone(templates)
      mutateDb((db) => {
        for (const tpl of value) {
          const t = db.sms_templates.find((x) => x.key === tpl.key)
          if (t) Object.assign(t, { title: tpl.title, body: tpl.body, category: tpl.category })
          else db.sms_templates.push(tpl)
        }
        db.logs.push(
          adminLog(user?.id ?? null, 'settings.sms_template', 'sms_template', null, {
            keys: value.map((t) => t.key),
          }),
        )
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: smsTemplateKeys.all }),
  })
}

// ── 고객 홈페이지 홍보 슬라이드(현장 피드백 7/29) — 특허사진·1등당첨자 사진 등 ─────────────
// mock 은 실 Storage 가 없어 파일을 data: URI 로 인코딩해 site_settings.promo_slides 에 직접
// 저장한다(§lib/db 는 브라우저 로컬 데이터 계층이라 이 방식이 유일한 선택지 — supabase 모드는
// 실제로 Storage 공개버킷에 업로드하고 공개 URL 만 저장한다, features/settings/supa.ts 참조).
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error instanceof Error ? reader.error : new Error('파일을 읽지 못했습니다.'))
    reader.readAsDataURL(file)
  })
}

export function useUploadPromoSlide() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (file: File): Promise<PromoSlide[]> => {
      if (dataSource === 'supabase') return supa.uploadPromoSlide(file, user?.id ?? null)
      const url = await fileToDataUrl(file)
      const entry: PromoSlide = { id: genId('slide'), url, caption: null }
      let next: PromoSlide[] = []
      mutateDb((db) => {
        next = [...(db.site_settings.promo_slides ?? []), entry]
        db.site_settings.promo_slides = next
        db.logs.push(adminLog(user?.id ?? null, 'settings.promo_slide_add', 'site_settings', null, { count: next.length }))
      })
      return next
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.all }),
  })
}

export function useDeletePromoSlide() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<PromoSlide[]> => {
      if (dataSource === 'supabase') return supa.deletePromoSlide(id, user?.id ?? null)
      let next: PromoSlide[] = []
      mutateDb((db) => {
        next = (db.site_settings.promo_slides ?? []).filter((s) => s.id !== id)
        db.site_settings.promo_slides = next
        db.logs.push(adminLog(user?.id ?? null, 'settings.promo_slide_delete', 'site_settings', null, { id }))
      })
      return next
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.all }),
  })
}

export function useUpdatePromoSlideCaption() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; caption: string }): Promise<PromoSlide[]> => {
      if (dataSource === 'supabase') return supa.updatePromoSlideCaption(v.id, v.caption, user?.id ?? null)
      let next: PromoSlide[] = []
      mutateDb((db) => {
        next = (db.site_settings.promo_slides ?? []).map((s) =>
          s.id === v.id ? { ...s, caption: v.caption.trim() || null } : s,
        )
        db.site_settings.promo_slides = next
        db.logs.push(adminLog(user?.id ?? null, 'settings.promo_slide_update', 'site_settings', null, { id: v.id }))
      })
      return next
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.all }),
  })
}

export function useReorderPromoSlides() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]): Promise<PromoSlide[]> => {
      if (dataSource === 'supabase') return supa.reorderPromoSlides(ids, user?.id ?? null)
      let next: PromoSlide[] = []
      mutateDb((db) => {
        const byId = new Map((db.site_settings.promo_slides ?? []).map((s) => [s.id, s]))
        next = ids.map((id) => byId.get(id)).filter((s): s is PromoSlide => !!s)
        db.site_settings.promo_slides = next
        db.logs.push(
          adminLog(user?.id ?? null, 'settings.promo_slide_reorder', 'site_settings', null, { count: next.length }),
        )
      })
      return next
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.all }),
  })
}

// ── 통화녹음 동반앱(APK) 배포 (현장 피드백 8/3, 정의현 차장) ─────────────────────
// "어드민페이지에서 다운받을 수 있게" — APK 를 카톡으로 돌리지 않고 전산에서 각자 받아간다.
// 다운로드는 활성 staff 전원(상담원이 본인 폰에 설치), 새 버전 업로드는 최고관리자만.

/** 현재 배포본 메타(없으면 null). 계정메뉴·설정 카드가 함께 쓴다. */
export function useAppDownload() {
  return useQuery({
    queryKey: settingsKeys.site(),
    queryFn: async (): Promise<SiteSettings> =>
      dataSource === 'supabase' ? fetchSiteSettings() : readDb().site_settings,
    select: (s: SiteSettings): AppDownload | null => {
      const d = s.app_download
      return d && d.path ? d : null
    },
  })
}

/** 다운로드 실행 — 매번 서명 URL(10분)을 새로 발급받아 연다. mock 은 실 Storage 가 없어 미지원. */
export function useDownloadApp() {
  return useMutation({
    mutationFn: async (path: string): Promise<string> => {
      if (dataSource !== 'supabase') {
        throw new Error('로컬(mock) 모드에서는 앱 다운로드를 사용할 수 없습니다.')
      }
      return supa.signAppDownloadUrl(path)
    },
  })
}

/** 새 APK 업로드(최고관리자). 같은 경로로 덮어써서 기존 다운로드 링크가 그대로 최신본을 가리킨다. */
/**
 * 회원 종료일 결제기록 기준 일괄 반영 (현장 8/13). 되돌릴 수 없는 일괄 쓰기라 호출부에서
 * 확인 모달을 거친다. 진행률 콜백은 mutate 인자로 받는다(쿼리 캐시와 무관한 일회성 작업).
 */
export function useBackfillEndDates() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { onProgress?: (done: number, total: number) => void }) => {
      if (dataSource !== 'supabase') {
        throw new Error('로컬(mock) 모드에서는 일괄 반영을 사용할 수 없습니다.')
      }
      return supa.backfillMemberEndDates(user?.id ?? null, v.onProgress)
    },
    // 종료일이 바뀌면 만료 표시가 달라지므로 회원 목록·상세를 새로 읽는다.
    onSuccess: () => qc.invalidateQueries({ queryKey: memberKeys.all }),
  })
}

/**
 * 유료회원 조합발송요일 일괄 복구 (현장 8/14) — 발송요일이 비어 자동발송에서 빠져 있던 회원을 채운다.
 */
export function useBackfillRecoDays() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { onProgress?: (done: number, total: number) => void }) => {
      if (dataSource !== 'supabase') {
        throw new Error('로컬(mock) 모드에서는 일괄 반영을 사용할 수 없습니다.')
      }
      return supa.backfillRecoDays(user?.id ?? null, v.onProgress)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: memberKeys.all }),
  })
}

export function useUploadAppDownload() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { file: File; version: string }): Promise<AppDownload> => {
      if (dataSource !== 'supabase') {
        throw new Error('로컬(mock) 모드에서는 앱 업로드를 사용할 수 없습니다.')
      }
      return supa.uploadAppDownload(v.file, v.version, user?.id ?? null)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.all }),
  })
}
