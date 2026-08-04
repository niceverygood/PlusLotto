import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { GripVertical, PanelLeft, PanelRight, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/cn'

interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  /** 운영자가 위치(좌/우 도킹·자유 이동)·폭을 직접 바꾸고 기억(현장 6/30 정의현 차장). */
  movable?: boolean
  /** movable 위치 저장 키(브라우저 localStorage). 같은 키끼리 위치 공유. */
  storageKey?: string
  /** 같은 종류 패널 다중 오픈 순번(현장 8/4 회원상세 다중 오픈). 0=기억된 위치 그대로,
   *  1부터는 겹치지 않게 계단식(float)으로 비껴 띄우고 위치를 저장하지 않는다. */
  cascade?: number
  /** Esc 로 닫기 허용(기본 true). 다중 오픈 시 맨 위 패널만 true 로 줘 한 장씩 닫는다. */
  closeOnEsc?: boolean
}

/** 상세/편집 패널. movable 이면 좌/우 도킹·자유 이동·폭 조절 가능(위치 기억). 아니면 우측 모달. */
export function Drawer(props: DrawerProps) {
  if (!props.open) return null
  return props.movable ? <MovablePanel {...props} /> : <ClassicPanel {...props} />
}

// ── 기본(모달) 드로어 — 우측 슬라이드, 배경 클릭/Esc 닫기 ──────────────────
function ClassicPanel({ onClose, title, children, footer, width = 560, closeOnEsc = true }: DrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => closeOnEsc && e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, closeOnEsc])

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-[1px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="absolute right-0 top-0 flex h-full flex-col border-l border-gray-200 bg-white shadow-lg"
        style={{ width }}
      >
        <PanelHeader title={title} onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function PanelHeader({ title, onClose }: { title?: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-3.5">
      <div className="min-w-0 text-[15px] font-bold text-ink-900">{title}</div>
      <button
        type="button"
        onClick={onClose}
        aria-label="닫기"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

// ── 이동/도킹/폭조절 가능한 드로어 ─────────────────────────────────────────
type DrawerMode = 'dock-right' | 'dock-left' | 'float'
interface Layout {
  mode: DrawerMode
  x: number
  y: number
  width: number
}

const MIN_W = 380
const lsKey = (k: string) => `pluslotto-drawer:${k}`
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))
/** 전산 확대(html zoom, tokens.css) 보정 — 포인터 좌표·window.inner* 는 확대된 실측(visual)px 이고
 *  style 에 넣는 left/top/width 는 다시 확대되는 CSS px 이라, 배율로 나눠 같은 단위로 맞춘다.
 *  보정 전에는 확대 상태에서 패널을 드래그하면 커서보다 12% 더 움직여 화면 밖으로 튀었다(현장 7/28). */
function zoomFactor(): number {
  if (typeof window === 'undefined') return 1
  const z = parseFloat(getComputedStyle(document.documentElement).zoom || '1')
  return Number.isFinite(z) && z > 0 ? z : 1
}
const viewW = () => (typeof window !== 'undefined' ? window.innerWidth / zoomFactor() : 9999)
const viewH = () => (typeof window !== 'undefined' ? window.innerHeight / zoomFactor() : 9999)
const maxW = () => viewW() - 64

function loadLayout(key: string, defWidth: number): Layout {
  const fallback: Layout = { mode: 'dock-right', x: 96, y: 64, width: defWidth }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(lsKey(key))
    if (!raw) return fallback
    const p = JSON.parse(raw) as Partial<Layout>
    const mode: DrawerMode = p.mode === 'dock-left' || p.mode === 'float' ? p.mode : 'dock-right'
    return {
      mode,
      x: typeof p.x === 'number' ? p.x : 96,
      y: typeof p.y === 'number' ? p.y : 64,
      width: clamp(typeof p.width === 'number' ? p.width : defWidth, MIN_W, maxW()),
    }
  } catch {
    return fallback
  }
}

