// 고정수 추천 스코어링 엔진 (문서 "고정수 로직.docx", 현장 7/9 정의현 차장 전달).
// 5개 항목 가중점수(최근20회 30·최근100회 25·미출현간격 20·전체출현 15·동반출현 10, 합 100)로
// 1~45번 전체 점수를 계산해 상위 N개를 고정수 후보로 제시한다. React/데이터fetch 비의존(순수 함수).
// 운영은 여전히 §V2-5(회차별 고정/제외 이력+효력일자)로 담당자가 직접 입력 — 이 모듈은
// '점수 기준 추천값 표시'까지만 하고, 자동으로 등급에 적용하지 않는다(현장 확인 전까지).
// TODO(live-verify): 문서에 정확한 경계가 없어 아래 2곳은 합리적으로 해석함(docs/ASSUMPTIONS.md).
//   ① 전체출현 점수의 '평균 수준(7점)'/'하위권(3점)' 경계 — 21~33위/34~45위로 절반 분할
//   ② 동반출현 점수의 '매우많음/많음/보통/적음' 경계 — 45개 번호의 최다 동반출현 파트너 횟수 4분위
import type { LottoRound } from '@/types/db'
import { LOTTO_MAX, LOTTO_MIN } from './lotto'

export interface FixedScoreRow {
  number: number
  s20: number // 최근20회 출현점수(0~30)
  s100: number // 최근100회 출현점수(0~25)
  sGap: number // 미출현 간격점수(0~20)
  sTotal: number // 전체출현점수(0~15)
  sPartner: number // 동반출현점수(0~10)
  score: number // 합계(0~100)
  appear20: number // 참고: 실제 최근20회 출현횟수
  appear100: number // 참고: 실제 최근100회 출현횟수
  gapRounds: number // 참고: 미출현 간격(회차수)
  appearAll: number // 참고: 전체 누적 출현횟수
}

function scoreRecent20(count: number): number {
  if (count >= 5) return 30
  if (count === 4) return 25
  if (count === 3) return 20
  if (count === 2) return 10
  return 5 // 1회 이하
}
function scoreRecent100(count: number): number {
  if (count >= 18) return 25
  if (count >= 15) return 20
  if (count >= 12) return 15
  if (count >= 9) return 10
  return 5
}
function scoreGap(gap: number): number {
  if (gap >= 15) return 20
  if (gap >= 10) return 15
  if (gap >= 5) return 10
  if (gap >= 1) return 5
  return 0 // 직전 회차에 출현(간격 0) — 문서 표에 없어 최저 처리
}

/** 문서의 '고정수 로직'(5항목 가중점수)을 그대로 구현. rounds 순서는 무관(내부에서 정렬). */
export function computeFixedScores(rounds: LottoRound[]): FixedScoreRow[] {
  const sorted = [...rounds].sort((a, b) => a.round_no - b.round_no) // 오래된 → 최신
  const total = sorted.length
  const numbers = Array.from({ length: LOTTO_MAX - LOTTO_MIN + 1 }, (_, i) => i + LOTTO_MIN)

  const appearAll = new Map<number, number>()
  const appear100 = new Map<number, number>()
  const appear20 = new Map<number, number>()
  const lastSeenIdx = new Map<number, number>() // 마지막 출현의 배열 인덱스(0-base, 오래된→최신)
  const cooccur = new Map<number, Map<number, number>>() // n -> (partner -> 동반출현횟수)

  for (const n of numbers) {
    appearAll.set(n, 0)
    appear100.set(n, 0)
    appear20.set(n, 0)
    cooccur.set(n, new Map())
  }

  const recent100Start = Math.max(0, total - 100)
  const recent20Start = Math.max(0, total - 20)

  sorted.forEach((r, idx) => {
    const nums = r.numbers ?? []
    for (const n of nums) {
      if (!appearAll.has(n)) continue // 방어적(범위 밖 데이터 무시)
      appearAll.set(n, (appearAll.get(n) ?? 0) + 1)
      if (idx >= recent100Start) appear100.set(n, (appear100.get(n) ?? 0) + 1)
      if (idx >= recent20Start) appear20.set(n, (appear20.get(n) ?? 0) + 1)
      lastSeenIdx.set(n, idx)
      const m = cooccur.get(n) as Map<number, number>
      for (const p of nums) {
        if (p === n) continue
        m.set(p, (m.get(p) ?? 0) + 1)
      }
    }
  })

  // 전체출현 순위(내림차순) — 상위10=15점 / 11~20위=10점 / 21~33위=7점(추정) / 34~45위=3점(추정)
  const rankedByAppear = [...numbers].sort((a, b) => (appearAll.get(b) ?? 0) - (appearAll.get(a) ?? 0))
  const appearRank = new Map<number, number>()
  rankedByAppear.forEach((n, i) => appearRank.set(n, i + 1))
  function scoreTotalAppear(rank: number): number {
    if (rank <= 10) return 15
    if (rank <= 20) return 10
    if (rank <= 33) return 7
    return 3
  }

  // 동반출현: 번호별 '최다 동반출현 파트너 횟수' 를 45개 값의 4분위로 등급화
  const bestPartnerCount = new Map<number, number>()
  for (const n of numbers) {
    const m = cooccur.get(n) as Map<number, number>
    let best = 0
    for (const c of m.values()) if (c > best) best = c
    bestPartnerCount.set(n, best)
  }
  const sortedPartnerCounts = [...bestPartnerCount.values()].sort((a, b) => a - b)
  function quantileAt(p: number): number {
    const idx = Math.min(
      sortedPartnerCounts.length - 1,
      Math.max(0, Math.floor(p * (sortedPartnerCounts.length - 1))),
    )
    return sortedPartnerCounts[idx]
  }
  const q25 = quantileAt(0.25)
  const q50 = quantileAt(0.5)
  const q75 = quantileAt(0.75)
  function scorePartner(count: number): number {
    if (count >= q75) return 10
    if (count >= q50) return 7
    if (count >= q25) return 5
    return 2
  }

  const rows: FixedScoreRow[] = numbers.map((n) => {
    const a20 = appear20.get(n) ?? 0
    const a100 = appear100.get(n) ?? 0
    const aAll = appearAll.get(n) ?? 0
    const last = lastSeenIdx.get(n)
    const gapRounds = last == null ? total : total - 1 - last
    const partnerCount = bestPartnerCount.get(n) ?? 0

    const s20 = scoreRecent20(a20)
    const s100 = scoreRecent100(a100)
    const sGap = scoreGap(gapRounds)
    const sTotal = scoreTotalAppear(appearRank.get(n) ?? numbers.length)
    const sPartner = scorePartner(partnerCount)

    return {
      number: n,
      s20,
      s100,
      sGap,
      sTotal,
      sPartner,
      score: s20 + s100 + sGap + sTotal + sPartner,
      appear20: a20,
      appear100: a100,
      gapRounds,
      appearAll: aAll,
    }
  })

  return rows.sort((a, b) => b.score - a.score || a.number - b.number)
}

/** 상위 N개 번호(점수 내림차순)를 고정수 후보로. */
export function topFixedNumbers(rounds: LottoRound[], n: number): number[] {
  return computeFixedScores(rounds)
    .slice(0, n)
    .map((r) => r.number)
}
