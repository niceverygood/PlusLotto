// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 회원가입(가입 신청) 페이지 (/signup)
// ─────────────────────────────────────────────────────────────────────────
// signupApproach = "가입문의(inquiry) 폼".
//   고객 사이트는 anon 키 → members 셀프 INSERT 불가(RLS+트리거). 그래서 셀프 가입이 아니라
//   '가입 신청'을 inquiries 로 접수하고, 운영자(담당자)가 확인 후 연락/가입 처리하는 흐름이다.
//   → useMemberAuth().signup(input) 이 그 폴백을 캡슐화한다.
//     ok:true  → "가입 신청 접수 완료(담당자 확인 후 연락)" 안내 + 로그인 유도.
//     ok:false → graceful 에러(전화 가입 안내).
//
// SignupInput = { name; phone; memo? } — 비밀번호 입력 없음(초기 비번 = 전화 뒷4자리,
//   운영자 가입 처리 후 로그인 시 사용). 그래서 폼은 이름·전화·(선택)메모만 받는다.
//
// 이 파일은 <Outlet/> 안에서 렌더되므로 SiteLayout 을 import 하지 않고 '본문 콘텐츠'만 반환한다.
// 라우트 등록(/signup)은 Phase3 가 담당.
// ─────────────────────────────────────────────────────────────────────────
import { useMemo, useState, type FormEvent } from 'react'
import { BRAND } from '@/lib/brand'
import { Link } from 'react-router-dom'
import { CheckCircle2, Loader2, Phone, ShieldCheck, User } from 'lucide-react'
import { useMemberAuth } from './auth'
import { cn } from '@/lib/cn'

const digits = (s: string): string => s.replace(/\D/g, '')

const inputCls =
  'h-12 w-full rounded-md border border-gray-300 bg-white px-3.5 text-[15px] text-gray-800 outline-none transition-colors placeholder:text-gray-400 focus:border-primary-500'

/** 가입 안내 항목(신뢰 강화용 정적 카피). */
const POINTS: { title: string; desc: string }[] = [
  { title: '매주 추천번호 발급', desc: '회원 등급에 따라 엄선된 추천 조합을 정기적으로 발급해 드립니다.' },
  { title: '내 번호·등급·종료일 확인', desc: '로그인 후 마이페이지에서 발급 내역과 멤버십 정보를 한눈에 확인하세요.' },
  { title: '담당자 1:1 관리', desc: '가입 신청 후 담당자가 직접 확인하여 가입을 도와드립니다.' },
]

