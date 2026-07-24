// 특허적용 제외수 로직 (김형준 이사 전달 "특허적용 제외수 로직.docx", 현장 피드백 7/23).
// 실버(goldp)·골드(vip)·다이아(royal) 3개 유료등급 전용 — 통계 제외수 엔진(computeExclusions/
// passesQuality, lottoGenerator.ts)과는 완전히 별도 경로로 동작한다. 그 외 등급(무료·간편가입·
// 등급미정(gold)·토스DB 등)의 발급 조합은 기존 로직을 그대로 유지 — 이 파일은 아무 영향도 주지 않는다.
//
// 문서 요약(등급별):
//  실버(goldp) — 최근 10회차, 자동 제외 5개. 필터: 번호합(100~175)·홀짝(3:3/4:2/2:4).
//  골드(vip)   — 최근 30회차, 자동 제외 8개. 필터: 실버 필터 + 연번제한(0~2쌍)·구간균등배분(구간당 최대 3)
//                + 이월수제한(직전회차 번호 0~2개).
//  다이아(royal) — 역대 전회차, 자동 제외 12개. 필터: 골드 필터 + 끝수중복제한(동일 끝자리 0~2개).
//
// 제외수 산정(①②는 3등급 공통 점수표):
//  ① 과열(고빈도) 점수 — 분석 창(window) 내 출현율 40%↑50점·30~39%35점·20~29%20점·10~19%5점·0회0점.
//  ② 장기 미출현(gap) 점수 — 연속 미출현 15회차↑50점·10~14회35점·5~9회20점·2~4회5점·직전출현(0회)0점.
//     gap=1(직전 1회차만 쉼)은 문서에 경계가 없어 0점으로 처리(ASSUMPTIONS.md 기록).
//  ③ 총점(①+②) 상위 N개를 제외수로 채택. N번째와 N+1번째가 동점이면 경계가 모호하므로 분석
//     창을 10회차씩 늘려(문서 "20회차→30회차… 10회차씩 더 긁어와서") 재계산 — 명확히 갈릴 때까지 반복.
//
// ⚠️ 확률 정직성(lottoGenerator.ts 와 동일 원칙): 6/45 모든 조합의 1등 확률은 동일하다. 이 모듈은
// 문서의 필터 기준으로 '제시할 조합을 선별'할 뿐 당첨 확률을 높인다고 단언하지 않는다.
import type { Grade, LottoExcludeSettings, LottoRound } from '@/types/db'
import { LOTTO_MAX, LOTTO_MIN, LOTTO_PICK } from './lotto'
import {
  consecutivePairCount,
  decadeBucket,
  drawCombo,
  generateRandomSets,
  key as comboKey,
  makeRng,
  maxConsecutiveRun,
  oddCount,
  sortedRoundsDesc,
  generateIssueSets,
} from './lottoGenerator'

export type PatentGrade = 'goldp' | 'vip' | 'royal'
export const PATENT_GRADES: readonly PatentGrade[] = ['goldp', 'vip', 'royal']
export const PATENT_GRADE_LABEL: Record<PatentGrade, string> = { goldp: '실버', vip: '골드', royal: '다이아' }

export function isPatentGrade(grade: Grade | null | undefined): grade is PatentGrade {
  return grade === 'goldp' || grade === 'vip' || grade === 'royal'
}

const ALL_NUMBERS: readonly number[] = Array.from(
  { length: LOTTO_MAX - LOTTO_MIN + 1 },
  (_, i) => i + LOTTO_MIN,
)

interface PatentFilters {
  sumBand: boolean // 번호합 100~175
  oddEven343: boolean // 홀짝 3:3 또는 4:2/2:4
  consecutivePairMax2: boolean // 연번 0~2쌍(3쌍 이상 제외)
  segmentMax3: boolean // 5구간 중 한 구간 4개 이상 쏠림 제외
  carryoverMax2: boolean // 직전회차 번호(이월수) 0~2개(3개 이상 제외)
  lastDigitMax2: boolean // 끝수(일의 자리) 동일 0~2개(3개 이상 제외)
}

