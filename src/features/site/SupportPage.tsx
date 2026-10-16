// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 고객센터 (/support) · Phase 2
// ─────────────────────────────────────────────────────────────────────────
// 한 페이지 안에서 3개 섹션을 탭으로 구분한다.
//   ① 공지사항  — useNotices() 목록(고정 우선→최신순), 펼침형 본문
//   ② 자주 묻는 질문 — useFaqs() 아코디언(sort_order asc)
//   ③ 1:1 문의   — useSubmitInquiry() (이름·연락처·비밀번호·제목·내용) + 비밀글 목록·내 문의 확인(현장 10/16)
// 공유 파일은 수정하지 않는다. 필요한 로컬 상태/헬퍼만 이 파일에 둔다.
// 데이터 훅은 RLS(anon) 차단 시 빈 배열/graceful 에러로 폴백하므로,
//   로딩/빈/에러 상태를 모두 화면에서 안내한다.
// 이 페이지는 SiteLayout 의 <Outlet/> 안에서 렌더되므로 '본문 콘텐츠'만 반환한다.
// ─────────────────────────────────────────────────────────────────────────
import { useMemo, useState, type FormEvent } from 'react'
import {
  ChevronDown,
  HelpCircle,
  Lock,
  Megaphone,
  MessageSquarePlus,
  Phone,
  Pin,
  Search,
} from 'lucide-react'
import { Button, EmptyState, Skeleton } from '@/design-system/components'
import { date, datetime } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { Faq, Notice } from '@/types/db'
import { CUSTOMER_SITE } from '@/lib/customerSiteContext'
import {
  useFaqs, useInquiryBoard, useMyInquiries, useNotices, usePublicSiteInfo, useSubmitInquiry,
  type InquiryInput, type MyInquiry,
} from './api'

// 전산(설정 > 사이트 설정 > 사업자 정보)에 값이 없을 때만 쓰는 안내용 기본값(현장 피드백: 1660-0681).
const FALLBACK_SUPPORT_PHONE = '1660-0681'

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
  const { data: publicInfo } = usePublicSiteInfo()
  const supportPhone = publicInfo?.business?.support_phone || CUSTOMER_SITE?.business.support_phone || FALLBACK_SUPPORT_PHONE

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
              {CUSTOMER_SITE ? `${CUSTOMER_SITE.name} 고객센터` : '평일 09:00 ~ 18:00 (주말·공휴일 휴무)'}
            </p>
          </div>
        </div>
        <span className="font-mono text-[20px] font-extrabold tabular-nums tracking-tight text-primary-700">
          {supportPhone}
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
  const [password, setPassword] = useState('')
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
      phone: contact.trim(),
      password: password.trim(),
      category,
      title: title.trim(),
      body: body.trim(),
    }
    // 클라이언트 1차 검증(서버 훅도 동일 검증을 한 번 더 한다).
    if (!input.name) return setFeedback({ tone: 'err', msg: '이름을 입력해주세요.' })
    if (input.phone.replace(/\D/g, '').length < 9) return setFeedback({ tone: 'err', msg: '연락처를 정확히 입력해주세요.' })
    if (input.password.length < 4) return setFeedback({ tone: 'err', msg: '비밀번호를 4자 이상 입력해주세요.' })
    if (!input.title) return setFeedback({ tone: 'err', msg: '제목을 입력해주세요.' })
    if (!input.body) return setFeedback({ tone: 'err', msg: '문의 내용을 입력해주세요.' })

    const res = await submit.mutateAsync(input)
    if (res.ok) {
      setFeedback({
        tone: 'ok',
        msg: '문의가 비밀글로 접수되었습니다. 답변은 아래 [내 문의 확인]에서 연락처와 비밀번호로 보실 수 있습니다.',
      })
      setName('')
      setContact('')
      setPassword('')
      setTitle('')
      setBody('')
      setCategory(INQUIRY_CATEGORIES[0])
    } else {
      setFeedback({ tone: 'err', msg: res.error ?? '문의 접수에 실패했습니다.' })
    }
  }

  return (
    <div className="flex flex-col gap-6">
    <div className="grid gap-6 lg:grid-cols-[1fr,300px]">
      {/* 폼 */}
      <form
        onSubmit={handleSubmit}
        className="rounded-lg border border-gray-200 bg-white p-5 sm:p-6"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-3">
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
          <Field label="연락처" required>
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
          <Field label="비밀번호" required>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="4자 이상"
              autoComplete="new-password"
              maxLength={20}
              className={inputCls}
            />
          </Field>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-gray-500">
          <Lock className="h-3.5 w-3.5" /> 문의글은 비밀글로 접수되어 작성자 본인만 연락처와 비밀번호로 볼 수 있습니다.
        </p>

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
              maxLength={200}
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
              maxLength={4500}
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
      <div className="grid gap-6 lg:grid-cols-2">
        <InquiryBoard />
        <MyInquiriesLookup />
      </div>
    </div>
  )
}

