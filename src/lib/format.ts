import { format as formatDate } from 'date-fns'
import { ko } from 'date-fns/locale'

/** 금액 → "₩ 1,000,100" (tabular 정렬은 .tnum/mono 와 함께 사용). */
export function krw(value: number | null | undefined): string {
  if (value == null) return '-'
  return `₩ ${value.toLocaleString('ko-KR')}`
}

/** 통화 기호 없는 천단위 숫자. */
export function num(value: number | null | undefined): string {
  if (value == null) return '-'
  return value.toLocaleString('ko-KR')
}

/** 휴대폰 번호 하이픈 포맷. */
export function phone(value: string | null | undefined): string {
  if (!value) return '-'
  const d = value.replace(/\D/g, '')
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
  return value
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const d = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(d.getTime()) ? null : d
}

/** 일시 → "2026-06-01 18:12". */
export function datetime(value: string | Date | null | undefined): string {
  const d = toDate(value)
  return d ? formatDate(d, 'yyyy-MM-dd HH:mm', { locale: ko }) : '-'
}

/** 날짜 → "2026-06-01". */
export function date(value: string | Date | null | undefined): string {
  const d = toDate(value)
  return d ? formatDate(d, 'yyyy-MM-dd', { locale: ko }) : '-'
}

/** 짧은 날짜 → "26-06-01" (테이블용). */
export function dateShort(value: string | Date | null | undefined): string {
  const d = toDate(value)
  return d ? formatDate(d, 'yy-MM-dd', { locale: ko }) : '-'
}
