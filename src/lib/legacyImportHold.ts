// 서버 sms_is_legacy_import_held와 같은 이관 검수 보류 조건. 최종 발송 차단은 서버가 담당한다.
const LEGACY_SITES = new Set(['lotto815', 'cplotto', 'infolotto'])

export function isLegacyImportHeld(meta: Record<string, unknown> | null | undefined): boolean {
  return typeof meta?.source_site === 'string'
    && LEGACY_SITES.has(meta.source_site)
    && meta.reco_pause_reason === 'legacy_import_review'
    && meta.reco_paused === true
}

export function assertNoLegacyImportHold(members: readonly { meta?: Record<string, unknown> | null }[]): void {
  if (members.some((member) => isLegacyImportHeld(member.meta))) {
    throw new Error('이관 검수 중인 회원이 포함되어 조합 발급·문자 발송을 보류했습니다. 검수 대상은 선택에서 제외해 주세요.')
  }
}
