import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface FilterChip {
  key: string
  label: string
  onRemove: () => void
}

interface FilterBarProps {
  searchValue: string
  onSearchChange: (v: string) => void
  searchPlaceholder?: string
  chips?: FilterChip[]
  onClearAll?: () => void
  /** 접이식 패널 내용(필터 컨트롤). */
  children?: ReactNode
  className?: string
}

export function FilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'ID · 이름 · 핸드폰 검색',
  chips = [],
  onClearAll,
  children,
  className,
}: FilterBarProps) {
  const [open, setOpen] = useState(false)
  const hasChips = chips.length > 0

  // 한글 IME 대응: 입력값을 로컬로 관리해 키 입력마다 URL→재렌더→value 재설정으로 조합이 끊기는 것을 방지.
  // 조합 중에는 부모(URL)로 전파하지 않고, 조합 종료 시에만 반영한다(현장 피드백 — 검색창 한글 깨짐).
  const [local, setLocal] = useState(searchValue)
  const composing = useRef(false)
  useEffect(() => {
    // 외부에서 값이 바뀌면(필터칩 해제·초기화 등) 동기화 — 단 조합 중에는 건드리지 않음.
    if (!composing.current && searchValue !== local) setLocal(searchValue)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue])
  const clearSearch = () => {
    setLocal('')
    onSearchChange('')
  }

  return (
    <div className={cn('rounded-lg border border-gray-200 bg-white', className)}>
      <div className="flex flex-wrap items-center gap-2 p-2.5">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={local}
            onChange={(e) => {
              setLocal(e.target.value)
              if (!composing.current) onSearchChange(e.target.value) // 비조합(영문·숫자)은 즉시 반영
            }}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={(e) => {
              composing.current = false
              onSearchChange((e.target as HTMLInputElement).value) // 한글 조합 완료 후 반영
            }}
            placeholder={searchPlaceholder}
            className="h-9 w-full rounded-md border border-gray-300 bg-white pl-8 pr-8 text-[13px] text-gray-700 outline-none placeholder:text-gray-400 focus:border-primary-500"
          />
          {local && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="검색어 지우기"
              className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {children && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-semibold transition-colors',
              open
                ? 'border-primary-500 bg-primary-50 text-primary-700'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50',
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            필터
            {hasChips && (
              <span className="rounded-full bg-primary-600 px-1.5 text-[10px] font-bold text-white tnum">
                {chips.length}
              </span>
            )}
          </button>
        )}
      </div>

      {hasChips && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-gray-100 px-2.5 py-2">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-full border border-primary-100 bg-primary-50 py-1 pl-2.5 pr-1 text-[11.5px] font-semibold text-primary-700"
            >
              {chip.label}
              <button
                type="button"
                onClick={chip.onRemove}
                aria-label={`${chip.label} 해제`}
                className="grid h-4 w-4 place-items-center rounded-full text-primary-600 hover:bg-primary-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {onClearAll && (
            <button
              type="button"
              onClick={onClearAll}
              className="ml-1 text-[11.5px] font-semibold text-gray-500 underline-offset-2 hover:text-gray-700 hover:underline"
            >
              전체 초기화
            </button>
          )}
        </div>
      )}

      {open && children && (
        <div className="border-t border-gray-100 bg-gray-50/60 p-3">{children}</div>
      )}
    </div>
  )
}
