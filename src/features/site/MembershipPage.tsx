// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 88멤버십 (등급 안내) 페이지 (/membership)
// ─────────────────────────────────────────────────────────────────────────
// 무료/골드/골드플러스/VIP/로얄 등급의 혜택을 비교하는 마케팅·안내 페이지.
// 등급 카드(명칭·가격·태그라인·혜택·개별약관)는 전산(설정 > 멤버십 등급)에서 편집 →
//   security-definer RPC(useMembershipTiers)로 연동. 운영 미편집 시 코드 기본값 폴백.
// 등급 색은 전부 grade-* 토큰(임의 hex 금지).
//
// ※ 이 파일은 <SiteLayout/> 의 <Outlet/> 안에 렌더되므로 "본문 콘텐츠"만 반환한다.
// ─────────────────────────────────────────────────────────────────────────
import { useMemo } from 'react'
import { BRAND } from '@/lib/brand'
import { Link } from 'react-router-dom'
import { Banknote, Check, Crown, FileText, Headphones, Minus, Sparkles } from 'lucide-react'
import type { Grade, MembershipTier } from '@/types/db'
import { Badge } from '@/design-system/components'
import { cn } from '@/lib/cn'
import { DEFAULT_MEMBERSHIP_TIERS, membershipTermsPath, type TierGrade, visibleTiers } from '@/lib/membership'
import { useMemberAuth } from './auth'
import { useMembershipTiers, usePublicSiteInfo } from './api'

// ── 등급별 색 토큰 매핑 (Badge 와 동일한 grade-* 토큰만 사용) ───────────────
const GRADE_TONE: Record<
  Grade,
  { text: string; dot: string; ring: string; soft: string; bar: string }
> = {
  free: { text: 'text-grade-free', dot: 'bg-grade-free', ring: 'ring-grade-free/30', soft: 'bg-grade-free-bg', bar: 'bg-grade-free' },
  simple: { text: 'text-grade-simple', dot: 'bg-grade-simple', ring: 'ring-grade-simple/30', soft: 'bg-grade-simple-bg', bar: 'bg-grade-simple' },
  gold: { text: 'text-grade-gold', dot: 'bg-grade-gold', ring: 'ring-grade-gold/40', soft: 'bg-grade-gold-bg', bar: 'bg-grade-gold' },
  goldp: { text: 'text-grade-goldp', dot: 'bg-grade-goldp', ring: 'ring-grade-goldp/40', soft: 'bg-grade-goldp-bg', bar: 'bg-grade-goldp' },
  vip: { text: 'text-grade-vip', dot: 'bg-grade-vip', ring: 'ring-grade-vip/40', soft: 'bg-grade-vip-bg', bar: 'bg-grade-vip' },
  royal: { text: 'text-grade-royal', dot: 'bg-grade-royal', ring: 'ring-grade-royal/40', soft: 'bg-grade-royal-bg', bar: 'bg-grade-royal' },
  ovr: { text: 'text-grade-ovr', dot: 'bg-grade-ovr', ring: 'ring-grade-ovr/30', soft: 'bg-grade-ovr-bg', bar: 'bg-grade-ovr' },
  toss: { text: 'text-grade-toss', dot: 'bg-grade-toss', ring: 'ring-grade-toss/30', soft: 'bg-grade-toss-bg', bar: 'bg-grade-toss' },
}

// ── 등급 × 기능 비교 매트릭스 (값은 운영 표준 — 카드 혜택과 별개의 요약표) ──
interface FeatureRow {
  label: string
  values: Record<TierGrade, boolean | string>
}

// TODO(live-verify): 비교 항목/값은 합리적 추정. 운영 확정 시 교체.
const FEATURE_ROWS: FeatureRow[] = [
  { label: '주간 추천 조합 수', values: { free: '1조합', gold: '5조합', goldp: '10조합', vip: '20조합', royal: '30조합+' } },
  { label: '추천 번호 문자(SMS) 발송', values: { free: false, gold: true, goldp: true, vip: true, royal: true } },
  { label: '회차별 당첨 집계 알림', values: { free: false, gold: true, goldp: true, vip: true, royal: true } },
  { label: '번호 분석 리포트', values: { free: false, gold: '기본', goldp: '심화', vip: '프리미엄', royal: '프리미엄+' } },
  { label: '전담 상담원 1:1 관리', values: { free: false, gold: false, goldp: false, vip: true, royal: true } },
  { label: '맞춤 당첨 컨설팅', values: { free: false, gold: false, goldp: false, vip: true, royal: true } },
  { label: '특별 이벤트·당첨 케어', values: { free: false, gold: false, goldp: false, vip: false, royal: true } },
]

function CellValue({ value, tone }: { value: boolean | string; tone: string }) {
  if (value === true) {
    return (
      <span className={cn('inline-flex items-center justify-center', tone)}>
        <Check className="h-4 w-4" aria-label="제공" />
      </span>
    )
  }
  if (value === false) {
    return (
      <span className="inline-flex items-center justify-center text-gray-300">
        <Minus className="h-4 w-4" aria-label="미제공" />
      </span>
    )
  }
  return <span className="text-[12.5px] font-semibold text-ink-900 tabular-nums">{value}</span>
}

