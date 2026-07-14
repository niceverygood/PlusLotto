// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 고객센터 (/portal/support) · Phase 2
// ─────────────────────────────────────────────────────────────────────────
// 한 페이지 안에서 3개 섹션을 탭으로 구분한다.
//   ① 공지사항  — useNotices() 목록(고정 우선→최신순), 펼침형 본문
//   ② 자주 묻는 질문 — useFaqs() 아코디언(sort_order asc)
//   ③ 1:1 문의   — useSubmitInquiry() (이름·연락처·제목·내용)
// 공유 파일은 수정하지 않는다. 필요한 로컬 상태/헬퍼만 이 파일에 둔다.
// 데이터 훅은 RLS(anon) 차단 시 빈 배열/graceful 에러로 폴백하므로,
//   로딩/빈/에러 상태를 모두 화면에서 안내한다.
// 이 페이지는 SiteLayout 의 <Outlet/> 안에서 렌더되므로 '본문 콘텐츠'만 반환한다.
// ─────────────────────────────────────────────────────────────────────────
import { useMemo, useState, type FormEvent } from 'react'
import {
  ChevronDown,
  HelpCircle,
  Megaphone,
  MessageSquarePlus,
  Phone,
  Pin,
} from 'lucide-react'
import { Button, EmptyState, Skeleton } from '@/design-system/components'
import { datetime } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { Faq, Notice } from '@/types/db'
import { useFaqs, useNotices, useSubmitInquiry, type InquiryInput } from './api'

// ── 탭 정의 ────────────────────────────────────────────────────────────────
type SupportTab = 'notices' | 'faqs' | 'inquiry'

interface TabDef {
  key: SupportTab
  label: string
  icon: typeof Megaphone
}

const TABS: TabDef[] = [
  { key: 'notices', label: '공지사항', icon: Megaphone },
  { key: 'faqs', label: '자주 묻는 질문', icon: HelpCircle },
  { key: 'inquiry', label: '1:1 문의', icon: MessageSquarePlus },
]

// 문의 유형(선택). api.ts 의 InquiryInput.category 로 전달.
const INQUIRY_CATEGORIES = ['결제/입금', '추천번호', '계정/등급', '기타'] as const

