// 기본 문자 멘트 템플릿(sms_templates) 편집 카드 — site_settings 와 별도 엔터티.
// 저장 시 members(드로어·일괄·나의문자)의 동일 키 캐시도 함께 갱신(§8).
// 변수: $name $id $pw $num $contents $link (lib/sms.renderSms 와 동일).
import { useEffect, useState } from 'react'
import type { SmsTemplate } from '@/types/db'
import { Button } from '@/design-system/components'
import { cn } from '@/lib/cn'
import { SectionCard, hintCls, inputCls, labelCls, textareaCls } from './ui'
import { useSaveSmsTemplates, useSmsTemplates } from './api'

const VARS = ['$name', '$id', '$pw', '$num', '$contents', '$link']

export function TemplatesCard() {
  const { data: templates } = useSmsTemplates()
  const save = useSaveSmsTemplates()
  const [draft, setDraft] = useState<SmsTemplate[]>([])

  useEffect(() => {
    if (templates) setDraft(templates.map((t) => ({ ...t })))
  }, [templates])

  const dirty = !!templates && JSON.stringify(draft) !== JSON.stringify(templates)

  function patch(key: string, field: 'title' | 'body', value: string) {
    setDraft((d) => d.map((t) => (t.key === key ? { ...t, [field]: value } : t)))
  }

  async function onSave() {
    await save.mutateAsync(draft)
  }

  return (
    <SectionCard
      title="기본 문자 멘트 템플릿"
      desc="가입·추천·당첨 안내 문자의 기본 본문입니다. 회원 발송 시 변수에 실제 값이 채워집니다."
      action={
        <Button variant="pri" size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
          {save.isPending ? '저장 중…' : '템플릿 저장'}
        </Button>
      }
    >
      <p className={cn(hintCls, 'mb-3 mt-0')}>
        사용 가능 변수:{' '}
        {VARS.map((v) => (
          <code key={v} className="mr-1 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-600">
            {v}
          </code>
        ))}
      </p>
      <div className="space-y-3">
        {draft.map((t) => (
          <div key={t.key} className="rounded-lg border border-gray-200 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-500">{t.key}</span>
              <input
                className={cn(inputCls, 'h-8 max-w-[260px] text-[12.5px]')}
                value={t.title}
                onChange={(e) => patch(t.key, 'title', e.target.value)}
              />
            </div>
            <label className={cn(labelCls, 'sr-only')} htmlFor={`tpl-${t.key}`}>
              본문
            </label>
            {t.key === 'terms' && (
              <p className={cn(hintCls, 'mb-1.5 mt-0')}>
                $link 는 회원 등급의 공개 약관 페이지 주소로 자동 치환됩니다. 약관 전문은 문자에
                포함하지 않습니다. 기존 $contents 변수도 호환을 위해 같은 링크로 치환됩니다.
              </p>
            )}
            <textarea
              id={`tpl-${t.key}`}
              rows={2}
              className={textareaCls}
              value={t.body}
              onChange={(e) => patch(t.key, 'body', e.target.value)}
            />
          </div>
        ))}
      </div>
    </SectionCard>
  )
}
