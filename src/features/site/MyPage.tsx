// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 마이페이지 (/mypage)
// ─────────────────────────────────────────────────────────────────────────
// 회원 본인의 등급·발급번호(주간 추천조합)·이용 안내를 확인하는 핵심 화면.
//   - 미로그인  → 로그인 유도(CTA → /login).
//   - 로딩 중   → 스켈레톤(세션 복원 동안).
//   - 로그인 시 → 상단 프로필 카드(이름 + 등급 Badge + 이용/종료일 안내)
//                + 회차별 발급번호 카드(recos: round_no 내림차순, 최근 회차 강조).
//
// ※ 이 파일은 <SiteLayout/> 의 <Outlet/> 안에 렌더되므로 '본문 콘텐츠'만 반환한다.
//    (SiteLayout/auth/api/routes 등 공유 파일은 수정하지 않음. 라우트 등록은 Phase3 담당.)
//
// 데이터 출처: useMemberAuth().member = { name, grade, phone, recos }.
//   - SiteMember 에는 종료일(period_end) 필드가 없다(세션 최소화). → 종료일은
//     "발급 회차 기준"으로 안내하고, 정확한 종료일은 고객센터/멤버십 페이지로 유도한다.
//   // TODO(live-verify): 회원 세션에 이용 종료일 노출 필요 시 portal_member_recos RPC 확장.
// ─────────────────────────────────────────────────────────────────────────
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, Hash, LogIn, Phone, Sparkles, Ticket } from 'lucide-react'
import { Badge, LottoBalls } from '@/design-system/components'
import { GRADE_LABEL } from '@/design-system/labels'
import { datetime, phone as fmtPhone } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { Grade, WeeklyRecoIssue } from '@/types/db'
import { useMemberAuth } from './auth'
import { useMembershipTiers } from './api'

// 유료 등급 집합 — 발급번호/이용권 안내 분기에 사용.
const PAID_GRADES = new Set<Grade>(['gold', 'goldp', 'vip', 'royal'])

/** 가장 최근(가장 큰) 회차의 발급 일시 → 사람이 읽기 쉬운 안내 텍스트. */
function latestIssuedLabel(recos: WeeklyRecoIssue[]): string | null {
  if (recos.length === 0) return null
  const latest = recos.reduce((a, b) => (b.round_no > a.round_no ? b : a))
  return latest.issued_at ? datetime(latest.issued_at) : null
}

// ── 미로그인: 로그인 유도 ──────────────────────────────────────────────────
function LoginPrompt() {
  return (
    <div className="mx-auto flex max-w-[480px] flex-col items-center px-4 py-16 text-center sm:py-24">
      <div className="mb-5 grid h-16 w-16 place-items-center rounded-full bg-primary-50 text-primary-600">
        <Ticket className="h-8 w-8" />
      </div>
      <h1 className="text-[22px] font-extrabold text-ink-900 sm:text-[26px]">
        마이페이지는 로그인 후 이용할 수 있어요
      </h1>
      <p className="mt-3 text-[14px] leading-relaxed text-gray-500">
        로그인하시면 회원님의 <span className="font-semibold text-gray-700">등급</span>과 회차별
        <span className="font-semibold text-gray-700"> 발급 번호</span>를 확인하실 수 있습니다.
      </p>
      <Link
        to="/login"
        className="mt-7 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary-600 px-6 py-3 text-[15px] font-bold text-white transition-colors hover:bg-primary-700"
      >
        <LogIn className="h-4 w-4" />
        로그인하러 가기
      </Link>
      <p className="mt-4 text-[13px] text-gray-400">
        아직 회원이 아니신가요?{' '}
        <Link to="/signup" className="font-semibold text-primary-600 hover:underline">
          회원가입
        </Link>
      </p>
    </div>
  )
}

// ── 로딩 스켈레톤 ───────────────────────────────────────────────────────────
function MyPageSkeleton() {
  return (
    <div className="mx-auto max-w-[1120px] animate-pulse px-4 py-10 sm:px-6">
      <div className="h-32 w-full rounded-xl bg-gray-100" />
      <div className="mt-8 h-6 w-40 rounded bg-gray-100" />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="h-56 rounded-xl bg-gray-100" />
        <div className="h-56 rounded-xl bg-gray-100" />
      </div>
    </div>
  )
}

