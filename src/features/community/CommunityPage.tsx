// 커뮤니티 (/community, CLAUDE §8) — 공지사항·이벤트 게시 관리.
// 목록(고정·게시상태·조회수) + 작성/수정 Drawer(react-hook-form+zod) + 삭제(확인).
// 작성/수정/삭제는 admin·manager 만. 모든 변경은 admin 로그를 남긴다(§8).
import { useState } from 'react'
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
import { dateShort } from '@/lib/format'
import type { CampaignEvent, Notice } from '@/types/db'
import {
  useNotices,
  useEvents,
  useSaveNotice,
  useDeleteNotice,
  useSaveEvent,
  useDeleteEvent,
  type NoticeInput,
  type EventInput,
} from './api'

type Tab = 'notices' | 'events'

const inputCls =
  'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] text-gray-800 outline-none focus:border-primary-500'
const labelCls = 'mb-1.5 block text-[12px] font-semibold text-gray-600'
const errCls = 'mt-1 text-[11.5px] text-danger'

function PublishChip({ published }: { published: boolean }) {
  return published ? (
    <span className="rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">게시중</span>
  ) : (
    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">임시저장</span>
  )
}

export function CommunityPage() {
  usePageMeta('커뮤니티', '공지사항 · 이벤트')
  const role = useRole()
  const canWrite = role === 'admin' || role === 'manager'

  const [tab, setTab] = useState<Tab>('notices')
  const { data: staff = [] } = useStaff()
  const authorName = (id: string | null) => (id ? (staff.find((s) => s.id === id)?.name ?? id) : '-')

  const { data: notices = [], isLoading: nLoading } = useNotices()
  const { data: events = [], isLoading: eLoading } = useEvents()

  const [editNotice, setEditNotice] = useState<Notice | 'new' | null>(null)
  const [editEvent, setEditEvent] = useState<CampaignEvent | 'new' | null>(null)
  const [del, setDel] = useState<{ kind: Tab; id: string; title: string } | null>(null)

  const deleteNotice = useDeleteNotice()
  const deleteEvent = useDeleteEvent()

  const tabs: TabItem[] = [
    { key: 'notices', label: '공지사항', count: notices.length },
    { key: 'events', label: '이벤트', count: events.length },
  ]

  const onDelete = () => {
    if (!del) return
    const m = del.kind === 'notices' ? deleteNotice : deleteEvent
    m.mutate(del.id, { onSuccess: () => setDel(null) })
  }

  return (
    <div>
      <PageHeader
        title="커뮤니티"
        description="공지사항·이벤트를 게시하고 관리합니다."
        actions={
          canWrite ? (
            <Button
              variant="pri"
              size="sm"
              onClick={() => (tab === 'notices' ? setEditNotice('new') : setEditEvent('new'))}
            >
              <Plus className="h-4 w-4" /> {tab === 'notices' ? '새 공지' : '새 이벤트'}
            </Button>
          ) : undefined
        }
      />

      <div className="mb-3">
        <Tabs tabs={tabs} value={tab} onChange={(k) => setTab(k as Tab)} />
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        {tab === 'notices' ? (
          nLoading ? (
            <div className="p-4">
              <SkeletonRows rows={6} cols={5} />
            </div>
          ) : notices.length === 0 ? (
            <EmptyState title="공지사항이 없습니다" />
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-gray-100 bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="w-10 px-3 py-2.5" />
                  <th className="px-2 py-2.5">제목</th>
                  <th className="w-24 px-2 py-2.5">상태</th>
                  <th className="w-20 px-2 py-2.5 text-right">조회</th>
                  <th className="w-28 px-2 py-2.5">작성자</th>
                  <th className="w-32 px-2 py-2.5 text-right">작성일</th>
                  {canWrite && <th className="w-24 px-3 py-2.5 text-right">관리</th>}
                </tr>
              </thead>
              <tbody>
                {notices.map((n) => (
                  <tr key={n.id} className="border-t border-gray-100 hover:bg-gray-50/60">
                    <td className="px-3 py-2.5 text-center">
                      {n.pinned && <Pin className="inline h-3.5 w-3.5 text-accent-600" />}
                    </td>
                    <td className="px-2 py-2.5">
                      <span className="font-semibold text-ink-800">{n.title}</span>
                    </td>
                    <td className="px-2 py-2.5">
                      <PublishChip published={n.published} />
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-[12px] tnum text-gray-500">
                      {n.view_count.toLocaleString('ko-KR')}
                    </td>
                    <td className="px-2 py-2.5 text-[12px] text-gray-600">{authorName(n.author_id)}</td>
                    <td className="px-2 py-2.5 text-right font-mono text-[11.5px] tnum text-gray-500">
                      {dateShort(n.created_at)}
                    </td>
                    {canWrite && (
                      <td className="px-3 py-2.5 text-right">
                        <RowActions
                          onEdit={() => setEditNotice(n)}
                          onDelete={() => setDel({ kind: 'notices', id: n.id, title: n.title })}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : eLoading ? (
          <div className="p-4">
            <SkeletonRows rows={6} cols={5} />
          </div>
        ) : events.length === 0 ? (
          <EmptyState title="이벤트가 없습니다" />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-gray-100 bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2.5">제목</th>
                <th className="w-48 px-2 py-2.5">기간</th>
                <th className="w-24 px-2 py-2.5">상태</th>
                <th className="w-20 px-2 py-2.5 text-right">조회</th>
                <th className="w-28 px-2 py-2.5">작성자</th>
                {canWrite && <th className="w-24 px-3 py-2.5 text-right">관리</th>}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-gray-100 hover:bg-gray-50/60">
                  <td className="px-3 py-2.5">
                    <span className="font-semibold text-ink-800">{e.title}</span>
                  </td>
                  <td className="px-2 py-2.5 font-mono text-[11.5px] tnum text-gray-600">
                    {e.starts_at ? dateShort(e.starts_at) : '—'} ~ {e.ends_at ? dateShort(e.ends_at) : '—'}
                  </td>
                  <td className="px-2 py-2.5">
                    <PublishChip published={e.published} />
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono text-[12px] tnum text-gray-500">
                    {e.view_count.toLocaleString('ko-KR')}
                  </td>
                  <td className="px-2 py-2.5 text-[12px] text-gray-600">{authorName(e.author_id)}</td>
                  {canWrite && (
                    <td className="px-3 py-2.5 text-right">
                      <RowActions
                        onEdit={() => setEditEvent(e)}
                        onDelete={() => setDel({ kind: 'events', id: e.id, title: e.title })}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editNotice && (
        <NoticeEditor notice={editNotice === 'new' ? null : editNotice} onClose={() => setEditNotice(null)} />
      )}
      {editEvent && (
        <EventEditor event={editEvent === 'new' ? null : editEvent} onClose={() => setEditEvent(null)} />
      )}

      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        onConfirm={onDelete}
        title={del?.kind === 'notices' ? '공지 삭제' : '이벤트 삭제'}
        description={`'${del?.title ?? ''}'을(를) 삭제합니다. 되돌릴 수 없습니다.`}
        confirmText="삭제"
        tone="danger"
        loading={deleteNotice.isPending || deleteEvent.isPending}
      />
    </div>
  )
}

function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex justify-end gap-1">
      <button
        type="button"
        onClick={onEdit}
        className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-primary-600"
        title="수정"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-danger-bg hover:text-danger"
        title="삭제"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ── 공지 작성/수정 ────────────────────────────────────────────────────
const noticeSchema = z.object({
  title: z.string().min(1, '제목을 입력하세요.'),
  body: z.string().min(1, '내용을 입력하세요.'),
  pinned: z.boolean(),
  published: z.boolean(),
})

function NoticeEditor({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  const save = useSaveNotice()
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<NoticeInput>({
    resolver: zodResolver(noticeSchema),
    defaultValues: {
      title: notice?.title ?? '',
      body: notice?.body ?? '',
      pinned: notice?.pinned ?? false,
      published: notice?.published ?? true,
    },
  })

  const submit = handleSubmit((input) =>
    save.mutate({ id: notice?.id, input }, { onSuccess: onClose }),
  )

  return (
    <Drawer
      open
      onClose={onClose}
      title={notice ? '공지 수정' : '새 공지 작성'}
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
        <div>
          <label className={labelCls}>제목</label>
          <input className={inputCls} {...register('title')} />
          {errors.title && <p className={errCls}>{errors.title.message}</p>}
        </div>
        <div>
          <label className={labelCls}>내용</label>
          <textarea
            className={inputCls + ' h-44 resize-none py-2 leading-relaxed'}
            {...register('body')}
          />
          {errors.body && <p className={errCls}>{errors.body.message}</p>}
        </div>
        <div className="flex gap-5 pt-1">
          <label className="flex items-center gap-2 text-[13px] text-gray-700">
            <input type="checkbox" {...register('pinned')} /> 상단 고정
          </label>
          <label className="flex items-center gap-2 text-[13px] text-gray-700">
            <input type="checkbox" {...register('published')} /> 게시(체크 해제 시 임시저장)
          </label>
        </div>
      </div>
    </Drawer>
  )
}

// ── 이벤트 작성/수정 ──────────────────────────────────────────────────
const eventSchema = z.object({
  title: z.string().min(1, '제목을 입력하세요.'),
  body: z.string().min(1, '내용을 입력하세요.'),
  starts_at: z.string(),
  ends_at: z.string(),
  published: z.boolean(),
})
type EventForm = z.infer<typeof eventSchema>

const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '')
const fromDateInput = (s: string) => (s ? new Date(`${s}T00:00:00`).toISOString() : null)

function EventEditor({ event, onClose }: { event: CampaignEvent | null; onClose: () => void }) {
  const save = useSaveEvent()
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EventForm>({
    resolver: zodResolver(eventSchema),
    defaultValues: {
      title: event?.title ?? '',
      body: event?.body ?? '',
      starts_at: toDateInput(event?.starts_at ?? null),
      ends_at: toDateInput(event?.ends_at ?? null),
      published: event?.published ?? true,
    },
  })

  const submit = handleSubmit((v) => {
    const input: EventInput = {
      title: v.title,
      body: v.body,
      starts_at: fromDateInput(v.starts_at),
      ends_at: fromDateInput(v.ends_at),
      published: v.published,
    }
    save.mutate({ id: event?.id, input }, { onSuccess: onClose })
  })

  return (
    <Drawer
      open
      onClose={onClose}
      title={event ? '이벤트 수정' : '새 이벤트 작성'}
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
        <div>
          <label className={labelCls}>제목</label>
          <input className={inputCls} {...register('title')} />
          {errors.title && <p className={errCls}>{errors.title.message}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>시작일</label>
            <input type="date" className={inputCls} {...register('starts_at')} />
          </div>
          <div>
            <label className={labelCls}>종료일</label>
            <input type="date" className={inputCls} {...register('ends_at')} />
          </div>
        </div>
        <div>
          <label className={labelCls}>내용</label>
          <textarea
            className={inputCls + ' h-40 resize-none py-2 leading-relaxed'}
            {...register('body')}
          />
          {errors.body && <p className={errCls}>{errors.body.message}</p>}
        </div>
        <label className="flex items-center gap-2 pt-1 text-[13px] text-gray-700">
          <input type="checkbox" {...register('published')} /> 게시(체크 해제 시 임시저장)
        </label>
      </div>
    </Drawer>
  )
}
