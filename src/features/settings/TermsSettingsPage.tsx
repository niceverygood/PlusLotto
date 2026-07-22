// 이용약관 편집 (/settings/terms) — 등급별 약관(현장 피드백 6/11).
// '공통(기본)' + 등급 탭. 등급 약관이 비어 있으면 공통이 적용된다(폴백).
import { useEffect, useState } from 'react'
import { usePageMeta } from '@/app/uiStore'
import { cn } from '@/lib/cn'
import { Tabs, type TabItem } from '@/design-system/components'
import { GRADE_LABEL } from '@/design-system/labels'
import type { Grade, SiteSettings } from '@/types/db'
import { SaveBar, SectionCard, hintCls, textareaCls } from './ui'
import { useSaveSiteSettings, useSiteSettings } from './api'

const GRADES: Grade[] = ['simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss']
type TermsTab = 'common' | Grade

function draftFrom(settings: SiteSettings): Record<string, string> {
  const d: Record<string, string> = { common: settings.terms }
  for (const g of GRADES) d[g] = settings.terms_by_grade?.[g] ?? ''
  return d
}

export function TermsSettingsPage() {
  usePageMeta('설정', '이용약관(등급별)')
  const { data: settings } = useSiteSettings()
  const save = useSaveSiteSettings()
  const [tab, setTab] = useState<TermsTab>('common')
  const [draft, setDraft] = useState<Record<string, string> | null>(null)

  useEffect(() => {
    if (settings) setDraft(draftFrom(settings))
  }, [settings])

  const dirty =
    !!settings && !!draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(settings))
  const saved = save.isSuccess && !dirty

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!settings || !draft) return
    const byGrade: Partial<Record<Grade, string>> = {}
    for (const g of GRADES) {
      const v = (draft[g] ?? '').trim()
      if (v) byGrade[g] = draft[g]
    }
    await save.mutateAsync({ ...settings, terms: draft.common, terms_by_grade: byGrade })
  }

  if (!draft) return <div className="py-16 text-center text-[13px] text-gray-400">불러오는 중…</div>

  const tabs: TabItem[] = [
    { key: 'common', label: '공통(기본)' },
    ...GRADES.map((g) => ({
      key: g,
      label: GRADE_LABEL[g] + ((draft[g] ?? '').trim() ? ' ●' : ''),
    })),
  ]
  const cur = draft[tab] ?? ''
  const isCommon = tab === 'common'

  return (
    <form onSubmit={onSubmit}>
      <SectionCard
        title="이용약관 (등급별)"
        desc="등급 탭에서 등급 전용 약관을 입력합니다. 저장하면 고객 홈페이지 약관보기와 문자 약관 링크에 즉시 반영됩니다. 비어 있으면 '공통(기본)' 약관이 적용됩니다. ● 표시 = 등급 전용 약관 있음."
      >
        <Tabs tabs={tabs} value={tab} onChange={(k) => setTab(k as TermsTab)} className="mb-3" />
        <textarea
          rows={18}
          className={cn(textareaCls, 'text-[12.5px] leading-relaxed')}
          placeholder={isCommon ? '' : '비워두면 공통(기본) 약관이 적용됩니다.'}
          value={cur}
          onChange={(e) => setDraft({ ...draft, [tab]: e.target.value })}
        />
        <p className={cn(hintCls, 'mt-2')}>
          {cur.length.toLocaleString()}자
          {!isCommon && !cur.trim() && ' · 현재 이 등급은 공통(기본) 약관이 적용됩니다'}
        </p>
      </SectionCard>
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        saved={saved}
        onReset={() => settings && setDraft(draftFrom(settings))}
      />
    </form>
  )
}
