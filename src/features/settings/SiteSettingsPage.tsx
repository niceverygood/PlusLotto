// 사이트 설정 (/settings) — 무통장 · 등급색 · PG 다중 · 문자 · 1~5등 당첨문자 + 문자 템플릿.
// 폼형 패턴(SectionCard + FieldRow + SaveBar), react-hook-form + zod (CLAUDE §10).
// 등급색 저장 → settingsKeys.site 무효화 → gradeTheme 가 토큰 재적용(전 화면 Badge 반영, §3 검수).
// 시크릿(PG api_key·SMTNT key)은 SecretField 로 마스킹, 빈 입력 시 기존값 유지. TODO(live-verify): 실 PG/문자 연동.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Controller, useFieldArray, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ExternalLink, Plus, Trash2 } from 'lucide-react'
import type { Grade, PgProvider, SiteSettings } from '@/types/db'
import { Button } from '@/design-system/components'
import { GRADE_LABEL, STATUS_META, type StatusKey } from '@/design-system/labels'
import { usePageMeta } from '@/app/uiStore'
import { genId } from '@/lib/db/store'
import { cn } from '@/lib/cn'
import { datetime, num } from '@/lib/format'
import { normalizeWinnerStats, upsertWinnerRound, winnerTotal, WINNER_RANKS } from '@/lib/winnerStats'
import { readWinSms } from '@/lib/winSms'
import { STATUS_KEY_ORDER, normalizeStatusColors } from '@/lib/statusColors'
import {
  FieldRow,
  SaveBar,
  SecretField,
  SectionCard,
  errCls,
  inputCls,
  textareaCls,
} from './ui'
import { useSaveSiteSettings, useSiteSettings, useWinnerHistory } from './api'
import { TemplatesCard } from './TemplatesCard'
import { PromoSlidesCard } from './PromoSlidesCard'
import { AppDownloadCard } from './AppDownloadCard'
import { EndDateBackfillCard } from './EndDateBackfillCard'

const GRADE_ORDER: readonly Grade[] = ['simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss']

const gradeColorSchema = z.object({ fg: z.string(), bg: z.string() })
const formSchema = z.object({
  bank: z.object({
    bank_name: z.string().min(1, '은행명을 입력하세요.'),
    account_no: z.string().min(1, '계좌번호를 입력하세요.'),
    holder: z.string().min(1, '예금주를 입력하세요.'),
    guide: z.string(),
  }),
  grade_colors: z.object({
    simple: gradeColorSchema,
    free: gradeColorSchema,
    gold: gradeColorSchema,
    goldp: gradeColorSchema,
    vip: gradeColorSchema,
    royal: gradeColorSchema,
    ovr: gradeColorSchema,
    toss: gradeColorSchema,
  }),
  // 회원·결제 상태 뱃지 색(현장 8/3) — grade_colors 와 같은 {fg,bg} 형태, 상태값 전부 명시.
  // expired(만료)는 DB 상태가 아니라 종료일에서 계산하는 표시 전용 상태(현장 8/13)지만 색은 동일하게 설정.
  status_colors: z.object({
    active: gradeColorSchema,
    suspended: gradeColorSchema,
    deleted: gradeColorSchema,
    withdrawn: gradeColorSchema,
    expired: gradeColorSchema,
    wait: gradeColorSchema,
    approved: gradeColorSchema,
    failed: gradeColorSchema,
    cancelled: gradeColorSchema,
  }),
  pg: z.array(
    z.object({
      id: z.string(),
      name: z.string().min(1, '명칭을 입력하세요.'),
      enabled: z.boolean(),
      mid: z.string(),
      apiKeyNew: z.string(),
      tidsText: z.string(),
      memo: z.string(),
    }),
  ),
  sms: z.object({
    sender_no: z.string().min(1, '발신번호를 입력하세요.'),
    smtnt_id: z.string(),
    smtntKeyNew: z.string(),
    oneshot_enabled: z.boolean(),
    ad_optout: z.string(),
  }),
  win_messages: z.array(z.object({ rank: z.number(), body: z.string().min(1, '문구를 입력하세요.') })),
  // 당첨 안내문자 자동발송(현장 7/28) — 등수별 체크 + 유료/무료 체크. 선택한 분류만 발송.
  win_sms: z.object({
    enabled: z.boolean(),
    rank1: z.boolean(),
    rank2: z.boolean(),
    rank3: z.boolean(),
    rank4: z.boolean(),
    rank5: z.boolean(),
    paid: z.boolean(),
    free: z.boolean(),
  }),
  // 가입환영문자 자동발송(현장 7/28) — 첫 결제 승인 시 1회.
  join_sms_auto: z.boolean(),
  call_keywords: z.string(), // 통화 녹음 자동탐지 특정 단어(쉼표 구분) — 현장 피드백 7/3
  call_volume_alert_threshold: z.string(), // 월 통화량(상담상태 변경 건수) 경고 기준
  call_script: z.string(), // AI 통화분석 기준 스크립트(선택) — 현장 피드백 7/10
  business: z.object({
    name: z.string(),
    reg_no: z.string(),
    address: z.string(),
    support_phone: z.string(),
  }),
  winnerEnabled: z.boolean(),
  winnerRound: z.string(),
  winnerRank1: z.string(),
  winnerRank2: z.string(),
  winnerRank3: z.string(),
  winnerRank4: z.string(),
  winnerRank5: z.string(),
})
type FormValues = z.infer<typeof formSchema>

