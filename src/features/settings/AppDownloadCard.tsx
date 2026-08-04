// 통화녹음 자동업로드 앱(APK) 배포 카드 (현장 피드백 8/3, 정의현 차장 — "어드민페이지에서
// 다운받을 수 있게"). APK 파일을 카톡으로 돌리지 않고 전산에서 받아가게 한다.
//
// 현장 피드백 8/4(정의현 차장): 계정메뉴의 전 역할 다운로드 버튼은 제거 — 통화녹음 관련
// 내용은 관리자 이상만. 이제 다운로드·업로드 모두 이 카드(설정, 관리자 이상 노출)에서만 하고,
// 상담원 폰 설치는 관리자가 받아서 직접 전달한다.
// 업로드는 즉시 반영(다른 설정 폼처럼 '저장' 버튼을 기다리지 않음, PromoSlidesCard 와 동일 방침).
import { useRef, useState } from 'react'
import { Download, Smartphone, Upload } from 'lucide-react'
import type { AppDownload } from '@/types/db'
import { Button } from '@/design-system/components'
import { datetime } from '@/lib/format'
import { useRole } from '@/lib/auth'
import { SectionCard, hintCls, inputCls } from './ui'
import { useDownloadApp, useUploadAppDownload } from './api'

const MAX_APK_BYTES = 100 * 1024 * 1024 // 100MB

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function AppDownloadCard({ current }: { current: AppDownload | null }) {
  const role = useRole()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const upload = useUploadAppDownload()
  const download = useDownloadApp()
  const [version, setVersion] = useState('')
  const isAdmin = role === 'admin'

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // 같은 파일 다시 고를 수 있게
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.apk')) {
      window.alert('APK 파일(.apk)만 올릴 수 있습니다.')
      return
    }
    if (file.size > MAX_APK_BYTES) {
      window.alert(`파일이 너무 큽니다(${formatMb(file.size)}). 100MB 이하만 올릴 수 있습니다.`)
      return
    }
    if (!version.trim()) {
      window.alert('버전을 먼저 입력하세요(예: 0.1.1).')
      return
    }
    upload.mutate(
      { file, version },
      {
        onSuccess: () => setVersion(''),
        onError: (err) =>
          window.alert(err instanceof Error ? err.message : '업로드에 실패했습니다.'),
      },
    )
  }

  return (
    <SectionCard
      title="통화녹음 자동업로드 앱"
      desc="상담원 폰에 설치하는 안드로이드 앱입니다. 다운로드는 이 카드에서만 가능하며(관리자 이상), 상담원 폰 설치는 관리자가 받아서 직접 전달합니다."
    >
      {current ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
          <Smartphone className="h-5 w-5 shrink-0 text-gray-500" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-ink-900">
              {current.name} <span className="font-mono text-[12px] text-primary-600">v{current.version}</span>
            </div>
            <div className="font-mono text-[11px] tabular-nums text-gray-500">
              {formatMb(current.size)} · {datetime(current.uploaded_at)} 업로드
            </div>
          </div>
          <Button
            variant="sec"
            size="sm"
            disabled={download.isPending}
            onClick={() =>
              download.mutate(current.path, {
                onSuccess: (url) => window.open(url, '_blank', 'noopener'),
                onError: (e) =>
                  window.alert(e instanceof Error ? e.message : '다운로드 링크를 만들지 못했습니다.'),
              })
            }
          >
            <Download className="h-4 w-4" /> 내려받기
          </Button>
        </div>
      ) : (
        <p className="mb-3 rounded-lg border border-dashed border-gray-300 px-3 py-4 text-center text-[12.5px] text-gray-400">
          아직 배포된 앱이 없습니다. 아래에서 APK 를 올리면 여기서 내려받을 수 있습니다.
        </p>
      )}

      {isAdmin ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">새 버전</span>
            <input
              className={inputCls + ' w-[120px]'}
              placeholder="예: 0.1.1"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </label>
          <input ref={fileInputRef} type="file" accept=".apk" className="hidden" onChange={onPick} />
          <Button
            variant="pri"
            size="sm"
            disabled={upload.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" /> {upload.isPending ? '올리는 중…' : 'APK 올리기'}
          </Button>
          <p className={hintCls + ' basis-full'}>
            같은 자리에 덮어쓰기 때문에 상담원은 별도 안내 없이 다음 다운로드부터 새 버전을 받습니다.
            이미 설치한 폰은 새 APK 를 다시 설치해야 갱신됩니다.
          </p>
        </div>
      ) : (
        <p className={hintCls}>새 버전 업로드는 최고관리자만 할 수 있습니다.</p>
      )}
    </SectionCard>
  )
}
