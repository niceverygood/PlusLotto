// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 88시스템 (/portal/system)
// ─────────────────────────────────────────────────────────────────────────
// 서비스 동작 방식 소개 페이지. SiteLayout 의 <Outlet/> 안에 렌더되므로
// "본문 콘텐츠"만 반환한다(레이아웃/헤더/푸터는 SiteLayout 담당, import 금지).
//
// 내용 구성:
//  1) 히어로 — 한 줄 요약
//  2) 추천번호 생성 개요(제외수 기반 선별 / 매주 자동발급)
//  3) 발급 → 문자 → 당첨집계 흐름 다이어그램(텍스트/박스)
//  4) ⚠️ 확률 정직성 문구(6/45 모든 조합 1등확률 동일 — 선별일 뿐 확률 안 높임)
//  5) 로그인 유도 CTA(/portal/login·/portal/mypage)
//
// 데이터 훅 불필요(정적 소개). 라우트 등록은 Phase3 담당.
// 브랜드 토큰만 사용(임의 hex/px 금지). UI 한국어, 모바일 반응형.
// ─────────────────────────────────────────────────────────────────────────
import { Link } from 'react-router-dom'
import { BRAND } from '@/lib/brand'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Filter,
  ListChecks,
  Repeat,
  ShieldCheck,
  Sparkles,
  Trophy,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { LottoBalls } from '@/design-system/components'
import { useMemberAuth } from './auth'

// ── 데이터: 생성 단계 카드 ─────────────────────────────────────────────────
interface StepCard {
  icon: LucideIcon
  title: string
  desc: string
}

const GEN_STEPS: StepCard[] = [
  {
    icon: BarChart3,
    title: '회차 데이터 분석',
    desc: '역대 당첨 회차의 번호 출현·구간·홀짝 패턴 등 기록을 폭넓게 살펴봅니다.',
  },
  {
    icon: Filter,
    title: '제외수 선별',
    desc: '운영 기준에 맞지 않는 번호를 제외수로 걸러 후보 범위를 좁힙니다.',
  },
  {
    icon: ListChecks,
    title: '조합 구성',
    desc: '남은 번호로 1~45 중 6개씩 여러 조합을 구성해 추천 세트를 만듭니다.',
  },
  {
    icon: Repeat,
    title: '매주 자동 발급',
    desc: '매주 새 회차마다 추천 조합을 자동 발급해 회원에게 전달합니다.',
  },
]

// ── 데이터: 발급 → 문자 → 당첨집계 흐름 ────────────────────────────────────
interface FlowStep {
  no: number
  icon: LucideIcon
  title: string
  desc: string
}

const FLOW_STEPS: FlowStep[] = [
  {
    no: 1,
    icon: Sparkles,
    title: '추천번호 발급',
    desc: '매주 새 회차의 추천 조합이 회원 계정에 자동 등록됩니다.',
  },
  {
    no: 2,
    icon: ListChecks,
    title: '문자(SMS) 발송',
    desc: '발급된 번호를 등록된 연락처로 문자 안내해 바로 확인할 수 있습니다.',
  },
  {
    no: 3,
    icon: Trophy,
    title: '추첨 후 당첨집계',
    desc: '추첨이 끝나면 발급 번호와 당첨 번호를 대조해 결과를 집계합니다.',
  },
]

// 섹션 공통 컨테이너 폭(SiteLayout 헤더와 동일 1120px).
const SECTION = 'mx-auto w-full max-w-[1120px] px-4 sm:px-6'

