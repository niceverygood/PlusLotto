// 이용자 일괄작업 바 (CLAUDE §8). 선택 회원에 상태/유입분류 일괄변경,
// 담당 배정·자동할당·리셋, 문자 발송을 적용한다. 위험 작업은 확인 모달(§10).
import { useState } from 'react'
import { UserPlus, Wand2, MessageSquare, RefreshCw, Tag, Eraser, Award, CalendarClock } from 'lucide-react'
import { BulkButton, ConfirmModal, Modal, Button } from '@/design-system/components'
import { STATUS_META, GRADE_LABEL } from '@/design-system/labels'
import { useStaff } from '@/lib/staff'
import { useRole } from '@/lib/auth'
import { useTodayDbCounts } from '@/lib/todayDb'
import { koByteLength, classifyMsgType } from '@/lib/oneshot'
import type { Grade, MemberStatus } from '@/types/db'
import {
  useAssignStaff,
  useAutoAssign,
  useBulkUpdateMembers,
  useBulkUpdateMemberSettings,
  useResetAssign,
  useResetMembers,
  useSendCustomSms,
  useSendSms,
  useSmsTemplates,
} from './api'
import { INFLOW_TYPES } from './views'

type BulkModal = 'status' | 'inflow' | 'grade' | 'assign' | 'auto' | 'reco' | 'reset' | 'resetdb' | 'sms' | null

const STATUS_VALUES: MemberStatus[] = ['active', 'suspended', 'deleted', 'withdrawn']
const GRADE_VALUES: Grade[] = ['simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss']
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] // index = weekly_reco_day(0=일..6=토)

const selectCls =
  'h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-[13px] text-gray-700 outline-none focus:border-primary-500'

