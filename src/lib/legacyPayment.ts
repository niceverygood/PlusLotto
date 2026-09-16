import type { Payment } from '@/types/db'

/** 등급이 확인되지 않은 이전 상품은 현행 상품으로 임의 연결하지 않는다. */
export function legacyPaymentProductName(payment: Pick<Payment, 'meta'>): string | null {
  const meta = payment.meta
  if (!['lotto815', 'cplotto', 'infolotto'].includes(String(meta?.source_site))) return null
  const name = meta?.legacy_item_name
  return typeof name === 'string' && name.trim() ? `${name.trim()} (이전상품)` : null
}
