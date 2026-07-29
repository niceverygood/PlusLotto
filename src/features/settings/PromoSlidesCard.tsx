// 고객 홈페이지 홍보 슬라이드 카드(현장 피드백 7/29, 정의현 차장) — 특허사진·1등당첨자 사진 등
// 홍보자료를 어드민에서 업로드하면 고객 홈페이지 상단에 슬라이드(캐러셀)로 노출된다.
// site_settings 와 별도 저장(useSaveSiteSettings 를 거치지 않음) — 업로드·삭제·순서변경마다
// 즉시 반영(다른 설정 폼처럼 '저장' 버튼을 누를 때까지 기다리지 않는다, 이미지 목록이라 그게 자연스러움).
import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ImagePlus, Trash2 } from 'lucide-react'
import type { PromoSlide } from '@/types/db'
import { Button, ConfirmModal } from '@/design-system/components'
import { cn } from '@/lib/cn'
import { SectionCard, hintCls, inputCls } from './ui'
import {
  useDeletePromoSlide,
  useReorderPromoSlides,
  useUpdatePromoSlideCaption,
  useUploadPromoSlide,
} from './api'

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5MB — 고객 홈페이지 로딩 속도 보호

export function PromoSlidesCard({ slides }: { slides: PromoSlide[] }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const upload = useUploadPromoSlide()
  const del = useDeletePromoSlide()
  const updateCaption = useUpdatePromoSlideCaption()
  const reorder = useReorderPromoSlides()
  const [captionDraft, setCaptionDraft] = useState<Record<string, string>>({})
  const [toDelete, setToDelete] = useState<PromoSlide | null>(null)

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      window.alert('이미지 용량은 5MB 이하만 업로드할 수 있습니다.')
      return
    }
    upload.mutate(file)
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir
    if (target < 0 || target >= slides.length) return
    const ids = slides.map((s) => s.id)
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    reorder.mutate(ids)
  }

  return (
    <SectionCard
      title="고객 홈페이지 홍보 슬라이드"
      desc="특허사진 · 1등당첨자 사진 등 홍보자료를 슬라이드(캐러셀) 형식으로 고객 홈페이지 상단에 노출합니다."
      action={
        <>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onPick} />
          <Button
            size="sm"
            variant="pri"
            icon={<ImagePlus className="h-3.5 w-3.5" />}
            disabled={upload.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {upload.isPending ? '업로드 중…' : '이미지 추가'}
          </Button>
        </>
      }
    >
      <p className={cn(hintCls, 'mb-3 mt-0')}>
        이미지 용량은 5MB 이하 권장. 목록 순서가 그대로 고객 홈페이지 노출 순서입니다.
      </p>
      {slides.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 py-8 text-center text-[12.5px] text-gray-400">
          등록된 슬라이드가 없습니다. ‘이미지 추가’로 첫 슬라이드를 올려보세요.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {slides.map((s, i) => (
            <li key={s.id} className="flex items-center gap-3 rounded-lg border border-gray-200 p-2.5">
              <img src={s.url} alt="" className="h-14 w-20 shrink-0 rounded-md object-cover" />
              <input
                className={cn(inputCls, 'h-9 flex-1 text-[12.5px]')}
                placeholder="캡션(선택) — 슬라이드에 함께 표시할 한 줄 설명"
                value={captionDraft[s.id] ?? s.caption ?? ''}
                onChange={(e) => setCaptionDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                onBlur={(e) => {
                  if (e.target.value === (s.caption ?? '')) return
                  updateCaption.mutate({ id: s.id, caption: e.target.value })
                }}
              />
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  title="위로"
                  disabled={i === 0 || reorder.isPending}
                  onClick={() => move(i, -1)}
                  className="grid h-7 w-7 place-items-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title="아래로"
                  disabled={i === slides.length - 1 || reorder.isPending}
                  onClick={() => move(i, 1)}
                  className="grid h-7 w-7 place-items-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title="삭제"
                  onClick={() => setToDelete(s)}
                  className="grid h-7 w-7 place-items-center rounded text-danger hover:bg-danger-bg"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) del.mutate(toDelete.id)
          setToDelete(null)
        }}
        title="슬라이드 삭제"
        description="이 슬라이드를 고객 홈페이지에서 제거합니다. 계속할까요?"
        confirmText="삭제"
        tone="danger"
        loading={del.isPending}
      />
    </SectionCard>
  )
}
