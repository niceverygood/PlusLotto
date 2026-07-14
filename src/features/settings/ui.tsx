// 설정 화면 공용 폼 프리미티브 (CLAUDE §10 폼형 패턴: 섹션 카드 + 2열 label/input + SaveBar).
// 토큰/유틸만 사용. 시크릿(API키)은 SecretField 로 마스킹 + 회전 입력(라이브 확인 TODO).
import { useState, type ReactNode } from 'react'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { Button } from '@/design-system/components'
import { cn } from '@/lib/cn'

export const inputCls =
  'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] text-gray-800 outline-none focus:border-primary-500'
export const textareaCls =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] leading-relaxed text-gray-800 outline-none focus:border-primary-500'
export const labelCls = 'block text-[12.5px] font-semibold text-gray-700'
export const hintCls = 'mt-1 text-[11.5px] text-gray-400'
export const errCls = 'mt-1 text-[11.5px] text-danger'

export function SectionCard({
  title,
  desc,
  action,
  children,
}: {
  title: string
  desc?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mb-4 rounded-lg border border-gray-200 bg-white shadow-sm">
      <header className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold text-ink-900">{title}</h2>
          {desc && <p className="mt-0.5 text-[12px] text-gray-500">{desc}</p>}
        </div>
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/** 2열 label/input 행. 라벨 좌측 고정폭, 컨트롤 우측 신축. */
export function FieldRow({
  label,
  hint,
  htmlFor,
  children,
  align = 'center',
}: {
  label: string
  hint?: string
  htmlFor?: string
  children: ReactNode
  align?: 'center' | 'start'
}) {
  return (
    <div
      className={cn(
        'grid gap-1.5 border-b border-gray-50 py-2.5 last:border-b-0 sm:grid-cols-[168px_1fr] sm:gap-4',
        align === 'start' ? 'sm:items-start' : 'sm:items-center',
      )}
    >
      <label htmlFor={htmlFor} className={cn(labelCls, align === 'start' && 'sm:pt-2')}>
        {label}
      </label>
      <div className="min-w-0">
        {children}
        {hint && <p className={hintCls}>{hint}</p>}
      </div>
    </div>
  )
}

/** 하단 sticky 저장 바. dirty 시 강조 + 저장/되돌리기(저장 버튼은 form submit). */
export function SaveBar({
  dirty,
  saving,
  saved,
  onReset,
}: {
  dirty: boolean
  saving: boolean
  saved: boolean
  onReset: () => void
}) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-2 flex items-center gap-3 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur">
      <span
        className={cn(
          'text-[12.5px]',
          dirty ? 'font-semibold text-accent-600' : saved ? 'text-success' : 'text-gray-400',
        )}
      >
        {dirty ? '저장되지 않은 변경사항이 있습니다.' : saved ? '저장되었습니다.' : '변경사항 없음'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="sec" size="md" onClick={onReset} disabled={!dirty || saving}>
          되돌리기
        </Button>
        <Button variant="pri" size="md" type="submit" disabled={!dirty || saving}>
          {saving ? '저장 중…' : '저장'}
        </Button>
      </div>
    </div>
  )
}

export function maskSecret(s: string): string {
  if (!s) return '미설정'
  if (s.length <= 4) return '••••'
  return `${'•'.repeat(Math.min(12, s.length - 4))}${s.slice(-4)}`
}

/**
 * 시크릿 입력 — 평소 마스킹 표시(stored 의 끝 4자리만). "변경" 클릭 시에만 새 값 입력.
 * 빈 값(value==='')이면 기존 키 유지. 컨트롤드: 상위 폼이 value/onChange 관리.
 */
export function SecretField({
  stored,
  value,
  onChange,
  placeholder = '변경 시에만 새 키 입력',
}: {
  stored: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [editing, setEditing] = useState(false)
  const [reveal, setReveal] = useState(false)

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[12px] text-gray-500">
          {maskSecret(stored)}
        </code>
        <Button
          variant="sec"
          size="sm"
          icon={<KeyRound className="h-3.5 w-3.5" />}
          onClick={() => {
            setEditing(true)
            onChange('')
          }}
        >
          변경
        </Button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <input
          type={reveal ? 'text' : 'password'}
          className={cn(inputCls, 'pr-9 font-mono')}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
          aria-label="표시 전환"
        >
          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      <Button
        variant="gho"
        size="sm"
        onClick={() => {
          setEditing(false)
          onChange('')
        }}
      >
        취소
      </Button>
    </div>
  )
}
