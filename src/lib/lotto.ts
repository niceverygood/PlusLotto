// 로또(6/45) 순수 도메인 로직 — React/UI 비의존. seed(lib) 와 features/lotto 가 함께 import 해
// '시드 생성'과 '당첨 확정'이 동일한 규칙으로 등수/당첨금을 산정하도록 단일 출처로 둔다.
import type { Grade, LottoExcludeRule, LottoExcludeSettings, LottoRound, SiteSettings } from '@/types/db'

export const LOTTO_MIN = 1
export const LOTTO_MAX = 45
export const LOTTO_PICK = 6

// 고정/제외수를 운영하는 등급(현장 피드백 2026-06, 실버 추가는 7/23 특허 제외수 로직 도입 시).
// vip=고객화면 '골드', royal='다이아', goldp='실버'(D95 고객명 변경). gold(구 내부 등급)는 신규 부여가
// 없는 하위호환 전용 등급이라 등급 지정 목록에서 제외한다(현장 피드백 7/27 — 목록에 4개가 보여 혼란).
// goldp·vip·royal 3등급은 lib/lottoPatentExclude.ts 의 특허 제외수 로직이 자동 적용된다(§8).
export const LOTTO_RULE_GRADES: Grade[] = ['goldp', 'vip', 'royal']

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 등급별 활성 고정/제외 규칙 = effective_from<=오늘 중 가장 최근. 해당 등급 규칙이 없으면
// 공통(grade=null) → 그것도 없으면 레거시 lotto_exclude 스냅샷으로 폴백(현장 피드백).
// lib 에 두는 이유: 추천(lotto)·수동발급(members) 두 feature 가 공유(§2 feature 간 직접 import 금지).
export function resolveExcludeForGrade(
  settings: Pick<SiteSettings, 'lotto_exclude' | 'lotto_exclude_history'>,
  grade: Grade | null,
): LottoExcludeSettings {
  const today = todayStr()
  // 동일 회차·등급·시작일로 재등록한 경우 created_at 을 최종 타이브레이커로 둔다 — 아니면
  // 나중에 등록한 규칙이 실제 조합 생성에 반영되지 않는 오류가 난다(현장 피드백 7/27).
  const effective = (settings.lotto_exclude_history ?? [])
    .filter((r) => r.effective_from <= today)
    .sort(
      (a, b) =>
        b.effective_from.localeCompare(a.effective_from) ||
        b.round_no - a.round_no ||
        b.created_at.localeCompare(a.created_at),
    )
  const pick = (g: Grade | null): LottoExcludeRule | undefined =>
    effective.find((r) => (r.grade ?? null) === g)
  const rule = (grade != null ? pick(grade) : undefined) ?? pick(null)
  return rule ? { fixed: rule.fixed, excluded: rule.excluded } : settings.lotto_exclude
}

/** 6개 번호 합. */
export function lottoSum(numbers: readonly number[]): number {
  return numbers.reduce((a, n) => a + n, 0)
}

/** "홀:짝" 문자열 (예: "3:3"). */
export function oddEven(numbers: readonly number[]): string {
  const odd = numbers.filter((n) => n % 2 === 1).length
  return `${odd}:${numbers.length - odd}`
}

/** 당첨번호와 일치하는 개수. */
export function matchCount(bet: readonly number[], win: readonly number[]): number {
  const set = new Set(win)
  return bet.reduce((c, n) => (set.has(n) ? c + 1 : c), 0)
}

/**
 * 베팅 등수 판정 (6/45 표준 규칙).
 * 1등 6 / 2등 5+보너스 / 3등 5 / 4등 4 / 5등 3 / 그외 null(미당첨).
 */
export function gradeRank(
  bet: readonly number[],
  win: readonly number[],
  bonus: number,
): number | null {
  const m = matchCount(bet, win)
  if (m === 6) return 1
  if (m === 5) return bet.includes(bonus) ? 2 : 3
  if (m === 4) return 4
  if (m === 3) return 5
  return null
}

// TODO(live-verify): prize_1/2/3 을 '1인당 당첨금'으로 간주. 4·5등은 고정금으로 가정(원본 규칙 확인 필요).
const FIXED_PRIZE: Record<number, number> = { 4: 50000, 5: 5000 }

/** 등수 → 당첨금. 미당첨(null)은 null. */
export function prizeForRank(
  round: Pick<LottoRound, 'prize_1' | 'prize_2' | 'prize_3'>,
  rank: number | null,
): number | null {
  if (rank == null) return null
  if (rank === 1) return round.prize_1 ?? 0
  if (rank === 2) return round.prize_2 ?? 0
  if (rank === 3) return round.prize_3 ?? 0
  return FIXED_PRIZE[rank] ?? 0
}

export const RANK_LABEL: Record<number, string> = {
  1: '1등',
  2: '2등',
  3: '3등',
  4: '4등',
  5: '5등',
}

/** 당첨번호 표시용 등수 라벨(미당첨 포함). */
export function rankLabel(rank: number | null): string {
  return rank == null ? '미당첨' : RANK_LABEL[rank]
}
