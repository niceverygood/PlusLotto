// 권한관리 (/admins/roles, CLAUDE §5·§9) — 역할 × 모듈(메뉴 노출) 체크박스 매트릭스.
// 원본 `08 권한관리` 화면 미확인 → 매트릭스 구조로 구현(ASSUMPTIONS). 저장 시 nav_access 영속 →
// 사이드바/라우트 가드가 즉시 반영(§8). admin 의 관리자·로그 접근은 자기잠금 방지로 항상 ON(고정).
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Lock, RotateCcw } from 'lucide-react'
import { Button, PageHeader, SkeletonRows } from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useCurrentUser } from '@/lib/auth'
import { useNavAccess } from '@/lib/navAccess'
import {
  ADMIN_LOCKED,
  DEFAULT_NAV_ACCESS,
  MODULE_LABEL,
  NAV_KEYS,
  ROLE_LABEL,
  ROLE_ORDER,
  type NavAccessMap,
  type NavKey,
} from '@/lib/permissions'
import type { Role } from '@/types/db'
import { useSaveNavAccess } from './api'

function cloneMap(m: NavAccessMap): NavAccessMap {
  const out: NavAccessMap = {}
  for (const k of NAV_KEYS) out[k] = [...(m[k] ?? [])]
  return out
}

// 정규화 직렬화(역할 순서 고정) — 변경 여부 비교용.
function norm(m: NavAccessMap): string {
  return NAV_KEYS.map((k) => `${k}:${ROLE_ORDER.filter((r) => (m[k] ?? []).includes(r)).join(',')}`).join('|')
}

const isLockedCell = (key: NavKey, role: Role) => role === 'admin' && ADMIN_LOCKED.includes(key)

export function RolesPage() {
  usePageMeta('권한관리', '역할별 메뉴 노출 매트릭스')
  const navigate = useNavigate()
  const me = useCurrentUser()
  const { data, isLoading } = useNavAccess()
  const save = useSaveNavAccess()

  const [draft, setDraft] = useState<NavAccessMap | null>(null)
  const [baseKey, setBaseKey] = useState<string | null>(null)

  // 쿼리 데이터가 도착/변경되면 draft 를 동기화(저장 후 재조회 포함).
  if (data) {
    const key = norm(data)
    if (key !== baseKey) {
      setBaseKey(key)
      setDraft(cloneMap(data))
    }
  }

  const toggle = (key: NavKey, role: Role) => {
    if (isLockedCell(key, role)) return
    setDraft((prev) => {
      if (!prev) return prev
      const cur = prev[key] ?? []
      const next = cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role]
      return { ...prev, [key]: next }
    })
  }

  const isOn = (key: NavKey, role: Role) =>
    isLockedCell(key, role) || !!draft?.[key]?.includes(role)

  const dirty = !!draft && !!data && norm(draft) !== norm(data)

  // 권한 매트릭스 편집은 admin(총괄) 전용 — 실장·팀장은 계정관리(/admins)만 접근(계층 위임, §5).
  if (me && me.role !== 'admin') return <Navigate to="/admins" replace />

  return (
    <div>
      <PageHeader
        title="권한관리"
        description="역할이 볼 수 있는 메뉴(모듈)를 지정합니다. 저장 시 사이드바에 즉시 반영됩니다."
        actions={
          <>
            <Button variant="sec" size="sm" onClick={() => navigate('/admins')}>
              계정 목록
            </Button>
            <Button
              variant="gho"
              size="sm"
              onClick={() => setDraft(cloneMap(DEFAULT_NAV_ACCESS))}
              disabled={save.isPending}
            >
              <RotateCcw className="h-4 w-4" /> 기본값
            </Button>
            <Button
              variant="pri"
              size="sm"
              onClick={() => draft && save.mutate(draft)}
              disabled={!dirty || save.isPending}
            >
              저장
            </Button>
          </>
        }
      />

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {isLoading || !draft ? (
          <div className="p-4">
            <SkeletonRows rows={8} cols={5} />
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-gray-100 bg-gray-50 text-[12px] font-bold text-gray-600">
              <tr>
                <th className="px-4 py-3">모듈</th>
                {ROLE_ORDER.map((r) => (
                  <th key={r} className="px-2 py-3 text-center">
                    {ROLE_LABEL[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {NAV_KEYS.map((key) => (
                <tr key={key} className="border-t border-gray-100 hover:bg-gray-50/60">
                  <td className="px-4 py-2.5 font-semibold text-ink-800">{MODULE_LABEL[key]}</td>
                  {ROLE_ORDER.map((role) => {
                    const locked = isLockedCell(key, role)
                    return (
                      <td key={role} className="px-2 py-2.5 text-center">
                        <label className="inline-flex items-center justify-center" title={locked ? '자기잠금 방지 — 항상 허용' : undefined}>
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-primary-600 disabled:opacity-50"
                            checked={isOn(key, role)}
                            disabled={locked}
                            onChange={() => toggle(key, role)}
                          />
                          {locked && <Lock className="ml-1 h-3 w-3 text-gray-300" />}
                        </label>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-gray-500">
        <Lock className="h-3.5 w-3.5" />
        관리자의 ‘관리자·로그’ 접근은 자기잠금 방지를 위해 항상 허용되며 해제할 수 없습니다.
      </p>
    </div>
  )
}
