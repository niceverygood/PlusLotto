import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type ButtonVariant = 'pri' | 'acc' | 'suc' | 'dng' | 'sec' | 'gho'
export type ButtonSize = 'md' | 'sm'

const VARIANT: Record<ButtonVariant, string> = {
  pri: 'bg-primary-600 text-white hover:bg-primary-700',
  acc: 'bg-accent-500 text-white hover:bg-accent-600',
  suc: 'bg-success text-white hover:brightness-95',
  dng: 'bg-danger text-white hover:brightness-95',
  sec: 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 hover:border-gray-400',
  gho: 'bg-transparent text-gray-600 hover:bg-gray-100',
}

const SIZE: Record<ButtonSize, string> = {
  md: 'text-[12.5px] px-3.5 py-2',
  sm: 'text-[11.5px] px-2.5 py-1.5',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
}

export function Button({
  variant = 'sec',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex select-none items-center justify-center gap-1.5 rounded-[7px] border border-transparent font-semibold leading-none transition active:translate-y-[0.5px]',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