function toForm(s: SiteSettings): FormValues {
  const winner = normalizeWinnerStats(s.winner_stats)
  const winSms = readWinSms(s)
  return {
    bank: { ...s.bank },
    grade_colors: structuredClone(s.grade_colors),
    status_colors: normalizeStatusColors(s.status_colors) as FormValues['status_colors'],
    pg: s.pg_providers.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      mid: p.mid,
      apiKeyNew: '',
      tidsText: p.tids.join('\n'),
      memo: p.memo ?? '',
    })),
    sms: {
      sender_no: s.sms.sender_no,
      smtnt_id: s.sms.smtnt_id,
      smtntKeyNew: '',
      oneshot_enabled: s.sms.oneshot_enabled ?? false,
      ad_optout: s.sms.ad_optout ?? '',
    },
    win_messages: s.win_messages.map((w) => ({ rank: w.rank, body: w.body })),
    win_sms: {
      enabled: winSms.enabled,
      rank1: winSms.ranks.includes(1),
      rank2: winSms.ranks.includes(2),
      rank3: winSms.ranks.includes(3),
      rank4: winSms.ranks.includes(4),
      rank5: winSms.ranks.includes(5),
      paid: winSms.paid,
      free: winSms.free,
    },
    join_sms_auto: !!s.join_sms_auto,
    call_keywords: (s.call_keywords ?? ['보장']).join(', '),
    call_volume_alert_threshold: String(s.call_volume_alert_threshold ?? 1000),
    call_script: s.call_script ?? '',
    business: {
      name: s.business?.name ?? '',
      reg_no: s.business?.reg_no ?? '',
      address: s.business?.address ?? '',
      support_phone: s.business?.support_phone ?? '',
    },
    winnerEnabled: winner.enabled,
    winnerRound: winner.current ? String(winner.current.round_no) : '',
    winnerRank1: String(winner.current?.rank1 ?? 0),
    winnerRank2: String(winner.current?.rank2 ?? 0),
    winnerRank3: String(winner.current?.rank3 ?? 0),
    winnerRank4: String(winner.current?.rank4 ?? 0),
    winnerRank5: String(winner.current?.rank5 ?? 0),
  }
}