interface PatentGradeConfig {
  window: number | 'all'
  excludeCount: number
  filters: PatentFilters
}

const SILVER_FILTERS: PatentFilters = {
  sumBand: true,
  oddEven343: true,
  consecutivePairMax2: false,
  segmentMax3: false,
  carryoverMax2: false,
  lastDigitMax2: false,
}
const GOLD_FILTERS: PatentFilters = { ...SILVER_FILTERS, consecutivePairMax2: true, segmentMax3: true, carryoverMax2: true }
const DIAMOND_FILTERS: PatentFilters = { ...GOLD_FILTERS, lastDigitMax2: true }

const PATENT_CONFIG: Record<PatentGrade, PatentGradeConfig> = {
  goldp: { window: 10, excludeCount: 5, filters: SILVER_FILTERS }, // 실버
  vip: { window: 30, excludeCount: 8, filters: GOLD_FILTERS }, // 골드
  royal: { window: 'all', excludeCount: 12, filters: DIAMOND_FILTERS }, // 다이아
}

// ── ①②점수표 ────────────────────────────────────────────────────────
function freqScore(ratio: number): number {
  if (ratio >= 0.4) return 50
  if (ratio >= 0.3) return 35
  if (ratio >= 0.2) return 20
  if (ratio >= 0.1) return 5
  return 0
}

function gapScore(gap: number): number {
  if (gap >= 15) return 50
  if (gap >= 10) return 35
  if (gap >= 5) return 20
  if (gap >= 2) return 5
  return 0 // gap 0(직전출현)·1(경계 미명시, 0점 처리)
}

interface NumberScore {
  number: number
  freq: number
  gap: number
  total: number
}

/** roundsDesc(최신순) 중 앞 windowSize개로 번호별 ①②점수를 계산. */
function scoreWindow(roundsDesc: readonly LottoRound[], windowSize: number): NumberScore[] {
  const win = roundsDesc.slice(0, windowSize)
  const n = win.length
  const out: NumberScore[] = []
  for (let num = LOTTO_MIN; num <= LOTTO_MAX; num++) {
    let appear = 0
    let gap = n // 창 안에서 못 찾으면 '한 번도 안 나옴' = 최대 gap
    for (let i = 0; i < n; i++) {
      if (win[i].numbers.includes(num)) {
        appear++
        if (gap === n) gap = i
      }
    }
    const ratio = n > 0 ? appear / n : 0
    const freq = freqScore(ratio)
    const gapPts = gapScore(gap)
    out.push({ number: num, freq, gap: gapPts, total: freq + gapPts })
  }
  return out
}

/**
 * ③ 점수 상위 excludeCount개 산정. N/N+1위 동점이면 창을 10회차씩 늘려 재계산 — window 는
 * 매 반복 +10 회차씩만 늘고 maxAvailable 을 넘지 못하므로(canGrow=false 시 즉시 반환) 유한 횟수
 * 내 항상 종료한다(별도 반복 한도 불필요 — 임의 상한을 두면 실제 회차가 많을 때 조기 종료될 수 있음).
 */
function computeExcludeSet(
  roundsDesc: readonly LottoRound[],
  baseWindow: number | 'all',
  excludeCount: number,
  fixedSet: ReadonlySet<number>,
): { excluded: number[]; window: number } {
  const maxAvailable = roundsDesc.length
  let window = baseWindow === 'all' ? maxAvailable : Math.min(baseWindow, maxAvailable)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const scores = scoreWindow(roundsDesc, window).filter((s) => !fixedSet.has(s.number))
    const sorted = [...scores].sort((a, b) => b.total - a.total || a.number - b.number)
    const cutoff = sorted[excludeCount - 1]?.total ?? 0
    const next = sorted[excludeCount]?.total
    const tiedAtBoundary = next !== undefined && next === cutoff
    const canGrow = baseWindow !== 'all' && window < maxAvailable
    if (!tiedAtBoundary || !canGrow) {
      return { excluded: sorted.slice(0, excludeCount).map((s) => s.number), window }
    }
    window = Math.min(window + 10, maxAvailable)
  }
}

