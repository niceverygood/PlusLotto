// 설정(site_settings · sms_templates) 데이터 훅 (CLAUDE §1·§8). 전부 TanStack Query 경유.
// 저장은 mock DB 변경 + admin 로그 적재 후 무효화. 등급색 저장 시 settingsKeys.site 무효화로
// gradeTheme(useGradeColorSync)가 재적용 → 전 화면 <Badge grade> 토큰이 즉시 바뀐다(§3 검수).
// sms_templates 는 members(드로어·일괄·나의문자)와 공유 키 → 저장 시 그쪽도 함께 갱신(§8).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LogEntry, LottoRound, SiteSettings, SmsTemplate } from '@/types/db'
import { genId, mutateDb, nowIso, readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchSiteSettings, fetchTables, selectAll } from '@/lib/db/remote'
import { useCurrentUser } from '@/lib/auth'
import { lottoKeys, settingsKeys, smsTemplateKeys } from '@/lib/queryKeys'
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

/** 사이트 설정 전체 저장(무통장·등급색·PG·문자·당첨문자). 등급색 변경은 토큰으로 전파(§3). */
export function useSaveSiteSettings() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (next: SiteSettings) => {
      if (dataSource === 'supabase') return supa.saveSiteSettings(next, user?.id ?? null)
      const value = jsonClone(next)
      mutateDb((db) => {
        db.site_settings = value
        db.logs.push(
          adminLog(user?.id ?? null, 'settings.update', 'site_settings', null, {
            pg: value.pg_providers.length,
          }),
        )
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.all }),
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