function parseTids(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

function toSettings(v: FormValues, prev: SiteSettings): SiteSettings {
  const prevPg: Record<string, PgProvider> = {}
  for (const p of prev.pg_providers) prevPg[p.id] = p
  const roundNo = Math.max(0, Math.round(Number(v.winnerRound) || 0))
  let winnerStats = normalizeWinnerStats(prev.winner_stats)
  if (roundNo > 0) {
    winnerStats = upsertWinnerRound(winnerStats, {
      round_no: roundNo,
      rank1: Math.max(0, Math.round(Number(v.winnerRank1) || 0)),
      rank2: Math.max(0, Math.round(Number(v.winnerRank2) || 0)),
      rank3: Math.max(0, Math.round(Number(v.winnerRank3) || 0)),
      rank4: Math.max(0, Math.round(Number(v.winnerRank4) || 0)),
      rank5: Math.max(0, Math.round(Number(v.winnerRank5) || 0)),
    })
  }
  winnerStats = { ...winnerStats, enabled: v.winnerEnabled }

  return {
    bank: { ...v.bank },
    grade_colors: v.grade_colors,
    status_colors: v.status_colors,
    pg_providers: v.pg.map((r) => ({
      id: r.id,
      name: r.name.trim(),
      enabled: r.enabled,
      mid: r.mid.trim(),
      api_key: r.apiKeyNew.trim() || prevPg[r.id]?.api_key || '',
      tids: parseTids(r.tidsText),
      memo: r.memo.trim() || null,
    })),
    sms: {
      sender_no: v.sms.sender_no.trim(),
      smtnt_id: v.sms.smtnt_id.trim(),
      smtnt_key: v.sms.smtntKeyNew.trim() || prev.sms.smtnt_key,
      oneshot_enabled: v.sms.oneshot_enabled,
      ad_optout: v.sms.ad_optout.trim(),
    },
    win_messages: v.win_messages.map((w) => ({ rank: w.rank, body: w.body })),
    win_sms: {
      enabled: v.win_sms.enabled,
      ranks: [
        ...(v.win_sms.rank1 ? [1] : []),
        ...(v.win_sms.rank2 ? [2] : []),
        ...(v.win_sms.rank3 ? [3] : []),
        ...(v.win_sms.rank4 ? [4] : []),
        ...(v.win_sms.rank5 ? [5] : []),
      ],
      paid: v.win_sms.paid,
      free: v.win_sms.free,
    },
    join_sms_auto: v.join_sms_auto,
    business: {
      name: v.business.name.trim(),
      reg_no: v.business.reg_no.trim(),
      address: v.business.address.trim(),
      support_phone: v.business.support_phone.trim(),
    },
    winner_stats: winnerStats,
    report: prev.report,
    lotto_exclude: prev.lotto_exclude,
    lotto_exclude_history: prev.lotto_exclude_history,
    weekly_free_reco: prev.weekly_free_reco ?? { enabled: true, set_count: 30 },
    terms: prev.terms,
    terms_by_grade: prev.terms_by_grade,
    // 다른 화면(멤버십 등급·추천번호 생성기록)에서 편집되는 필드 — 이 폼엔 없으니 그대로 보존.
    // (이전엔 여기 빠져 있어 이 폼 저장 시 조용히 초기화되던 문제 발견·수정)
    membership_tiers: prev.membership_tiers,
    generation_records: prev.generation_records,
    call_keywords: parseTids(v.call_keywords),
    call_volume_alert_threshold: Math.max(1, Number(v.call_volume_alert_threshold) || 1000),
    call_script: v.call_script,
  }
}

export function SiteSettingsPage() {
  usePageMeta('설정', '사이트 · 등급색 · PG · 문자 · 당첨문자')
  const navigate = useNavigate()
  const { data: settings, isLoading } = useSiteSettings()
  const { data: winnerHistory = [] } = useWinnerHistory()
  const save = useSaveSiteSettings()
  const [resetKey, setResetKey] = useState(0)

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    getValues,
    formState: { errors, isDirty },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) })

  const pgArray = useFieldArray({ control, name: 'pg' })
  const winArray = useFieldArray({ control, name: 'win_messages' })

  useEffect(() => {
    if (settings) {
      reset(toForm(settings))
      setResetKey((k) => k + 1)
    }
  }, [settings, reset])

  const gradeColors = watch('grade_colors')
  const statusColors = watch('status_colors')
  const winnerCurrentRound = normalizeWinnerStats(settings?.winner_stats).current?.round_no
  async function onSubmit(v: FormValues) {
    if (!settings) return
    await save.mutateAsync(toSettings(v, settings))
    // onSuccess 무효화 → settings 갱신 → 위 effect 가 reset (isDirty=false, SecretField 접힘)
  }

  const saved = save.isSuccess && !isDirty

  if (isLoading || !settings) {
    return <div className="py-16 text-center text-[13px] text-gray-400">설정을 불러오는 중…</div>
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* ── 무통장 입금 설정 ─────────────────────────── */}
      <SectionCard
        title="무통장 입금 설정"
        desc="무통장 결제 안내에 노출되는 입금 계좌 정보입니다. 고객 홈페이지(멤버십 안내)에도 함께 노출됩니다."
      >
        <FieldRow label="은행" htmlFor="bank_name">
          <input id="bank_name" className={inputCls} {...register('bank.bank_name')} />
          {errors.bank?.bank_name && <p className={errCls}>{errors.bank.bank_name.message}</p>}
        </FieldRow>
        <FieldRow label="계좌번호" htmlFor="account_no">
          <input id="account_no" className={cn(inputCls, 'font-mono')} {...register('bank.account_no')} />
          {errors.bank?.account_no && <p className={errCls}>{errors.bank.account_no.message}</p>}
        </FieldRow>
        <FieldRow label="예금주" htmlFor="holder">
          <input id="holder" className={inputCls} {...register('bank.holder')} />
          {errors.bank?.holder && <p className={errCls}>{errors.bank.holder.message}</p>}
        </FieldRow>
        <FieldRow label="입금 안내문" htmlFor="bank_guide" align="start">
          <textarea id="bank_guide" rows={2} className={textareaCls} {...register('bank.guide')} />
        </FieldRow>
      </SectionCard>

      {/* ── 사업자 정보(고객 홈페이지 하단) ────────────── */}
      <SectionCard
        title="사업자 정보"
        desc="고객 홈페이지 하단(푸터)에 노출되는 사업자 정보입니다."
      >
        <FieldRow label="상호" htmlFor="biz_name">
          <input id="biz_name" className={inputCls} {...register('business.name')} />
        </FieldRow>
        <FieldRow label="사업자등록번호" htmlFor="biz_reg_no">
          <input id="biz_reg_no" className={cn(inputCls, 'font-mono')} {...register('business.reg_no')} />
        </FieldRow>
        <FieldRow label="주소" htmlFor="biz_address">
          <input id="biz_address" className={inputCls} {...register('business.address')} />
        </FieldRow>
        <FieldRow label="고객센터 번호" htmlFor="biz_support_phone">
          <input id="biz_support_phone" className={cn(inputCls, 'max-w-[220px] font-mono')} {...register('business.support_phone')} />
        </FieldRow>
      </SectionCard>

      {/* ── 고객 홈페이지 실적 표시(당첨자 수) ────────── */}
      <SectionCard
        title="고객 홈페이지 실적 표시"
        desc="매 회차 등수별 당첨자 수를 수동 입력합니다. 가장 최신 회차 한 건만 고객 홈페이지에 노출되고, 지난 회차는 이 관리자 화면에 기록으로 남습니다."
      >
        <FieldRow label="노출 여부" align="start">
          <label className="flex items-center gap-2 text-[13px] text-gray-700">
            <input type="checkbox" {...register('winnerEnabled')} /> 당첨자 수 노출
          </label>
        </FieldRow>
        <FieldRow label="회차" htmlFor="winner_round">
          <input
            id="winner_round"
            inputMode="numeric"
            placeholder="예: 1233"
            className={cn(inputCls, 'max-w-[160px] font-mono tnum')}
            {...register('winnerRound')}
          />
          <span className="ml-2 text-[12.5px] text-gray-500">회</span>
          <p className="mt-1 text-[11.5px] text-gray-400">
            새 회차 번호와 인원을 입력해 저장하면 기존 회차는 지우지 않고 아래 기록에 보관됩니다.
          </p>
        </FieldRow>
        <FieldRow label="등수별 당첨자 수" align="start">
          <div className="flex flex-wrap gap-3">
            {(['winnerRank1', 'winnerRank2', 'winnerRank3', 'winnerRank4', 'winnerRank5'] as const).map(
              (field, i) => (
                <label key={field} className="flex items-center gap-1.5 text-[12.5px] text-gray-600">
                  {i + 1}등
                  <input
                    inputMode="numeric"
                    className={cn(inputCls, 'h-9 w-[92px] font-mono tnum')}
                    {...register(field)}
                  />
                  명
                </label>
              ),
            )}
          </div>
        </FieldRow>
        <FieldRow label="과거 기록" align="start">
          {winnerHistory.length === 0 ? (
            <p className="py-2 text-[12.5px] text-gray-400">저장된 회차별 당첨자 기록이 없습니다.</p>
          ) : (
            <div className="w-full overflow-x-auto rounded-md border border-gray-200">
              <table className="min-w-[720px] w-full text-[12px]">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">회차</th>
                    {WINNER_RANKS.map((rank) => (
                      <th key={rank.key} className="px-3 py-2 text-right font-semibold">{rank.label}</th>
                    ))}
                    <th className="px-3 py-2 text-right font-semibold">합계</th>
                    <th className="px-3 py-2 text-right font-semibold">저장일시</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {winnerHistory.map((row) => (
                    <tr key={row.round_no}>
                      <td className="px-3 py-2 font-mono font-semibold text-ink-800 tnum">
                        {row.round_no}회
                        {row.round_no === winnerCurrentRound && (
                          <span className="ml-2 rounded bg-primary-50 px-1.5 py-0.5 font-sans text-[10px] font-bold text-primary-700">
                            홈페이지 노출
                          </span>
                        )}
                      </td>
                      {WINNER_RANKS.map((rank) => (
                        <td key={rank.key} className="px-3 py-2 text-right font-mono text-gray-600 tnum">
                          {num(row[rank.key])}명
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right font-mono font-semibold text-ink-800 tnum">
                        {num(winnerTotal(row))}명
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400 tnum">
                        {row.updated_at === new Date(0).toISOString() ? '-' : datetime(row.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </FieldRow>
      </SectionCard>

      {/* ── 유저 등급색 ──────────────────────────────── */}
      <SectionCard
        title="유저 등급색"
        desc="등급 뱃지 색입니다. 저장 시 모든 화면의 등급 표시에 즉시 반영됩니다."
      >
        <div className="space-y-2">
          {GRADE_ORDER.map((g) => {
            const c = gradeColors?.[g]
            return (
              <div
                key={g}
                className="grid items-center gap-3 border-b border-gray-50 py-2 last:border-b-0 sm:grid-cols-[120px_1fr]"
              >
                <div className="flex items-center gap-2">
                  {/* 미저장 미리보기(폼 값 인라인 스타일) */}
                  <span
                    className="inline-flex items-center gap-[5px] rounded-full px-[9px] py-[3px] text-[11px] font-bold"
                    style={c ? { backgroundColor: c.bg, color: c.fg } : undefined}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={c ? { backgroundColor: c.fg } : undefined} />
                    {GRADE_LABEL[g]}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-[12px] text-gray-500">
                    글자
                    <input type="color" className="h-7 w-9 cursor-pointer rounded border border-gray-200 bg-white p-0.5" {...register(`grade_colors.${g}.fg`)} />
                    <input className={cn(inputCls, 'h-8 w-[92px] font-mono text-[11.5px]')} {...register(`grade_colors.${g}.fg`)} />
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-gray-500">
                    배경
                    <input type="color" className="h-7 w-9 cursor-pointer rounded border border-gray-200 bg-white p-0.5" {...register(`grade_colors.${g}.bg`)} />
                    <input className={cn(inputCls, 'h-8 w-[92px] font-mono text-[11.5px]')} {...register(`grade_colors.${g}.bg`)} />
                  </label>
                </div>
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* ── 상태색(회원·결제 상태 뱃지) ──────────────── */}
      <SectionCard
        title="상태색"
        desc="회원·결제 상태 뱃지 색입니다(예: 취소 → 빨강). 저장 시 모든 화면의 상태 표시에 즉시 반영됩니다."
      >
        <div className="space-y-2">
          {STATUS_KEY_ORDER.map((key) => {
            const c = statusColors?.[key as keyof FormValues['status_colors']]
            return (
              <div
                key={key}
                className="grid items-center gap-3 border-b border-gray-50 py-2 last:border-b-0 sm:grid-cols-[120px_1fr]"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex items-center gap-[5px] rounded-md px-[9px] py-[3px] text-[11px] font-bold"
                    style={c ? { backgroundColor: c.bg, color: c.fg } : undefined}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={c ? { backgroundColor: c.fg } : undefined} />
                    {STATUS_META[key as StatusKey].label}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-[12px] text-gray-500">
                    글자
                    <input type="color" className="h-7 w-9 cursor-pointer rounded border border-gray-200 bg-white p-0.5" {...register(`status_colors.${key}.fg`)} />
                    <input className={cn(inputCls, 'h-8 w-[92px] font-mono text-[11.5px]')} {...register(`status_colors.${key}.fg`)} />
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-gray-500">
                    배경
                    <input type="color" className="h-7 w-9 cursor-pointer rounded border border-gray-200 bg-white p-0.5" {...register(`status_colors.${key}.bg`)} />
                    <input className={cn(inputCls, 'h-8 w-[92px] font-mono text-[11.5px]')} {...register(`status_colors.${key}.bg`)} />
                  </label>
                </div>
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* ── PG 설정 (다중) ───────────────────────────── */}
      <SectionCard
        title="PG 설정"
        desc="결제대행(PG) 채널을 다중 운영합니다. API 키는 보안상 마스킹되며, '변경' 시에만 새 키를 입력합니다."
        action={
          <Button
            variant="sec"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() =>
              pgArray.append({ id: genId('pg'), name: '', enabled: true, mid: '', apiKeyNew: '', tidsText: '', memo: '' })
            }
          >
            PG 추가
          </Button>
        }
      >
        <div className="space-y-3">
          {pgArray.fields.map((field, i) => {
            // field.id 는 useFieldArray 가 부여한 React 키(비즈니스 id 를 가림) → 실제 id 는 폼 값에서 읽는다.
            const stored = settings.pg_providers.find((p) => p.id === getValues(`pg.${i}.id`))?.api_key ?? ''
            return (
              <div key={field.id} className="rounded-lg border border-gray-200 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    className={cn(inputCls, 'h-9 max-w-[220px] font-semibold')}
                    placeholder="PG 명칭"
                    {...register(`pg.${i}.name`)}
                  />
                  <label className="flex items-center gap-1.5 text-[12px] text-gray-600">
                    <input type="checkbox" {...register(`pg.${i}.enabled`)} /> 사용
                  </label>
                  <button
                    type="button"
                    onClick={() => pgArray.remove(i)}
                    className="ml-auto grid h-8 w-8 place-items-center rounded-md text-gray-400 transition-colors hover:bg-danger-bg hover:text-danger"
                    aria-label="PG 삭제"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {errors.pg?.[i]?.name && <p className={cn(errCls, 'mb-1')}>{errors.pg[i]?.name?.message}</p>}
                <div className="grid gap-x-4 sm:grid-cols-2">
                  <FieldRow label="상점 ID(MID)" align="center">
                    <input className={cn(inputCls, 'font-mono')} {...register(`pg.${i}.mid`)} />
                  </FieldRow>
                  <FieldRow label="API 키" align="center">
                    <Controller
                      control={control}
                      name={`pg.${i}.apiKeyNew`}
                      render={({ field: f }) => (
                        <SecretField key={`${field.id}-${resetKey}`} stored={stored} value={f.value} onChange={f.onChange} />
                      )}
                    />
                  </FieldRow>
                  <FieldRow label="단말기 ID(TID)" align="start" hint="여러 개는 줄바꿈 또는 쉼표로 구분">
                    <textarea rows={2} className={cn(textareaCls, 'font-mono text-[12px]')} {...register(`pg.${i}.tidsText`)} />
                  </FieldRow>
                  <FieldRow label="메모" align="center">
                    <input className={inputCls} {...register(`pg.${i}.memo`)} />
                  </FieldRow>
                </div>
              </div>
            )
          })}
          {pgArray.fields.length === 0 && (
            <p className="py-4 text-center text-[12.5px] text-gray-400">등록된 PG 가 없습니다. ‘PG 추가’로 채널을 등록하세요.</p>
          )}
        </div>
      </SectionCard>

      {/* ── 문자 설정 ────────────────────────────────── */}
      <SectionCard title="문자 설정" desc="발신번호 · OneShot 실발송 연동 · 추천번호 발송 스케줄.">
        <FieldRow label="발신번호" htmlFor="sender_no">
          <input id="sender_no" className={cn(inputCls, 'max-w-[220px] font-mono')} {...register('sms.sender_no')} />
          {errors.sms?.sender_no && <p className={errCls}>{errors.sms.sender_no.message}</p>}
          <p className="mt-1 text-[11.5px] text-gray-400">OneShot 에 사전등록된 발신번호여야 발송됩니다.</p>
        </FieldRow>
        <FieldRow label="OneShot 아이디" htmlFor="smtnt_id">
          <input id="smtnt_id" className={cn(inputCls, 'max-w-[260px]')} {...register('sms.smtnt_id')} />
          <p className="mt-1 text-[11.5px] text-gray-400">
            매뉴얼의 사용자 아이디(예: lotto_dream_api). 인증은 API 키가 아니라 서버 IP 화이트리스트입니다.
          </p>
        </FieldRow>
        <FieldRow label="실발송(OneShot)" align="start">
          <label className="flex items-center gap-2 text-[13px] text-gray-700">
            <input type="checkbox" {...register('sms.oneshot_enabled')} /> 실제 문자 발송 사용
          </label>
          <p className="mt-1 text-[11.5px] text-warning">
            끄면 발송 이력만 기록(데모). 켜기 전 발송 함수 배포 + 고정 IP(프록시)를 OneShot 에 등록 + 발신번호
            설정이 필요합니다. 실발송은 캐쉬가 차감됩니다.
          </p>
        </FieldRow>
        <FieldRow label="가입환영문자 자동발송" align="start">
          <label className="flex items-center gap-2 text-[13px] text-gray-700">
            <input type="checkbox" className="h-4 w-4 accent-primary-600" {...register('join_sms_auto')} /> 첫 결제 승인 시 자동발송
          </label>
          <p className="mt-1 text-[11.5px] text-gray-400">
            회원의 첫 결제가 승인되는 순간 ‘가입’ 템플릿(아래 <b>기본 문자 멘트 템플릿</b>)을 1회 자동
            발송합니다. 이미 유료 이력이 있는 회원의 재결제(갱신)에는 나가지 않습니다. 실발송은 위 ‘실발송
            사용’ · 발신번호가 켜져 있어야 합니다.
          </p>
        </FieldRow>
        <FieldRow label="무료수신거부 번호" htmlFor="ad_optout">
          <input id="ad_optout" className={cn(inputCls, 'max-w-[220px] font-mono')} {...register('sms.ad_optout')} />
          <p className="mt-1 text-[11.5px] text-gray-400">
            광고성(마케팅) 문자 발송 시 본문에 (광고)와 함께 자동 표기됩니다. 비우면 미표기.
          </p>
        </FieldRow>
        <FieldRow label="추천번호 발송요일" align="start">
          <p className="text-[12.5px] leading-relaxed text-gray-500">
            회원별 발송요일은 <b>회원정보창</b>에서 지정하고, 매일 09:00 자동 발급/발송됩니다.
            유료회원 조합 문자 자동발송은 <b>설정 &gt; 로또 고정·제외 &gt; 추천조합 발급 설정</b>에서 켭니다.
          </p>
        </FieldRow>
      </SectionCard>

      {/* ── 통화 녹음 · 키워드 탐지 · 통화량 경고(현장 피드백 7/3, 김형준 이사) ── */}
      <SectionCard
        title="통화 녹음 · 키워드 탐지"
        desc="회원 상세에서 업로드한 통화 녹음의 전사(STT) 결과에서 자동 탐지할 단어와, 월 발신 통화량(상담상태 변경 건수 기준) 경고 기준을 설정합니다."
      >
        <FieldRow label="탐지 단어" htmlFor="call_keywords">
          <input
            id="call_keywords"
            className={inputCls}
            placeholder="보장, 확정, 무조건"
            {...register('call_keywords')}
          />
          <p className="mt-1 text-[11.5px] text-gray-400">
            쉼표로 구분. 통화 녹음을 전사하면 이 단어가 몇 번 나왔는지 회원 상세 ‘통화녹음’ 탭에 표시됩니다.
          </p>
        </FieldRow>
        <FieldRow label="통화량 경고 기준" htmlFor="call_volume_alert_threshold">
          <input
            id="call_volume_alert_threshold"
            inputMode="numeric"
            className={cn(inputCls, 'max-w-[140px] font-mono tnum')}
            {...register('call_volume_alert_threshold')}
          />
          <p className="mt-1 text-[11.5px] text-gray-400">
            이번 달 상담상태 변경 건수(=발신 통화 근사치)가 이 값을 넘으면 관리자 화면에 경고가 표시됩니다.
          </p>
        </FieldRow>
        <FieldRow label="AI 분석 기준 스크립트" htmlFor="call_script" align="start">
          <textarea
            id="call_script"
            rows={6}
            className={textareaCls}
            placeholder="비워두면 AI 통화분석에서 '스크립트 유사성' 항목이 생략됩니다."
            {...register('call_script')}
          />
          <p className="mt-1 text-[11.5px] text-gray-400">
            회원 상세 통화녹음 탭의 ‘AI 분석’이 전사본과 이 스크립트를 비교해 유사성을 알려줍니다.
          </p>
        </FieldRow>
      </SectionCard>

      {/* ── 1~5등 당첨문자 + 자동발송 조건(현장 7/28) ───────────────────────────── */}
      <SectionCard
        title="당첨 안내문자 (1~5등)"
        desc="당첨 확정 시 등수별로 발송되는 문자입니다. $name · $contents 변수 사용 가능."
      >
        {/* 자동발송 — 체크한 등수 × 체크한 회원분류에만 나간다. 끄면 종전처럼 담당자 수동발송만. */}
        <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <label className="flex items-center gap-2 text-[13px] font-bold text-ink-900">
            <input type="checkbox" className="h-4 w-4 accent-primary-600" {...register('win_sms.enabled')} />
            당첨 안내문자 자동발송 사용
          </label>
          <p className="mt-1 text-[11.5px] text-gray-400">
            회차 당첨이 확정되면(수기 확정 · 매일 자동적재 모두) 아래에서 체크한 등수 · 회원분류의 당첨자에게
            등수별 문구가 자동 발송됩니다. 같은 회차는 한 번만 발송합니다. (실발송은 문자 설정의 ‘실발송 사용’ ·
            발신번호가 켜져 있어야 합니다.)
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[12px] font-semibold text-gray-600">발송 등수</span>
            {([1, 2, 3, 4, 5] as const).map((r) => (
              <label key={r} className="flex items-center gap-1.5 text-[12.5px] text-gray-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary-600"
                  {...register(`win_sms.rank${r}` as const)}
                />
                {r}등
              </label>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[12px] font-semibold text-gray-600">발송 대상</span>
            <label className="flex items-center gap-1.5 text-[12.5px] text-gray-700">
              <input type="checkbox" className="h-4 w-4 accent-primary-600" {...register('win_sms.paid')} />
              유료회원 <span className="text-[11px] text-gray-400">(골드 · 골드플러스 · VIP · 로얄)</span>
            </label>
            <label className="flex items-center gap-1.5 text-[12.5px] text-gray-700">
              <input type="checkbox" className="h-4 w-4 accent-primary-600" {...register('win_sms.free')} />
              무료회원 <span className="text-[11px] text-gray-400">(간편가입 · 무료 등)</span>
            </label>
          </div>
        </div>

        <div className="space-y-2.5">
          {winArray.fields.map((field, i) => (
            <FieldRow key={field.id} label={`${field.rank}등`} align="start">
              <textarea rows={2} className={textareaCls} {...register(`win_messages.${i}.body`)} />
              {errors.win_messages?.[i]?.body && <p className={errCls}>{errors.win_messages[i]?.body?.message}</p>}
            </FieldRow>
          ))}
        </div>
      </SectionCard>

      <SaveBar dirty={isDirty} saving={save.isPending} saved={saved} onReset={() => reset(toForm(settings))} />

      {/* ── 문자 템플릿(기본 멘트) — 별도 엔터티(sms_templates) ── */}
      <TemplatesCard />

      {/* ── 고객 홈페이지 홍보 슬라이드(현장 피드백 7/29) — site_settings.promo_slides, 즉시 반영 ── */}
      <PromoSlidesCard slides={settings.promo_slides ?? []} />

      {/* 통화녹음 자동업로드 앱 배포(현장 피드백 8/3) — 상담원 다운로드 입구는 계정메뉴에 있다. */}
      <AppDownloadCard current={settings.app_download ?? null} />

      {/* 회원 종료일 일괄 반영(현장 8/13) — 최고관리자에게만 보인다(카드 내부에서 가드). */}
      <EndDateBackfillCard />

      {/* ── FAQ · 공지 설정(기존 모듈 연결) ───────────── */}
      <SectionCard title="FAQ · 공지 설정" desc="FAQ 와 공지사항은 고객센터 · 커뮤니티에서 관리합니다.">
        <div className="flex flex-wrap gap-2">
          <Button variant="sec" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => navigate('/admin/support')}>
            FAQ 관리(고객센터)
          </Button>
          <Button variant="sec" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => navigate('/community')}>
            공지 관리(커뮤니티)
          </Button>
        </div>
      </SectionCard>
    </form>
  )
}
