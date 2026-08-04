import { create } from 'zustand'

interface MemberDrawerState {
  /** 열린 회원상세 목록(열린 순서). 마지막 항목이 화면 최상단에 그려진다. */
  memberIds: string[]
  open: (id: string) => void
  close: (id: string) => void
  closeAll: () => void
}

/**
 * 회원상세 Drawer 전역 오픈 상태(현장 피드백 7/23 — "결제내역에서 회원 클릭 시 원화면이 사라지고
 * 이용자목록으로 이동되는 버그"). AppShell 최상단에 열린 회원마다 <MemberDrawer/> 를 마운트해두고,
 * 어느 화면(결제·나의고객·이용자 등)에서든 이 스토어의 open(id) 만 호출하면 라우트 이동 없이
 * Drawer 가 뜬다. feature 간 직접 import 금지(§2) — 각 feature 는 이 lib 스토어만 참조한다.
 *
 * 여러 개 동시 오픈(현장 피드백 8/4, 정의현 차장 — "회원 정보창 여러개 띄울수 있도록"):
 * 단일 memberId 를 배열로 확장. 다른 회원을 열면 기존 창을 대체하지 않고 추가로 띄우고,
 * 이미 열린 회원을 다시 열면 그 창을 맨 위로 올린다.
 */
export const useMemberDrawerStore = create<MemberDrawerState>((set) => ({
  memberIds: [],
  open: (id) =>
    set((s) => ({
      memberIds: s.memberIds.includes(id)
        ? [...s.memberIds.filter((x) => x !== id), id] // 이미 열려 있으면 맨 위로
        : [...s.memberIds, id],
    })),
  close: (id) => set((s) => ({ memberIds: s.memberIds.filter((x) => x !== id) })),
  closeAll: () => set({ memberIds: [] }),
}))