// ── 등급 카드 ──────────────────────────────────────────────────────────────
function TierCard({ tier, isCurrent }: { tier: MembershipTier; isCurrent: boolean }) {
  const tone = GRADE_TONE[tier.grade]
  return (
    <div
      className={cn(
        'relative flex flex-col rounded-lg border bg-white p-5 shadow-sm transition',
        tier.featured ? 'border-primary-200 ring-1 ring-primary-100' : 'border-gray-200',
        isCurrent && 'ring-2 ring-primary-400',
      )}
    >
      {tier.featured && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary-600 px-3 py-1 text-[11px] font-bold text-white shadow-sm">
          인기
        </span>
      )}
      {isCurrent && (
        <span className="absolute right-4 top-4 rounded-full bg-primary-50 px-2 py-0.5 text-[10.5px] font-bold text-primary-700">
          내 등급
        </span>
      )}

      <span className={cn('mb-4 h-1 w-10 rounded-full', tone.bar)} />

      <div className="mb-1 flex items-center gap-2">
        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', tone.dot)} />
        <h3 className={cn('text-[18px] font-extrabold', tone.text)}>{tier.label}</h3>
      </div>
      <p className="mb-4 text-[13px] leading-relaxed text-gray-500">{tier.tagline}</p>

      {/* 가격 */}
      <div className={cn('mb-4 rounded-md px-3 py-2.5', tone.soft)}>
        <div className="text-[11.5px] font-semibold text-gray-500">월 이용료</div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[20px] font-extrabold text-ink-900">{tier.price}</span>
          {tier.weekly_sets && (
            <span className="text-[12px] font-medium text-gray-500">· {tier.weekly_sets}</span>
          )}
        </div>
      </div>

      {/* 혜택 목록 */}
      <ul className="mb-5 flex flex-1 flex-col gap-2">
        {tier.highlights.map((h) => (
          <li key={h} className="flex items-start gap-2 text-[13px] leading-snug text-gray-700">
            <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', tone.text)} />
            <span>{h}</span>
          </li>
        ))}
      </ul>

      {/* 등급별 약관 → 가입 문의 순서(현장 피드백 7/22) */}
      <Link
        to={membershipTermsPath(tier.grade)}
        className="mb-2 inline-flex items-center justify-center gap-1.5 rounded-[7px] border border-gray-300 bg-white px-3.5 py-2.5 text-[13px] font-bold text-gray-700 transition hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700"
      >
        <FileText className="h-3.5 w-3.5" />
        약관보기
      </Link>

      <Link
        to="/support"
        className={cn(
          'mt-auto inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3.5 py-2.5 text-[13px] font-bold transition',
          tier.featured
            ? 'bg-primary-600 text-white hover:bg-primary-700'
            : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 hover:border-gray-400',
        )}
      >
        {tier.grade === 'free' ? '무료로 시작하기' : '가입 문의하기'}
      </Link>
    </div>
  )
}

