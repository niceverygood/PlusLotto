import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3, Rows3 } from 'lucide-react'
import { useUiStore, type Density } from '@/app/uiStore'
import { cn } from '@/lib/cn'
import { Pagination } from './Pagination'
import { BulkActionBar } from './BulkActionBar'
import { EmptyState } from './EmptyState'
import { SkeletonRows } from './Skeleton'

export interface DataTablePagination {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  pageSizeOptions?: number[]
  onPageSizeChange?: (size: number) => void
}

interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[]
  data: T[]
  getRowId?: (row: T) => string
  isLoading?: boolean
  onRowClick?: (row: T) => void
  /** 행 값에 따라 <tr> 에 클래스를 붙인다(예: 결제 '취소' 행 전체 빨간 글자, 현장 8/4). */
  rowClassName?: (row: T) => string | undefined
  /** 행 값에 따라 <tr> 에 인라인 스타일을 준다(예: 이용자 목록 등급/상태별 행 글자색 --row-fg, 현장 8/7). */
  rowStyle?: (row: T) => CSSProperties | undefined
  enableSelection?: boolean
  bulkActions?: (ctx: { selectedIds: string[]; selectedRows: T[]; clear: () => void }) => ReactNode
  pagination?: DataTablePagination
  /** 서버 정렬: 제공 시 manual. 미제공 시 클라이언트 정렬. */
  sorting?: SortingState
  onSortingChange?: OnChangeFn<SortingState>
  toolbar?: ReactNode
  resultLabel?: (total: number) => ReactNode
  emptyState?: ReactNode
  /** 지정 시 내부 세로 스크롤 + sticky 헤더 활성화. */
  maxBodyHeight?: string
  /** 컬럼 초기 가시성(역할별 프리셋). 변경 시 적용하려면 상위에서 key 로 리마운트. */
  initialColumnVisibility?: VisibilityState
  className?: string
}

function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  ariaLabel: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked
  }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 accent-primary-600"
    />
  )
}

const DENSITY_PAD: Record<Density, string> = {
  comfortable: 'py-[11px]',
  compact: 'py-[7px]',
}

