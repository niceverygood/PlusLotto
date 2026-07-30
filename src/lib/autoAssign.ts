// 자동배분(자동할당) 분배 계획 — "가장 오래 배정을 못 받은 담당자부터" 라는 한 가지 규칙으로
// 매 호출 순서를 배정 이력(assignments)에서 새로 도출한다. mock(features/members/api.ts)·
// supabase(features/members/supa.ts) 두 경로가 같은 규칙을 쓰도록 순수 함수로 lib/ 에 둔다
// (§2 — feature 간 직접 import 금지). React/Query/Storage 어디에도 의존하지 않는 순수 계산이라
// 별도 실행(시뮬레이션)만으로 분배 결과를 그대로 검증할 수 있다.
//
// 왜 이력 기반인가(현장 피드백 7/28·7/30 "이전 분배자에게 재분배되는 상황"):
//  - 최초 구현은 호출마다 순번을 0부터 다시 세어, 1건씩 반복 배분하면 늘 풀의 첫 담당자로 갔다.
//  - D115 는 site_settings.auto_assign_cursor(마지막 배정 staff_id)로 호출 간 상태를 만들었지만
//    그 커서는 (a) 컬럼 마이그레이션이 라이브에 적용돼야 하고 (b) 설정 테이블 쓰기 권한
//    (0002_rls.sql settings_write = admin·manager)이 있어야 갱신된다. 둘 중 하나라도 어긋나면
//    읽기·쓰기가 조용히 실패하고 폴백(0번부터)으로 돌아가 증상이 그대로 재현된다.
//  - assignments 는 배정마다 이미 남기는 이력이라 추가 컬럼도 추가 권한도 필요 없다. 방금 배정받은
//    사람이 자동으로 순번 맨 뒤로 가므로, 리셋 후 재배분·풀 가감·1건씩 반복 실행 어디서도 직전
//    담당자에게 되돌아가지 않는다(자기치유 — 커서가 틀어져도 바로잡을 상태 자체가 없다).

export interface AssignmentLike {
  staff_id: string | null
  created_at: string
}

/**
 * 담당자별 '마지막으로 배정받은 시각'. 리셋(staff_id=null) 행은 배정이 아니므로 제외.
 * 여기 없는 담당자 = 아직(또는 조회 범위 내에) 받은 적 없음 → 분배 순번 맨 앞.
 */
export function lastAssignedAt(rows: readonly AssignmentLike[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of rows) {
    if (!a.staff_id) continue
    const cur = out[a.staff_id]
    if (!cur || a.created_at > cur) out[a.staff_id] = a.created_at
  }
  return out
}

/**
 * 회원 `count` 명을 풀에 분배할 담당자 순서를 만든다(회원 i → 반환 배열 [i]).
 *
 * 규칙: 매 건마다 '마지막 배정이 가장 오래된(또는 없는) 담당자'에게 주고, 그 사람을 순번 맨 뒤로
 * 보낸 뒤 다음 건을 고른다 — 배치 안에서도 골고루 퍼지고(풀 크기만큼 돌아가며), 호출을 나눠
 * 실행해도 직전 호출의 이력이 그대로 이어지므로 같은 사람이 연속으로 받지 않는다.
 *
 * 참고: '오늘 받은 건수'를 맞추는 균등분배(부하 기준)는 일부러 쓰지 않는다 — 수동배정 등으로
 * 이미 많이 받은 사람을 건너뛰느라 한 담당자에게 연속으로 몰리는 구간이 생기고, 그 모습이 현장이
 * 버그로 보고한 "동일 상담원에게 계속 배분"과 구분되지 않기 때문. 화면 문구도 '라운드로빈'이다.
 */
export function planAutoAssign<T extends { id: string }>(
  count: number,
  pool: readonly T[],
  lastAt: Readonly<Record<string, string>>,
): T[] {
  if (count <= 0 || pool.length === 0) return []

  // 마지막 배정이 오래된 순 → 아직 못 받은 사람(undefined)이 맨 앞. 동률이면 id 순(결정적).
  const ordered = [...pool].sort((a, b) => {
    const la = lastAt[a.id]
    const lb = lastAt[b.id]
    if (la !== lb) {
      if (la === undefined) return -1
      if (lb === undefined) return 1
      return la < lb ? -1 : 1
    }
    return a.id.localeCompare(b.id)
  })

  // 정렬된 순서대로 돌아가며(라운드로빈) 배정 — 방금 받은 사람은 자연히 한 바퀴 뒤로 밀린다.
  return Array.from({ length: count }, (_, i) => ordered[i % ordered.length])
}