export function MembershipPage() {
  const { member } = useMemberAuth()
  const currentGrade = member?.grade ?? null
  const { data } = useMembershipTiers()
  const { data: publicInfo } = usePublicSiteInfo()
  const bank = publicInfo?.bank
  const allTiers = data ?? DEFAULT_MEMBERSHIP_TIERS
  // 고객 홈페이지는 등급 3종만 노출(현장 피드백 7/20) — 회원 본인의 실제 등급 라벨은 숨김 등급이어도
  // 정확히 표시해야 하므로 labelOf 는 allTiers(비필터) 기준으로 만든다.
  const tiers = visibleTiers(allTiers)
  const visibleGrades = useMemo(() => tiers.map((t) => t.grade as TierGrade), [tiers])

  const labelOf = useMemo(() => {
    const m = new Map(allTiers.map((t) => [t.grade, t.label]))
    return (g: Grade): string | undefined => m.get(g)
  }, [allTiers])

  return (
    <div className="font-sans">
      {/* ── 히어로 ───────────────────────────────────────────── */}
      <section className="border-b border-gray-200 bg-gradient-to-b from-ink-900 to-ink-800">
        <div className="mx-auto max-w-[1120px] px-4 py-14 sm:px-6 sm:py-16">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold text-accent-500">
            <Crown className="h-3.5 w-3.5" />
            {BRAND.short}멤버십
          </span>
          <h1 className="mt-4 text-[28px] font-extrabold leading-tight text-white sm:text-[34px]">
            등급별 맞춤 번호 서비스로
            <br className="hidden sm:block" /> 더 똑똑하게 시작하세요
          </h1>
          <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-gray-300 sm:text-[15px]">
            회원님께 맞는 등급으로, 원하는 만큼의 추천 조합과 전용 분석을 제공합니다.
            등급은 언제든 상향할 수 있어요.
          </p>

          {member ? (
            <div className="mt-6 inline-flex items-center gap-3 rounded-lg bg-white/10 px-4 py-3 backdrop-blur">
              <span className="text-[13px] text-gray-200">
                <span className="font-bold text-white">{member.name}</span>님의 현재 등급
              </span>
              <Badge grade={member.grade}>{labelOf(member.grade)}</Badge>
            </div>
          ) : (
            <div className="mt-6 flex flex-wrap gap-2.5">
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-1.5 rounded-[7px] bg-accent-500 px-5 py-2.5 text-[14px] font-bold text-white transition hover:bg-accent-600"
              >
                <Sparkles className="h-4 w-4" />
                회원가입하고 시작
              </Link>
              <Link
                to="/login"
                className="inline-flex items-center justify-center rounded-[7px] border border-white/30 px-5 py-2.5 text-[14px] font-bold text-white transition hover:bg-white/10"
              >
                로그인
              </Link>
            </div>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-[1120px] px-4 py-12 sm:px-6 sm:py-14">
        {/* ── 등급 카드 ──────────────────────────────────────── */}
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[22px] font-extrabold text-ink-900">멤버십 등급 안내</h2>
            <p className="mt-1 text-[13.5px] text-gray-500">
              가격은 상담을 통해 안내드립니다. 부담 없이 문의해 주세요.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tiers.map((t) => (
            <TierCard key={t.grade} tier={t} isCurrent={currentGrade === t.grade} />
          ))}
        </div>

        {/* ── 기능 비교표 ────────────────────────────────────── */}
        <div className="mt-14">
          <h2 className="text-[22px] font-extrabold text-ink-900">등급별 혜택 비교</h2>
          <p className="mt-1 text-[13.5px] text-gray-500">
            등급에 따라 제공되는 서비스 범위를 한눈에 비교하세요.
          </p>

          <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="px-4 py-3 text-[12.5px] font-bold text-gray-600">혜택 항목</th>
                  {visibleGrades.map((g) => {
                    const tone = GRADE_TONE[g]
                    const isCurrent = currentGrade === g
                    return (
                      <th
                        key={g}
                        className={cn(
                          'px-3 py-3 text-center text-[13px] font-extrabold',
                          tone.text,
                          isCurrent && 'bg-primary-50',
                        )}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <span className={cn('h-2 w-2 rounded-full', tone.dot)} />
                          {labelOf(g) ?? g}
                        </span>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {FEATURE_ROWS.map((row, i) => (
                  <tr
                    key={row.label}
                    className={cn('border-b border-gray-100', i % 2 === 1 && 'bg-gray-50/40')}
                  >
                    <td className="px-4 py-3 text-[13px] font-semibold text-gray-700">{row.label}</td>
                    {visibleGrades.map((g) => {
                      const tone = GRADE_TONE[g]
                      const isCurrent = currentGrade === g
                      return (
                        <td
                          key={g}
                          className={cn('px-3 py-3 text-center', isCurrent && 'bg-primary-50/60')}
                        >
                          <CellValue value={row.values[g]} tone={tone.text} />
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-gray-400">
            * 제공 조합 수·혜택 구성은 운영 정책에 따라 변경될 수 있으며, 정확한 내용은 상담 시
            안내드립니다.
          </p>
        </div>

        {/* ── 결제 안내(무통장 입금) ─────────────────────────── */}
        {bank && bank.account_no && (
          <div className="mt-14 rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent-50 text-accent-600">
                <Banknote className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-[17px] font-extrabold text-ink-900">결제 안내(무통장 입금)</h3>
                <p className="mt-1 text-[13.5px] leading-relaxed text-gray-500">
                  아래 계좌로 입금해 주시면 담당자 확인 후 등급이 적용됩니다.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[14px]">
                  <span className="font-bold text-ink-900">
                    {bank.bank_name} <span className="font-mono tabular-nums">{bank.account_no}</span>
                  </span>
                  <span className="text-gray-500">예금주 {bank.holder}</span>
                </div>
                {bank.guide && (
                  <p className="mt-2.5 text-[12.5px] leading-relaxed text-gray-400">{bank.guide}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── 하단 CTA ──────────────────────────────────────── */}
        <div className="mt-14 rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary-50 text-primary-600">
                <Headphones className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-[17px] font-extrabold text-ink-900">
                  어떤 등급이 맞을지 고민되시나요?
                </h3>
                <p className="mt-1 text-[13.5px] leading-relaxed text-gray-500">
                  상담원이 회원님께 꼭 맞는 등급과 혜택을 친절하게 안내해 드립니다.
                </p>
              </div>
            </div>
            <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
              <Link
                to="/support"
                className="inline-flex items-center justify-center gap-1.5 rounded-[7px] bg-primary-600 px-5 py-2.5 text-[14px] font-bold text-white transition hover:bg-primary-700"
              >
                <Headphones className="h-4 w-4" />
                상담·가입 문의
              </Link>
              {!member && (
                <Link
                  to="/signup"
                  className="inline-flex items-center justify-center gap-1.5 rounded-[7px] border border-gray-300 bg-white px-5 py-2.5 text-[14px] font-bold text-gray-700 transition hover:bg-gray-50 hover:border-gray-400"
                >
                  회원가입
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
