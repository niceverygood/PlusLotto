// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 홈/랜딩 (Phase 2, 라우트 /)
// ─────────────────────────────────────────────────────────────────────────
// SiteLayout 의 <Outlet/> 안에 렌더되는 "본문 콘텐츠"만 반환한다(레이아웃·헤더·푸터 X).
// 구성: 히어로 → 3대 강점 → 회차 미리보기(graceful) → 등급 미리보기 → 신뢰요소 → 마무리 CTA.
// 브랜드 토큰만 사용(ink/primary/accent 금색/grade-*/gray). 임의 hex·px 금지. 모바일 우선.
//
// ── 데이터/상태 ───────────────────────────────────────────────────────────
//   - useMemberAuth(): 로그인 여부에 따라 CTA(회원가입/로그인 ↔ 마이페이지) 분기.
//   - useRecentRounds(1): 최근 회차 1건 미리보기. 로딩/빈/에러는 모두 graceful 처리.
// ─────────────────────────────────────────────────────────────────────────
import type { ReactNode } from 'react'
import { BRAND } from '@/lib/brand'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BellRing,
  CheckCircle2,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  Trophy,
  Users,
} from 'lucide-react'
import { Badge, LottoBalls } from '@/design-system/components'
import { date } from '@/lib/format'
import { cn } from '@/lib/cn'
import { DEFAULT_MEMBERSHIP_TIERS, visibleTiers } from '@/lib/membership'
import { useMemberAuth } from './auth'
import { useMembershipTiers, usePublicSiteInfo, useRecentRounds } from './api'

// ── 3대 강점 정의 ──────────────────────────────────────────────────────────
interface Strength {
  icon: ReactNode
  title: string
  desc: string
}

const STRENGTHS: Strength[] = [
  {
    icon: <Sparkles className="h-6 w-6" />,
    title: 'AI 추천번호 자동발급',
    desc: '매주 데이터 분석으로 선별한 추천 조합을 자동으로 발급해 드립니다. 더 이상 번호 고민은 그만.',
  },
  {
    icon: <Trophy className="h-6 w-6" />,
    title: '당첨 집계 · 당첨 안내',
    desc: '추첨 직후 발급 번호의 당첨 여부를 자동 집계하고, 당첨 시 빠르게 안내해 드립니다.',
  },
  {
    icon: <MessageSquareText className="h-6 w-6" />,
    title: '카톡 / 문자 발송',
    desc: '발급된 번호와 당첨 소식을 카카오톡·문자로 받아보세요. 놓치지 않고 한눈에 확인.',
  },
]

// 당첨자 발표 — 직전 확정 회차 등수별 인원(누적 아님, 현장 피드백 7/20 재확정).
const WINNER_RANKS: { key: 'rank1' | 'rank2' | 'rank3' | 'rank4' | 'rank5'; label: string }[] = [
  { key: 'rank1', label: '1등' },
  { key: 'rank2', label: '2등' },
  { key: 'rank3', label: '3등' },
  { key: 'rank4', label: '4등' },
  { key: 'rank5', label: '5등' },
]

// 등급 미리보기는 전산 편집 멤버십 등급(useMembershipTiers)에서 가져온다(명칭·소개 연동).

// ── 작은 표시용 컴포넌트 ───────────────────────────────────────────────────
function SectionHeading({
  eyebrow,
  title,
  desc,
}: {
  eyebrow: string
  title: ReactNode
  desc?: string
}) {
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center">
      <span className="mb-3 inline-block rounded-full bg-primary-50 px-3 py-1 text-[12px] font-bold text-primary-700">
        {eyebrow}
      </span>
      <h2 className="text-[24px] font-extrabold leading-tight text-ink-900 sm:text-[30px]">
        {title}
      </h2>
      {desc && <p className="mt-3 text-[14px] leading-relaxed text-gray-500 sm:text-[15px]">{desc}</p>}
    </div>
  )
}

/** 로그인 상태에 맞춰 1차 CTA 경로/문구를 결정. */
function usePrimaryCta(): { to: string; label: string } {
  const { member } = useMemberAuth()
  return member
    ? { to: '/mypage', label: '내 추천번호 확인하기' }
    : { to: '/signup', label: '무료로 시작하기' }
}