export function MemberBulkActions({
  selectedIds,
  clear,
}: {
  selectedIds: string[]
  selectedRows: unknown[]
  clear: () => void
}) {
  // 디비 배분/입력·담당자 변경·유입분류는 최고관리자만(현장 피드백)
  const role = useRole()
  const isAdmin = role === 'admin'
  // 자유본문(직접입력) 일괄발송은 최고관리자·관리자만(현장 피드백 6/22, 오발송·스팸 위험)
  const canDirectSms = role === 'admin' || role === 'manager'
  const [modal, setModal] = useState<BulkModal>(null)
  const [statusVal, setStatusVal] = useState<MemberStatus>('active')
  const [inflowVal, setInflowVal] = useState<string>(INFLOW_TYPES[0])
  const [staffVal, setStaffVal] = useState('')
  const [smsVal, setSmsVal] = useState('')
  const [smsMode, setSmsMode] = useState<'template' | 'direct'>('template')
  const [smsBody, setSmsBody] = useState('') // 직접입력 본문(일괄)
  const [autoPool, setAutoPool] = useState<string[]>([]) // 자동배분 실행 시 대상 풀(임시 가감)
  const [gradeVal, setGradeVal] = useState<Grade>('goldp') // 일괄 등급변경
  const [recoDay, setRecoDay] = useState<string>('') // 자동조합 발송요일 0..6, ''=전역기본(금)
  const [recoCount, setRecoCount] = useState<string>('10') // 자동조합 발송갯수

  const { data: staff = [] } = useStaff()
  const { data: templates = [] } = useSmsTemplates()
  // 금일 배분디비 갯수 — 관리자 리스트뿐 아니라 자동할당 대상 선택에도 표시(현장 피드백).
  const { data: todayDb = {} } = useTodayDbCounts()

  const bulkUpdate = useBulkUpdateMembers()
  const bulkSettings = useBulkUpdateMemberSettings()
  const assign = useAssignStaff()
  const autoAssign = useAutoAssign()
  const reset = useResetAssign()
  const resetDb = useResetMembers()
  const sendSms = useSendSms()
  const sendCustomSms = useSendCustomSms()

  const busy =
    bulkUpdate.isPending ||
    bulkSettings.isPending ||
    assign.isPending ||
    autoAssign.isPending ||
    reset.isPending ||
    resetDb.isPending ||
    sendSms.isPending ||
    sendCustomSms.isPending

  const close = () => setModal(null)
  const done = () => {
    clear()
    close()
  }

  const n = selectedIds.length

  const openSms = () => {
    setSmsVal(templates[0]?.key ?? '')
    setSmsMode('template')
    setSmsBody('')
    setModal('sms')
  }
  const openAssign = () => {
    setStaffVal(staff[0]?.id ?? '')
    setModal('assign')
  }
  // 자동배분 후보 = 활성 rep. 모달 오픈 시 기본 풀('자동배분 대상' 플래그)로 초기화(§V2-1).
  const reps = staff.filter((s) => s.is_active && s.role === 'rep')
  const openAuto = () => {
    setAutoPool(reps.filter((s) => s.auto_assign_enabled).map((s) => s.id))
    setModal('auto')
  }
  const togglePool = (id: string) =>
    setAutoPool((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  return (
    <>
      <BulkButton onClick={() => setModal('status')}>
        <Tag className="h-3.5 w-3.5" /> 상태변경
      </BulkButton>
      {isAdmin && (
        <>
          <BulkButton onClick={() => setModal('inflow')}>
            <Tag className="h-3.5 w-3.5" /> 유입분류
          </BulkButton>
          <BulkButton onClick={() => setModal('grade')}>
            <Award className="h-3.5 w-3.5" /> 등급변경
          </BulkButton>
          <BulkButton onClick={() => setModal('reco')}>
            <CalendarClock className="h-3.5 w-3.5" /> 자동조합
          </BulkButton>
          <BulkButton onClick={openAssign}>
            <UserPlus className="h-3.5 w-3.5" /> 담당배정
          </BulkButton>
          <BulkButton onClick={openAuto}>
            <Wand2 className="h-3.5 w-3.5" /> 자동할당
          </BulkButton>
          <BulkButton onClick={() => setModal('reset')}>
            <RefreshCw className="h-3.5 w-3.5" /> 담당리셋
          </BulkButton>
          <BulkButton onClick={() => setModal('resetdb')}>
            <Eraser className="h-3.5 w-3.5" /> DB초기화
          </BulkButton>
        </>
      )}
      <BulkButton onClick={openSms}>
        <MessageSquare className="h-3.5 w-3.5" /> 문자발송
      </BulkButton>

      {/* 상태 일괄변경 */}
      <Modal
        open={modal === 'status'}
        onClose={close}
        title={`상태 일괄변경 · ${n}건`}
        size="sm"
        footer={
          <>
            <Button variant="sec" size="sm" onClick={close} disabled={busy}>
              취소
            </Button>
            <Button
              variant="pri"
              size="sm"
              disabled={busy}
              onClick={() =>
                bulkUpdate.mutate({ ids: selectedIds, patch: { status: statusVal } }, { onSuccess: done })
              }
            >
              적용
            </Button>
          </>
        }
      >
        <label className="mb-1.5 block text-[12px] font-semibold text-gray-600">변경할 상태</label>
        <select
          className={selectCls}
          value={statusVal}
          onChange={(e) => setStatusVal(e.target.value as MemberStatus)}
        >
          {STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </select>
        <p className="mt-2 text-[11.5px] text-gray-400">정지·삭제·탈퇴는 위험 작업입니다. 신중히 적용하세요.</p>
      </Modal>

      {/* 유입분류 일괄변경 */}
      <Modal
        open={modal === 'inflow'}
        onClose={close}
        title={`유입분류 일괄변경 · ${n}건`}
        size="sm"
        footer={
          <>
            <Button variant="sec" size="sm" onClick={close} disabled={busy}>
              취소
            </Button>
            <Button
              variant="pri"
              size="sm"
              disabled={busy}
              onClick={() =>
                bulkUpdate.mutate(
                  { ids: selectedIds, patch: { inflow_type: inflowVal } },
                  { onSuccess: done },
                )
              }
            >
              적용
            </Button>
          </>
        }
      >
        <label className="mb-1.5 block text-[12px] font-semibold text-gray-600">유입분류</label>
        <select className={selectCls} value={inflowVal} onChange={(e) => setInflowVal(e.target.value)}>
          {INFLOW_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Modal>

      {/* 등급 일괄변경 */}
      <Modal
        open={modal === 'grade'}
        onClose={close}
        title={`등급 일괄변경 · ${n}건`}
        size="sm"
        footer={
          <>
            <Button variant="sec" size="sm" onClick={close} disabled={busy}>
              취소
            </Button>
            <Button
              variant="pri"
              size="sm"
              disabled={busy}
              onClick={() =>
                bulkUpdate.mutate({ ids: selectedIds, patch: { grade: gradeVal } }, { onSuccess: done })
              }
            >
              적용
            </Button>
          </>
        }
      >
        <label className="mb-1.5 block text-[12px] font-semibold text-gray-600">변경할 등급</label>
        <select className={selectCls} value={gradeVal} onChange={(e) => setGradeVal(e.target.value as Grade)}>
          {GRADE_VALUES.map((g) => (
            <option key={g} value={g}>
              {GRADE_LABEL[g]}
            </option>
          ))}
        </select>
        <p className="mt-2 text-[11.5px] leading-relaxed text-gray-400">
          결제 없이 등급만 변경됩니다(운영자 수동 조정). 매출 귀속·자동조합 대상에 영향을 줄 수 있습니다.
        </p>
      </Modal>

      {/* 자동조합(추천번호) 발송설정 일괄 */}
      <Modal
        open={modal === 'reco'}
        onClose={close}
        title={`자동조합 발송설정 · ${n}건`}
        size="sm"
        footer={
          <>
            <Button variant="sec" size="sm" onClick={close} disabled={busy}>
              취소
            </Button>
            <Button
              variant="pri"
              size="sm"
              disabled={busy || (recoCount !== '' && Number(recoCount) < 1)}
              onClick={() =>
                bulkSettings.mutate(
                  {
                    ids: selectedIds,
                    patch: {
                      weekly_reco_day: recoDay === '' ? null : Number(recoDay),
                      weekly_reco_count: recoCount === '' ? null : Number(recoCount),
                    },
                  },
                  { onSuccess: done },
                )
              }
            >
              적용
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold text-gray-600">발송요일</label>
            <select className={selectCls} value={recoDay} onChange={(e) => setRecoDay(e.target.value)}>
              <option value="">전역 기본(금)</option>
              {WEEKDAYS.map((d, i) => (
                <option key={i} value={i}>
                  {d}요일
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold text-gray-600">조합 갯수</label>
            <input
              className={selectCls}
              inputMode="numeric"
              placeholder="전역 기본(30)"
              value={recoCount}
              onChange={(e) => setRecoCount(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-gray-400">
          매일 09:00 크론이 발송요일이 오늘인 회원에게 추천조합을 자동발급합니다(회원 홈페이지에서 조회).
          <b className="text-gray-500"> 유료(골드~로얄) 회원은 발송요일을 지정해야</b> 발급됩니다. 빈 칸은 해당 설정 해제(전역 기본).
        </p>
      </Modal>

      {/* 담당 배정 */}
      <Modal
        open={modal === 'assign'}
        onClose={close}
        title={`담당자 배정 · ${n}건`}
        size="sm"
        footer={
          <>
            <Button variant="sec" size="sm" onClick={close} disabled={busy}>
              취소
            </Button>
            <Button
              variant="pri"
              size="sm"
              disabled={busy || !staffVal}
              onClick={() => assign.mutate({ ids: selectedIds, staffId: staffVal }, { onSuccess: done })}
            >
              배정
            </Button>
          </>
        }
      >
        <label className="mb-1.5 block text-[12px] font-semibold text-gray-600">담당자</label>
        <select className={selectCls} value={staffVal} onChange={(e) => setStaffVal(e.target.value)}>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.role})
            </option>
          ))}
        </select>
      </Modal>

      {/* 문자 발송 */}
      <Modal
        open={modal === 'sms'}
        onClose={close}
        title={`문자 발송 · ${n}건`}
        size="sm"
        footer={
          <>
            <Button variant="sec" size="sm" onClick={close} disabled={busy}>
              취소
            </Button>
            <Button
              variant="acc"
              size="sm"
              disabled={busy || (smsMode === 'template' ? !smsVal : !smsBody.trim())}
              onClick={() => {
                const onErr = (e: unknown) =>
                  window.alert(e instanceof Error ? e.message : '문자 발송에 실패했습니다.')
                if (smsMode === 'template')
                  sendSms.mutate({ ids: selectedIds, templateKey: smsVal }, { onSuccess: done, onError: onErr })
                else sendCustomSms.mutate({ ids: selectedIds, body: smsBody }, { onSuccess: done, onError: onErr })
              }}
            >
              발송
            </Button>
          </>
        }
      >
        {canDirectSms && (
          <div className="mb-2.5 flex gap-1 rounded-md bg-gray-100 p-0.5 text-[12.5px]">
            <button
              type="button"
              className={
                'flex-1 rounded px-2 py-1 ' +
                (smsMode === 'template' ? 'bg-white font-semibold text-gray-800 shadow-sm' : 'text-gray-500')
              }
              onClick={() => setSmsMode('template')}
            >
              템플릿
            </button>
            <button
              type="button"
              className={
                'flex-1 rounded px-2 py-1 ' +
                (smsMode === 'direct' ? 'bg-white font-semibold text-gray-800 shadow-sm' : 'text-gray-500')
              }
              onClick={() => setSmsMode('direct')}
            >
              직접입력
            </button>
          </div>
        )}
        {smsMode === 'template' ? (
          <>
            <label className="mb-1.5 block text-[12px] font-semibold text-gray-600">템플릿</label>
            <select className={selectCls} value={smsVal} onChange={(e) => setSmsVal(e.target.value)}>
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.title}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label className="mb-1.5 block text-[12px] font-semibold text-gray-600">직접 입력</label>
            <textarea
              value={smsBody}
              onChange={(e) => setSmsBody(e.target.value)}
              rows={4}
              placeholder="발송할 문자 내용을 직접 입력하세요."
              className="w-full rounded-md border border-gray-300 p-2 text-[12.5px] text-gray-700 outline-none focus:border-primary-500"
            />
            <div className="mt-1 text-right font-mono text-[10.5px] tnum text-gray-400">
              {koByteLength(smsBody)}byte · {classifyMsgType(smsBody)}
            </div>
          </>
        )}
        <p className="mt-2 text-[11.5px] text-gray-400">
          선택한 {n}명에게 발송 이력이 생성되고 회원 상세 문자내역에 반영됩니다.
        </p>
      </Modal>

      {/* 자동할당 — 대상 풀(기본 플래그 + 실행 시 임시 가감) 후 라운드로빈(§V2-1) */}
      <Modal
        open={modal === 'auto'}
        onClose={close}
        title={`자동 할당 · ${n}건`}
        size="sm"
        footer={
          <>
            <Button variant="sec" size="sm" onClick={close} disabled={busy}>
              취소
            </Button>
            <Button
              variant="pri"
              size="sm"
              disabled={busy || autoPool.length === 0}
              onClick={() =>
                autoAssign.mutate({ ids: selectedIds, staffIds: autoPool }, { onSuccess: done })
              }
            >
              자동할당
            </Button>
          </>
        }
      >
        <p className="mb-2 text-[12px] leading-relaxed text-gray-500">
          선택한 <b className="text-gray-700">{n}건</b>을 아래 체크된 담당자에게 라운드로빈으로
          배정합니다. 기본값은 ‘자동배분 대상’으로 지정된 담당자이며, 이번 실행에 한해 가감할 수 있습니다.
        </p>
        {reps.length === 0 ? (
          <p className="rounded-md bg-gray-50 px-3 py-2 text-[12px] text-gray-500">
            활성 담당자(rep)가 없습니다. 운영자 관리에서 담당자를 추가하세요.
          </p>
        ) : (
          <>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-gray-600">
                대상 담당자 · {autoPool.length}명
              </span>
              <div className="flex gap-2 text-[11.5px]">
                <button
                  type="button"
                  className="text-primary-600 hover:underline"
                  onClick={() => setAutoPool(reps.map((s) => s.id))}
                >
                  전체
                </button>
                <button
                  type="button"
                  className="text-gray-400 hover:underline"
                  onClick={() => setAutoPool([])}
                >
                  해제
                </button>
              </div>
            </div>
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-gray-200 p-1">
              {reps.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={autoPool.includes(s.id)}
                    onChange={() => togglePool(s.id)}
                  />
                  <span className="text-gray-700">{s.name}</span>
                  <span
                    className="ml-auto font-mono text-[10.5px] tnum text-gray-400"
                    title="금일 배분디비(전체 · 수동/자동)"
                  >
                    금일 {todayDb[s.id]?.total ?? 0}
                    <span className="text-gray-300"> ({todayDb[s.id]?.manual ?? 0}/{todayDb[s.id]?.auto ?? 0})</span>
                  </span>
                  {s.auto_assign_enabled && (
                    <span className="rounded bg-gray-100 px-1.5 text-[10px] font-semibold text-gray-500">
                      기본
                    </span>
                  )}
                </label>
              ))}
            </div>
          </>
        )}
      </Modal>

      {/* 담당리셋 (위험) */}
      <ConfirmModal
        open={modal === 'reset'}
        onClose={close}
        onConfirm={() => reset.mutate({ ids: selectedIds }, { onSuccess: done })}
        title="담당 리셋"
        description={`${n}건의 담당자를 미지정으로 되돌립니다. 매출 귀속이 변경될 수 있습니다.`}
        confirmText="담당리셋"
        tone="danger"
        loading={busy}
      />

      {/* DB 초기화 (위험·재사용) */}
      <ConfirmModal
        open={modal === 'resetdb'}
        onClose={close}
        onConfirm={() => resetDb.mutate({ ids: selectedIds }, { onSuccess: done })}
        title="DB 초기화 (재사용)"
        description={`${n}건을 입력 시점(신규 리드) 상태로 초기화합니다. 상담상태는 '신규'로 바뀌며 등급·상태·담당·아웃콜·성향이 리셋되고 가입일시는 초기화 시점으로 갱신됩니다. 콜메모는 소프트삭제되어 최고관리자만 열람합니다. 결제 이력은 보존됩니다. 되돌릴 수 없습니다.`}
        confirmText="초기화"
        tone="danger"
        loading={busy}
      />
    </>
  )
}
