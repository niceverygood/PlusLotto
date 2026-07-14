// 고객센터 (/support, CLAUDE §8) — 1:1 문의(상태필터·답변 Drawer 대기→답변완료),
// FAQ(작성/수정/삭제), 공지(커뮤니티 게시글 읽기). FAQ 편집은 admin·manager 만.
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Pin, Plus, Pencil, Trash2 } from 'lucide-react'
import {
  Button,
  ConfirmModal,
  Drawer,
  EmptyState,
  PageHeader,
  SkeletonRows,
  Tabs,
  type TabItem,
} from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useRole } from '@/lib/auth'
import { useStaff } from '@/lib/staff'
import { dateShort, datetime } from '@/lib/format'
import type { Faq, Inquiry } from '@/types/db'
import {
  useInquiries,
  useAnswerInquiry,
  useFaqs,
  useSaveFaq,
  useDeleteFaq,
  useSupportNotices,
  type FaqInput,
} from './api'

type Tab = 'inquiries' | 'faqs' | 'notices'
type InqFilter = 'all' | 'open' | 'answered'

const CATEGORIES = ['결제', '번호', '계정', '기타'] as const

const inputCls =
  'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] text-gray-800 outline-none focus:border-primary-500'
const labelCls = 'mb-1.5 block text-[12px] font-semibold text-gray-600'
const errCls = 'mt-1 text-[11.5px] text-danger'

function InqStatusChip({ status }: { status: Inquiry['status'] }) {
  return status === 'answered' ? (
    <span className="rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">답변완료</span>
  ) : (
    <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-semibold text-warning">대기</span>
  )
}

export function SupportPage() {
  usePageMeta('고객센터', '1:1 문의 · FAQ · 공지')
  const role = useRole()
  const canEditFaq = role === 'admin' || role === 'manager'

  const [tab, setTab] = useState<Tab>('inquiries')

  const { data: inquiries = [], isLoading: iLoading } = useInquiries()
  const { data: faqs = [], isLoading: fLoading } = useFaqs()
  const { data: notices = [], isLoading: nLoading } = useSupportNotices()

  const openCount = useMemo(() => inquiries.filter((i) => i.status === 'open').length, [inquiries])

  const tabs: TabItem[] = [
    { key: 'inquiries', label: '1:1 문의', count: openCount },
    { key: 'faqs', label: 'FAQ', count: faqs.length },
    { key: 'notices', label: '공지', count: notices.length },
  ]

  return (
    <div>
      <PageHeader title="고객센터" description="고객 문의 응대 · FAQ · 공지 관리" />

      <div className="mb-3">
        <Tabs tabs={tabs} value={tab} onChange={(k) => setTab(k as Tab)} />
      </div>

      {tab === 'inquiries' && <InquiriesPanel inquiries={inquiries} loading={iLoading} />}
      {tab === 'faqs' && <FaqsPanel faqs={faqs} loading={fLoading} canEdit={canEditFaq} />}
      {tab === 'notices' && <NoticesPanel notices={notices} loading={nLoading} />}
    </div>
  )
}