export function SignupPage() {
  const { signup } = useMemberAuth()

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [memo, setMemo] = useState('')
  const [agree, setAgree] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const phoneDigits = useMemo(() => digits(phone), [phone])
  const canSubmit = name.trim().length > 0 && phoneDigits.length >= 9 && agree && !busy

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return

    // 클라이언트 측 1차 검증(서버 검증과 별개로 즉시 피드백).
    if (!name.trim()) {
      setError('이름을 입력해주세요.')
      return
    }
    if (phoneDigits.length < 9) {
      setError('올바른 전화번호를 입력해주세요.')
      return
    }
    if (!agree) {
      setError('개인정보 수집·이용에 동의해주세요.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const res = await signup({
        name: name.trim(),
        phone: phoneDigits,
        memo: memo.trim() || undefined,
      })
      if (res.ok) {
        setDone(true)
      } else {
        setError(res.error ?? '가입 신청에 실패했습니다. 잠시 후 다시 시도해주세요.')
      }
    } catch {
      setError('일시적인 오류입니다. 잠시 후 다시 시도해주세요.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 py-10 sm:px-6 sm:py-14">
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:gap-12">
        {/* ── 좌측: 소개/신뢰 카피 ─────────────────────────────── */}
        <section className="order-2 lg:order-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-primary-50 px-3 py-1 text-[12.5px] font-bold text-primary-700">
            <ShieldCheck className="h-3.5 w-3.5" />
            {BRAND.name} 회원 신청
          </div>
          <h1 className="mt-4 text-[26px] font-extrabold leading-tight text-ink-900 sm:text-[30px]">
            {BRAND.short}<span className="text-accent-500">{BRAND.rest}</span> 회원이 되어
            <br />내 추천번호를 받아보세요
          </h1>
          <p className="mt-3 max-w-md text-[14px] leading-relaxed text-gray-500">
            아래 정보를 남겨 주시면 담당자가 확인 후 연락드려 가입을 도와드립니다. 가입 후에는
            전화번호로 로그인하여 발급 번호와 멤버십 정보를 확인할 수 있습니다.
          </p>

          <ul className="mt-7 space-y-4">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-3">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-success-bg text-success">
                  <CheckCircle2 className="h-4 w-4" />
                </span>
                <div>
                  <div className="text-[14.5px] font-bold text-ink-900">{p.title}</div>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-gray-500">{p.desc}</p>
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-8 rounded-lg border border-gray-200 bg-white px-4 py-3 text-[12.5px] leading-relaxed text-gray-500">
            본 서비스는 로또 번호 추천 정보 제공 서비스이며 당첨을 보장하지 않습니다. 지나친 구매는
            사행성을 조장할 수 있으니 적정 구매 한도를 지켜주세요.
          </p>
        </section>

        {/* ── 우측: 신청 폼 / 완료 안내 ────────────────────────── */}
        <section className="order-1 lg:order-2">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-md sm:p-7">
            {done ? (
              <SignupDone />
            ) : (
              <>
                <h2 className="text-[19px] font-extrabold text-ink-900">회원가입 신청</h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-gray-500">
                  이름과 연락처를 남겨 주세요. 담당자 확인 후 가입을 도와드립니다.
                </p>

                {error && (
                  <div
                    role="alert"
                    className="mt-4 rounded-md border border-danger-bd bg-danger-bg px-3 py-2.5 text-[13px] leading-relaxed text-danger"
                  >
                    {error}
                  </div>
                )}

                <form onSubmit={onSubmit} className="mt-5 space-y-3.5" noValidate>
                  <label className="block">
                    <span className="mb-1.5 block text-[12.5px] font-semibold text-gray-600">
                      이름 <span className="text-danger">*</span>
                    </span>
                    <div className="relative">
                      <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-300" />
                      <input
                        className={cn(inputCls, 'pl-9')}
                        type="text"
                        autoComplete="name"
                        placeholder="홍길동"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={busy}
                      />
                    </div>
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-[12.5px] font-semibold text-gray-600">
                      전화번호 <span className="text-danger">*</span>
                    </span>
                    <div className="relative">
                      <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-300" />
                      <input
                        className={cn(inputCls, 'pl-9 font-mono tnum')}
                        type="tel"
                        inputMode="numeric"
                        autoComplete="tel"
                        placeholder="01012345678"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        disabled={busy}
                      />
                    </div>
                    <span className="mt-1 block text-[11.5px] leading-relaxed text-gray-400">
                      가입 후 이 번호로 로그인합니다. 초기 비밀번호는 전화번호 뒷 4자리입니다.
                    </span>
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-[12.5px] font-semibold text-gray-600">
                      메모 <span className="font-normal text-gray-400">(선택)</span>
                    </span>
                    <textarea
                      className="min-h-[88px] w-full resize-y rounded-md border border-gray-300 bg-white px-3.5 py-2.5 text-[14px] leading-relaxed text-gray-800 outline-none transition-colors placeholder:text-gray-400 focus:border-primary-500"
                      placeholder="추천인·유입경로·문의 사항 등 남기실 내용이 있으면 적어주세요."
                      value={memo}
                      onChange={(e) => setMemo(e.target.value)}
                      disabled={busy}
                      maxLength={500}
                    />
                  </label>

                  <label className="flex cursor-pointer items-start gap-2.5 pt-0.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary-600"
                      checked={agree}
                      onChange={(e) => setAgree(e.target.checked)}
                      disabled={busy}
                    />
                    <span className="text-[12.5px] leading-relaxed text-gray-600">
                      개인정보 수집·이용 및 가입 상담 연락에 동의합니다.
                      <span className="text-danger"> *</span>
                    </span>
                  </label>

                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="mt-1 flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary-600 text-[15px] font-bold text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    가입 신청하기
                  </button>
                </form>

                <p className="mt-5 text-center text-[13px] text-gray-500">
                  이미 회원이신가요?{' '}
                  <Link
                    to="/login"
                    className="font-bold text-primary-600 underline-offset-2 hover:underline"
                  >
                    로그인
                  </Link>
                </p>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

// ── 신청 완료 안내 ───────────────────────────────────────────────────────
function SignupDone() {
  return (
    <div className="py-4 text-center">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success-bg text-success">
        <CheckCircle2 className="h-8 w-8" />
      </span>
      <h2 className="mt-4 text-[19px] font-extrabold text-ink-900">가입 신청이 접수되었습니다</h2>
      <p className="mx-auto mt-2 max-w-xs text-[13.5px] leading-relaxed text-gray-500">
        담당자가 확인 후 빠르게 연락드려 가입을 도와드리겠습니다. 가입이 완료되면 입력하신
        전화번호로 로그인하실 수 있습니다.
      </p>

      <div className="mt-6 flex flex-col gap-2.5">
        <Link
          to="/login"
          className="flex h-12 w-full items-center justify-center rounded-md bg-primary-600 text-[15px] font-bold text-white transition-colors hover:bg-primary-700"
        >
          로그인하러 가기
        </Link>
        <Link
          to="/"
          className="flex h-12 w-full items-center justify-center rounded-md border border-gray-300 text-[15px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
        >
          홈으로
        </Link>
      </div>
    </div>
  )
}
