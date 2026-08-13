// 이용자 목록 엑셀 내려받기 (현장 8/13, 정의현 차장 — "이용자 목록에서, 필터링된 결과값만
// 엑셀파일로 다운받을수 있도록").
//
// '필터링된 결과값'은 화면에 보이는 현재 페이지가 아니라 **필터에 걸린 전체**다. 목록은 서버
// 페이지네이션이라 내려받을 때 같은 필터로 전 페이지를 순회해 모은다(RPC 한 번 최대 1000행).
//
// xlsx 는 무겁기 때문에(~400KB) import.ts 와 같이 동적 로드해 메인 번들에서 뺀다.
import type { Member, Staff } from '@/types/db'
import { GRADE_LABEL, STATUS_META } from '@/design-system/labels'
import { datetime, phone } from '@/lib/format'
import { isMemberExpired, memberEndDate } from '@/lib/memberExpiry'

/** 내려받기 한 번에 모을 수 있는 최대 행 수 — 브라우저 메모리·대기시간 안전선. */
export const EXPORT_ROW_LIMIT = 50_000

function sheetRow(m: Member, staffName: (id: string | null) => string): Record<string, string | number> {
  const end = memberEndDate(m)
  return {
    ID: m.user_id,
    이름: m.name,
    닉네임: m.nickname ?? '',
    휴대폰: phone(m.phone),
    등급: GRADE_LABEL[m.grade] ?? m.grade,
    // 만료는 종료일에서 계산하는 표시 전용 상태(현장 8/13)라 상태 칸에 그대로 반영해 내보낸다.
    상태: isMemberExpired(m) ? '만료' : (STATUS_META[m.status]?.label ?? m.status),
    상담상태: m.consult_status ?? '',
    성향: m.tendency ?? '',
    담당: staffName(m.assigned_staff_id),
    유입구분: m.inflow_type ?? '',
    유입코드: m.inflow_code ?? '',
    메모: m.memo ?? '',
    당첨이력: m.win_history ?? '',
    아웃콜: m.outcall_done ? 'O' : '',
    종료일: end ? datetime(end) : '',
    가입일: datetime(m.registered_at),
    최근접속: m.last_active_at ? datetime(m.last_active_at) : '',
  }
}

/**
 * 회원 배열을 .xlsx 로 만들어 즉시 내려받는다.
 * 파일명에 적용된 뷰·검색어와 날짜를 넣어 어떤 조건으로 뽑은 파일인지 나중에 알아볼 수 있게 한다.
 */
export async function downloadMembersXlsx(
  rows: Member[],
  staff: readonly Staff[],
  label: string,
): Promise<void> {
  const XLSX = await import('xlsx')
  const nameById = new Map(staff.map((s) => [s.id, s.name]))
  const staffName = (id: string | null): string => (id ? (nameById.get(id) ?? id) : '미지정')

  const ws = XLSX.utils.json_to_sheet(rows.map((m) => sheetRow(m, staffName)))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '이용자')
  XLSX.writeFile(wb, `이용자_${sanitize(label)}_${today()}.xlsx`)
}

function sanitize(s: string): string {
  // 파일명에 못 쓰는 문자만 제거(한글은 그대로 — 현장이 파일명으로 조건을 알아본다).
  return s.replace(/[\\/:*?"<>|]/g, '').trim() || '전체'
}

function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replace(/-/g, '')
}
