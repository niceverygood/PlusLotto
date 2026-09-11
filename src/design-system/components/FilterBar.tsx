import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
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

/**
 * 타이핑이 멎을 때까지 기다리는 시간(ms).
 *
 * 왜 필요한가 — 현장 9/11 "전산 검색의 속도가 매우 느립니다".
 * 검색어는 URL 쿼리로 올라가고 그때마다 서버 조회 RPC가 돈다. 디바운스가 없으면
 * 휴대폰 번호 11자리를 치는 동안 조회가 11번 나간다. 게다가 앞 3~4글자("0", "01",
 * "010"…)는 회원 거의 전부와 일치해서 매번 최악의 전체 스캔이 되고, 목록 RPC는
 * 총건수까지 세느라 그 비용을 두 번 치른다. 정작 쓸모 있는 결과는 마지막 한 번뿐이다.
 * 200,000행 재현 환경 측정: "0"·"01"·"010" 각 60~170ms, "01012" 이후 2~3ms.
 * 타이핑이 멎은 뒤 한 번만 보내면 앞의 비싼 조회가 통째로 사라진다.
 */
const SEARCH_DEBOUNCE_MS = 350

export function FilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'ID · 이름 · 핸드폰 검색',
  chips = [],
  onClearAll,
  children,
  className,
}: FilterBarProps) {
  const hasChips = chips.length > 0

  // 한글 IME 대응: 입력값을 로컬로 관리해 키 입력마다 URL→재렌더→value 재설정으로 조합이 끊기는 것을 방지.
  // 조합 중에는 부모(URL)로 전파하지 않고, 조합 종료 시에만 반영한다(현장 피드백 — 검색창 한글 깨짐).
  const [local, setLocal] = useState(searchValue)
  const composing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 최신 콜백을 참조로 들고 있어야 디바운스 타이머가 예전 클로저를 붙잡지 않는다.
  const onSearchChangeRef = useRef(onSearchChange)
  onSearchChangeRef.current = onSearchChange

  /** 대기 중인 조회를 취소하고 지금 바로 반영. */
  const commit = (v: string) => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    onSearchChangeRef.current(v)
  }
  /** 타이핑이 멎으면 반영. 그 전에 또 치면 앞의 예약은 버린다. */
  const schedule = (v: string) => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      onSearchChangeRef.current(v)
    }, SEARCH_DEBOUNCE_MS)
  }
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  useEffect(() => {
    // 외부에서 값이 바뀌면(필터칩 해제·초기화 등) 동기화 — 단 조합 중이거나 우리가 보낸 값이
    // 아직 반영 대기 중이면 건드리지 않는다. 대기 중에 덮어쓰면 방금 친 글자가 지워진다.
    if (timer.current === null && !composing.current && searchValue !== local) setLocal(searchValue)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue])
  const clearSearch = () => {
    setLocal('')
    commit('')
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
              if (!composing.current) schedule(e.target.value) // 비조합(영문·숫자)은 타이핑이 멎으면 반영
            }}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={(e) => {
              composing.current = false
              schedule((e.target as HTMLInputElement).value) // 한글 조합 완료 후 반영
            }}
            onKeyDown={(e) => {
              // 다 치고 엔터를 누르면 기다리지 않는다.
              if (e.key === 'Enter' && !composing.current) commit(e.currentTarget.value)
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

      {/* 항시 노출(현장 피드백 7/23) — 접이식 토글 제거, 필터 패널을 상시 렌더. */}
      {children && (
        <div className="border-t border-gray-100 bg-gray-50/60 p-3">{children}</div>
      )}
    </div>
  )
}
