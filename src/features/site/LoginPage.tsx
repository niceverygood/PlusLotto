// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 로그인 페이지 (/login) · Phase 2
// ─────────────────────────────────────────────────────────────────────────
// SiteLayout 의 <Outlet/> 안에 렌더되므로 '본문 콘텐츠'만 반환한다(헤더/푸터 X).
// 전화번호 + 비밀번호(기본=전화 뒷4자리) → useMemberAuth().login → 성공 시 /mypage.
// 라우트 등록은 Phase3(routes.tsx)가 담당 — 여기서는 등록하지 않는다.
// 브랜드 토큰만 사용(임의 hex 금지), TS strict, UI 한국어, 모바일 반응형.
// ─────────────────────────────────────────────────────────────────────────
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { KeyRound, Loader2, LogIn, Phone, ShieldCheck } from 'lucide-react'
import { useMemberAuth } from './auth'

const digits = (s: string): string => s.replace(/\D/g, '')

const inputCls =
  'h-12 w-full rounded-md border border-gray-300 bg-white pl-10 pr-3.5 text-[15px] text-gray-800 outline-none transition-colors placeholder:text-gray-400 focus:border-primary-500'

export function LoginPage() {
  const { login } = useMemberAuth()
  const navigate = useNavigate()

  const [phone, setPhone] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 클라이언트 1차 검증(서버 RPC 전에 graceful 안내)
  const phoneValid = digits(phone).length >= 9
  const canSubmit = phoneValid && pw.trim().length > 0 && !busy

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!phoneValid) {
      setError('전화번호를 정확히 입력해주세요.')
      return
    }
    if (!pw.trim()) {
      setError('비밀번호를 입력해주세요.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await login(phone, pw)
      if (res.ok) {
        navigate('/mypage')
      } else {
        setError(res.error ?? '전화번호 또는 비밀번호가 일치하지 않습니다.')
      }
    } catch {
      setError('일시적인 오류입니다. 잠시 후 다시 시도해주세요.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-[1120px] items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-[440px]">
        {/* 인삿말 */}
        <div className="mb-6 text-center">
          <span className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-primary-50 px-3 py-1.5 text-[12.5px] font-bold text-primary-700">
            <ShieldCheck className="h-3.5 w-3.5" />
            회원 전용 서비스
          </span>
          <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-ink-900 sm:text-[28px]">
            로그인
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-gray-500">
            로그인하고 내 등급과 발급된 추천번호를 확인하세요.
          </p>
        </div>

        {/* 로그인 카드 */}
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-7">
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-danger-bd bg-danger-bg px-3.5 py-2.5 text-[13px] font-medium text-danger"
            >
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-gray-700">
                전화번호
              </span>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  className={inputCls}
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="01012345678"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value)
                    if (error) setError(null)
                  }}
                  disabled={busy}
                  aria-label="전화번호"
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-gray-700">
                비밀번호
              </span>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  className={inputCls}
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  placeholder="전화번호 뒷 4자리"
                  value={pw}
                  onChange={(e) => {
                    setPw(e.target.value)
                    if (error) setError(null)
                  }}
                  disabled={busy}
                  aria-label="비밀번호"
                />
              </div>
              <span className="mt-1.5 block text-[12px] leading-relaxed text-gray-400">
                초기 비밀번호는 <b className="font-semibold text-gray-500">전화번호 뒷 4자리</b>
                입니다.
              </span>
            </label>

            <button
              type="submit"
              disabled={!canSubmit}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary-600 text-[15px] font-bold text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  로그인 중...
                </>
              ) : (
                <>
                  <LogIn className="h-4 w-4" />
                  로그인
                </>
              )}
            </button>
          </form>
        </div>

        {/* 회원가입 안내 */}
        <div className="mt-5 text-center text-[14px] text-gray-500">
          아직 회원이 아니신가요?{' '}
          <Link
            to="/signup"
            className="font-bold text-primary-600 underline-offset-2 hover:text-primary-700 hover:underline"
          >
            회원가입
          </Link>
        </div>

        <p className="mt-6 text-center text-[12px] leading-relaxed text-gray-400">
          로그인이 어려우시면 고객센터로 문의해주세요.
          <br />
          본 서비스는 추천 정보 제공이며 당첨을 보장하지 않습니다.
        </p>
      </div>
    </div>
  )
}
