// 고객 홈페이지(포털) 최소 버전 (현장 피드백 — 무료회원 주간발급 확인용).
// 공개 라우트(/portal): 전화번호 + 비밀번호(기본 뒷4자리)로 로그인 → 본인 발급번호 조회.
// 운영콘솔 staff 인증과 무관. 사이트를 명시한 로그인으로 계약별 조회를 분리한다.
// 풀 홈페이지(분석/멤버십/고객센터, ilhanglotto.co.kr 참고)는 별도 단계 — ASSUMPTIONS 참조.
import { useState, type FormEvent } from 'react'
import { BRAND } from '@/lib/brand'
import { Loader2, LogIn, LogOut, Phone } from 'lucide-react'
import { Badge, LottoBalls } from '@/design-system/components'
import { datetime } from '@/lib/format'
import { loginPortal } from '@/lib/portalLogin'
import { DEFAULT_PORTAL_SITE, isPortalSourceSite, PORTAL_SITES, type PortalMemberSession, type PortalSourceSite } from '@/lib/portalScope'
import { siteScopeLabel } from '@/lib/siteScope'

const inputCls =
  'h-12 w-full rounded-md border border-gray-300 bg-white px-3.5 text-[15px] text-gray-800 outline-none focus:border-primary-500'

export function PortalPage() {
  const [sourceSite, setSourceSite] = useState<PortalSourceSite>(DEFAULT_PORTAL_SITE)
  const [phone, setPhone] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<PortalMemberSession | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const s = await loginPortal(phone, pw, sourceSite)
      if (s) setSession(s)
      else setError('선택한 서비스의 회원 정보와 일치하지 않습니다. 서비스와 전화번호, 비밀번호를 확인해주세요.')
    } catch {
      setError('일시적인 오류입니다. 잠시 후 다시 시도해주세요.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 헤더 */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-[560px] items-center gap-2 px-4">
          <span className="h-2.5 w-2.5 rounded-sm bg-[color:var(--accent-500)]" />
          <span className="text-[17px] font-extrabold text-ink-900">{BRAND.name}</span>
          <span className="text-[12px] text-gray-400">내 추천번호 확인</span>
          {session && (
            <button
              type="button"
              onClick={() => {
                setSession(null)
                setPw('')
              }}
              className="ml-auto flex items-center gap-1 text-[12.5px] text-gray-500 hover:text-gray-700"
            >
              <LogOut className="h-3.5 w-3.5" /> 로그아웃
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[560px] px-4 py-6">
        {!session ? (
          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <h1 className="mb-1 text-[19px] font-extrabold text-ink-900">내 번호 확인</h1>
            <p className="mb-5 text-[13px] leading-relaxed text-gray-500">
              매주 발급되는 추천번호를 확인하세요.
              <br />
              아이디는 <b>전화번호</b>, 초기 비밀번호는 <b>전화번호 뒷 4자리</b>입니다.
            </p>
            {error && (
              <div className="mb-4 rounded-md border border-danger-bd bg-danger-bg px-3 py-2.5 text-[13px] text-danger">
                {error}
              </div>
            )}
            <form onSubmit={onSubmit} className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-[12.5px] font-semibold text-gray-600">가입 서비스</span>
                <select
                  className={inputCls}
                  value={sourceSite}
                  disabled={busy}
                  onChange={(e) => {
                    if (isPortalSourceSite(e.target.value)) setSourceSite(e.target.value)
                    setPw('')
                    setError(null)
                  }}
                >
                  {PORTAL_SITES.map((site) => <option key={site.key} value={site.key}>{site.label}</option>)}
                </select>
                <span className="mt-1.5 block text-[12px] text-gray-500">가입한 서비스를 선택하면 해당 서비스의 발급 내역을 확인할 수 있습니다.</span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12.5px] font-semibold text-gray-600">전화번호</span>
                <div className="relative">
                  <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-300" />
                  <input
                    className={inputCls + ' pl-9'}
                    inputMode="numeric"
                    autoComplete="tel"
                    placeholder="01012345678"
                    value={phone}
                    disabled={busy}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12.5px] font-semibold text-gray-600">비밀번호</span>
                <input
                  className={inputCls}
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  placeholder="전화번호 뒷 4자리"
                  value={pw}
                  disabled={busy}
                  onChange={(e) => setPw(e.target.value)}
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary-600 text-[15px] font-bold text-white transition-colors hover:bg-primary-700 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                로그인
              </button>
            </form>
          </div>
        ) : (
          <div>
            <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-4 py-3.5 shadow-sm">
              <span className="text-[15px] font-bold text-ink-900">{session.name}님</span>
              <span className="text-xs text-gray-500">{siteScopeLabel(session.sourceSite)}</span>
              <Badge grade={session.grade} />
              <span className="ml-auto text-[11.5px] text-gray-400">
                발급 {session.recos.length}회
              </span>
            </div>
            {session.recos.length === 0 ? (
              <div className="rounded-lg border border-gray-200 bg-white py-14 text-center text-[13.5px] text-gray-400 shadow-sm">
                아직 발급된 번호가 없습니다.
                <br />
                매주 발급일에 새 번호가 등록됩니다.
              </div>
            ) : (
              <div className="space-y-4">
                {session.recos.map((iss) => (
                  <section
                    key={`${iss.round_no}-${iss.issued_at}`}
                    className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
                  >
                    <div className="mb-2.5 flex items-baseline justify-between">
                      <h2 className="text-[15px] font-extrabold text-ink-900">
                        {iss.round_no}회 추천번호{' '}
                        <span className="font-mono text-[12px] font-normal text-gray-400 tnum">
                          {iss.sets.length}조합
                        </span>
                      </h2>
                      <span className="font-mono text-[11px] tnum text-gray-400">{datetime(iss.issued_at)}</span>
                    </div>
                    <ul className="space-y-1.5">
                      {iss.sets.map((set, i) => (
                        <li key={i} className="flex items-center gap-2.5">
                          <span className="grid h-5 w-6 shrink-0 place-items-center rounded bg-gray-100 text-[10.5px] font-bold text-gray-500 tnum">
                            {i + 1}
                          </span>
                          <LottoBalls numbers={set} size="sm" />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            <p className="mt-5 text-center text-[11.5px] leading-relaxed text-gray-400">
              추천번호는 운영 기준에 따라 선별된 조합이며 당첨을 보장하지 않습니다.
              <br />
              문의: 고객센터
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
