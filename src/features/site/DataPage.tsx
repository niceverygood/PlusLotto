// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 플러스로또자료 (/data)  [Phase 2]
// ─────────────────────────────────────────────────────────────────────────
// 최근 회차 당첨번호 자료실. useRecentRounds 로 최근 N회차를 불러와
//   ① 최신 회차 하이라이트 카드(번호 + 합·홀짝 등 요약)
//   ② 회차별 당첨번호 표(데스크탑 표 / 모바일 카드) — 회차·추첨일·번호6+보너스·1등 당첨금
//   ③ 불러온 회차 범위의 간단 통계(최다 출현 번호 등)
// 데이터 훅이 로딩/빈/에러일 때 모두 graceful 처리(화면이 죽지 않게).
//
// 규약: 이 파일만 생성. 공유 파일 수정 금지. SiteLayout import 금지(본문만 반환).
//   TS strict / any 금지 / Tailwind·브랜드 토큰만 / UI 한국어 / 모바일 반응형.
// ─────────────────────────────────────────────────────────────────────────
import { useMemo, type ReactNode } from 'react'
import { BRAND } from '@/lib/brand'
import { BarChart3, CalendarDays, Hash, Trophy } from 'lucide-react'
import { EmptyState, LottoBalls, SkeletonRows } from '@/design-system/components'
import { krw, date } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { LottoRound } from '@/types/db'
import { useRecentRounds } from './api'

const RECENT_COUNT = 20

// ── 홀짝 표기 정규화 ───────────────────────────────────────────────────────
// odd_even 컬럼은 자유 문자열일 수 있어(예: "홀3:짝3", "3:3") 그대로 노출하되,
// 비어 있으면 numbers 로 직접 계산해 "홀 n · 짝 m" 으로 폴백한다.
function oddEvenLabel(round: LottoRound): string {
  const raw = round.odd_even?.trim()
  if (raw) return raw
  const nums = Array.isArray(round.numbers) ? round.numbers : []
  const odd = nums.filter((n) => n % 2 === 1).length
  return `홀 ${odd} · 짝 ${nums.length - odd}`
}

// numbers 가 비정상(6개 미만)인 회차를 위한 안전한 합계.
function sumOf(round: LottoRound): number {
  if (typeof round.sum === 'number' && round.sum > 0) return round.sum
  const nums = Array.isArray(round.numbers) ? round.numbers : []
  return nums.reduce((acc, n) => acc + n, 0)
}

// ── 최다 출현 번호(불러온 회차 범위 내) ────────────────────────────────────
interface FreqItem {
  num: number
  count: number
}

function topNumbers(rounds: LottoRound[], top = 6): FreqItem[] {
  const freq = new Map<number, number>()
  for (const r of rounds) {
    const nums = Array.isArray(r.numbers) ? r.numbers : []
    for (const n of nums) freq.set(n, (freq.get(n) ?? 0) + 1)
  }
  return [...freq.entries()]
    .map(([num, count]) => ({ num, count }))
    .sort((a, b) => b.count - a.count || a.num - b.num)
    .slice(0, top)
}

// ── 요약 통계 카드(작은 박스) ──────────────────────────────────────────────
function StatBox({
  icon,
  label,
  value,
  sub,
}: {
  icon: ReactNode
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary-50 text-primary-600">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-gray-500">{label}</p>
        <p className="truncate text-[16px] font-extrabold tabular-nums text-ink-900">{value}</p>
        {sub && <p className="text-[11.5px] text-gray-400">{sub}</p>}
      </div>
    </div>
  )
}

