// 정기 리포트 설정 (/settings/report) — 운영 지표 자동 발송 주기·수신자·포함 항목.
// TODO(live-verify): 실제 리포트 발송 채널(메일/슬랙)·지표 구성 미확인 → 표준 패턴(ASSUMPTIONS).
import { useEffect, useState } from 'react'
import type { ReportFrequency, ReportSettings } from '@/types/db'
import { usePageMeta } from '@/app/uiStore'
import { cn } from '@/lib/cn'
import { FieldRow, SaveBar, SectionCard, hintCls, inputCls, textareaCls } from './ui'
import { useSaveSiteSettings, useSiteSettings } from './api'

const FREQ: readonly { value: ReportFrequency; label: string }[] = [
  { value: 'daily', label: '매일' },
  { value: 'weekly', label: '매주' },
  { value: 'monthly', label: '매월' },
]
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const
const SECTIONS: readonly { key: string; label: string }[] = [
  { key: 'revenue', label: '매출 요약' },
  { key: 'signup', label: '신규 가입' },
  { key: 'payment', label: '결제 현황' },
  { key: 'outcall', label: '미아웃콜' },
]

export function ReportSettingsPage() {
  usePageMeta('설정', '정기 리포트')
  const { data: settings } = useSiteSettings()
  const save = useSaveSiteSettings()
  const [draft, setDraft] = useState<ReportSettings | null>(null)

  useEffect(() => {
    if (settings) setDraft(structuredClone(settings.report))
  }, [settings])

  const dirty = !!settings && !!draft && JSON.stringify(draft) !== JSON.stringify(settings.report)
  const saved = save.isSuccess && !dirty

  function set<K extends keyof ReportSettings>(key: K, value: ReportSettings[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
  }
  function toggleSection(key: string) {
    setDraft((d) =>
      d ? { ...d, sections: d.sections.includes(key) ? d.sections.filter((s) => s !== key) : [...d.sections, key] } : d,
    )
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!settings || !draft) return
    await save.mutateAsync({ ...settings, report: draft })
  }

  if (!draft) return <div className="py-16 text-center text-[13px] text-gray-400">불러오는 중…</div>

  return (
    <form onSubmit={onSubmit}>
      <SectionCard title="정기 리포트" desc="운영 지표를 설정한 주기로 자동 발송합니다.">
        <FieldRow label="자동 발송">
          <label className="flex items-center gap-2 text-[13px] text-gray-700">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} /> 사용
          </label>
        </FieldRow>
        <FieldRow label="발송 주기">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={cn(inputCls, 'h-9 w-28')}
              value={draft.frequency}
              onChange={(e) => set('frequency', e.target.value as ReportFrequency)}
            >
              {FREQ.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            {draft.frequency === 'weekly' && (
              <select
                className={cn(inputCls, 'h-9 w-24')}
                value={draft.weekday}
                onChange={(e) => set('weekday', Number(e.target.value))}
              >
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}요일
                  </option>
                ))}
              </select>
            )}
            {draft.frequency === 'monthly' && (
              <select
                className={cn(inputCls, 'h-9 w-24')}
                value={draft.day_of_month}
                onChange={(e) => set('day_of_month', Number(e.target.value))}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}일
                  </option>
                ))}
              </select>
            )}
            <input
              type="time"
              className={cn(inputCls, 'h-9 w-[120px]')}
              value={draft.time}
              onChange={(e) => set('time', e.target.value)}
            />
          </div>
        </FieldRow>
        <FieldRow label="포함 항목" align="start">
          <div className="flex flex-wrap gap-3">
            {SECTIONS.map((s) => (
              <label key={s.key} className="flex items-center gap-1.5 text-[13px] text-gray-700">
                <input type="checkbox" checked={draft.sections.includes(s.key)} onChange={() => toggleSection(s.key)} />
                {s.label}
              </label>
            ))}
          </div>
        </FieldRow>
        <FieldRow label="수신 이메일" align="start" hint="한 줄에 하나씩 입력">
          <textarea
            rows={3}
            className={cn(textareaCls, 'font-mono text-[12px]')}
            value={draft.recipients.join('\n')}
            onChange={(e) =>
              set(
                'recipients',
                e.target.value
                  .split('\n')
                  .map((t) => t.trim())
                  .filter(Boolean),
              )
            }
          />
        </FieldRow>
        <p className={cn(hintCls, 'mt-2')}>
          현재 데모에서는 발송이 시뮬레이션됩니다. 실제 발송 연동은 라이브 전환 시 구성합니다.
        </p>
      </SectionCard>
      <SaveBar dirty={dirty} saving={save.isPending} saved={saved} onReset={() => settings && setDraft(structuredClone(settings.report))} />
    </form>
  )
}
