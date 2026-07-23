import { create } from 'zustand'

interface MemberDrawerState {
  memberId: string | null
  open: (id: string) => void
  close: () => void
}

/**
 * 회원상세 Drawer 전역 오픈 상태(현장 피드백 7/23 — "결제내역에서 회원 클릭 시 원화면이 사라지고
 * 이용자목록으로 이동되는 버그"). AppShell 최상단에 <MemberDrawer/> 인스턴스 1개만 마운트해두고,
 * 어느 화면(결제·나의고객·이용자 등)에서든 이 스토어의 open(id) 만 호출하면 라우트 이동 없이 그
 * 하나의 Drawer 가 뜬다. feature 간 직접 import 금지(§2) — 각 feature 는 이 lib 스토어만 참조한다.
 */
export const useMemberDrawerStore = create<MemberDrawerState>((set) => ({
  memberId: null,
  open: (id) => set({ memberId: id }),
  close: () => set({ memberId: null }),
}))