// ── 발급번호 1세트(6개 번호) ────────────────────────────────────────────────
function RecoSetRow({ index, set }: { index: number; set: number[] }) {
  return (
    <li className="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-2.5">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white text-[12px] font-bold tabular-nums text-gray-500 shadow-sm">
        {index + 1}
      </span>
      {set.length === 6 ? (
        <LottoBalls numbers={set} size="sm" className="flex-wrap" />
      ) : (
        // 방어: 6개가 아니면 칩으로라도 표기(데이터 이상 graceful)
        <span className="flex flex-wrap items-center gap-1">
          {set.map((n, i) => (
            <span
              key={i}
              className="grid h-6 w-6 place-items-center rounded-full bg-white text-[12px] font-bold tabular-nums text-ink-900 shadow-sm"
            >
              {n}
            </span>
          ))}
        </span>
      )}
    </li>
  )
}

// ── 회차별 발급번호 카드 ────────────────────────────────────────────────────
function RoundCard({ reco, featured }: { reco: WeeklyRecoIssue; featured: boolean }) {
  return (
    <section
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border bg-white',
        featured ? 'border-primary-500 shadow-md ring-1 ring-primary-100' : 'border-gray-200',
      )}
    >
      {/* 카드 헤더 */}
      <header
        className={cn(
          'flex items-center justify-between gap-2 border-b px-4 py-3',
          featured ? 'border-primary-100 bg-primary-50' : 'border-gray-100 bg-gray-50',
        )}
      >
        <div className="flex items-center gap-2">
          <Hash
            className={cn('h-4 w-4 shrink-0', featured ? 'text-primary-600' : 'text-gray-400')}
          />
          <h3
            className={cn(
              'text-[15px] font-extrabold tabular-nums',
              featured ? 'text-primary-700' : 'text-ink-900',
            )}
          >
            {reco.round_no.toLocaleString('ko-KR')}회
          </h3>
          {featured && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary-600 px-2 py-0.5 text-[10.5px] font-bold text-white">
              <Sparkles className="h-3 w-3" />
              최신
            </span>
          )}
        </div>
        <span className="text-[12px] font-semibold tabular-nums text-gray-400">
          {reco.sets.length}조합
        </span>
      </header>

      {/* 발급 일시 */}
      {reco.issued_at && (
        <div className="flex items-center gap-1.5 px-4 pt-3 text-[12px] text-gray-400">
          <CalendarClock className="h-3.5 w-3.5" />
          <span className="tabular-nums">{datetime(reco.issued_at)} 발급</span>
        </div>
      )}

      {/* 조합 목록 */}
      <ul className="flex flex-col gap-2 p-3 sm:p-4">
        {reco.sets.length === 0 ? (
          <li className="rounded-lg bg-gray-50 px-3 py-6 text-center text-[13px] text-gray-400">
            이 회차에 발급된 조합이 없습니다.
          </li>
        ) : (
          reco.sets.map((set, i) => <RecoSetRow key={i} index={i} set={set} />)
        )}
      </ul>
    </section>
  )
}

// ── 발급번호 비어있음 ───────────────────────────────────────────────────────
function NoRecos({ grade }: { grade: Grade }) {
  const paid = PAID_GRADES.has(grade)
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-gray-50 text-gray-400">
        <Ticket className="h-7 w-7" />
      </div>
      <p className="text-[15px] font-bold text-ink-900">아직 발급된 번호가 없습니다</p>
      <p className="mx-auto mt-2 max-w-[360px] text-[13.5px] leading-relaxed text-gray-500">
        {paid
          ? '번호가 발급되면 이 페이지에서 회차별로 확인하실 수 있습니다. 발급은 매주 순차적으로 진행됩니다.'
          : '발급 번호는 멤버십 이용 회원에게 제공됩니다. 멤버십을 시작하시면 회차별 추천 조합을 받아보실 수 있어요.'}
      </p>
      {!paid && (
        <Link
          to="/membership"
          className="mt-5 inline-flex items-center justify-center gap-1.5 rounded-md bg-accent-500 px-5 py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-accent-600"
        >
          멤버십 보러가기
        </Link>
      )}
    </div>
  )
}