// ── 조합 필터(등급별 가산 스택) ──────────────────────────────────────────
function passesPatentFilters(
  asc: readonly number[],
  filters: PatentFilters,
  prevNumbers: readonly number[],
  relaxed: boolean,
): boolean {
  if (relaxed) return maxConsecutiveRun(asc) < LOTTO_PICK // 완화: 6연번만 회피(풀 고갈 시 최소 안전장치)

  if (filters.sumBand) {
    const total = asc.reduce((a, n) => a + n, 0)
    if (total < 100 || total > 175) return false
  }
  if (filters.oddEven343) {
    const odd = oddCount(asc)
    if (odd !== 2 && odd !== 3 && odd !== 4) return false // 3:3·4:2·2:4 만 허용
  }
  if (filters.consecutivePairMax2 && consecutivePairCount(asc) >= 3) return false
  if (filters.segmentMax3) {
    const counts = new Map<number, number>()
    for (const n of asc) counts.set(decadeBucket(n), (counts.get(decadeBucket(n)) ?? 0) + 1)
    if (Math.max(...counts.values()) >= 4) return false
  }
  if (filters.carryoverMax2) {
    const overlap = asc.filter((n) => prevNumbers.includes(n)).length
    if (overlap >= 3) return false
  }
  if (filters.lastDigitMax2) {
    const counts = new Map<number, number>()
    for (const n of asc) counts.set(n % 10, (counts.get(n % 10) ?? 0) + 1)
    if (Math.max(...counts.values()) >= 3) return false
  }
  return true
}

function generatePatentCombos(
  pool: readonly number[],
  fixed: readonly number[],
  count: number,
  rng: () => number,
  filters: PatentFilters,
  prevNumbers: readonly number[],
  pastSets: ReadonlySet<string>,
): { sets: number[][]; relaxed: boolean } {
  const out: number[][] = []
  const used = new Set<string>()
  let relaxed = false
  const TRY_PER_SET = 400
  while (out.length < count) {
    let placed = false
    for (let attempt = 0; attempt < TRY_PER_SET; attempt++) {
      const combo = drawCombo(pool, fixed, rng)
      const k = comboKey(combo)
      if (used.has(k) || pastSets.has(k)) continue
      if (passesPatentFilters(combo, filters, prevNumbers, relaxed)) {
        out.push(combo)
        used.add(k)
        placed = true
        break
      }
    }
    if (!placed) {
      if (!relaxed) {
        relaxed = true
        continue
      }
      break // 완화로도 새 조합을 못 뽑으면(풀 고갈) 종료 — 지금까지 만든 것만 반환.
    }
  }
  return { sets: out, relaxed }
}

export interface PatentGenerateResult {
  sets: number[][]
  excluded: number[] // 최종 제외수(자동+수동 합, 오름차순)
  autoExcluded: number[] // 문서 알고리즘이 산정한 자동 제외수만(오름차순, 점수 높은 순)
  window: number // 실제 사용된 분석 회차 수(동점 확장 반영)
  fixed: number[] // 적용된 수동 고정수
  pool: number[] // 남은 풀(오름차순)
  targetRound: number
  prevRound: number | null
  prevNumbers: number[] | null
  prevBonus: number | null
  relaxed: boolean // 풀·필터가 좁아 완화 모드로 넘어갔는지(감사기록용)
}

