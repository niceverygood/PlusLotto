import { useState, type FormEvent, type ReactNode } from 'react'
import { BRAND } from '@/lib/brand'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { Button } from '@/design-system/components'
import { useCurrentUser, useSignIn } from '@/lib/auth'
import { isSupabaseConfigured } from '@/lib/supabase'
import type { Role } from '@/types/db'
import { cn } from '@/lib/cn'

interface DemoAccount {
  role: Role
  label: string
  loginId: string
}

// mock 데모 계정 (seed staff 와 일치). 실 Supabase 전환 시 노출 안 됨.
const DEMO_ACCOUNTS: DemoAccount[] = [
  { role: 'admin', label: '최고관리자', loginId: 'admin01' },
  { role: 'manager', label: '관리자', loginId: 'two001' },
  { role: 'leader', label: '실장', loginId: 'leader01' },
  { role: 'rep', label: '팀장', loginId: 'rep01' },
]

export function LoginPage() {
  const user = useCurrentUser()
  const signIn = useSignIn()
  const navigate = useNavigate()
  const location = useLocation()

  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 기본 랜딩은 '/'(RoleHome) — 역할별 분기(팀장=/members)를 한 곳에서 처리(현장 피드백 6/11).
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/'

  if (user) return <Navigate to={from} replace />

  async function doSignIn(id: string, pw?: string) {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const res = await signIn(id, pw)
    setSubmitting(false)
    if (res.ok) navigate(from, { replace: true })
    else setError(res.error ?? '로그인에 실패했습니다.')
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!identifier.trim()) {
      setError('아이디를 입력하세요.')
      return
    }
    void doSignIn(identifier, password)
  }

  return (
    <div className="grid min-h-screen place-items-center bg-gray-50 p-4">
      <div className="w-full max-w-[380px] rounded-lg border border-gray-200 bg-white p-7 shadow-md">
        {/* 브랜드 */}
        <div className="mb-6 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm bg-[color:var(--accent-500)]" />
          <span className="text-[17px] font-extrabold text-ink-900">{BRAND.name}</span>
          <span className="text-[12px] text-gray-400">운영 콘솔</span>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-danger-bd bg-danger-bg px-3 py-2 text-[12.5px] text-danger">
            {error}
          </div>
        )}

        {isSupabaseConfigured ? (
          // ── 실 Supabase: 이메일/비밀번호 ──────────────
          <form onSubmit={onSubmit} className="space-y-3">
            <Field label="이메일">
              <input
                type="email"
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className={inputCls}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="비밀번호">
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Button type="submit" variant="pri" className="w-full" disabled={submitting} icon={<LogIn className="h-4 w-4" />}>
              {submitting ? '로그인 중…' : '로그인'}
            </Button>
          </form>
        ) : (
          // ── mock: 데모 빠른 로그인 + 아이디 로그인 ─────
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.5px] text-gray-400">
                데모 계정 빠른 로그인
              </div>
              <div className="grid grid-cols-2 gap-2">
                {DEMO_ACCOUNTS.map((acc) => (
                  <button
                    key={acc.role}
                    type="button"
                    disabled={submitting}
                    onClick={() => void doSignIn(acc.loginId)}
                    className="flex flex-col items-start rounded-md border border-gray-200 px-3 py-2 text-left transition-colors hover:border-primary-500 hover:bg-primary-50 disabled:opacity-50"
                  >
                    <span className="text-[13px] font-bold text-ink-900">{acc.label}</span>
                    <span className="font-mono text-[11px] text-gray-400">{acc.loginId}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-gray-300">
              <span className="h-px flex-1 bg-gray-200" />
              또는
              <span className="h-px flex-1 bg-gray-200" />
            </div>

            <form onSubmit={onSubmit} className="space-y-3">
              <Field label="아이디">
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className={inputCls}
                  placeholder="login_id"
                />
              </Field>
              <Button type="submit" variant="pri" className="w-full" disabled={submitting} icon={<LogIn className="h-4 w-4" />}>
                {submitting ? '로그인 중…' : '로그인'}
              </Button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}

const inputCls = cn(
  'h-9 w-full rounded-md border border-gray-300 px-2.5 text-[13px] text-ink-900 outline-none',
  'placeholder:text-gray-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-100',
)

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-gray-600">{label}</span>
      {children}
    </label>
  )
}