// ── 1:1 문의 ──────────────────────────────────────────────────────────
function InquiriesPanel({ inquiries, loading }: { inquiries: Inquiry[]; loading: boolean }) {
  const [filter, setFilter] = useState<InqFilter>('all')
  const [selected, setSelected] = useState<Inquiry | null>(null)

  const counts = useMemo(
    () => ({
      all: inquiries.length,
      open: inquiries.filter((i) => i.status === 'open').length,
      answered: inquiries.filter((i) => i.status === 'answered').length,
    }),
    [inquiries],
  )
  const rows = filter === 'all' ? inquiries : inquiries.filter((i) => i.status === filter)

  const FILTERS: { key: InqFilter; label: string }[] = [
    { key: 'all', label: '전체' },
    { key: 'open', label: '대기' },
    { key: 'answered', label: '답변완료' },
  ]

  return (
    <>
      <div className="mb-3 flex gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={
              'rounded-md border px-3 py-1.5 text-[12.5px] font-semibold transition-colors ' +
              (filter === f.key
                ? 'border-primary-500 bg-primary-50 text-primary-700'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50')
            }
          >
            {f.label} <span className="font-mono tnum text-gray-400">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        {loading ? (
          <div className="p-4">
            <SkeletonRows rows={6} cols={5} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="문의가 없습니다" />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-gray-100 bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-20 px-3 py-2.5">유형</th>
                <th className="px-2 py-2.5">제목</th>
                <th className="w-28 px-2 py-2.5">작성자</th>
                <th className="w-24 px-2 py-2.5">상태</th>
                <th className="w-32 px-3 py-2.5 text-right">접수일</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => setSelected(i)}
                  className="cursor-pointer border-t border-gray-100 hover:bg-gray-50/60"
                >
                  <td className="px-3 py-2.5">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
                      {i.category}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 font-semibold text-ink-800">{i.title}</td>
                  <td className="px-2 py-2.5 text-[12px] text-gray-600">{i.author_name}</td>
                  <td className="px-2 py-2.5">
                    <InqStatusChip status={i.status} />
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[11.5px] tnum text-gray-500">
                    {dateShort(i.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <InquiryDrawer inquiry={selected} onClose={() => setSelected(null)} />
    </>
  )
}

function InquiryDrawer({ inquiry, onClose }: { inquiry: Inquiry | null; onClose: () => void }) {
  const answer = useAnswerInquiry()
  const { data: staff = [] } = useStaff()
  const [text, setText] = useState('')

  // inquiry 가 바뀔 때 입력 초기화.
  const key = inquiry?.id ?? null
  const [lastKey, setLastKey] = useState<string | null>(null)
  if (key !== lastKey) {
    setLastKey(key)
    setText(inquiry?.answer ?? '')
  }

  if (!inquiry) return null
  const answeredBy = inquiry.answered_by
    ? (staff.find((s) => s.id === inquiry.answered_by)?.name ?? inquiry.answered_by)
    : null

  const submit = () => {
    if (!text.trim()) return
    answer.mutate({ id: inquiry.id, answer: text.trim() }, { onSuccess: onClose })
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="문의 상세"
      width={600}
      footer={
        <>
          <Button variant="sec" size="sm" onClick={onClose} disabled={answer.isPending}>
            닫기
          </Button>
          <Button variant="pri" size="sm" onClick={submit} disabled={answer.isPending || !text.trim()}>
            {inquiry.status === 'answered' ? '답변 수정' : '답변 등록'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
            {inquiry.category}
          </span>
          <InqStatusChip status={inquiry.status} />
        </div>
        <div>
          <h3 className="text-[16px] font-bold text-ink-900">{inquiry.title}</h3>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {inquiry.author_name} · {datetime(inquiry.created_at)}
          </p>
        </div>
        <div className="whitespace-pre-wrap rounded-md border border-gray-200 bg-gray-50 p-3 text-[13px] leading-relaxed text-gray-700">
          {inquiry.body}
        </div>

        <div>
          <label className={labelCls}>
            답변
            {answeredBy && (
              <span className="ml-2 font-normal text-gray-400">
                {answeredBy} · {inquiry.answered_at ? datetime(inquiry.answered_at) : ''}
              </span>
            )}
          </label>
          <textarea
            className={inputCls + ' h-44 resize-none py-2 leading-relaxed'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="고객에게 전달할 답변을 입력하세요."
          />
        </div>
      </div>
    </Drawer>
  )
}

// ── FAQ ───────────────────────────────────────────────────────────────
function FaqsPanel({ faqs, loading, canEdit }: { faqs: Faq[]; loading: boolean; canEdit: boolean }) {
  const [edit, setEdit] = useState<Faq | 'new' | null>(null)
  const [del, setDel] = useState<Faq | null>(null)
  const deleteFaq = useDeleteFaq()

  return (
    <>
      {canEdit && (
        <div className="mb-3 flex justify-end">
          <Button variant="pri" size="sm" onClick={() => setEdit('new')}>
            <Plus className="h-4 w-4" /> 새 FAQ
          </Button>
        </div>
      )}
      <div className="rounded-lg border border-gray-200 bg-white">
        {loading ? (
          <div className="p-4">
            <SkeletonRows rows={6} cols={4} />
          </div>
        ) : faqs.length === 0 ? (
          <EmptyState title="FAQ가 없습니다" />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-gray-100 bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-16 px-3 py-2.5 text-right">순서</th>
                <th className="w-20 px-2 py-2.5">유형</th>
                <th className="px-2 py-2.5">질문</th>
                <th className="w-20 px-2 py-2.5">상태</th>
                {canEdit && <th className="w-24 px-3 py-2.5 text-right">관리</th>}
              </tr>
            </thead>
            <tbody>
              {faqs.map((f) => (
                <tr key={f.id} className="border-t border-gray-100 align-top hover:bg-gray-50/60">
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tnum text-gray-400">
                    {f.sort_order}
                  </td>
                  <td className="px-2 py-2.5">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
                      {f.category}
                    </span>
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="font-semibold text-ink-800">{f.question}</div>
                    <div className="mt-0.5 max-w-[520px] truncate text-[12px] text-gray-500">{f.answer}</div>
                  </td>
                  <td className="px-2 py-2.5">
                    {f.published ? (
                      <span className="rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">게시중</span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">숨김</span>
                    )}
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEdit(f)}
                          className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-primary-600"
                          title="수정"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDel(f)}
                          className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-danger-bg hover:text-danger"
                          title="삭제"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {edit && <FaqEditor faq={edit === 'new' ? null : edit} nextOrder={faqs.length} onClose={() => setEdit(null)} />}

      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        onConfirm={() => del && deleteFaq.mutate(del.id, { onSuccess: () => setDel(null) })}
        title="FAQ 삭제"
        description={`'${del?.question ?? ''}'을(를) 삭제합니다.`}
        confirmText="삭제"
        tone="danger"
        loading={deleteFaq.isPending}
      />
    </>
  )
}

const faqSchema = z.object({
  category: z.string().min(1),
  question: z.string().min(1, '질문을 입력하세요.'),
  answer: z.string().min(1, '답변을 입력하세요.'),
  sort_order: z.coerce.number().int().min(0),
  published: z.boolean(),
})

function FaqEditor({ faq, nextOrder, onClose }: { faq: Faq | null; nextOrder: number; onClose: () => void }) {
  const save = useSaveFaq()
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FaqInput>({
    resolver: zodResolver(faqSchema),
    defaultValues: {
      category: faq?.category ?? CATEGORIES[0],
      question: faq?.question ?? '',
      answer: faq?.answer ?? '',
      sort_order: faq?.sort_order ?? nextOrder,
      published: faq?.published ?? true,
    },
  })

  const submit = handleSubmit((input) => save.mutate({ id: faq?.id, input }, { onSuccess: onClose }))

  return (
    <Drawer
      open
      onClose={onClose}
      title={faq ? 'FAQ 수정' : '새 FAQ 작성'}
      footer={
        <>
          <Button variant="sec" size="sm" onClick={onClose} disabled={save.isPending}>
            취소
          </Button>
          <Button variant="pri" size="sm" onClick={submit} disabled={save.isPending}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_100px] gap-3">
          <div>
            <label className={labelCls}>유형</label>
            <select className={inputCls} {...register('category')}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>순서</label>
            <input type="number" className={inputCls} {...register('sort_order')} />
          </div>
        </div>
        <div>
          <label className={labelCls}>질문</label>
          <input className={inputCls} {...register('question')} />
          {errors.question && <p className={errCls}>{errors.question.message}</p>}
        </div>
        <div>
          <label className={labelCls}>답변</label>
          <textarea className={inputCls + ' h-40 resize-none py-2 leading-relaxed'} {...register('answer')} />
          {errors.answer && <p className={errCls}>{errors.answer.message}</p>}
        </div>
        <label className="flex items-center gap-2 pt-1 text-[13px] text-gray-700">
          <input type="checkbox" {...register('published')} /> 게시(체크 해제 시 숨김)
        </label>
      </div>
    </Drawer>
  )
}

// ── 공지(읽기 전용) ────────────────────────────────────────────────────
function NoticesPanel({
  notices,
  loading,
}: {
  notices: import('@/types/db').Notice[]
  loading: boolean
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <SkeletonRows rows={5} cols={2} />
      </div>
    )
  }
  if (notices.length === 0) return <EmptyState title="게시된 공지가 없습니다" />

  return (
    <div className="space-y-2">
      {notices.map((n) => {
        const open = openId === n.id
        return (
          <div key={n.id} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <button
              type="button"
              onClick={() => setOpenId(open ? null : n.id)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-gray-50/60"
            >
              {n.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-accent-600" />}
              <span className="flex-1 font-semibold text-ink-800">{n.title}</span>
              <span className="font-mono text-[11.5px] tnum text-gray-400">{dateShort(n.created_at)}</span>
            </button>
            {open && (
              <div className="whitespace-pre-wrap border-t border-gray-100 px-4 py-3 text-[13px] leading-relaxed text-gray-700">
                {n.body}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