/** 문서 알고리즘으로 등급별 자동 제외수 산정 + 조합 생성. manual 은 §V2-5 수동 고정/제외(그대로 존중). */
export function generatePatentSets(
  rounds: readonly LottoRound[],
  grade: PatentGrade,
  manual: LottoExcludeSettings,
  setCount: number,
  seed?: number,
): PatentGenerateResult {
  const cfg = PATENT_CONFIG[grade]
  const desc = sortedRoundsDesc(rounds)
  const prev = desc[0] ?? null
  const targetRound = prev ? prev.round_no + 1 : 1
  const fixed = manual.fixed.filter((n) => n >= LOTTO_MIN && n <= LOTTO_MAX).slice(0, LOTTO_PICK)
  const fixedSet = new Set(fixed)

  const { excluded: autoExcluded, window } = computeExcludeSet(desc, cfg.window, cfg.excludeCount, fixedSet)
  const excludedSet = new Set<number>([...autoExcluded, ...manual.excluded])
  for (const f of fixedSet) excludedSet.delete(f) // 수동 고정수는 어떤 경로로도 제외되지 않는다.

  let pool = ALL_NUMBERS.filter((n) => !excludedSet.has(n))
  if (pool.length < LOTTO_PICK) {
    // 풀 하한 방어(lottoGenerator.generateRecommendation 과 동일 원칙) — 수동 제외는 유지,
    // 자동 제외 중 점수가 약한(목록 뒤쪽) 것부터 되돌린다. 45−12=33 이 최소 풀이라 실질적으론 도달하지 않는다.
    const manualSet = new Set(manual.excluded)
    const droppable = autoExcluded.filter((n) => !manualSet.has(n))
    while (pool.length < LOTTO_PICK && droppable.length) {
      const back = droppable.pop()!
      excludedSet.delete(back)
      pool = ALL_NUMBERS.filter((n) => !excludedSet.has(n))
    }
  }

  const prevNumbers = prev ? [...prev.numbers].sort((a, b) => a - b) : []
  const pastSets = new Set(rounds.map((r) => comboKey(r.numbers)))
  const rng = makeRng(seed ?? (Date.now() & 0xffffffff))
  const { sets, relaxed } =
    pool.length >= LOTTO_PICK
      ? generatePatentCombos(pool, fixed, Math.max(1, setCount), rng, cfg.filters, prevNumbers, pastSets)
      : { sets: [] as number[][], relaxed: false }

  return {
    sets,
    excluded: [...excludedSet].sort((a, b) => a - b),
    autoExcluded,
    window,
    fixed,
    pool,
    targetRound,
    prevRound: prev?.round_no ?? null,
    prevNumbers: prev ? prevNumbers : null,
    prevBonus: prev?.bonus ?? null,
    relaxed,
  }
}

/**
 * 발급 조합(등급 인지) — 실버·골드·다이아는 특허 제외수 로직, 그 외 등급은 기존 통계 로직(lottoGenerator).
 * 모든 발급 경로(주간 자동·수동 발급·등급 일괄발급·추천문자 즉석발급)가 grade 를 알고 있으므로
 * generateIssueSets 대신 이 함수를 호출하면 등급별 로직이 자동으로 갈린다.
 */
export function generateIssueSetsForGrade(
  rounds: readonly LottoRound[],
  grade: Grade,
  exclude: LottoExcludeSettings,
  count: number,
  logicRatio = 100,
  seed?: number,
): number[][] {
  if (!isPatentGrade(grade)) return generateIssueSets(rounds, exclude, count, logicRatio, seed)
  const total = Math.max(1, count)
  const ratio = Math.max(0, Math.min(100, Math.round(logicRatio)))
  const logicCount = Math.max(0, Math.min(total, Math.round((total * ratio) / 100)))
  const sets = logicCount > 0 ? generatePatentSets(rounds, grade, exclude, logicCount, seed).sets : []
  const randomCount = total - sets.length
  if (randomCount > 0) sets.push(...generateRandomSets(randomCount, new Set(sets.map(comboKey))))
  return sets
}
