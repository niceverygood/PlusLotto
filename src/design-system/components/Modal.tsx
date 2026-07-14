import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

const SIZE = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' }

/** Escape/오버레이 클릭 닫기 + body 스크롤 잠금. */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-[1px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 w-full rounded-xl border border-gray-200 bg-white shadow-lg',
          SIZE[size],
        )}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
            <h2 className="text-[15px] font-bold text-ink-900">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="닫기"
              className="grid h-7 w-7 place-items-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="px-5 py-4 text-[13px] text-gray-700">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

interface ConfirmModalProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description?: ReactNode
  confirmText?: string
  cancelText?: string
  tone?: 'danger' | 'primary'
  loading?: boolean
}

/** 위험 액션 확인 모달 (PG취소·삭제·정지·일괄변경 — CLAUDE §10). */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = '확인',
  cancelText = '취소',
  tone = 'primary',
  loading = false,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="sec" size="sm" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button
            variant={tone === 'danger' ? 'dng' : 'pri'}
            size="sm"
            onClick={onConfirm}
            disabled={loading}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {description && <div className="text-[13px] leading-relaxed text-gray-600">{description}</div>}
    </Modal>
  )
}
