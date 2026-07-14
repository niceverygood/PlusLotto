// 나의고객 — 문자 발송 센터 (CLAUDE §8 SMS 흐름). 템플릿 선택 → 대상(내 담당
// 케이스로드의 하위 뷰) 일괄 발송 + 발송 내역. 발송 시 sms_sends 생성 →
// 회원 문자내역·문자로그·발송내역에 즉시 반영(쿼리 무효화).
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageSquare, Send, Users } from 'lucide-react'
import { Button, ConfirmModal, EmptyState, PageHeader, SkeletonRows } from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { SMS_TYPE_LABEL } from '@/design-system/labels'
import { datetime, phone } from '@/lib/format'
import { renderSms } from '@/lib/sms'
import type { SmsType } from '@/types/db'
import { useMyCustomers, useMySmsLog, useSendSms, useSmsTemplates, type MembersQuery } from './api'
import { getView } from './views'

// 발송 대상 스코프(내 케이스로드의 하위 뷰 재사용).
const SMS_SCOPES = ['all', 'today-join', 'no-outcall-all', 'paid'] as const

const selectCls =
  'h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-[13px] text-gray-700 outline-none focus:border-primary-500'

export function MySmsPage() {
  usePageMeta('문자 발송', '내 담당 회원 대상 문자 발송 · 내역')
  const navigate = useNavigate()

  const [scope, setScope] = useState<(typeof SMS_SCOPES)[number]>('all')
  const [tplKey, setTplKey] = useState('')
  const [confirm, setConfirm] = useState(false)

  const { data: templates = [] } = useSmsTemplates()
  const sendSms = useSendSms()
  const { data: log = [], isLoading: logLoading } = useMySmsLog()

  // 선택 스코프의 대상 회원(미리보기·발송 대상). 페이지네이션 없이 전량.
  const recipQuery: MembersQuery = { view: scope, page: 1, pageSize: 1000 }
  const { data: recipients } = useMyCustomers(recipQuery)
  const recipRows = recipients?.rows ?? []
  const recipCount = recipients?.total ?? 0

  const activeTpl = templates.find((t) => t.key === tplKey) ?? templates[0]
  const preview = useMemo(() => {
    if (!activeTpl) return ''
    return recipRows[0] ? renderSms(activeTpl.body, recipRows[0]) : activeTpl.body
  }, [activeTpl, recipRows])

  const canSend = !!activeTpl && recipCount > 0 && !sendSms.isPending

  const doSend = () => {
    if (!activeTpl) return
    sendSms.mutate(
      { ids: recipRows.map((m) => m.id), templateKey: activeTpl.key },
      { onSuccess: () => setConfirm(false) },
    )
  }

  return (
    <div>
      <PageHeader
        title="문자 발송"
        description="내 담당 회원에게 템플릿 문자를 일괄 발송합니다."
        actions={
          <Button variant="sec" size="sm" onClick={() => navigate('/my/customers')}>
            <Users className="h-4 w-4" /> 담당 고객
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* 발송 내역 */}
        <section className="rounded-lg border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
            <h2 className="text-[14px] font-bold text-ink-800">발송 내역</h2>
            <span className="font-mono text-[12px] tnum text-gray-400">{log.length}건</span>
          </div>
          {logLoading ? (
            <div className="p-4">
              <SkeletonRows rows={6} />
            </div>
          ) : log.length === 0 ? (
            <EmptyState
              icon={<MessageSquare className="h-6 w-6" />}
              title="발송 내역이 없습니다"
              description="오른쪽에서 템플릿과 대상을 선택해 문자를 발송하세요."
            />
          ) : (
            <div className="max-h-[560px] overflow-y-auto">
              <table className="w-full text-left text-[12.5px]">
                <thead className="sticky top-0 bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2">회원</th>
                    <th className="px-2 py-2">유형</th>
                    <th className="px-2 py-2">내용</th>
                    <th className="px-4 py-2 text-right">발송일시</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((s) => (
                    <tr key={s.id} className="border-t border-gray-100 align-top">
                      <td className="whitespace-nowrap px-4 py-2 font-semibold text-ink-800">
                        {s.member_name}
                        <div className="font-mono text-[11px] font-normal text-gray-400">{phone(s.phone)}</div>
                      </td>
                      <td className="px-2 py-2">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
                          {SMS_TYPE_LABEL[s.type as SmsType] ?? s.type}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-gray-600">
                        <span className="block max-w-[320px] truncate" title={s.body}>
                          {s.body}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right font-mono text-[11.5px] tnum text-gray-500">
                        {s.sent_at ? datetime(s.sent_at) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 발송 작성 */}
        <aside className="h-fit rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-[14px] font-bold text-ink-800">새 문자 발송</h2>

          <label className="mb-1 block text-[12px] font-semibold text-gray-600">발송 대상</label>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {SMS_SCOPES.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setScope(k)}
                className={
                  'rounded-md border px-2.5 py-1 text-[12px] font-semibold transition-colors ' +
                  (scope === k
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50')
                }
              >
                {getView(k).label}
              </button>
            ))}
          </div>

          <label className="mb-1 block text-[12px] font-semibold text-gray-600">템플릿</label>
          <select
            className={selectCls + ' mb-3'}
            value={activeTpl?.key ?? ''}
            onChange={(e) => setTplKey(e.target.value)}
          >
            {templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.title}
              </option>
            ))}
          </select>

          <label className="mb-1 block text-[12px] font-semibold text-gray-600">미리보기</label>
          <div className="mb-3 min-h-[72px] whitespace-pre-wrap rounded-md border border-gray-200 bg-gray-50 p-2.5 text-[12.5px] leading-relaxed text-gray-700">
            {preview || '템플릿을 선택하세요.'}
          </div>

          <div className="mb-3 rounded-md bg-primary-50 px-3 py-2 text-[12px] text-primary-700">
            대상 <b className="font-mono tnum">{recipCount.toLocaleString('ko-KR')}</b>명에게 발송됩니다.
          </div>

          <Button
            variant="acc"
            size="md"
            className="w-full justify-center"
            disabled={!canSend}
            onClick={() => setConfirm(true)}
          >
            <Send className="h-4 w-4" /> 문자 발송
          </Button>
        </aside>
      </div>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={doSend}
        title="문자 발송"
        description={`${getView(scope).label} ${recipCount.toLocaleString('ko-KR')}명에게 '${activeTpl?.title ?? ''}' 문자를 발송합니다.`}
        confirmText="발송"
        loading={sendSms.isPending}
      />
    </div>
  )
}