// ── 페이지 본체 ─────────────────────────────────────────────────────────────
export function MyPage() {
  const { member, loading } = useMemberAuth()
  const { data: tiers } = useMembershipTiers()
  // 등급 명칭은 전산 편집값(멤버십 등급)을 우선 사용. 미편집/미노출 등급은 코드 기본 라벨.
  const gradeLabel = (g: Grade): string =>
    tiers?.find((t) => t.grade === g)?.label ?? GRADE_LABEL[g]

  // 회차 내림차순 정렬(최근 회차 먼저). member 없으면 빈 배열.
  const sortedRecos = useMemo<WeeklyRecoIssue[]>(() => {
    if (!member) return []
    return [...member.recos].sort((a, b) => b.round_no - a.round_no)
  }, [member])

  const totalSets = useMemo(
    () => sortedRecos.reduce((sum, r) => sum + r.sets.length, 0),
    [sortedRecos],
  )

  if (loading) return <MyPageSkeleton />
  if (!member) return <LoginPrompt />

  const paid = PAID_GRADES.has(member.grade)
  const latestIssued = latestIssuedLabel(member.recos)
  const featuredRound = sortedRecos.length > 0 ? sortedRecos[0].round_no : null

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-8 sm:px-6 sm:py-10">
      {/* ── 프로필 / 멤버십 카드 ─────────────────────────────────── */}
      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          {/* 좌: 이름 + 등급 */}
          <div className="flex items-center gap-4">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary-50 text-[20px] font-extrabold text-primary-600">
              {member.name.slice(0, 1) || '회'}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[20px] font-extrabold text-ink-900 sm:text-[22px]">
                  {member.name}
                  <span className="text-[15px] font-bold text-gray-400"> 님</span>
                </h1>
                <Badge grade={member.grade}>{gradeLabel(member.grade)}</Badge>
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-[13px] text-gray-500">
                <Phone className="h-3.5 w-3.5" />
                <span className="tabular-nums">{fmtPhone(member.phone)}</span>
              </p>
            </div>
          </div>

          {/* 우: 이용/종료일 안내 */}
          <div className="rounded-lg bg-gray-50 px-4 py-3 sm:min-w-[260px]">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-400">
              <CalendarClock className="h-3.5 w-3.5" />
              이용 안내
            </div>
            {paid ? (
              <>
                <p className="mt-1.5 text-[14px] font-bold text-ink-900">
                  {gradeLabel(member.grade)} 멤버십 이용 중
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-gray-500">
                  {latestIssued ? (
                    <>
                      최근 발급{' '}
                      <span className="font-semibold tabular-nums text-gray-700">
                        {latestIssued}
                      </span>
                    </>
                  ) : (
                    '발급 일정에 맞춰 번호가 제공됩니다.'
                  )}
                  <br />
                  정확한 이용 종료일은{' '}
                  <Link
                    to="/support"
                    className="font-semibold text-primary-600 hover:underline"
                  >
                    고객센터
                  </Link>
                  로 확인해 주세요.
                </p>
              </>
            ) : (
              <>
                <p className="mt-1.5 text-[14px] font-bold text-ink-900">
                  {gradeLabel(member.grade)} 회원
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-gray-500">
                  멤버십을 시작하시면 회차별 추천 번호를 받아보실 수 있습니다.
                </p>
                <Link
                  to="/membership"
                  className="mt-2 inline-flex text-[12.5px] font-bold text-accent-600 hover:underline"
                >
                  멤버십 안내 보기 →
                </Link>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ── 발급번호 섹션 ───────────────────────────────────────── */}
      <div className="mt-9">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[18px] font-extrabold text-ink-900 sm:text-[20px]">
              내 발급 번호
            </h2>
            <p className="mt-0.5 text-[13px] text-gray-500">
              회차별로 발급된 추천 조합입니다.
            </p>
          </div>
          {sortedRecos.length > 0 && (
            <div className="shrink-0 text-right text-[12.5px] text-gray-400">
              <span className="font-semibold tabular-nums text-gray-700">
                {sortedRecos.length}
              </span>
              개 회차 ·{' '}
              <span className="font-semibold tabular-nums text-gray-700">{totalSets}</span>조합
            </div>
          )}
        </div>

        {sortedRecos.length === 0 ? (
          <NoRecos grade={member.grade} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sortedRecos.map((reco) => (
              <RoundCard
                key={`${reco.round_no}-${reco.issued_at}`}
                reco={reco}
                featured={reco.round_no === featuredRound}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── 하단 안내 ───────────────────────────────────────────── */}
      <p className="mt-8 text-[12px] leading-relaxed text-gray-400">
        본 번호는 추천 정보이며 당첨을 보장하지 않습니다. 회차·발급 내역에 대한 문의는{' '}
        <Link to="/support" className="font-semibold text-gray-500 hover:underline">
          고객센터
        </Link>
        를 이용해 주세요.
      </p>
    </div>
  )
}
