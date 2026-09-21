// 서버 sms_is_legacy_import_held와 같은 이관 검수 보류 조건. 최종 발송 차단은 서버가 담당한다.
// 사이트 목록은 legacySites.ts 한 곳에서만 정의한다 — 예전엔 여기 따로 적혀 있어서 사이트를
// 추가할 때 한쪽만 고쳐질 위험이 있었다(api/send-sms.ts 는 src import 가 불가해 별도 복제 +
// scripts/tests/legacy-site-list-sync.test.ts 가 두 목록의 일치를 강제한다).
import { LEGACY_SITE_KEYS } from './legacySites'

export function isLegacyImportHeld(meta: Record<string, unknown> | null | undefined): boolean {
  return typeof meta?.source_site === 'string'
    && LEGACY_SITE_KEYS.has(meta.source_site)
    && meta.reco_pause_reason === 'legacy_import_review'
    && meta.reco_paused === true
}

export function assertNoLegacyImportHold(members: readonly { meta?: Record<string, unknown> | null }[]): void {
  if (members.some((member) => isLegacyImportHeld(member.meta))) {
    throw new Error('이관 검수 중인 회원이 포함되어 조합 발급·문자 발송을 보류했습니다. 검수 대상은 선택에서 제외해 주세요.')
  }
}
