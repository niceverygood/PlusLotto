// 유입구분은 엑셀/외부 DB에서 공백 포함 표기가 섞여 들어올 수 있다.
// 화면·mock·Supabase 입력/필터가 같은 정규형을 사용하도록 lib 한 곳에서 관리한다.
export const INFLOW_TYPES = ['신규', '하루전부재', '하루전거절', '이틀전', '삼일전', '구디비'] as const
export type InflowType = (typeof INFLOW_TYPES)[number]

const CANONICAL_BY_COMPACT = new Map<string, InflowType>(
  INFLOW_TYPES.map((value) => [value.replace(/\s+/g, ''), value]),
)

export function normalizeInflowType(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return CANONICAL_BY_COMPACT.get(trimmed.replace(/\s+/g, '')) ?? trimmed
}

export function sameInflowType(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeInflowType(a)
  const right = normalizeInflowType(b)
  return left != null && right != null && left === right
}
