// 관리자 (/admins, CLAUDE §5·§8) — 운영자 계정 목록·생성·수정·활성토글.
// 계정 생성/수정은 Drawer(react-hook-form+zod), 비활성화는 확인 모달. 모든 변경은 admin 로그(§8).
// 비밀번호 설정 없음 — TODO(live-verify): 실 인증 규칙(이메일/사번·임시비번 등) 확인 대상.
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Pencil, PhoneMissed, Plus, ShieldCheck, UserPlus } from 'lucide-react'
import { Button, ConfirmModal, Drawer, EmptyState, PageHeader, SkeletonRows } from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useCurrentUser } from '@/lib/auth'
import { useStaff, useTeams } from '@/lib/staff'
import { datetime } from '@/lib/format'
import { assignableRoles, canManageStaff, canViewCallRecordings, ROLE_LABEL, ROLE_ORDER } from '@/lib/permissions'
import type { Role, Staff } from '@/types/db'
import {
  useCallVolumeStatus,
  useSaveStaff,
  useToggleAutoAssign,
  useToggleStaffActive,
  useTodayDbCounts,
  type StaffInput,
} from './api'
import { dataSource } from '@/lib/supabase'
import { setStaffPassword } from './supa'

const inputCls =
  'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] text-gray-800 outline-none focus:border-primary-500'
const labelCls = 'mb-1.5 block text-[12px] font-semibold text-gray-600'
const errCls = 'mt-1 text-[11.5px] text-danger'

function RoleChip({ role }: { role: Role }) {
  const tone =
    role === 'admin'
      ? 'bg-primary-50 text-primary-700'
      : role === 'manager'
        ? 'bg-info-bg text-info'
        : 'bg-gray-100 text-gray-600'
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{ROLE_LABEL[role]}</span>
}

function ActiveChip({ active }: { active: boolean }) {
  return active ? (
    <span className="rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">활성</span>
  ) : (
    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">비활성</span>
  )
}

