// 등급색 기본값 = design-system/tokens.css 의 --g-{grade}/--g-{grade}-bg 와 같은 값.
// site_settings.grade_colors 는 등급이 늘기 전에 저장된 행일 수 있다(예: 10/12 루비 추가 전 저장).
// 누락 키를 기본값으로 채워 설정 화면 검증(전 등급 필수)과 편집기가 깨지지 않게 한다.
import type { Grade, GradeColorMap } from '@/types/db'

export const DEFAULT_GRADE_COLORS: GradeColorMap = {
  free: { fg: '#94a3b8', bg: '#eef1f5' },
  simple: { fg: '#64748b', bg: '#eaedf2' },
  gold: { fg: '#c99700', bg: '#fbf2d2' },
  goldp: { fg: '#b45309', bg: '#fbebd9' },
  ruby: { fg: '#be185d', bg: '#fce7f3' },
  vip: { fg: '#0f9d6b', bg: '#e3f6ee' },
  royal: { fg: '#7c3aed', bg: '#f1eafe' },
  ovr: { fg: '#0f1420', bg: '#e5e7eb' },
  toss: { fg: '#0ea5e9', bg: '#e4f4fd' },
}

export function normalizeGradeColors(raw: Partial<GradeColorMap> | null | undefined): GradeColorMap {
  const out = structuredClone(DEFAULT_GRADE_COLORS)
  for (const g of Object.keys(out) as Grade[]) {
    const c = raw?.[g]
    if (c && typeof c.fg === 'string' && typeof c.bg === 'string') out[g] = { fg: c.fg, bg: c.bg }
  }
  return out
}
