// 로그 (/logs/:kind, CLAUDE §9) — 관리자·결제·문자·유입·포인트 5종 감사 로그.
// 공통 리스트형(일시·작성자·액션·대상·메타) + 검색·기간 필터. 각 레코드는 §8 액션이 자동 생성.
// TODO(live-verify): 포인트(적립/차감) 시스템 존재 여부 미확인(ASSUMPTIONS) — 표준 로그로 시연.
import { useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { ScrollText, Search } from 'lucide-react'
import { Button, EmptyState, PageHeader, SkeletonRows, Tabs, type TabItem } from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useStaff } from '@/lib/staff'
import { datetime } from '@/lib/format'
import type { LogEntry, LogKind } from '@/types/db'
import { useLogs } from './api'

const LOG_KINDS: { key: LogKind; label: string }[] = [
  { key: 'admin', label: '관리자' },
  { key: 'payment', label: '결제' },
  { key: 'sms', label: '문자' },
  { key: 'inflow', label: '유입' },
  { key: 'point', label: '포인트' },
]
const VALID = new Set(LOG_KINDS.map((k) => k.key))

// 액션 코드 → 한글 라벨. 미정의 코드는 원문 노출.
const ACTION_LABEL: Record<string, string> = {
  'auth.login': '로그인',
  'member.update': '회원 정보수정',
  'member.assign': '담당 배정',
  'member.status': '회원 상태변경',
  'staff.create': '계정 생성',
  'staff.update': '계정 수정',
  'staff.activate': '계정 활성화',
  'staff.deactivate': '계정 비활성화',
  'roles.update': '권한 변경',
  'notice.create': '공지 작성',
  'notice.update': '공지 수정',
  'notice.delete': '공지 삭제',
  'event.create': '이벤트 작성',
  'event.update': '이벤트 수정',
  'event.delete': '이벤트 삭제',
  'payment.approve': '결제 승인',
  'payment.cancel': '결제 취소',
  'sms.send': '문자 발송',
  'inflow.update': '유입분류 변경',
  'point.grant': '포인트 적립',
  'point.deduct': '포인트 차감',
}

const inputCls =
  'h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] text-gray-700 outline-none focus:border-primary-500'

function metaSummary(meta: Record<string, unknown>): string {
  const entries = Object.entries(meta)
  if (entries.length === 0) return '—'
  return entries
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}

export function LogsPage() {
  const { kind } = useParams<{ kind: string }>()
  const navigate = useNavigate()
  const valid = !!kind && VALID.has(kind as LogKind)
  const active = (valid ? kind : 'admin') as LogKind
  const activeLabel = LOG_KINDS.find((k) => k.key === active)?.label ?? '관리자'
  usePageMeta('로그', `${activeLabel} 로그`)

  const { data: logs = [], isLoading } = useLogs(active)
  const { data: staff = [] } = useStaff()
  const actorName = (id: string | null) => (id ? (staff.find((s) => s.id === id)?.name ?? id) : '시스템')

  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const fromMs = from ? Date.parse(`${from}T00:00:00`) : null
    const toMs = to ? Date.parse(`${to}T23:59:59`) : null
    return logs.filter((l) => {
      if (fromMs != null && Date.parse(l.created_at) < fromMs) return false
      if (toMs != null && Date.parse(l.created_at) > toMs) return false
      if (!needle) return true
      const hay = [
        l.action,
        ACTION_LABEL[l.action] ?? '',
        l.target_type ?? '',
        l.target_id ?? '',
        actorName(l.actor),
        metaSummary(l.meta),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(needle)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, q, from, to, staff])

  // 유효하지 않은 kind 는 기본 탭으로.
  if (!valid) return <Navigate to="/logs/admin" replace />

  const tabs: TabItem[] = LOG_KINDS.map((k) => ({ key: k.key, label: k.label }))
  const resetFilters = () => {
    setQ('')
    setFrom('')
    setTo('')
  }

  return (
    <div>
      <PageHeader title="로그" description="운영 활동 감사 로그를 조회합니다." />

      <div className="mb-3">
        <Tabs tabs={tabs} value={active} onChange={(k) => navigate(`/logs/${k}`)} />
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            className={inputCls + ' pl-8'}
            placeholder="액션·대상·작성자 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-gray-500">시작일</label>
          <input type="date" className={inputCls + ' w-40'} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-gray-500">종료일</label>
          <input type="date" className={inputCls + ' w-40'} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {(q || from || to) && (
          <Button variant="gho" size="sm" onClick={resetFilters}>
            초기화
          </Button>
        )}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
          <h2 className="text-[14px] font-bold text-ink-800">{activeLabel} 로그</h2>
          <span className="font-mono text-[12px] tnum text-gray-400">{filtered.length}건</span>
        </div>
        {isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={8} cols={5} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={<ScrollText className="h-6 w-6" />} title="로그가 없습니다" description="조건에 맞는 로그가 없습니다." />
        ) : (
          <div className="max-h-[640px] overflow-y-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="sticky top-0 bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="w-40 px-4 py-2">일시</th>
                  <th className="w-24 px-2 py-2">작성자</th>
                  <th className="w-32 px-2 py-2">액션</th>
                  <th className="w-40 px-2 py-2">대상</th>
                  <th className="px-2 py-2">상세</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l: LogEntry) => (
                  <tr key={l.id} className="border-t border-gray-100 align-top hover:bg-gray-50/60">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-[11.5px] tnum text-gray-500">
                      {datetime(l.created_at)}
                    </td>
                    <td className="px-2 py-2 text-gray-700">{actorName(l.actor)}</td>
                    <td className="px-2 py-2">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
                        {ACTION_LABEL[l.action] ?? l.action}
                      </span>
                    </td>
                    <td className="px-2 py-2 font-mono text-[11.5px] text-gray-500">
                      {l.target_type ? `${l.target_type}:${l.target_id ?? '—'}` : '—'}
                    </td>
                    <td className="px-2 py-2 text-gray-600">
                      <span className="block max-w-[420px] truncate" title={metaSummary(l.meta)}>
                        {metaSummary(l.meta)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