export function DataTable<T>({
  columns,
  data,
  getRowId,
  isLoading = false,
  onRowClick,
  rowClassName,
  rowStyle,
  enableSelection = false,
  bulkActions,
  pagination,
  sorting,
  onSortingChange,
  toolbar,
  resultLabel,
  emptyState,
  maxBodyHeight,
  initialColumnVisibility,
  className,
}: DataTableProps<T>) {
  const density = useUiStore((s) => s.density)
  const setDensity = useUiStore((s) => s.setDensity)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => initialColumnVisibility ?? {},
  )
  const [internalSorting, setInternalSorting] = useState<SortingState>([])
  const [colMenuOpen, setColMenuOpen] = useState(false)

  const manualSorting = !!onSortingChange

  // 선택 상태가 페이지/필터를 넘어 남아있던 문제(현장 피드백 7/23 "자동할당 갯수차이") — rowSelection 은
  // row id 만 들고 있어 페이지 이동·검색·뷰 변경으로 현재 목록에 없는 행이 섞여도 selectedIds 에는 그대로
  // 남는다. 서버 페이지네이션 결과(page·total)가 바뀌면 곧 다른 목록이라는 뜻이므로 선택을 비운다.
  const resetSig = pagination ? `${pagination.page}:${pagination.total}` : null
  const prevResetSig = useRef<string | null>(resetSig)
  useEffect(() => {
    if (resetSig === null) return
    if (prevResetSig.current !== null && prevResetSig.current !== resetSig) setRowSelection({})
    prevResetSig.current = resetSig
  }, [resetSig])

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: {
      rowSelection,
      columnVisibility,
      sorting: manualSorting ? sorting : internalSorting,
    },
    enableRowSelection: enableSelection,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: manualSorting ? onSortingChange : setInternalSorting,
    manualSorting,
    manualPagination: !!pagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
  })

  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original)
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k])
  const clearSelection = () => setRowSelection({})

  const total = pagination?.total ?? data.length
  const padY = DENSITY_PAD[density]
  const hideableCols = table.getAllLeafColumns().filter((c) => c.getCanHide() && c.id !== '__select')

  return (
    <div className={cn('overflow-hidden rounded-lg border border-gray-200 bg-white', className)}>
      {/* 툴바 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2.5">
        <span className="text-[12px] text-gray-500">
          {resultLabel ? (
            resultLabel(total)
          ) : (
            <>
              결과 <b className="font-mono text-ink-800 tnum">{total.toLocaleString('ko-KR')}</b>건
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {toolbar}
          {/* 밀도 토글 */}
          <button
            type="button"
            onClick={() => setDensity(density === 'comfortable' ? 'compact' : 'comfortable')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-semibold text-gray-600 transition-colors hover:bg-gray-100"
            title="행 밀도"
          >
            <Rows3 className="h-4 w-4" />
            {density === 'comfortable' ? '넓게' : '좁게'}
          </button>
          {/* 컬럼 토글 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setColMenuOpen((o) => !o)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-semibold text-gray-600 transition-colors hover:bg-gray-100"
            >
              <Columns3 className="h-4 w-4" />
              컬럼
            </button>
            {colMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setColMenuOpen(false)} />
                <div className="absolute right-0 top-9 z-20 max-h-72 w-48 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5 shadow-md">
                  {hideableCols.map((col) => {
                    const label =
                      typeof col.columnDef.header === 'string' ? col.columnDef.header : col.id
                    return (
                      <label
                        key={col.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-gray-700 hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={col.getIsVisible()}
                          onChange={col.getToggleVisibilityHandler()}
                          className="h-3.5 w-3.5 rounded border-gray-300 accent-primary-600"
                        />
                        {label}
                      </label>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 테이블 */}
      <div className="overflow-x-auto" style={maxBodyHeight ? { maxHeight: maxBodyHeight, overflowY: 'auto' } : undefined}>
        {isLoading ? (
          <SkeletonRows rows={8} cols={columns.length + (enableSelection ? 1 : 0)} />
        ) : data.length === 0 ? (
          emptyState ?? <EmptyState />
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {enableSelection && (
                    <th className="sticky top-0 z-[1] w-9 border-b border-gray-200 bg-gray-50 px-3 py-[9px]">
                      <IndeterminateCheckbox
                        ariaLabel="전체 선택"
                        checked={table.getIsAllRowsSelected()}
                        indeterminate={table.getIsSomeRowsSelected()}
                        onChange={table.getToggleAllRowsSelectedHandler()}
                      />
                    </th>
                  )}
                  {hg.headers.map((header) => {
                    const canSort = header.column.getCanSort()
                    const sorted = header.column.getIsSorted()
                    const align = (header.column.columnDef.meta as { align?: string } | undefined)?.align
                    return (
                      <th
                        key={header.id}
                        className={cn(
                          'sticky top-0 z-[1] whitespace-nowrap border-b border-gray-200 bg-gray-50 px-3 py-[9px] text-[10.5px] font-bold uppercase tracking-[0.4px] text-gray-600',
                          align === 'right' ? 'text-right' : 'text-left',
                        )}
                      >
                        {header.isPlaceholder ? null : (
                          <button
                            type="button"
                            disabled={!canSort}
                            onClick={header.column.getToggleSortingHandler()}
                            className={cn(
                              'inline-flex items-center gap-1',
                              align === 'right' && 'flex-row-reverse',
                              canSort && 'cursor-pointer hover:text-ink-800',
                            )}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {canSort &&
                              (sorted === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : sorted === 'desc' ? (
                                <ArrowDown className="h-3 w-3" />
                              ) : (
                                <ChevronsUpDown className="h-3 w-3 opacity-40" />
                              ))}
                          </button>
                        )}
                      </th>
                    )
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => onRowClick?.(row.original)}
                  className={cn(
                    'border-b border-gray-100 transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-primary-50/40',
                    row.getIsSelected() && 'bg-primary-50/60',
                    rowClassName?.(row.original),
                  )}
                  style={rowStyle?.(row.original)}
                >
                  {enableSelection && (
                    <td className={cn('w-9 px-3', padY)}>
                      <IndeterminateCheckbox
                        ariaLabel="행 선택"
                        checked={row.getIsSelected()}
                        onChange={row.getToggleSelectedHandler()}
                      />
                    </td>
                  )}
                  {row.getVisibleCells().map((cell) => {
                    const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align
                    return (
                      <td
                        key={cell.id}
                        className={cn('px-3 align-middle text-gray-700', padY, align === 'right' && 'text-right')}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 일괄작업 바 */}
      {enableSelection && selectedIds.length > 0 && bulkActions && (
        <BulkActionBar count={selectedIds.length} onClear={clearSelection}>
          {bulkActions({ selectedIds, selectedRows, clear: clearSelection })}
        </BulkActionBar>
      )}

      {/* 페이지네이션 */}
      {pagination && data.length > 0 && (
        <div className="border-t border-gray-200 px-2">
          <Pagination
            page={pagination.page}
            pageSize={pagination.pageSize}
            total={pagination.total}
            onPageChange={pagination.onPageChange}
            pageSizeOptions={pagination.pageSizeOptions}
            onPageSizeChange={pagination.onPageSizeChange}
          />
        </div>
      )}
    </div>
  )
}