// 문의 목록 — 다른 사람 글은 제목·내용 없이 '비밀글'로만 보인다(현장 10/16 "작성자외에는 볼 수 없도록").
function InquiryBoard() {
  const { data: rows = [], isLoading, isError } = useInquiryBoard()
  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <h3 className="border-b border-gray-100 px-5 py-3 text-[14px] font-bold text-ink-900">문의 게시판</h3>
      {isLoading ? (
        <p className="px-5 py-6 text-[13px] text-gray-400">불러오는 중…</p>
      ) : isError ? (
        <p role="alert" className="px-5 py-6 text-[13px] text-gray-500">문의 목록을 불러오지 못했습니다.</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-gray-500">등록된 문의가 없습니다.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
              <Lock className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              <span className="min-w-0 flex-1 truncate text-gray-500">비밀글입니다</span>
              <span className="shrink-0 text-gray-500">{r.author}</span>
              <span className="shrink-0 font-mono tabular-nums text-gray-400">{date(r.created_at)}</span>
              <StatusPill answered={r.status === 'answered'} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// 내 문의 확인 — 접수 때 쓴 연락처 + 비밀번호가 맞는 글만 제목·내용·답변을 보여 준다.
function MyInquiriesLookup() {
  const lookup = useMyInquiries()
  const [phone, setPhone] = useState('')
  const [pw, setPw] = useState('')
  const [items, setItems] = useState<MyInquiry[] | null>(null)

  async function handleLookup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setItems(null)
    try {
      setItems(await lookup.mutateAsync({ phone, password: pw }))
    } catch {
      /* 오류 문구는 lookup.error 로 표시 */
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <h3 className="border-b border-gray-100 px-5 py-3 text-[14px] font-bold text-ink-900">내 문의 확인</h3>
      <form onSubmit={handleLookup} className="flex flex-wrap items-end gap-2 px-5 py-4" noValidate>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="연락처"
          inputMode="tel"
          className={cn(inputCls, 'w-auto flex-1 font-mono tabular-nums')}
        />
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="비밀번호"
          maxLength={20}
          className={cn(inputCls, 'w-auto flex-1')}
        />
        <Button type="submit" variant="sec" disabled={lookup.isPending} icon={<Search className="h-4 w-4" />}>
          {lookup.isPending ? '확인 중…' : '확인'}
        </Button>
      </form>
      {lookup.error && <p role="alert" className="px-5 pb-4 text-[13px] text-danger">{lookup.error.message}</p>}
      {items && items.length === 0 && (
        <p className="px-5 pb-4 text-[13px] text-gray-500">연락처와 비밀번호가 맞는 문의가 없습니다.</p>
      )}
      {items && items.length > 0 && (
        <ul className="divide-y divide-gray-100 border-t border-gray-100">
          {items.map((q) => (
            <li key={q.id} className="px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-ink-900">{q.title}</span>
                <StatusPill answered={q.status === 'answered'} />
              </div>
              <p className="mt-0.5 text-[12px] text-gray-400">
                {q.category} · <span className="font-mono tabular-nums">{datetime(q.created_at)}</span>
              </p>
              <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-gray-700">{q.body}</p>
              {q.answer && (
                <div className="mt-2 rounded-md bg-primary-50 px-3 py-2">
                  <p className="text-[12px] font-bold text-primary-700">답변</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-gray-700">{q.answer}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function StatusPill({ answered }: { answered: boolean }) {
  return (
    <span className={cn(
      'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
      answered ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning',
    )}>
      {answered ? '답변완료' : '답변대기'}
    </span>
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