export function DataPage() {
  const { data, isLoading, isError } = useRecentRounds(RECENT_COUNT)
  const rounds = useMemo<LottoRound[]>(() => data ?? [], [data])
  const latest = rounds[0]
  const freq = useMemo(() => topNumbers(rounds), [rounds])

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-8 sm:px-6 sm:py-10">
      {/* ── 페이지 헤더 ──────────────────────────────────────── */}
      <header className="mb-7">
        <p className="mb-1 text-[12.5px] font-bold uppercase tracking-wide text-primary-600">
          {BRAND.name}자료
        </p>
        <h1 className="text-[26px] font-extrabold tracking-tight text-ink-900 sm:text-[30px]">
          회차별 당첨번호
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-gray-500">
          최근 회차의 당첨번호와 1등 당첨금을 한눈에 확인하세요. 자료는 추첨 결과를 기준으로
          제공됩니다.
        </p>
      </header>

      {/* ── 로딩 ──────────────────────────────────────────────── */}
      {isLoading && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <SkeletonRows rows={8} cols={4} />
        </div>
      )}

      {/* ── 에러(또는 데이터 없음) ─────────────────────────────── */}
      {!isLoading && (isError || rounds.length === 0) && (
        <div className="rounded-xl border border-gray-200 bg-white">
          <EmptyState
            title={isError ? '자료를 불러오지 못했습니다' : '등록된 회차 자료가 없습니다'}
            description={
              isError
                ? '일시적인 오류로 당첨번호를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.'
                : '추첨 결과가 등록되면 회차별 당첨번호가 이곳에 표시됩니다.'
            }
          />
        </div>
      )}

      {/* ── 본문 ──────────────────────────────────────────────── */}
      {!isLoading && !isError && rounds.length > 0 && latest && (
        <div className="space-y-8">
          {/* 최신 회차 하이라이트 */}
          <section
            className="rounded-xl border border-primary-100 bg-primary-50/60 p-5 sm:p-6"
            aria-label={`${latest.round_no}회 당첨번호`}
          >
            <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="rounded-full bg-primary-600 px-2.5 py-1 text-[12px] font-bold text-white">
                최신 {latest.round_no}회
              </span>
              <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-gray-500">
                <CalendarDays className="h-4 w-4 text-gray-400" />
                <span className="font-mono tabular-nums">{date(latest.draw_date)}</span> 추첨
              </span>
            </div>

            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <LottoBalls
                numbers={latest.numbers}
                bonus={latest.bonus}
                size="lg"
                className="flex-wrap gap-1.5"
              />
              <dl className="grid grid-cols-3 gap-3 sm:max-w-md sm:flex-1">
                <div className="rounded-lg bg-white px-3 py-2.5 text-center">
                  <dt className="text-[11.5px] font-semibold text-gray-500">번호 합계</dt>
                  <dd className="text-[18px] font-extrabold tabular-nums text-ink-900">
                    {sumOf(latest)}
                  </dd>
                </div>
                <div className="rounded-lg bg-white px-3 py-2.5 text-center">
                  <dt className="text-[11.5px] font-semibold text-gray-500">홀짝</dt>
                  <dd className="text-[14px] font-extrabold text-ink-900">{oddEvenLabel(latest)}</dd>
                </div>
                <div className="rounded-lg bg-white px-3 py-2.5 text-center">
                  <dt className="text-[11.5px] font-semibold text-gray-500">1등 당첨금</dt>
                  <dd className="text-[13.5px] font-extrabold tabular-nums text-accent-600">
                    {krw(latest.prize_1)}
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          {/* 간단 통계 요약 */}
          <section aria-label="요약 통계">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatBox
                icon={<Hash className="h-5 w-5" />}
                label="수록 회차"
                value={`${rounds.length}회`}
                sub={`${rounds[rounds.length - 1]?.round_no}회 ~ ${latest.round_no}회`}
              />
              <StatBox
                icon={<BarChart3 className="h-5 w-5" />}
                label="평균 당첨번호 합"
                value={String(
                  Math.round(rounds.reduce((acc, r) => acc + sumOf(r), 0) / rounds.length),
                )}
                sub={`최근 ${rounds.length}회 기준`}
              />
              <StatBox
                icon={<Trophy className="h-5 w-5" />}
                label="최근 1등 당첨금"
                value={krw(latest.prize_1)}
                sub={`${latest.round_no}회`}
              />
            </div>

            {/* 최다 출현 번호 */}
            {freq.length > 0 && (
              <div className="mt-3 rounded-lg border border-gray-200 bg-white px-4 py-3.5">
                <p className="mb-2.5 text-[12.5px] font-bold text-gray-600">
                  최다 출현 번호{' '}
                  <span className="font-normal text-gray-400">(최근 {rounds.length}회)</span>
                </p>
                <ul className="flex flex-wrap items-center gap-3">
                  {freq.map((f) => (
                    <li key={f.num} className="flex items-center gap-1.5">
                      <LottoBalls numbers={[f.num]} size="sm" />
                      <span className="font-mono text-[12px] font-semibold tabular-nums text-gray-500">
                        {f.count}회
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* 회차별 당첨번호 표 */}
          <section aria-label="회차별 당첨번호">
            <h2 className="mb-3 text-[18px] font-extrabold text-ink-900">전체 회차</h2>

            {/* 데스크탑: 표 */}
            <div className="hidden overflow-hidden rounded-xl border border-gray-200 bg-white md:block">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-[12.5px] font-bold text-gray-500">
                    <th className="px-4 py-3">회차</th>
                    <th className="px-4 py-3">추첨일</th>
                    <th className="px-4 py-3">당첨번호</th>
                    <th className="px-4 py-3 text-right">1등 당첨금</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rounds.map((r, i) => (
                    <tr
                      key={r.round_no}
                      className={cn('text-[13.5px]', i === 0 ? 'bg-primary-50/40' : 'hover:bg-gray-50')}
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-mono font-extrabold tabular-nums text-ink-900">
                        {r.round_no}회
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono tabular-nums text-gray-500">
                        {date(r.draw_date)}
                      </td>
                      <td className="px-4 py-3">
                        <LottoBalls
                          numbers={r.numbers}
                          bonus={r.bonus}
                          size="sm"
                          className="flex-wrap gap-1.5"
                        />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-mono font-bold tabular-nums text-accent-600">
                        {krw(r.prize_1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 모바일: 카드 리스트 */}
            <ul className="space-y-3 md:hidden">
              {rounds.map((r, i) => (
                <li
                  key={r.round_no}
                  className={cn(
                    'rounded-xl border bg-white p-4',
                    i === 0 ? 'border-primary-200 bg-primary-50/40' : 'border-gray-200',
                  )}
                >
                  <div className="mb-2.5 flex items-baseline justify-between">
                    <span className="font-mono text-[15px] font-extrabold tabular-nums text-ink-900">
                      {r.round_no}회
                    </span>
                    <span className="font-mono text-[12px] tabular-nums text-gray-400">
                      {date(r.draw_date)}
                    </span>
                  </div>
                  <LottoBalls
                    numbers={r.numbers}
                    bonus={r.bonus}
                    size="md"
                    className="flex-wrap gap-1.5"
                  />
                  <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-2.5">
                    <span className="text-[12px] font-semibold text-gray-500">1등 당첨금</span>
                    <span className="font-mono text-[13px] font-bold tabular-nums text-accent-600">
                      {krw(r.prize_1)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <p className="text-center text-[11.5px] leading-relaxed text-gray-400">
            당첨번호 자료는 추첨 결과를 기준으로 제공되며, 본 서비스는 당첨을 보장하지 않습니다.
          </p>
        </div>
      )}
    </div>
  )
}
