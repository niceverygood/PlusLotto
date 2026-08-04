// 미매칭 통화녹음 (/admins/recordings, 현장 피드백 7/3·7/6, 김형준 이사·정의현 차장).
// Android 자동업로드 앱이 전화번호로 회원을 못 찾은 통화녹음을 여기서 검색해 수동으로 연결한다.
// 연결하면 그 회원 상세 '통화녹음' 탭에 자동배지로 표시된다(§8 연동).
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Link2, Phone, Play } from 'lucide-react'
import { Button, EmptyState, PageHeader, SkeletonRows } from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { datetime } from '@/lib/format'
import { useRole } from '@/lib/auth'
import { useStaff } from '@/lib/staff'
import { canViewCallRecordings } from '@/lib/permissions'
import {
  useResolveUnmatchedRecording,
  useSearchMembersLite,
  useUnmatchedRecordingUrl,
  useUnmatchedRecordings,
  type UnmatchedRecording,
} from './api'

export function UnmatchedRecordingsPage() {
  usePageMeta('관리자', '미매칭 통화녹음')
  const navigate = useNavigate()
  const role = useRole()
  const { data: recs = [], isLoading } = useUnmatchedRecordings()
  const { data: staff = [] } = useStaff()
  const staffName = Object.fromEntries(staff.map((s) => [s.id, s.name]))
  const resolve = useResolveUnmatchedRecording()

  // 통화녹음 관련 화면은 관리자 이상만(현장 피드백 8/4, 정의현 차장) — 관리자 메뉴는 실장도
  // 접근하므로(계층 위임) URL 직접 진입을 여기서 한 번 더 막는다.
  if (role && !canViewCallRecordings(role)) return <Navigate to="/admins" replace />

  return (
    <div>
      <PageHeader
        title="미매칭 통화녹음"
        description="Android 자동업로드 앱이 전화번호로 회원을 찾지 못한 통화녹음입니다. 이름·전화번호로 검색해 회원에 연결하세요."
        actions={
          <Button variant="sec" size="sm" onClick={() => navigate('/admins')}>
            계정 목록
          </Button>
        }
      />
      {isLoading ? (
        <SkeletonRows rows={5} cols={4} />
      ) : recs.length === 0 ? (
        <EmptyState icon={<Phone className="h-6 w-6" />} title="미매칭 통화녹음이 없습니다" />
      ) : (
        <div className="space-y-2">
          {recs.map((r) => (
            <UnmatchedRow
              key={r.id}
              rec={r}
              uploaderName={r.uploaded_by ? (staffName[r.uploaded_by] ?? r.uploaded_by) : '-'}
              onResolve={(memberId) => resolve.mutate({ rec: r, memberId })}
              pending={resolve.isPending}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function UnmatchedRow({
  rec,
  uploaderName,
  onResolve,
  pending,
}: {
  rec: UnmatchedRecording
  uploaderName: string
  onResolve: (memberId: string) => void
  pending: boolean
}) {
  const getUrl = useUnmatchedRecordingUrl()
  const [playUrl, setPlayUrl] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const { data: candidates = [] } = useSearchMembersLite(q)

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="font-mono text-[13px] font-bold tnum text-ink-800">{rec.raw_phone}</span>
        <span className="text-[11.5px] text-gray-400">
          {rec.recorded_at ? datetime(rec.recorded_at) : datetime(rec.created_at)}
        </span>
        <span className="text-[11.5px] text-gray-400">업로드 {uploaderName}</span>
        <Button
          size="sm"
          variant="sec"
          icon={<Play className="h-3.5 w-3.5" />}
          disabled={getUrl.isPending}
          onClick={() => getUrl.mutate(rec.file_path, { onSuccess: setPlayUrl })}
        >
          재생
        </Button>
      </div>
      {playUrl && <audio className="mt-2 w-full" controls src={playUrl} />}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="이름·전화번호·로그인ID로 회원 검색"
          className="h-8 w-[240px] rounded-md border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-700 outline-none focus:border-primary-500"
        />
        {candidates.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={pending}
                onClick={() => onResolve(c.id)}
                className="flex items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-2.5 py-1 text-[11.5px] font-semibold text-primary-700 hover:bg-primary-100 disabled:opacity-50"
              >
                <Link2 className="h-3 w-3" /> {c.name} · {c.phone}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
