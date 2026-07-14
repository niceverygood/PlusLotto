import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * URL query ↔ 필터 상태 동기화. 뒤로가기/공유 가능 (CLAUDE §6 FilterBar).
 * 빈 문자열/undefined 는 파라미터에서 제거한다.
 */
export function useUrlFilters() {
  const [searchParams, setSearchParams] = useSearchParams()

  const params = useMemo(() => {
    const out: Record<string, string> = {}
    searchParams.forEach((v, k) => {
      out[k] = v
    })
    return out
  }, [searchParams])

  const get = useCallback((key: string) => searchParams.get(key) ?? undefined, [searchParams])

  const setMany = useCallback(
    (next: Record<string, string | number | null | undefined>, opts?: { resetPage?: boolean }) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(next)) {
            if (v === null || v === undefined || v === '') sp.delete(k)
            else sp.set(k, String(v))
          }
          if (opts?.resetPage) sp.delete('page')
          return sp
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const set = useCallback(
    (key: string, value: string | number | null | undefined, opts?: { resetPage?: boolean }) =>
      setMany({ [key]: value }, opts),
    [setMany],
  )

  const remove = useCallback((key: string) => set(key, null, { resetPage: true }), [set])

  /** keep 에 든 키는 보존하고 나머지 제거 (보통 ['view'] 보존). */
  const clear = useCallback(
    (keep: string[] = []) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams()
          for (const k of keep) {
            const v = prev.get(k)
            if (v != null) sp.set(k, v)
          }
          return sp
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  return { params, get, set, setMany, remove, clear }
}
