import { create } from 'zustand'

interface PaymentDrawerState {
  paymentId: string | null
  open: (id: string) => void
  close: () => void
}

/**
 * 결제상세 Drawer 전역 오픈 상태 (현장 8/13, 정의현 차장 — "회원정보 > 결제내역 > 수기취소 버튼
 * 옆에 수기수정 버튼도 추가").
 *
 * 결제 수정 화면(금액·결제수단·PG사·입금자명·상품(등급)·담당자·결제일시)은 이미 결제상세
 * Drawer 에 있다. 회원정보창에 같은 폼을 다시 만들면 두 벌이 되므로, 회원상세 Drawer 와 똑같이
 * 전역 인스턴스를 AppShell 에 두고 어느 화면에서든 open(id) 로 띄운다.
 * feature 간 직접 import 금지(§2) — 각 feature 는 이 lib 스토어만 참조한다.
 *
 * 회원상세와 달리 하나만 연다: 결제 수정은 한 건씩 처리하는 작업이고, 회원창 위에 겹쳐 뜨므로
 * 여러 개를 쌓으면 어느 결제를 고치는지 헷갈린다.
 */
export const usePaymentDrawerStore = create<PaymentDrawerState>((set) => ({
  paymentId: null,
  open: (id) => set({ paymentId: id }),
  close: () => set({ paymentId: null }),
}))
