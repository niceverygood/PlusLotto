// 등급색 런타임 토큰 오버라이드 (CLAUDE §3 / DECISIONS D2).
// tailwind.config.ts 는 grade-* 유틸을 tokens.css 의 --g-{grade}/--g-{grade}-bg CSS 변수로
// 매핑한다. 설정(site_settings.grade_colors)에서 바꾼 색을 document root 에 setProperty 하면
// 전 화면 <Badge grade>·도트가 즉시 반영된다(Phase 10 검수: "등급색 변경이 전 화면 Badge 에 반영").
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Grade, GradeColorMap, MembershipTier } from '@/types/db'
import { GRADE_LABEL } from '@/design-system/labels'
import { readDb } from './db/store'
import { dataSource } from './supabase'
import { fetchSiteSettings } from './db/remote'
import { settingsKeys } from './queryKeys'
import { resolveTiers, tierLabelMap } from './membership'

// Grade 키가 곧 토큰 접미사(--g-free, --g-gold …)와 1:1 이므로 별도 매핑 불필요.
export function applyGradeColors(colors: GradeColorMap): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const g of Object.keys(colors) as Grade[]) {
    const c = colors[g]
    if (!c) continue
    root.style.setProperty(`--g-${g}`, c.fg)
    root.style.setProperty(`--g-${g}-bg`, c.bg)
  }
}

// 멤버십 등급 명칭(membership_tiers.label) → 전산 GRADE_LABEL 로 전파(전역 등급명 변경, 6/30 차장).
// 운영자가 설정에서 라벨을 바꾸면 settingsKeys.site 무효화 → 재적용 → 전 화면 <Badge>·필터·드롭다운 반영.
// 고객사이트(anon)는 site_settings 를 못 읽으므로(비밀 보호) 여기서 적용 안 되고, 고객 페이지는 RPC 라벨을 직접 쓴다.
export function applyGradeLabels(tiers: MembershipTier[] | null | undefined): void {
  Object.assign(GRADE_LABEL, tierLabelMap(resolveTiers(tiers)))
}

/**
 * 앱 전역에서 1회 마운트(providers). 저장된 등급색을 읽어 토큰에 적용하고,
 * 설정 저장으로 settingsKeys.site 가 무효화되면 재적용한다.
 * lib 단독 의존(readDb 직접 읽기 — feature import 금지 §2)으로 settings feature 와 분리.
 */
export function useGradeColorSync(): void {
  const { data } = useQuery({
    queryKey: settingsKeys.site(),
    queryFn: async () =>
      dataSource === 'supabase' ? await fetchSiteSettings() : readDb().site_settings,
  })
  useEffect(() => {
    if (data) {
      applyGradeColors(data.grade_colors)
      applyGradeLabels(data.membership_tiers)
    }
  }, [data])
}