function MovablePanel({
  onClose,
  title,
  children,
  footer,
  width = 620,
  storageKey = 'default',
  cascade = 0,
  closeOnEsc = true,
}: DrawerProps) {
  const [layout, setLayout] = useState<Layout>(() => {
    const base = loadLayout(storageKey, width)
    if (cascade <= 0) return base
    // 다중 오픈(현장 8/4) — 두 번째 창부터는 기억된 위치와 무관하게 계단식 float 로 비껴 띄워
    // 첫 창을 가리지 않게 한다. 좌상단 기준 28px 씩 내려가며, 화면 밖으로 나가지 않게 보정.
    const step = 28
    return {
      mode: 'float',
      x: clamp(96 + step * cascade, 0, Math.max(0, viewW() - base.width)),
      y: clamp(64 + step * cascade, 8, Math.max(8, viewH() - 200)),
      width: base.width,
    }
  })
  const panelRef = useRef<HTMLDivElement>(null)

  // 위치 영속(localStorage) — 레이어 분리를 위해 store 대신 직접 저장.
  // 계단식 보조 창(cascade>0)은 저장하지 않아 첫 창의 기억된 위치를 덮어쓰지 않는다.
  useEffect(() => {
    if (cascade > 0) return
    try {
      localStorage.setItem(lsKey(storageKey), JSON.stringify(layout))
    } catch {
      /* 사적 모드 등 — 무시 */
    }
  }, [layout, storageKey, cascade])

  // 창 크기 변경 시 화면 밖으로 나가지 않게 보정.
  useEffect(() => {
    const onResize = () =>
      setLayout((l) => ({
        ...l,
        width: clamp(l.width, MIN_W, maxW()),
        x: clamp(l.x, 0, Math.max(0, viewW() - 140)),
        y: clamp(l.y, 8, Math.max(8, viewH() - 160)),
      }))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => closeOnEsc && e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, closeOnEsc])

  // 헤더 드래그 → 자유 이동(float).
  const beginDrag = useCallback((e: ReactPointerEvent) => {
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    e.preventDefault()
    const z = zoomFactor() // 확대 배율 보정 — 좌표를 전부 CSS px 단위로 환산해서 계산
    const sx = e.clientX / z
    const sy = e.clientY / z
    const ox = rect.left / z
    const oy = rect.top / z
    const w = rect.width / z
    const onMove = (ev: PointerEvent) =>
      setLayout((l) => ({
        ...l,
        mode: 'float',
        width: w,
        x: clamp(ox + ev.clientX / z - sx, 0, viewW() - w),
        y: clamp(oy + ev.clientY / z - sy, 8, Math.max(8, viewH() - 160)),
      }))
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  // 모서리 드래그 → 폭 조절.
  const resizeOnLeft = layout.mode === 'dock-right'
  const beginResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const z = zoomFactor()
      const sx = e.clientX / z
      const startW = layout.width
      const dir = layout.mode === 'dock-right' ? -1 : 1 // 우측 도킹은 왼쪽 모서리(왼쪽으로 끌수록 넓어짐)
      const onMove = (ev: PointerEvent) =>
        setLayout((l) => ({ ...l, width: clamp(startW + dir * (ev.clientX / z - sx), MIN_W, maxW()) }))
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [layout.mode, layout.width],
  )

  // 높이는 100vh 가 아니라 배율 보정된 --app-vh (tokens.css) — 전산 확대(zoom 1.12)에서 패널이 창보다
  // 12% 길어져, 안쪽 스크롤을 끝까지 내려도 하단 약 86px(=회원상세 기본정보 탭 최하단의 '메모' 목록)이
  // 화면 밖에 남아 영영 보이지 않던 문제(현장 7/28 "팀장이 쓴 메모가 안 보인다").
  const style: CSSProperties =
    layout.mode === 'float'
      ? { left: layout.x, top: layout.y, width: layout.width, height: 'min(calc(var(--app-vh) - 24px), 760px)' }
      : {
          top: 0,
          height: 'var(--app-vh)',
          width: layout.width,
          ...(layout.mode === 'dock-left' ? { left: 0 } : { right: 0 }),
        }

  const dockBtn =
    'grid h-7 w-7 place-items-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700'
  const activeDock = 'bg-primary-50 text-primary-600 hover:bg-primary-100 hover:text-primary-700'

  return createPortal(
    // 모들리스(배경 비활성) — 패널이 떠 있어도 뒤 목록을 보고 쓸 수 있게 pointer-events 통과.
    <div className="pointer-events-none fixed inset-0 z-50">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        className={cn(
          'pointer-events-auto absolute flex flex-col border border-gray-200 bg-white shadow-lg',
          layout.mode === 'float' && 'overflow-hidden rounded-lg ring-1 ring-ink-900/5',
        )}
        style={style}
      >
        {/* 모서리 폭조절 핸들 */}
        <div
          onPointerDown={beginResize}
          className={cn(
            'absolute top-0 z-10 h-full w-1.5 cursor-ew-resize transition-colors hover:bg-primary-300',
            resizeOnLeft ? 'left-0' : 'right-0',
          )}
          aria-label="폭 조절"
        />

        {/* 헤더(드래그 핸들) + 도킹/초기화/닫기 */}
        <div
          onPointerDown={beginDrag}
          className="flex cursor-move select-none items-center justify-between gap-2 border-b border-gray-200 px-4 py-3"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <GripVertical className="h-4 w-4 shrink-0 text-gray-300" />
            <div className="truncate text-[15px] font-bold text-ink-900">{title}</div>
          </div>
          <div
            className="flex shrink-0 items-center gap-0.5"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              title="왼쪽 고정"
              aria-label="왼쪽 고정"
              onClick={() => setLayout((l) => ({ ...l, mode: 'dock-left' }))}
              className={cn(dockBtn, layout.mode === 'dock-left' && activeDock)}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="오른쪽 고정"
              aria-label="오른쪽 고정"
              onClick={() => setLayout((l) => ({ ...l, mode: 'dock-right' }))}
              className={cn(dockBtn, layout.mode === 'dock-right' && activeDock)}
            >
              <PanelRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="위치 초기화"
              aria-label="위치 초기화"
              onClick={() => setLayout({ mode: 'dock-right', x: 96, y: 64, width })}
              className={dockBtn}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <span className="mx-0.5 h-4 w-px bg-gray-200" />
            <button
              type="button"
              title="닫기 (Esc)"
              aria-label="닫기"
              onClick={onClose}
              className={dockBtn}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
