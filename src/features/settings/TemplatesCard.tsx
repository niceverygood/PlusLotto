// 기본 문자 멘트 템플릿(sms_templates) 편집 카드 — site_settings 와 별도 엔터티.
// 저장 시 members(드로어·일괄·나의문자)의 동일 키 캐시도 함께 갱신(§8).
// 변수: $name $id $pw $num $contents $link (lib/sms.renderSms 와 동일) + $round(조합문자 전용, 현장 8/4).
import { useEffect, useRef, useState } from 'react'
import type { SmsTemplate } from '@/types/db'
import { Button } from '@/design-system/components'
import { cn } from '@/lib/cn'
import { SectionCard, hintCls, inputCls, labelCls, textareaCls } from './ui'
import { useSaveSmsTemplates, useSmsTemplates } from './api'

const VARS = ['$name', '$id', '$pw', '$num', '$round', '$contents', '$link']

export function TemplatesCard() {
  const { data: templates } = useSmsTemplates()
  const save = useSaveSmsTemplates()
  const [draft, setDraft] = useState<SmsTemplate[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  // 마지막으로 draft 에 심은 서버 내용의 서명. '입력 중인가'를 판정하는 기준이다.
  const serverSigRef = useRef<string | null>(null)

  // 서버 값을 draft 에 심되, **사용자가 입력 중이면 덮어쓰지 않는다**(현장 8/27 — 88로또에서
  // "조합발송 형식을 수정하는데 반영이 안됩니다"). smsTemplateKeys.all 은 설정 화면과 회원
  // 드로어가 공유하는 키라, 편집 중에 드로어를 열거나 staleTime(30초)이 지나 재조회가 일어나면
  // templates 배열이 새 참조로 바뀐다. 예전 코드는 그때마다 무조건 setDraft 해서 **타이핑한
  // 내용을 조용히 지웠다.** 다른 창에서 문구를 복사해 오는 동안 특히 잘 터진다.
  useEffect(() => {
    if (!templates) return
    const sig = JSON.stringify(templates)
    setDraft((prev) => {
      if (serverSigRef.current !== null && JSON.stringify(prev) !== serverSigRef.current) return prev
      serverSigRef.current = sig
      return templates.map((t) => ({ ...t }))
    })
  }, [templates])

  const dirty = !!templates && JSON.stringify(draft) !== JSON.stringify(templates)

  function patch(key: string, field: 'title' | 'body', value: string) {
    setSaved(false)
    setDraft((d) => d.map((t) => (t.key === key ? { ...t, [field]: value } : t)))
  }

  // 저장 실패를 화면에 띄운다. 예전에는 mutateAsync 를 그냥 await 만 해서 실패해도 아무 표시가
  // 없었다 — 템플릿 쓰기는 RLS 상 최고관리자·관리자만 되므로(0002_rls tmpl_write), 실장·팀장이
  // 저장하면 조용히 실패한다. 그게 "수정했는데 반영이 안 된다"로 보인다(D154 와 같은 유형).
  async function onSave() {
    setErr(null)
    setSaved(false)
    try {
      await save.mutateAsync(draft)
      serverSigRef.current = null // 저장 후 재조회분을 다시 심을 수 있게 초기화
      setSaved(true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(
        /row-level security|permission|policy/i.test(msg)
          ? '권한이 없어 저장되지 않았습니다. 문자 템플릿은 최고관리자·관리자만 수정할 수 있습니다.'
          : `저장하지 못했습니다 — ${msg}`,
      )
    }
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
      {err && (
        <p className="mb-3 rounded-md border border-danger-bd bg-danger-bg px-3 py-2 text-[12.5px] font-semibold text-danger">
          {err}
        </p>
      )}
      {saved && !dirty && (
        <p className="mb-3 rounded-md border border-success-bd bg-success-bg px-3 py-2 text-[12.5px] font-semibold text-success">
          저장했습니다. 이후 발송부터 이 본문으로 나갑니다.
        </p>
      )}
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
            {t.key === 'recommend' && (
              <p className={cn(hintCls, 'mb-1.5 mt-0')}>
                조합문자(수동발급·일괄발송·유료회원 자동발송)가 모두 이 본문으로 나갑니다. $round 는
                회차 번호, $num 은 발급 조합 리스트로 치환됩니다. 스팸 차단이
                잦으면 여기서 문구를 바꾸면 즉시 반영됩니다.
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