// ── 페이지 ─────────────────────────────────────────────────────────────────
export function HomePage() {
  const { member } = useMemberAuth()
  const cta = usePrimaryCta()
  const roundsQuery = useRecentRounds(1)
  const latest = roundsQuery.data?.[0]
  const { data: tierData } = useMembershipTiers()
  const tiers = visibleTiers(tierData ?? DEFAULT_MEMBERSHIP_TIERS)
  const { data: publicInfo } = usePublicSiteInfo()
  const winnerStats = publicInfo?.winner_stats

  return (
    <div className="font-sans">
      {/* ── 히어로 ─────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-ink-900">
        {/* 금색/네이비 분위기의 배경 글로우 (토큰 색상 기반) */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent-500/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-primary-600/25 blur-3xl"
        />

        <div className="relative mx-auto max-w-[1120px] px-4 py-16 sm:px-6 sm:py-24">
          <div className="mx-auto max-w-3xl text-center">
            <span className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-accent-500/40 bg-accent-500/10 px-3.5 py-1.5 text-[12.5px] font-bold text-accent-500">
              <Sparkles className="h-3.5 w-3.5" />
              AI 기반 로또 번호 추천 서비스
            </span>

            <h1 className="text-[32px] font-extrabold leading-[1.15] tracking-tight text-white sm:text-[48px]">
              인생역전의 기회,
              <br />
              <span className="text-accent-500">{BRAND.short}</span>{BRAND.rest}와 함께
            </h1>

            <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-gray-300 sm:text-[17px]">
              매주 자동 발급되는 추천 번호와 당첨 집계까지.
              <br className="hidden sm:block" />
              번호 고민 없이, 당첨의 설렘만 누리세요.
            </p>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                to={cta.to}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-7 text-[15px] font-bold text-ink-900 shadow-md transition-colors hover:bg-accent-600 sm:w-auto"
              >
                {cta.label}
                <ArrowRight className="h-4 w-4" />
              </Link>
              {!member && (
                <Link
                  to="/login"
                  className="inline-flex h-12 w-full items-center justify-center rounded-lg border border-white/25 px-7 text-[15px] font-bold text-white transition-colors hover:bg-white/10 sm:w-auto"
                >
                  로그인
                </Link>
              )}
            </div>

            {/* 신뢰 보조 카피 */}
            <p className="mt-5 text-[12.5px] text-gray-400">
              가입 즉시 추천번호 발급 · 별도 앱 설치 불필요
            </p>
          </div>
        </div>
      </section>

      {/* ── 3대 강점 ───────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 sm:py-20">
        <SectionHeading
          eyebrow={`WHY ${BRAND.name}`}
          title={
            <>
              번호 추천부터 당첨 안내까지,
              <br className="hidden sm:block" /> 한 번에
            </>
          }
          desc={`복잡한 과정 없이, ${BRAND.name}가 알아서 챙겨드립니다.`}
        />

        <div className="grid gap-5 sm:grid-cols-3">
          {STRENGTHS.map((s, i) => (
            <div
              key={s.title}
              className="group relative rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
                {s.icon}
              </div>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="font-mono text-[12px] font-bold text-accent-500 tabular-nums">
                  0{i + 1}
                </span>
                <h3 className="text-[17px] font-extrabold text-ink-900">{s.title}</h3>
              </div>
              <p className="text-[14px] leading-relaxed text-gray-500">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 회차 미리보기 (graceful) ───────────────────────────── */}
      {(roundsQuery.isLoading || latest) && (
        <section className="bg-gray-100/60 py-16 sm:py-20">
          <div className="mx-auto max-w-[1120px] px-4 sm:px-6">
            <div className="mx-auto max-w-2xl rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm sm:p-8">
              <div className="mb-2 inline-flex items-center gap-1.5 text-[12.5px] font-bold text-primary-700">
                <Trophy className="h-4 w-4" />
                최근 당첨 회차
              </div>
              {roundsQuery.isLoading ? (
                <div className="mx-auto mt-4 flex flex-col items-center gap-3">
                  <div className="h-6 w-32 animate-pulse rounded bg-gray-100" />
                  <div className="h-8 w-64 animate-pulse rounded-full bg-gray-100" />
                </div>
              ) : latest ? (
                <>
                  <h3 className="mt-1 text-[22px] font-extrabold text-ink-900 sm:text-[26px]">
                    제 <span className="font-mono tabular-nums">{latest.round_no}</span>회
                  </h3>
                  {latest.draw_date && (
                    <p className="mt-1 font-mono text-[12.5px] text-gray-400 tabular-nums">
                      {date(latest.draw_date)} 추첨
                    </p>
                  )}
                  {Array.isArray(latest.numbers) && latest.numbers.length > 0 && (
                    <div className="mt-5 flex justify-center">
                      <LottoBalls numbers={latest.numbers} bonus={latest.bonus} size="md" />
                    </div>
                  )}
                  <p className="mt-6 text-[13.5px] leading-relaxed text-gray-500">
                    {BRAND.name}는 매주 추첨 결과를 자동 집계해 회원님의 발급 번호 당첨 여부를 안내합니다.
                  </p>
                </>
              ) : null}
            </div>
          </div>
        </section>
      )}

      {/* ── 등급 미리보기 ──────────────────────────────────────── */}
      <section className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 sm:py-20">
        <SectionHeading
          eyebrow="MEMBERSHIP"
          title={
            <>
              등급에 따라 더 강력하게
            </>
          }
          desc="회원님께 맞는 등급으로 시작하세요."
        />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tiers.map((t) => (
            <div
              key={t.grade}
              className={cn(
                'flex flex-col rounded-xl border bg-white p-5 shadow-sm transition-shadow hover:shadow-md',
                t.featured ? 'border-grade-goldp/40' : 'border-gray-200',
              )}
            >
              <div className="mb-3">
                <Badge grade={t.grade}>{t.label}</Badge>
              </div>
              <div className="mb-1 text-[16px] font-extrabold text-ink-900">{t.label}</div>
              <p className="text-[13px] leading-relaxed text-gray-500">{t.tagline}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <Link
            to="/membership"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-[14px] font-bold text-gray-700 transition-colors hover:bg-gray-50"
          >
            멤버십 전체 보기
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* ── 신뢰 요소 ──────────────────────────────────────────── */}
      <section className="bg-ink-900 py-16 sm:py-20">
        <div className="mx-auto max-w-[1120px] px-4 sm:px-6">
          {/* 당첨자 수(누적 아님 — 직전 확정 회차 등수별, 운영자 수동 입력, 현장 피드백 7/20 재확정) */}
          {winnerStats?.enabled && (
            <div className="mb-10 text-center">
              <div className="text-[12.5px] font-bold uppercase tracking-[0.5px] text-accent-500">
                Winners
              </div>
              <p className="mt-2 text-[20px] font-extrabold text-white sm:text-[22px]">
                {latest ? `제 ${latest.round_no}회` : ''} 당첨자 발표
              </p>
              <div className="mt-5 flex flex-wrap items-start justify-center gap-x-8 gap-y-4">
                {WINNER_RANKS.map((r) => (
                  <div key={r.key}>
                    <div className="text-[12px] font-semibold text-gray-400">{r.label}</div>
                    <div className="mt-0.5 font-mono text-[22px] font-extrabold text-accent-500 tabular-nums">
                      {winnerStats[r.key].toLocaleString()}
                      <span className="ml-1 text-[13px] font-semibold text-gray-300">명</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-6 sm:grid-cols-3">
            {[
              {
                icon: <ShieldCheck className="h-6 w-6" />,
                title: '안전한 회원 관리',
                desc: '회원 정보와 발급 내역을 안전하게 관리합니다.',
              },
              {
                icon: <BellRing className="h-6 w-6" />,
                title: '빠른 당첨 안내',
                desc: '추첨 직후 당첨 여부를 자동으로 확인해 알려드립니다.',
              },
              {
                icon: <Users className="h-6 w-6" />,
                title: '전담 고객 지원',
                desc: '문의부터 등급 안내까지 담당자가 직접 도와드립니다.',
              },
            ].map((t) => (
              <div
                key={t.title}
                className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-5"
              >
                <span className="mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent-500/15 text-accent-500">
                  {t.icon}
                </span>
                <div>
                  <h3 className="text-[16px] font-extrabold text-white">{t.title}</h3>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-gray-300">{t.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* 보조 신뢰 배지 라인 */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[12.5px] text-gray-400">
            {['추첨 결과 자동 집계', '매주 정기 발급', '카톡·문자 알림', '담당자 1:1 지원'].map(
              (label) => (
                <span key={label} className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-accent-500" />
                  {label}
                </span>
              ),
            )}
          </div>
        </div>
      </section>

      {/* ── 마무리 CTA ─────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 sm:py-20">
        <div className="relative overflow-hidden rounded-2xl bg-primary-600 px-6 py-12 text-center shadow-md sm:px-10 sm:py-14">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-accent-500/25 blur-3xl"
          />
          <div className="relative">
            <h2 className="text-[24px] font-extrabold leading-tight text-white sm:text-[30px]">
              지금 바로 {BRAND.name}를 시작하세요
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-relaxed text-primary-100 sm:text-[15px]">
              가입은 무료, 추천번호는 매주 자동으로. 당첨의 기회를 놓치지 마세요.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                to={cta.to}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-7 text-[15px] font-bold text-ink-900 transition-colors hover:bg-accent-600 sm:w-auto"
              >
                {cta.label}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/support"
                className="inline-flex h-12 w-full items-center justify-center rounded-lg border border-white/30 px-7 text-[15px] font-bold text-white transition-colors hover:bg-white/10 sm:w-auto"
              >
                고객센터 문의
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
