import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind 클래스 병합 헬퍼 (조건부 + 충돌 해결). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
