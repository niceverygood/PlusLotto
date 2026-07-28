// 회원상세 팝업(새창) — 현장 피드백 7/23 "여러 명의 회원상세정보창을 동시에(팝업/새창 형식으로)".
// AppShell(사이드바/상단바) 없이 이 창 하나를 <MemberDrawer/> 로 채운다. 회원마다 별도 창 이름
// (member-popup-<id>) 으로 열리므로 여러 회원을 동시에 서로 다른 창에 띄울 수 있다(§8 허브 재사용).
import { useParams } from 'react-router-dom'
import { MemberDrawer } from './MemberDrawer'

export function MemberPopupPage() {
  const { id } = useParams<{ id: string }>()
  return (
    // 100vh 대신 배율 보정 높이(--app-vh) — 확대 상태에서 팝업 하단(메모 목록)이 잘리던 문제(현장 7/28).
    <div className="bg-gray-50" style={{ height: 'var(--app-vh)' }}>
      <MemberDrawer memberId={id ?? null} onClose={() => window.close()} />
    </div>
  )
}