export function SystemPage() {
  const { member } = useMemberAuth()

  return (
    <div className="font-sans text-ink-900">
      {/* ── 1) 히어로 ───────────────────────────────────────── */}
      <section className="bg-ink-900 text-white">
        <div className={`${SECTION} py-14 sm:py-20`}>
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[12.5px] font-semibold text-accent-100">
              <Sparkles className="h-3.5 w-3.5" />
              {BRAND.short}시스템
            </span>
            <h1 className="mt-4 text-[28px] font-extrabold leading-tight tracking-tight sm:text-[36px]">
              번호는 <span className="text-accent-500">선별</span>하고,
              <br className="hidden sm:block" /> 발급은 <span className="text-accent-500">자동</span>으로.
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-gray-300 sm:text-[16px]">
              {BRAND.name}는 매주 회차마다 데이터 기반으로 추천 조합을 선별해 자동 발급하고,
              문자로 안내한 뒤 추첨 결과까지 집계해 드리는 로또 번호 추천 서비스입니다.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              {member ? (
                <Link
                  to="/portal/mypage"
                  className="inline-flex items-center gap-2 rounded-md bg-accent-500 px-5 py-3 text-[15px] font-bold text-white transition-colors hover:bg-accent-600"
                >
                  내 추천번호 보기
                  <ArrowRight className="h-4 w-4" />
                </Link>
              ) : (
                <>
                  <Link
                    to="/portal/login"
                    className="inline-flex items-center gap-2 rounded-md bg-accent-500 px-5 py-3 text-[15px] font-bold text-white transition-colors hover:bg-accent-600"
                  >
                    내 번호 확인하기
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    to="/portal/signup"
                    className="inline-flex items-center gap-2 rounded-md border border-white/25 px-5 py-3 text-[15px] font-bold text-white transition-colors hover:bg-white/10"
                  >
                    회원가입
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── 2) 추천번호 생성 개요 ─────────────────────────────── */}
      <section className={`${SECTION} py-14 sm:py-20`}>
        <div className="mb-10 text-center">
          <h2 className="text-[22px] font-extrabold tracking-tight sm:text-[26px]">
            추천번호는 이렇게 만들어집니다
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-[14px] leading-relaxed text-gray-500 sm:text-[15px]">
            무작정 뽑는 것이 아니라, <b className="text-ink-900">제외수 기반 선별</b>로
            후보 범위를 좁힌 뒤 조합을 구성합니다. 모든 과정은 매주 자동으로 진행됩니다.
          </p>
        </div>

        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {GEN_STEPS.map((step, i) => {
            const Icon = step.icon
            return (
              <li
                key={step.title}
                className="relative flex flex-col rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
              >
                <div className="mb-3 flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-md bg-primary-50 text-primary-600">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-[12px] font-bold tabular-nums text-gray-300">
                    STEP {i + 1}
                  </span>
                </div>
                <h3 className="text-[16px] font-bold text-ink-900">{step.title}</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-gray-500">
                  {step.desc}
                </p>
              </li>
            )
          })}
        </ol>

        {/* 제외수 선별 시각 예시 */}
        <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-5 sm:p-6">
          <div className="flex items-center gap-2 text-[13px] font-bold text-gray-600">
            <Filter className="h-4 w-4 text-primary-600" />
            선별 예시 — 후보에서 추천 조합으로
          </div>
          <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex-1">
              <p className="mb-2 text-[12px] font-semibold text-gray-400">
                제외수를 걸러 좁혀진 후보 중 한 조합
              </p>
              <LottoBalls numbers={[7, 13, 22, 28, 34, 41]} size="md" />
            </div>
            <ArrowRight className="hidden h-5 w-5 shrink-0 text-gray-300 sm:block" />
            <div className="flex-1">
              <p className="mb-2 text-[12px] font-semibold text-gray-400">
                매주 발급되는 추천 조합으로 전달
              </p>
              <LottoBalls numbers={[7, 13, 22, 28, 34, 41]} size="md" />
            </div>
          </div>
          <p className="mt-4 text-[11.5px] leading-relaxed text-gray-400">
            ※ 위 번호는 화면 설명을 위한 예시이며 실제 발급 조합과 무관합니다.
          </p>
        </div>
      </section>

      {/* ── 3) 발급 → 문자 → 당첨집계 흐름 ────────────────────── */}
      <section className="border-y border-gray-200 bg-white">
        <div className={`${SECTION} py-14 sm:py-20`}>
          <div className="mb-10 text-center">
            <h2 className="text-[22px] font-extrabold tracking-tight sm:text-[26px]">
              발급부터 당첨집계까지
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-[14px] leading-relaxed text-gray-500 sm:text-[15px]">
              번호를 받고 끝이 아닙니다. 발급 → 문자 안내 → 추첨 후 당첨집계까지
              한 흐름으로 이어집니다.
            </p>
          </div>

          {/* 다이어그램(박스 + 화살표) — 모바일 세로 / 데스크탑 가로 */}
          <ol className="flex flex-col items-stretch gap-4 lg:flex-row lg:items-center lg:gap-0">
            {FLOW_STEPS.map((step, i) => {
              const Icon = step.icon
              const last = i === FLOW_STEPS.length - 1
              return (
                <li
                  key={step.no}
                  className="flex flex-1 flex-col items-stretch lg:flex-row lg:items-center"
                >
                  <div className="flex flex-1 flex-col items-center rounded-lg border border-gray-200 bg-gray-50 p-6 text-center">
                    <span className="grid h-12 w-12 place-items-center rounded-full bg-primary-600 text-white">
                      <Icon className="h-6 w-6" />
                    </span>
                    <span className="mt-3 font-mono text-[12px] font-bold tabular-nums text-primary-600">
                      {step.no}단계
                    </span>
                    <h3 className="mt-1 text-[16px] font-bold text-ink-900">{step.title}</h3>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-gray-500">
                      {step.desc}
                    </p>
                  </div>
                  {!last && (
                    <div
                      className="flex shrink-0 items-center justify-center py-2 lg:px-2 lg:py-0"
                      aria-hidden="true"
                    >
                      <ArrowRight className="h-5 w-5 rotate-90 text-gray-300 lg:rotate-0" />
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      </section>

      {/* ── 4) ⚠️ 확률 정직성 문구(필수) ──────────────────────── */}
      <section className={`${SECTION} py-14 sm:py-20`}>
        <div className="rounded-lg border border-warning-bd bg-warning-bg p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-white text-warning">
              <AlertTriangle className="h-6 w-6" />
            </span>
            <div>
              <h2 className="text-[19px] font-extrabold text-ink-900 sm:text-[21px]">
                꼭 알아두세요 — 확률에 대한 정직한 안내
              </h2>
              <p className="mt-3 text-[14px] leading-relaxed text-gray-700 sm:text-[15px]">
                로또 6/45는 1부터 45까지 중 6개를 뽑는 추첨으로,{' '}
                <b className="text-ink-900">
                  어떤 조합이든 1등에 당첨될 확률은 약 814만 5,060분의 1로 모두 동일
                </b>
                합니다. {BRAND.short}시스템의 번호 추천은 데이터를 바탕으로 조합을{' '}
                <b className="text-ink-900">선별</b>해 드리는 것일 뿐,{' '}
                <b className="text-ink-900">당첨 확률을 높여 주지 않으며 당첨을 보장하지 않습니다.</b>
              </p>

              <ul className="mt-5 space-y-2.5">
                {[
                  '모든 6/45 조합의 1등 확률은 수학적으로 동일합니다.',
                  '추천번호는 당첨 확률을 올리는 것이 아니라 선택을 돕는 참고용입니다.',
                  '본 서비스는 어떠한 경우에도 당첨을 보장하지 않습니다.',
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2.5 text-[13.5px] text-gray-700">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-6 flex items-start gap-2.5 rounded-md border border-warning-bd bg-white/70 px-4 py-3 text-[12.5px] leading-relaxed text-gray-600">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  로또는 사행성 상품입니다. 적정 구매 한도를 지켜 주세요. 도박 문제 상담은
                  한국도박문제예방치유원(국번없이 1336)에서 받을 수 있습니다.
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 5) 로그인/내번호 CTA ─────────────────────────────── */}
      <section className={`${SECTION} pb-16`}>
        <div className="flex flex-col items-center gap-5 rounded-lg bg-primary-50 px-6 py-12 text-center">
          <h2 className="text-[20px] font-extrabold text-ink-900 sm:text-[24px]">
            이번 주 내 추천번호가 궁금하신가요?
          </h2>
          <p className="max-w-md text-[14px] leading-relaxed text-gray-600">
            로그인하면 내 등급과 매주 발급된 추천 조합, 이용 종료일을 한눈에 확인할 수 있습니다.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {member ? (
              <Link
                to="/portal/mypage"
                className="inline-flex items-center gap-2 rounded-md bg-primary-600 px-5 py-3 text-[15px] font-bold text-white transition-colors hover:bg-primary-700"
              >
                마이페이지로 이동
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : (
              <>
                <Link
                  to="/portal/login"
                  className="inline-flex items-center gap-2 rounded-md bg-primary-600 px-5 py-3 text-[15px] font-bold text-white transition-colors hover:bg-primary-700"
                >
                  로그인하고 확인하기
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to="/portal/support"
                  className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-5 py-3 text-[15px] font-bold text-gray-700 transition-colors hover:bg-gray-50"
                >
                  고객센터 문의
                </Link>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
