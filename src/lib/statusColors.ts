// 회원·결제 상태 뱃지 색 기본값/정규화 (현장 피드백 8/3 — "회원 상태별 색깔도 설정에서 변경, 예) 취소 > 빨강").
// GradeColorMap 은 등급마다 이미 고유 색이라 톤 공유가 없지만, 상태(StatusKey)는 여러 값이 같은
// 톤(success/danger/gray 등)을 공유한다(§3) — "취소"만 골라 빨강으로 바꾸려면 톤이 아니라 상태값별로
// 저장해야 한다. 저장된 값에 없는 키는 기존 톤 기본색(tokens.css 값)으로 채운다.
import type { StatusColorMap } from '@/types/db'
import { STATUS_META, type StatusKey } from '@/design-system/labels'

export const STATUS_KEY_ORDER: readonly StatusKey[] = [
  'active',
  'suspended',
  'deleted',
  'withdrawn',
  'expired',
  'wait',
  'approved',
  'failed',
  'cancelled',
]

// tokens.css 의 --success/--warning/--danger/--gray-500 등과 동일한 hex(§3) — 커스터마이즈 전 초기값 겸 폴백.
const TONE_DEFAULT: Record<string, { fg: string; bg: string }> = {
  success: { fg: '#16A34A', bg: '#E7F6EE' },
  warning: { fg: '#D97706', bg: '#FEF3E2' },
  danger: { fg: '#DC2626', bg: '#FCEBEB' },
  info: { fg: '#0EA5E9', bg: '#E6F6FE' },
  gray: { fg: '#6B7585', bg: '#EDF0F4' },
  stop: { fg: '#DC2626', bg: '#FCEBEB' },
}

export function defaultStatusColors(): StatusColorMap {
  const out: StatusColorMap = {}
  for (const key of STATUS_KEY_ORDER) out[key] = { ...TONE_DEFAULT[STATUS_META[key].tone] }
  return out
}

/** 저장된 값에 없는 키는 톤 기본색으로 채워 항상 모든 키가 채워진 맵을 반환한다. */
export function normalizeStatusColors(raw: StatusColorMap | null | undefined): StatusColorMap {
  const base = defaultStatusColors()
  if (!raw) return base
  for (const key of STATUS_KEY_ORDER) if (raw[key]) base[key] = raw[key]!
  return base
}
