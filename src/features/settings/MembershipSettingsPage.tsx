// 멤버십 등급 편집 (/settings/membership) — 현장 6/30, 정의현 차장.
// 등급별 명칭·월 이용료·한 줄 소개·주간 조합·인기뱃지·핵심 혜택을 운영자가 직접 수정.
// 저장 → site_settings.membership_tiers → 고객 멤버십 페이지(RPC) 연동 + 명칭은 전산 전역 GRADE_LABEL 로 전파.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePageMeta } from '@/app/uiStore'
import { cn } from '@/lib/cn'
import { Tabs, type TabItem } from '@/design-system/components'
import type { MembershipTier, SiteSettings } from '@/types/db'
import { TIER_GRADES, resolveTiers } from '@/lib/membership'
import { FieldRow, SaveBar, SectionCard, inputCls, textareaCls } from './ui'
import { useSaveSiteSettings, useSiteSettings } from './api'

/** 저장 시 혜택 목록 정리(빈 줄·공백 제거). */
function cleanTiers(draft: MembershipTier[]): MembershipTier[] {
  return draft.map((t) => ({
    ...t,
    label: t.label.trim(),
    price: t.price.trim(),
    tagline: t.tagline.trim(),
    weekly_sets: t.weekly_sets.trim(),
    highlights: t.highlights.map((h) => h.trim()).filter(Boolean),
    terms: t.terms.trim(),
  }))
}

export function MembershipSettingsPage() {
  usePageMeta('설정', '멤버십 등급(고객 페이지)')
  const { data: settings } = useSiteSettings()
  const save = useSaveSiteSettings()
  const [tab, setTab] = useState<string>('free')
  const [draft, setDraft] = useState<MembershipTier[] | null>(null)

  useEffect(() => {
    if (settings) setDraft(resolveTiers(settings.membership_tiers))
  }, [settings])

  const baseline = settings ? resolveTiers(settings.membership_tiers) : null
  const dirty = !!draft && !!baseline && JSON.stringify(draft) !== JSON.stringify(baseline)
  const saved = save.isSuccess && !dirty

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!settings || !draft) return
    const next: SiteSettings = { ...settings, membership_tiers: cleanTiers(draft) }
    await save.mutateAsync(next)
  }

  if (!draft) return <div className="py-16 text-center text-[13px] text-gray-400">불러오는 중…</div>

  const cur = draft.find((t) => t.grade === tab) ?? draft[0]
  const update = (patch: Partial<MembershipTier>) =>
    setDraft(draft.map((t) => (t.grade === cur.grade ? { ...t, ...patch } : t)))

  const tabs: TabItem[] = TIER_GRADES.map((g) => {
    const t = draft.find((x) => x.grade === g)
    return { key: g, label: (t?.label || g) + (t?.featured ? ' ★' : '') + (t?.hidden ? ' (숨김)' : '') }
  })

  return (
    <form onSubmit={onSubmit}>
      <SectionCard
        title="멤버십 등급 (고객 페이지)"
        desc="등급별 명칭·가격·혜택을 직접 편집합니다. 저장하면 고객 멤버십 페이지에 즉시 반영되고, 명칭은 전산 전역(회원목록 배지·필터·드롭다운)에도 적용됩니다. ★ = 인기 뱃지."
      >
        <Tabs tabs={tabs} value={tab} onChange={setTab} className="mb-4" />

        <FieldRow label="등급 명칭" hint="고객 페이지·전산 전역 배지에 표시됩니다 (예: 골드플러스 → 88마스터).">
          <input
            className={inputCls}
            value={cur.label}
            onChange={(e) => update({ label: e.target.value })}
            placeholder="등급 명칭"
          />
        </FieldRow>

        <FieldRow label="월 이용료" hint="자유 입력 — 금액(예: 490,000원) 또는 '문의'.">
          <input
            className={inputCls}
            value={cur.price}
            onChange={(e) => update({ price: e.target.value })}
            placeholder="문의"
          />
        </FieldRow>

        <FieldRow label="한 줄 소개">
          <input
            className={inputCls}
            value={cur.tagline}
            onChange={(e) => update({ tagline: e.target.value })}
            placeholder="예: 본격적인 번호 관리의 시작"
          />
        </FieldRow>

        <FieldRow label="주간 조합 표시" hint="가격 옆 작은 텍스트 (예: 주 10조합).">
          <input
            className={cn(inputCls, 'sm:max-w-[200px]')}
            value={cur.weekly_sets}
            onChange={(e) => update({ weekly_sets: e.target.value })}
            placeholder="주 5조합"
          />
        </FieldRow>

        <FieldRow label="인기 뱃지">
          <label className="inline-flex items-center gap-2 text-[13px] text-gray-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300"
              checked={cur.featured}
              onChange={(e) => update({ featured: e.target.checked })}
            />
            이 등급 카드에 '인기' 강조 표시
          </label>
        </FieldRow>

        <FieldRow label="고객 페이지 노출" hint="끄면 이 등급 카드가 고객 홈페이지(멤버십 미리보기·전체 카드·비교표)에서 숨겨집니다. 전산 편집은 계속 가능합니다.">
          <label className="inline-flex items-center gap-2 text-[13px] text-gray-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300"
              checked={!cur.hidden}
              onChange={(e) => update({ hidden: !e.target.checked })}
            />
            고객 홈페이지에 이 등급 표시
          </label>
        </FieldRow>

        <FieldRow label="핵심 혜택" hint="한 줄에 하나씩 입력합니다. 카드에 체크 목록으로 노출됩니다." align="start">
          <textarea
            rows={5}
            className={cn(textareaCls, 'text-[12.5px] leading-relaxed')}
            value={cur.highlights.join('\n')}
            onChange={(e) => update({ highlights: e.target.value.split('\n') })}
            placeholder={'주간 추천 조합 5세트\n추천 번호 문자(SMS) 발송\n회차별 당첨 집계 알림'}
          />
        </FieldRow>

        <FieldRow label="등급별 이용약관" hint="약관은 한 곳에서 관리해 고객 홈페이지와 문자 링크가 항상 같은 내용을 표시합니다.">
          <Link
            to="/admin/settings/terms"
            className="inline-flex h-9 items-center rounded-md border border-primary-100 bg-primary-50 px-3 text-[12.5px] font-semibold text-primary-700 hover:border-primary-500"
          >
            이용약관 편집으로 이동
          </Link>
        </FieldRow>
      </SectionCard>

      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        saved={saved}
        onReset={() => baseline && setDraft(baseline)}
      />
    </form>
  )
}
