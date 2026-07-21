import type { GenerationRecord, Grade } from '@/types/db'
import { genId, nowIso } from '@/lib/db/store'
import type { GenerateResult } from '@/lib/lottoGenerator'

interface GenerationRecordContext {
  createdBy: string | null
  grade: Grade | null
  source: NonNullable<GenerationRecord['source']>
  setCount?: number
  logicRatio?: number
  issuedCount?: number
}

/** 특정 조합은 버리고 회차·등급 전체에 공통인 제외 로직만 스냅샷으로 만든다. */
export function makeGenerationRecord(
  result: GenerateResult,
  context: GenerationRecordContext,
): GenerationRecord {
  return {
    id: genId('genrec'),
    created_at: nowIso(),
    created_by: context.createdBy,
    grade: context.grade,
    target_round: result.targetRound,
    mode: result.mode,
    source: context.source,
    fixed: result.fixed,
    excluded: result.excluded,
    reasons: result.reasons,
    stages: result.stages,
    pool: result.pool,
    basis: result.basis,
    set_count: context.setCount,
    logic_ratio: context.logicRatio,
    issued_count: context.issuedCount,
  }
}

/** 회차+등급당 최신 한 건만 유지해 '특정 실행 목록'이 아닌 회차별 분석표로 만든다. */
export function upsertGenerationRecord(
  records: readonly GenerationRecord[] | undefined,
  next: GenerationRecord,
): GenerationRecord[] {
  return [
    next,
    ...(records ?? []).filter(
      (record) => record.target_round !== next.target_round || (record.grade ?? null) !== (next.grade ?? null),
    ),
  ].sort((a, b) => b.target_round - a.target_round || b.created_at.localeCompare(a.created_at))
}