export function AdminsPage() {
  usePageMeta('관리자', '운영자 계정 · 권한 관리')
  const navigate = useNavigate()
  const me = useCurrentUser()

  const { data: staff = [], isLoading } = useStaff()
  const { data: teams = [] } = useTeams()
  const { data: todayDb = {} } = useTodayDbCounts()
  const { data: callVolume } = useCallVolumeStatus()
  const teamName = (id: string | null) => (id ? (teams.find((t) => t.id === id)?.name ?? id) : '—')

  const [edit, setEdit] = useState<Staff | 'new' | null>(null)
  const [deactivate, setDeactivate] = useState<Staff | null>(null)
  const [roleFilter, setRoleFilter] = useState<Role | ''>('')

  const toggle = useToggleStaffActive()
  const toggleAutoAssign = useToggleAutoAssign()
  // 계층 위임(§5): 본인이 관리 가능한 하위 직원만 노출. admin 은 canManageStaff 가 전원 true.
  // 등급별(실장·팀장 등) 필터링(현장 피드백) + 로그인ID 기준 정렬(useStaff 가 이미 정렬 — 여기선 유지만).
  const visible = [...staff]
    .filter((s) => canManageStaff(me, s))
    .filter((s) => !roleFilter || s.role === roleFilter)
    .sort((a, b) => a.login_id.localeCompare(b.login_id))

  const onToggle = (s: Staff) => {
    if (s.is_active) setDeactivate(s)
    else toggle.mutate({ id: s.id, active: true })
  }

  return (
    <div>
      <PageHeader
        title="관리자"
        description="운영자 계정을 생성·수정하고 권한 매트릭스를 관리합니다."
        actions={
          <>
            {me?.role === 'admin' && (
              <Button variant="sec" size="sm" onClick={() => navigate('/admins/roles')}>
                <ShieldCheck className="h-4 w-4" /> 권한관리
              </Button>
            )}
            {/* 통화녹음 관련 화면은 관리자 이상만(현장 피드백 8/4, 정의현 차장). */}
            {canViewCallRecordings(me?.role ?? null) && (
              <Button variant="sec" size="sm" onClick={() => navigate('/admins/recordings')}>
                <PhoneMissed className="h-4 w-4" /> 미매칭 통화녹음
              </Button>
            )}
            <Button variant="pri" size="sm" onClick={() => setEdit('new')}>
              <Plus className="h-4 w-4" /> 새 계정
            </Button>
          </>
        }
      />

      {/* 월 발신 통화량 경고(현장 피드백 7/3) — 상담상태 변경 건수로 근사 집계 */}
      {callVolume?.over && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning-bd bg-warning-bg px-3.5 py-2.5 text-[12.5px] text-ink-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p>
            이번 달 발신 통화량(상담상태 변경 건수 근사){' '}
            <b className="font-mono tnum text-warning">{callVolume.count.toLocaleString('ko-KR')}건</b>이 경고 기준{' '}
            <b className="font-mono tnum">{callVolume.threshold.toLocaleString('ko-KR')}건</b>을 넘었습니다. 기준은{' '}
            <b>설정 &gt; 사이트 설정 &gt; 통화 녹음·키워드 탐지</b>에서 조정할 수 있습니다.
          </p>
        </div>
      )}

      {/* 등급별(실장·팀장 등) 필터링(현장 피드백) */}
      <div className="mb-3 flex items-center gap-2">
        <label className="text-[12px] font-semibold text-gray-500">등급</label>
        <select
          className="h-9 rounded-md border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-700 outline-none focus:border-primary-500"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as Role | '')}
        >
          <option value="">전체</option>
          {ROLE_ORDER.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        {isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={5} cols={6} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon={<UserPlus className="h-6 w-6" />} title="관리할 수 있는 운영자가 없습니다" />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-gray-100 bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2.5">이름</th>
                <th className="px-2 py-2.5">로그인 ID</th>
                <th className="w-28 px-2 py-2.5">역할</th>
                <th className="w-24 px-2 py-2.5">팀</th>
                <th className="w-20 px-2 py-2.5">상태</th>
                <th className="w-36 px-2 py-2.5 text-right" title="오늘 배정된 디비 수량 (전체 · 수동/자동)">
                  금일 디비
                </th>
                <th className="w-40 px-2 py-2.5 text-right">마지막 로그인</th>
                <th className="w-32 px-3 py-2.5 text-right">관리</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const isMe = s.id === me?.id
                return (
                  <tr key={s.id} className="border-t border-gray-100 hover:bg-gray-50/60">
                    <td className="px-3 py-2.5">
                      <span className="font-semibold text-ink-800">{s.name}</span>
                      {isMe && <span className="ml-1.5 text-[11px] text-gray-400">(나)</span>}
                    </td>
                    <td className="px-2 py-2.5 font-mono text-[12px] text-gray-600">{s.login_id}</td>
                    <td className="px-2 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <RoleChip role={s.role} />
                        {/* 자동배분 대상 — 활성/비활성 토글처럼 리스트에서 바로 체크(현장 피드백 7/28) */}
                        {s.role === 'rep' && (
                          <label
                            className="flex items-center gap-1 whitespace-nowrap text-[10.5px] font-semibold text-accent-600"
                            title="자동배분 대상"
                          >
                            <input
                              type="checkbox"
                              checked={s.auto_assign_enabled}
                              disabled={toggleAutoAssign.isPending}
                              onChange={(e) =>
                                toggleAutoAssign.mutate({ id: s.id, enabled: e.target.checked })
                              }
                            />
                            자동
                          </label>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-[12px] text-gray-600">{teamName(s.team_id)}</td>
                    <td className="px-2 py-2.5">
                      <ActiveChip active={s.is_active} />
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      {(() => {
                        // 비활성 계정(이틀전부재·중복디비 등 분류용 더미 계정 포함)은 실제 근무 중인
                        // 담당자가 아니므로 배정 건수를 그대로 노출하지 않는다 — 분류 목적 대량 배정이
                        // 실 담당자 수치처럼 보여 "배분상태 오류"로 보이는 문제였다(현장 피드백 7/28).
                        if (!s.is_active) {
                          return <span className="font-mono text-[12px] text-gray-300">—</span>
                        }
                        const c = todayDb[s.id]
                        if (!c || c.total === 0)
                          return <span className="font-mono text-[12px] text-gray-300">0</span>
                        return (
                          <span className="inline-flex items-baseline gap-1 font-mono tnum">
                            <b className="text-[13px] text-ink-800">{c.total}</b>
                            <span className="text-[10.5px] text-gray-400">
                              수동 {c.manual} · 자동 {c.auto}
                            </span>
                          </span>
                        )
                      })()}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-[11.5px] tnum text-gray-500">
                      {s.last_login_at ? datetime(s.last_login_at) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEdit(s)}
                          className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-primary-600"
                          title="수정"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggle(s)}
                          disabled={isMe}
                          className={
                            'rounded-md px-2 py-1 text-[11.5px] font-semibold transition-colors ' +
                            (isMe
                              ? 'cursor-not-allowed text-gray-300'
                              : s.is_active
                                ? 'text-danger hover:bg-danger-bg'
                                : 'text-success hover:bg-success-bg')
                          }
                          title={isMe ? '본인 계정은 변경할 수 없습니다' : undefined}
                        >
                          {s.is_active ? '비활성화' : '활성화'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {edit && <StaffEditor staff={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}

      <ConfirmModal
        open={!!deactivate}
        onClose={() => setDeactivate(null)}
        onConfirm={() =>
          deactivate &&
          toggle.mutate({ id: deactivate.id, active: false }, { onSuccess: () => setDeactivate(null) })
        }
        title="계정 비활성화"
        description={`'${deactivate?.name ?? ''}' 계정을 비활성화합니다. 해당 계정은 로그인할 수 없습니다.`}
        confirmText="비활성화"
        tone="danger"
        loading={toggle.isPending}
      />
    </div>
  )
}

// ── 계정 생성/수정 ────────────────────────────────────────────────────
const staffSchema = z.object({
  name: z.string().min(1, '이름을 입력하세요.'),
  login_id: z.string().min(2, '로그인 ID를 2자 이상 입력하세요.'),
  role: z.enum(['admin', 'manager', 'leader', 'rep']),
  team_id: z.string(),
  is_active: z.boolean(),
  auto_assign_enabled: z.boolean(),
})
type StaffForm = z.infer<typeof staffSchema>

function StaffEditor({ staff, onClose }: { staff: Staff | null; onClose: () => void }) {
  const save = useSaveStaff()
  const me = useCurrentUser()
  const { data: teams = [] } = useTeams()
  const [serverErr, setServerErr] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  // 신규 생성 후 부분성공(계정 저장 OK·비번 실패) 재시도 시 UPDATE 경로로 가도록 저장된 id 보존(D68 #9).
  const [savedId, setSavedId] = useState<string | null>(null)
  // 비밀번호 설정/변경은 최고관리자 + 라이브(supabase) 모드에서만 — Auth 계정 프로비저닝. 현장 피드백 6/23(D67).
  const canPw = me?.role === 'admin' && dataSource === 'supabase'

  // 계층 위임(§5): 부여 가능한 역할로 제한. 본인 역할은 변경 불가. 팀장은 본인 팀으로 고정.
  const roleOptions = assignableRoles(me?.role ?? null)
  const isSelf = !!staff && staff.id === me?.id
  const lockTeam = me?.role === 'leader'

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<StaffForm>({
    resolver: zodResolver(staffSchema),
    defaultValues: {
      name: staff?.name ?? '',
      login_id: staff?.login_id ?? '',
      role: staff?.role ?? roleOptions[roleOptions.length - 1] ?? 'rep',
      team_id: staff?.team_id ?? (lockTeam ? (me?.teamId ?? '') : ''),
      is_active: staff?.is_active ?? true,
      auto_assign_enabled: staff?.auto_assign_enabled ?? false,
    },
  })

  const role = watch('role')
  const submit = handleSubmit((v) => {
    setServerErr(null)
    const input: StaffInput = {
      name: v.name,
      login_id: v.login_id,
      role: v.role,
      team_id: v.role === 'admin' ? null : v.team_id || null,
      is_active: v.is_active,
      auto_assign_enabled: v.role === 'rep' ? v.auto_assign_enabled : false,
    }
    save.mutate(
      // 부분성공 재시도: 이미 INSERT 된 계정이면 savedId 로 UPDATE 경로 → 'ID 중복' 오류 회피(D68 #9).
      { id: staff?.id ?? savedId ?? undefined, input },
      {
        onSuccess: async (returnedId: string) => {
          setSavedId(returnedId)
          // 비밀번호 입력 시: 계정 저장 후 Auth 프로비저닝(이 아이디로 로그인 가능하게). 비우면 비번 변경 없음.
          if (canPw && pw.trim().length >= 6) {
            setPwBusy(true)
            try {
              await setStaffPassword(v.login_id.trim(), pw.trim())
            } catch (e) {
              setPwBusy(false)
              setServerErr('계정은 저장됐으나 비밀번호 설정 실패: ' + (e instanceof Error ? e.message : '') + ' — 저장을 다시 눌러 재시도하세요.')
              return // 드로어 유지 → 재시도(이제 UPDATE 경로라 중복오류 없음)
            }
            setPwBusy(false)
          }
          onClose()
        },
        onError: (e) => setServerErr(e instanceof Error ? e.message : '저장에 실패했습니다.'),
      },
    )
  })

  return (
    <Drawer
      open
      onClose={onClose}
      title={staff ? '계정 수정' : '새 계정 생성'}
      footer={
        <>
          <Button variant="sec" size="sm" onClick={onClose} disabled={save.isPending || pwBusy}>
            취소
          </Button>
          <Button variant="pri" size="sm" onClick={submit} disabled={save.isPending || pwBusy}>
            {pwBusy ? '계정 설정 중…' : '저장'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls}>이름</label>
          <input className={inputCls} {...register('name')} />
          {errors.name && <p className={errCls}>{errors.name.message}</p>}
        </div>
        <div>
          <label className={labelCls}>로그인 ID</label>
          <input className={inputCls} autoComplete="off" {...register('login_id')} />
          {errors.login_id && <p className={errCls}>{errors.login_id.message}</p>}
          {serverErr && <p className={errCls}>{serverErr}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>역할</label>
            <select className={inputCls} disabled={isSelf} {...register('role')}>
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            {isSelf && <p className="mt-1 text-[11.5px] text-gray-400">본인 역할은 변경할 수 없습니다.</p>}
          </div>
          <div>
            <label className={labelCls}>팀</label>
            <select className={inputCls} disabled={role === 'admin' || lockTeam} {...register('team_id')}>
              <option value="">팀 없음</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 pt-1 text-[13px] text-gray-700">
          <input type="checkbox" {...register('is_active')} /> 활성 계정(체크 해제 시 로그인 불가)
        </label>
        {role === 'rep' && (
          <label className="flex items-center gap-2 text-[13px] text-gray-700">
            <input type="checkbox" {...register('auto_assign_enabled')} /> 자동배분 대상(자동할당
            라운드로빈 풀에 포함)
          </label>
        )}
        {canPw ? (
          <div className="border-t border-gray-100 pt-3">
            <label className={labelCls}>비밀번호 {staff ? '변경' : '설정'}</label>
            <input
              type="password"
              className={inputCls}
              autoComplete="new-password"
              placeholder={staff ? '변경 시에만 입력 (6자 이상)' : '로그인 비밀번호 (6자 이상)'}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            <p className="mt-1 text-[11.5px] leading-relaxed text-gray-400">
              입력하면 이 아이디로 로그인할 계정이 생성/갱신됩니다. 비우면 비밀번호는 변경되지 않습니다.
            </p>
          </div>
        ) : (
          <p className="rounded-md bg-gray-50 px-3 py-2 text-[11.5px] leading-relaxed text-gray-500">
            {dataSource === 'supabase'
              ? '비밀번호 설정/변경은 최고관리자만 가능합니다.'
              : '데모(mock) 환경은 로그인 ID 로 인증합니다.'}
          </p>
        )}
      </div>
    </Drawer>
  )
}