// ── 페이지 ──────────────────────────────────────────────────────────────────
export function SupportPage() {
  const [tab, setTab] = useState<SupportTab>('notices')

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-10 sm:px-6 sm:py-12">
      {/* 헤더 */}
      <header className="mb-7">
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-ink-900 sm:text-[30px]">
          고객센터
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-gray-500">
          공지사항과 자주 묻는 질문을 확인하시고, 궁금한 점은 1:1 문의로 남겨주세요.
        </p>
      </header>

      {/* 고객센터 전화 안내 배너 */}
      <div className="mb-7 flex flex-col gap-3 rounded-lg border border-primary-100 bg-primary-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-100 text-primary-700">
            <Phone className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[14px] font-bold text-ink-900">전화 상담</p>
            <p className="text-[13px] text-gray-600">
              {/* TODO(live-verify): 실제 고객센터 번호/운영시간으로 교체 */}
              평일 09:00 ~ 18:00 (주말·공휴일 휴무)
            </p>
          </div>
        </div>
        <span className="font-mono text-[20px] font-extrabold tabular-nums tracking-tight text-primary-700">
          1588-0000
        </span>
      </div>

      {/* 탭 */}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-gray-200">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-2.5 text-[14px] font-semibold transition-colors',
                active
                  ? 'border-primary-600 text-primary-700'
                  : 'border-transparent text-gray-500 hover:text-ink-900',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* 탭 콘텐츠 */}
      {tab === 'notices' && <NoticesSection />}
      {tab === 'faqs' && <FaqsSection />}
      {tab === 'inquiry' && <InquirySection />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ① 공지사항
// ─────────────────────────────────────────────────────────────────────────
function NoticesSection() {
  const { data, isLoading, isError } = useNotices()
  const notices = data ?? []

  if (isLoading) return <ListSkeleton rows={4} />
  if (isError) {
    return (
      <EmptyState
        title="공지사항을 불러오지 못했습니다"
        description="잠시 후 다시 시도해주세요."
      />
    )
  }
  if (notices.length === 0) {
    return (
      <EmptyState
        icon={<Megaphone className="h-6 w-6" />}
        title="등록된 공지사항이 없습니다"
        description="새로운 소식이 등록되면 이곳에서 안내해드립니다."
      />
    )
  }

  return (
    <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white">
      {notices.map((n) => (
        <NoticeRow key={n.id} notice={n} />
      ))}
    </div>
  )
}

function NoticeRow({ notice }: { notice: Notice }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-gray-50"
      >
        {notice.pinned && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-bold text-accent-600">
            <Pin className="h-3 w-3" />
            고정
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-ink-900">
          {notice.title}
        </span>
        <span className="hidden shrink-0 font-mono text-[12px] tabular-nums text-gray-400 sm:inline">
          {datetime(notice.created_at)}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-gray-400 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-5 py-4">
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-gray-700">
            {notice.body}
          </p>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ② 자주 묻는 질문 (FAQ 아코디언, 카테고리 묶음)
// ─────────────────────────────────────────────────────────────────────────
function FaqsSection() {
  const { data, isLoading, isError } = useFaqs()
  const faqs = data ?? []

  // 카테고리별 그룹(원래 sort_order asc 순서를 유지).
  const grouped = useMemo(() => {
    const map = new Map<string, Faq[]>()
    for (const f of faqs) {
      const key = f.category?.trim() || '일반'
      const arr = map.get(key)
      if (arr) arr.push(f)
      else map.set(key, [f])
    }
    return [...map.entries()]
  }, [faqs])

  if (isLoading) return <ListSkeleton rows={5} />
  if (isError) {
    return (
      <EmptyState
        title="FAQ를 불러오지 못했습니다"
        description="잠시 후 다시 시도해주세요."
      />
    )
  }
  if (faqs.length === 0) {
    return (
      <EmptyState
        icon={<HelpCircle className="h-6 w-6" />}
        title="등록된 질문이 없습니다"
        description="자주 묻는 질문이 등록되면 이곳에서 확인하실 수 있습니다."
      />
    )
  }

  return (
    <div className="flex flex-col gap-7">
      {grouped.map(([category, items]) => (
        <section key={category}>
          <h2 className="mb-2.5 text-[13px] font-bold uppercase tracking-wide text-primary-700">
            {category}
          </h2>
          <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white">
            {items.map((f) => (
              <FaqRow key={f.id} faq={f} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function FaqRow({ faq }: { faq: Faq }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-gray-50"
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary-50 font-mono text-[13px] font-extrabold text-primary-700">
          Q
        </span>
        <span className="min-w-0 flex-1 text-[14.5px] font-semibold text-ink-900">
          {faq.question}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-gray-400 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div className="flex gap-3 border-t border-gray-100 bg-gray-50 px-5 py-4">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-50 font-mono text-[13px] font-extrabold text-accent-600">
            A
          </span>
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-gray-700">
            {faq.answer}
          </p>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ③ 1:1 문의 폼
// ─────────────────────────────────────────────────────────────────────────
function InquirySection() {
  const submit = useSubmitInquiry()
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [category, setCategory] = useState<string>(INQUIRY_CATEGORIES[0])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(null)

  const submitting = submit.isPending

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFeedback(null)

    const input: InquiryInput = {
      name: name.trim(),
      phone: contact.trim() || undefined,
      category,
      title: title.trim(),
      body: body.trim(),
    }
    // 클라이언트 1차 검증(서버 훅도 동일 검증을 한 번 더 한다).
    if (!input.name) return setFeedback({ tone: 'err', msg: '이름을 입력해주세요.' })
    if (!input.title) return setFeedback({ tone: 'err', msg: '제목을 입력해주세요.' })
    if (!input.body) return setFeedback({ tone: 'err', msg: '문의 내용을 입력해주세요.' })

    const res = await submit.mutateAsync(input)
    if (res.ok) {
      setFeedback({
        tone: 'ok',
        msg: '문의가 정상적으로 접수되었습니다. 빠른 시일 내에 답변드리겠습니다.',
      })
      setName('')
      setContact('')
      setTitle('')
      setBody('')
      setCategory(INQUIRY_CATEGORIES[0])
    } else {
      setFeedback({ tone: 'err', msg: res.error ?? '문의 접수에 실패했습니다.' })
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr,300px]">
      {/* 폼 */}
      <form
        onSubmit={handleSubmit}
        className="rounded-lg border border-gray-200 bg-white p-5 sm:p-6"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="이름" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="홍길동"
              autoComplete="name"
              className={inputCls}
            />
          </Field>
          <Field label="연락처">
            <input
              type="tel"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="010-0000-0000"
              autoComplete="tel"
              inputMode="tel"
              className={cn(inputCls, 'font-mono tabular-nums')}
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="문의 유형">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={inputCls}
            >
              {INQUIRY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-4">
          <Field label="제목" required>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="문의 제목을 입력해주세요"
              className={inputCls}
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="문의 내용" required>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="문의하실 내용을 자세히 적어주세요."
              rows={6}
              className={cn(inputCls, 'min-h-[140px] resize-y leading-relaxed')}
            />
          </Field>
        </div>

        {feedback && (
          <p
            role="status"
            className={cn(
              'mt-4 rounded-md px-3.5 py-2.5 text-[13px] font-semibold',
              feedback.tone === 'ok'
                ? 'bg-success-bg text-success'
                : 'bg-danger-bg text-danger',
            )}
          >
            {feedback.msg}
          </p>
        )}

        <div className="mt-5 flex justify-end">
          <Button
            type="submit"
            variant="pri"
            disabled={submitting}
            icon={<MessageSquarePlus className="h-4 w-4" />}
          >
            {submitting ? '접수 중…' : '문의 접수'}
          </Button>
        </div>
      </form>

      {/* 안내 사이드 */}
      <aside className="rounded-lg border border-gray-200 bg-gray-50 p-5">
        <h3 className="mb-2 text-[14px] font-bold text-ink-900">문의 전 확인해주세요</h3>
        <ul className="flex flex-col gap-2 text-[13px] leading-relaxed text-gray-600">
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary-500" />
            등급·종료일·발급번호는 <b className="font-semibold text-ink-900">마이페이지</b>에서
            바로 확인하실 수 있습니다.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary-500" />
            자주 묻는 질문(FAQ)에 비슷한 답변이 있을 수 있습니다.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary-500" />
            급한 문의는 고객센터 전화로 연락 주시면 더 빠르게 도와드립니다.
          </li>
        </ul>
        <p className="mt-4 border-t border-gray-200 pt-3 text-[12px] leading-relaxed text-gray-400">
          접수된 문의는 운영시간 내 순차적으로 답변드립니다.
        </p>
      </aside>
    </div>
  )
}

// ── 폼 필드 래퍼 ─────────────────────────────────────────────────────────────
function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-semibold text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
    </label>
  )
}

const inputCls =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-[14px] text-ink-900 ' +
  'placeholder:text-gray-400 transition-colors focus:border-primary-500 focus:outline-none ' +
  'focus:ring-2 focus:ring-primary-100'

// ── 로딩 스켈레톤 ─────────────────────────────────────────────────────────────
function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-gray-100 px-5 py-4 last:border-b-0"
        >
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-3 w-24 sm:block" />
        </div>
      ))}
    </div>
  )
}
