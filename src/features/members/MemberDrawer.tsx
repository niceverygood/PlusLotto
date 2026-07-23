// 회원 상세 Drawer — §8 교차연동 허브. 탭(기본정보·결제내역·문자내역·배정이력·메모) +
// 액션(등급변경·담당변경·정지·아웃콜·문자발송). 모든 액션은 api 뮤테이션 →
// 관련 쿼리 무효화 + 로그/배정/문자 부수효과를 만든다.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CreditCard, Dices, ExternalLink, Mic, MessageSquare, Play, Send, Sparkles, Trash2, Trophy, Upload, Wand2 } from 'lucide-react'
import {
  Badge,
  Button,
  ConfirmModal,
  Drawer,
  LottoBalls,
  StatusChip,
  Tabs,
  type TabItem,
} from '@/design-system/components'
import { GRADE_LABEL, PAYMENT_METHOD_LABEL, SMS_TYPE_LABEL } from '@/design-system/labels'
import { date, datetime, krw } from '@/lib/format'
import { useStaff, useTeams } from '@/lib/staff'
import { useRole } from '@/lib/auth'
import { koByteLength, classifyMsgType } from '@/lib/oneshot'
import { homepageId, homepagePw } from '@/lib/homepage'
import { readWinRecords, summarizeWinRecords, type WinRecord } from '@/lib/winHistory'
import { AGE_BANDS, COMPLAINT_RESULTS, COMPLAINT_TYPES, CONSULT_STATUSES, GENDERS, TENDENCIES } from './views'
import type { CallRecording, Grade, SmsSend, WeeklyRecoIssue } from '@/types/db'
import {
  readCallRecordings,
  readComplaints,
  readMemos,
  useAddComplaint,
  useAddMemo,
  useAnalyzeCallRecording,
  useAssignStaff,
  useCallRecordingUrl,
  useDeleteCallRecording,
  useDeleteRecoIssue,
  useDeleteMemo,
  useManualIssueReco,
  useMember,
  useMemberAssignments,
  useMemberPayments,
  useMemberSms,
  useProducts,
  useRequestPayment,
  useResetAssign,
  useSendCustomSms,
  useSendSms,
  useSmsTemplates,
  useTranscribeCallRecording,
  useUpdateMember,
  useUpdateMemberSettings,
  useUpdatePaymentStaff,
  useUploadCallRecording,
  type ResetMemo,
} from './api'
import type { PaymentMethod } from '@/types/db'

const GRADES: Grade[] = ['simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss']
// 메모는 별도 탭이 아니라 '기본정보' 탭 최하단에 표시(현장 피드백 7/3).
type DrawerTab = 'info' | 'payments' | 'sms' | 'assignments' | 'reco' | 'calls' | 'complaints'

function readWeeklyRecos(meta: Record<string, unknown> | undefined): WeeklyRecoIssue[] {
  const list = meta?.weekly_recos as WeeklyRecoIssue[] | undefined
  return Array.isArray(list) ? list : []
}

function linkedRecoIssue(sms: SmsSend, issues: readonly WeeklyRecoIssue[]): WeeklyRecoIssue | null {
  if (sms.type !== 'recommend') return null
  const sentAt = sms.sent_at ? Date.parse(sms.sent_at) : Number.NaN
  const exact = issues.find((issue) => Number.isFinite(sentAt) && Date.parse(issue.issued_at) === sentAt)
  if (exact) return exact
  const roundMatch = sms.body.match(/(?:^|\n)(\d+)\.(\d{2})회차(?:\n|$)/)
  if (!roundMatch) return null
  const roundNo = Number(`${roundMatch[1]}${roundMatch[2]}`)
  return issues.find((issue) => issue.round_no === roundNo) ?? null
}

const selectCls =
  'h-8 rounded-md border border-gray-300 bg-white px-2 text-[12px] text-gray-700 outline-none focus:border-primary-500'
// 기본정보 인라인 수정 입력칸(현장 피드백 7/6) — 평소엔 텍스트처럼 보이다 포커스 시 편집 표시.
const inlineEditCls =
  'h-6 w-full rounded border border-transparent bg-transparent px-1 -mx-1 text-[12.5px] text-ink-800 outline-none hover:border-gray-200 focus:border-primary-500 focus:bg-white'
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'bank', label: '무통장' },
  { value: 'manual', label: '수기' },
  { value: 'pg', label: 'PG' },
]
const metaNum = (meta: Record<string, unknown> | undefined, key: string): number | null =>
  typeof meta?.[key] === 'number' ? (meta[key] as number) : null
const metaStr = (meta: Record<string, unknown> | undefined, key: string): string =>
  typeof meta?.[key] === 'string' ? (meta[key] as string) : ''

// 통화예약(현장 피드백 7/23) — <input type="datetime-local"> 은 로컬시각 "YYYY-MM-DDTHH:mm" 문자열을 쓴다.
function isoToLocalInput(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function localInputToIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function MemberDrawer({ memberId, onClose }: { memberId: string | null; onClose: () => void }) {
  const open = !!memberId
  const { data: member } = useMember(memberId)
  const { data: payments = [] } = useMemberPayments(memberId)
  const { data: sms = [] } = useMemberSms(memberId)
  const { data: assignments = [] } = useMemberAssignments(memberId)
  const { data: staff = [] } = useStaff()
  const { data: teams = [] } = useTeams()
  const { data: products = [] } = useProducts()
  const { data: templates = [] } = useSmsTemplates()

  const role = useRole()
  const updateMember = useUpdateMember()
  const addMemo = useAddMemo()
  const deleteMemo = useDeleteMemo()
  const addComplaint = useAddComplaint()
  const assignStaff = useAssignStaff()
  const resetAssign = useResetAssign()
  const sendSms = useSendSms()
  const sendCustomSms = useSendCustomSms()
  const manualIssue = useManualIssueReco()
  const deleteRecoIssue = useDeleteRecoIssue()
  const requestPayment = useRequestPayment()
  const updatePaymentStaff = useUpdatePaymentStaff()
  const updateSettings = useUpdateMemberSettings()
  const uploadCallRec = useUploadCallRecording()
  const deleteCallRec = useDeleteCallRecording()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [tab, setTab] = useState<DrawerTab>('info')
  const [memoDraft, setMemoDraft] = useState('')
  // 기본정보 인라인 수정(현장 피드백 7/6·7/23) — 이름/핸드폰/닉네임/유입코드
  const [nameDraft, setNameDraft] = useState('')
  const [phoneDraft, setPhoneDraft] = useState('')
  const [nicknameDraft, setNicknameDraft] = useState('')
  const [inflowCodeDraft, setInflowCodeDraft] = useState('')
  // 통화예약 일시(현장 피드백 7/23) — meta.call_reservation_at(ISO), datetime-local input 은 로컬시각 문자열
  const [callResAtDraft, setCallResAtDraft] = useState('')
  // 민원관리(현장 피드백 7/6)
  const [complaintBody, setComplaintBody] = useState('')
  const [complaintType, setComplaintType] = useState<string>(COMPLAINT_TYPES[0])
  const [complaintResult, setComplaintResult] = useState<string>(COMPLAINT_RESULTS[0])
  const [smsTpl, setSmsTpl] = useState('')
  const [smsBody, setSmsBody] = useState('') // 직접 입력 발송 본문
  const [issueCount, setIssueCount] = useState('') // 수동 발급 세트 수
  const [issueSms, setIssueSms] = useState(true) // 수동 발급 시 문자 발송 여부(현장 7/22: 기본 체크)
  const [confirmSuspend, setConfirmSuspend] = useState(false)
  const [recoToDelete, setRecoToDelete] = useState<WeeklyRecoIssue | null>(null)
  // 회원 설정(조합발송요일/갯수/홈페이지 비번/종료일/일시정지)
  const [sendDay, setSendDay] = useState('')
  const [sendCount, setSendCount] = useState('')
  const [hpPw, setHpPw] = useState('')
  const [endDate, setEndDate] = useState('') // 종료일(YYYY-MM-DD) override, 빈값=결제 종료일 사용
  const [recoPaused, setRecoPaused] = useState(false) // 조합발송 일시정지
  // 결제 요청
  const [payProduct, setPayProduct] = useState('')
  const [payMethod, setPayMethod] = useState<PaymentMethod>('bank')
  const [payAmount, setPayAmount] = useState('') // 금액 수기 입력(현장 피드백 <결제> 1) — 상품 선택 시 기본값

  useEffect(() => {
    setMemoDraft('') // 새 콜메모 입력칸(리스트형 누적) — 회원 전환 시 비움
    setTab('info')
    setNameDraft(member?.name ?? '')
    setPhoneDraft(member?.phone ?? '')
    setNicknameDraft(member?.nickname ?? '')
    setInflowCodeDraft(member?.inflow_code ?? '')
    setCallResAtDraft(isoToLocalInput(metaStr(member?.meta, 'call_reservation_at')))
    setComplaintBody('')
    setComplaintType(COMPLAINT_TYPES[0])
    setComplaintResult(COMPLAINT_RESULTS[0])
    const d = metaNum(member?.meta, 'weekly_reco_day')
    const c = metaNum(member?.meta, 'weekly_reco_count')
    setSendDay(d === null ? '' : String(d))
    setSendCount(c === null ? '' : String(c))
    setHpPw(metaStr(member?.meta, 'homepage_pw'))
    setRecoPaused(member?.meta?.reco_paused === true)
    setPayProduct('')
    setPayMethod('bank')
    setPayAmount('')
    setSmsBody('')
    setIssueCount('')
    setIssueSms(true)
    setRecoToDelete(null)
  }, [member?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (templates.length && !smsTpl) setSmsTpl(templates[0].key)
  }, [templates, smsTpl])

  const staffName = useMemo(() => {
    const m: Record<string, string> = {}
    for (const s of staff) m[s.id] = s.name
    return m
  }, [staff])

  // 결제 회차(1차/2차/3차…) — 현장 피드백 7/6: 결제건마다 다른 담당자를 배정할 수 있어야 하므로
  // 시간순(오름차순)으로 몇 번째 결제인지 매겨서 표시. payments 는 최신순 정렬이라 여기서 뒤집어 계산.
  const paymentRound = useMemo(() => {
    const m: Record<string, number> = {}
    ;[...payments]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .forEach((p, i) => (m[p.id] = i + 1))
    return m
  }, [payments])

  // 종료일 기본값 = 결제일(없으면 가입일) + 1년. meta.end_date(수정 override) 우선 (현장 6/26·6/29).
  const defaultEnd = useMemo(() => {
    const paidAts = payments
      .filter((p) => p.status === 'approved' && p.paid_at)
      .map((p) => p.paid_at as string)
      .sort()
    const base = paidAts.length ? paidAts[paidAts.length - 1] : member?.registered_at
    if (!base) return null
    const d = new Date(base)
    d.setFullYear(d.getFullYear() + 1)
    return d.toISOString()
  }, [payments, member?.registered_at])
  const endOverride = metaStr(member?.meta, 'end_date')
  const effEnd = endOverride || defaultEnd
  // 종료일 입력칸 기본값: override 있으면 그 값, 없으면 결제일/가입일+1년(현장 6/29).
  useEffect(() => {
    setEndDate(endOverride ? endOverride.slice(0, 10) : defaultEnd ? defaultEnd.slice(0, 10) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member?.id, defaultEnd])
  const teamName = useMemo(() => {
    const m: Record<string, string> = {}
    for (const t of teams) m[t.id] = t.name
    return m
  }, [teams])
  const productName = useMemo(() => {
    const m: Record<string, string> = {}
    for (const p of products) m[p.id] = p.name
    return m
  }, [products])

  if (!member) {
    return (
      <Drawer open={open} onClose={onClose} title="회원 상세" width={760} movable storageKey="member">
        <div className="py-10 text-center text-[12.5px] text-gray-400">불러오는 중…</div>
      </Drawer>
    )
  }
  const id = member.id
  const canDeleteReco = role === 'admin' || role === 'manager'

  // 배정이력은 최고관리자만(현장 피드백 <회원정보창> 6). 메모는 기본정보 탭 하단에 통합(현장 피드백 7/3).
  const tabs: TabItem[] = [
    { key: 'info', label: '기본정보' },
    { key: 'payments', label: '결제내역', count: payments.length },
    { key: 'sms', label: '문자내역', count: sms.length },
    ...(role === 'admin'
      ? [{ key: 'assignments', label: '배정이력', count: assignments.length } as TabItem]
      : []),
    { key: 'reco', label: '발급번호', count: readWeeklyRecos(member.meta).length || undefined },
    { key: 'calls', label: '통화녹음', count: readCallRecordings(member).length || undefined },
    { key: 'complaints', label: '민원관리', count: readComplaints(member).length || undefined },
  ]

  const title = (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate font-bold text-ink-900">{member.name}</span>
      <span className="font-mono text-[12px] font-normal text-gray-400">{member.user_id}</span>
      <Badge grade={member.grade} />
      <StatusChip status={member.status} />
    </div>
  )

  return (
    <Drawer open={open} onClose={onClose} title={title} width={760} movable storageKey="member">
      {/* 빠른 액션 */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
        <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-500">
          등급
          <select
            className={selectCls}
            value={member.grade}
            onChange={(e) => updateMember.mutate({ id, patch: { grade: e.target.value as Grade } })}
          >
            {GRADES.map((g) => (
              <option key={g} value={g}>
                {GRADE_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        {/* 담당자 변경은 최고관리자만(현장 피드백). 그 외 역할은 읽기 전용 표시. */}
        <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-500">
          담당
          {role === 'admin' ? (
            <select
              className={selectCls}
              value={member.assigned_staff_id ?? ''}
              onChange={(e) =>
                e.target.value
                  ? assignStaff.mutate({ ids: [id], staffId: e.target.value })
                  : resetAssign.mutate({ ids: [id] })
              }
            >
              <option value="">미지정</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[12.5px] font-normal text-ink-800">
              {member.assigned_staff_id ? (staffName[member.assigned_staff_id] ?? '-') : '미지정'}
            </span>
          )}
        </label>
        <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-500">
          상담상태
          <select
            className={selectCls}
            value={member.consult_status ?? ''}
            onChange={(e) => updateMember.mutate({ id, patch: { consult_status: e.target.value || null } })}
          >
            <option value="">미지정</option>
            {CONSULT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-500">
          통화예약
          <input
            type="datetime-local"
            className={selectCls}
            value={callResAtDraft}
            onChange={(e) => setCallResAtDraft(e.target.value)}
            onBlur={() => {
              const iso = localInputToIso(callResAtDraft)
              const prev = metaStr(member.meta, 'call_reservation_at')
              if ((iso ?? '') !== prev) updateSettings.mutate({ id, patch: { call_reservation_at: iso } })
            }}
          />
          {callResAtDraft && (
            <button
              type="button"
              className="text-gray-400 hover:text-danger"
              title="예약 취소"
              onClick={() => {
                setCallResAtDraft('')
                updateSettings.mutate({ id, patch: { call_reservation_at: null } })
              }}
            >
              ×
            </button>
          )}
        </label>
        <div className="ml-auto flex items-center gap-2">
          {/* 여러 회원상세를 동시에(현장 피드백 7/23) — 새 브라우저 창으로 열어 이 화면과 독립적으로 띄운다. */}
          <button
            type="button"
            title="새창에서 열기"
            onClick={() =>
              window.open(
                `/admin/members/popup/${id}`,
                `member-popup-${id}`,
                'width=820,height=900,noopener',
              )
            }
            className="grid h-8 w-8 place-items-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          {member.status === 'suspended' ? (
            <Button size="sm" variant="suc" onClick={() => updateMember.mutate({ id, patch: { status: 'active' } })}>
              정지해제
            </Button>
          ) : (
            <Button size="sm" variant="dng" onClick={() => setConfirmSuspend(true)}>
              정지
            </Button>
          )}
        </div>
      </div>

      <Tabs tabs={tabs} value={tab} onChange={(k) => setTab(k as DrawerTab)} className="mb-4" />

      {tab === 'info' && (
        <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
          {/* 이름·핸드폰 인라인 수정(현장 피드백 7/6) — 값 바뀌면 blur 시 저장 */}
          <Row label="이름">
            <input
              className={inlineEditCls}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const v = nameDraft.trim()
                if (v && v !== member.name) updateMember.mutate({ id, patch: { name: v } })
                else setNameDraft(member.name)
              }}
            />
          </Row>
          <Row label="닉네임">
            <input
              className={inlineEditCls}
              value={nicknameDraft}
              placeholder="-"
              onChange={(e) => setNicknameDraft(e.target.value)}
              onBlur={() => {
                const v = nicknameDraft.trim()
                if (v !== (member.nickname ?? '')) updateMember.mutate({ id, patch: { nickname: v || null } })
              }}
            />
          </Row>
          <Row label="로그인 ID" mono>
            {member.user_id}
          </Row>
          <Row label="핸드폰" mono>
            <input
              className={inlineEditCls + ' font-mono tnum'}
              value={phoneDraft}
              onChange={(e) => setPhoneDraft(e.target.value)}
              onBlur={() => {
                const v = phoneDraft.trim()
                if (v && v !== member.phone) updateMember.mutate({ id, patch: { phone: v } })
                else setPhoneDraft(member.phone)
              }}
            />
          </Row>
          <Row label="등급">
            <Badge grade={member.grade} />
          </Row>
          <Row label="상태">
            <StatusChip status={member.status} />
          </Row>
          {/* 연령대·성별·성향 선택형(현장 피드백 7/3) — 즉시 저장 */}
          <Row label="연령대">
            <select
              className={selectCls}
              value={metaStr(member.meta, 'age_band')}
              onChange={(e) => updateSettings.mutate({ id, patch: { age_band: e.target.value || null } })}
            >
              <option value="">미지정</option>
              {AGE_BANDS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Row>
          <Row label="성별">
            <select
              className={selectCls}
              value={metaStr(member.meta, 'gender')}
              onChange={(e) => updateSettings.mutate({ id, patch: { gender: e.target.value || null } })}
            >
              <option value="">미지정</option>
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </Row>
          <Row label="성향">
            <select
              className={selectCls}
              value={member.tendency ?? ''}
              onChange={(e) => updateMember.mutate({ id, patch: { tendency: e.target.value || null } })}
            >
              <option value="">미지정</option>
              {TENDENCIES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Row>
          <Row label="상담상태">{member.consult_status ?? '-'}</Row>
          <Row label="아웃콜">{member.outcall_done ? '완료' : '미처리'}</Row>
          {/* 유입코드/유입구분은 최고관리자·관리자만(현장 피드백 7/21) */}
          {(role === 'admin' || role === 'manager') && (
            <>
              <Row label="유입코드" mono>
                <input
                  className={inlineEditCls + ' font-mono'}
                  value={inflowCodeDraft}
                  placeholder="-"
                  onChange={(e) => setInflowCodeDraft(e.target.value)}
                  onBlur={() => {
                    const v = inflowCodeDraft.trim()
                    if (v !== (member.inflow_code ?? '')) updateMember.mutate({ id, patch: { inflow_code: v || null } })
                  }}
                />
              </Row>
              <Row label="유입구분">{member.inflow_type ?? '-'}</Row>
            </>
          )}
          <Row label="담당자">{member.assigned_staff_id ? staffName[member.assigned_staff_id] ?? '-' : '미지정'}</Row>
          <Row label="팀">{member.team_id ? teamName[member.team_id] ?? '-' : '-'}</Row>
          <Row label="가입일시" mono>
            {datetime(member.registered_at)}
          </Row>
          <Row label="종료일" mono>
            {effEnd ? date(effEnd) : '-'}
            {recoPaused && <span className="ml-1.5 text-[10px] font-semibold text-danger">일시정지</span>}
            {endOverride && <span className="ml-1 text-[10px] text-amber-600">(수정됨)</span>}
          </Row>
          <Row label="최근접속" mono>
            {member.last_active_at ? datetime(member.last_active_at) : '미접속'}
          </Row>
          <Row label="홈페이지 ID" mono>
            {homepageId(member.phone) || '-'}
          </Row>
          <Row label="홈페이지 PW" mono>
            {metaStr(member.meta, 'homepage_pw') || homepagePw(member.phone) || '-'}
            {!metaStr(member.meta, 'homepage_pw') && <span className="ml-1 text-[10px] text-gray-400">(기본)</span>}
          </Row>
        </dl>
      )}

      {tab === 'info' && <WinHistorySection meta={member.meta} />}

      {tab === 'info' && (
        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="mb-2.5 text-[12px] font-bold text-gray-600">회원 설정 · 발송 / 홈페이지</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-gray-500">조합발송요일</span>
              <select className={selectCls + ' w-full'} value={sendDay} onChange={(e) => setSendDay(e.target.value)}>
                <option value="">전역 기본(금)</option>
                {WEEKDAYS.map((d, i) => (
                  <option key={i} value={i}>
                    {d}요일
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-gray-500">조합발송갯수</span>
              <input
                className={selectCls + ' w-full'}
                inputMode="numeric"
                placeholder="전역 기본(30)"
                value={sendCount}
                onChange={(e) => setSendCount(e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-gray-500">
                종료일 <span className="font-normal text-gray-400">(기본 결제일+1년)</span>
              </span>
              <input
                type="date"
                className={selectCls + ' w-full'}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>
            <label className="flex items-end gap-2 pb-1.5 text-[12px] text-gray-700">
              <input
                type="checkbox"
                checked={recoPaused}
                onChange={(e) => setRecoPaused(e.target.checked)}
              />
              <span>
                조합발송 일시정지
                <span className="ml-1 block text-[10.5px] font-normal text-gray-400">
                  체크 시 자동조합 발급·문자 중단
                </span>
              </span>
            </label>
            <div className="col-span-2 flex items-end justify-end">
              <Button
                size="sm"
                variant="pri"
                disabled={updateSettings.isPending}
                onClick={() =>
                  updateSettings.mutate({
                    id,
                    patch: {
                      weekly_reco_day: sendDay === '' ? null : Number(sendDay),
                      weekly_reco_count: sendCount === '' ? null : Number(sendCount),
                      end_date: endDate === '' ? null : endDate,
                      reco_paused: recoPaused,
                    },
                  })
                }
              >
                발송설정 저장
              </Button>
            </div>
            <label className="col-span-2 block">
              <span className="mb-1 block text-[11px] font-semibold text-gray-500">
                홈페이지 비밀번호 변경 <span className="font-normal text-gray-400">(비우면 기본=전화 뒷4자리)</span>
              </span>
              <div className="flex gap-2">
                <input
                  className={selectCls + ' flex-1'}
                  value={hpPw}
                  placeholder={homepagePw(member.phone)}
                  onChange={(e) => setHpPw(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="sec"
                  disabled={updateSettings.isPending}
                  onClick={() => updateSettings.mutate({ id, patch: { homepage_pw: hpPw.trim() || null } })}
                >
                  변경
                </Button>
              </div>
            </label>
          </div>
        </div>
      )}

      {tab === 'payments' && (
        <div>
          {/* 결제 요청(현장 피드백) — 상품 선택 → 대기 결제 생성, 관리자 승인 */}
          {(() => {
            const activeProducts = products.filter((p) => p.is_active)
            const selected = activeProducts.find((p) => p.id === payProduct)
            return (
              <div className="mb-3 rounded-lg border border-primary-100 bg-primary-50 p-2.5">
                <div className="mb-2 flex items-center gap-2 text-[12px] font-bold text-primary-700">
                  <CreditCard className="h-4 w-4" /> 결제 요청
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <select
                    className={selectCls + ' flex-1'}
                    value={payProduct}
                    onChange={(e) => {
                      setPayProduct(e.target.value)
                      // 금액 기본값 = 상품가(수기 수정 가능, <결제> 1)
                      const p = activeProducts.find((x) => x.id === e.target.value)
                      setPayAmount(p ? String(p.price) : '')
                    }}
                  >
                    <option value="">상품 선택</option>
                    {activeProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {krw(p.price)}
                      </option>
                    ))}
                  </select>
                  <input
                    className={selectCls + ' w-[110px] text-right font-mono tnum'}
                    inputMode="numeric"
                    placeholder="금액"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value.replace(/\D/g, ''))}
                  />
                  <select
                    className={selectCls}
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="pri"
                    disabled={!selected || !(Number(payAmount) > 0) || requestPayment.isPending}
                    onClick={() =>
                      selected &&
                      requestPayment.mutate(
                        { memberId: id, productId: selected.id, amount: Number(payAmount), method: payMethod },
                        {
                          onSuccess: () => {
                            setPayProduct('')
                            setPayAmount('')
                          },
                        },
                      )
                    }
                  >
                    결제 요청
                  </Button>
                </div>
                <p className="mt-1.5 text-[11px] text-gray-500">
                  금액은 상품가가 기본이며 수기로 수정할 수 있습니다
                  {Number(payAmount) > 0 && selected && Number(payAmount) !== selected.price
                    ? ` (현재 ${krw(Number(payAmount))} — 상품가 ${krw(selected.price)}와 다름)`
                    : ''}
                  . 요청 시 ‘대기’ 결제가 생성되고, 최고관리자/관리자가 결제 모듈에서 승인합니다.
                </p>
              </div>
            )
          })()}
          <TabList
            rows={payments}
            empty="결제 내역이 없습니다."
            render={(p) => (
            <div key={p.id} className="border-b border-gray-100 py-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10.5px] font-bold text-gray-500">
                    {paymentRound[p.id] ?? '?'}차결제
                  </span>
                  <StatusChip status={p.status} />
                  <span className="text-[12.5px] font-semibold text-ink-800">
                    {p.product_id ? productName[p.product_id] ?? p.product_id : '-'}
                  </span>
                  <span className="text-[11.5px] text-gray-400">
                    {PAYMENT_METHOD_LABEL[p.method]}
                    {p.pg_provider ? ` · ${p.pg_provider}` : ''}
                  </span>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[12.5px] font-bold tnum text-ink-800">{krw(p.amount)}</div>
                  <div className="font-mono text-[10.5px] tnum text-gray-400">
                    {p.paid_at ? date(p.paid_at) : date(p.created_at)}
                  </div>
                </div>
              </div>
              {/* 결제건별 담당자 배정(현장 피드백 7/6) — 회차마다 다른 담당자 지정 가능, 매출귀속에 즉시 반영 */}
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-500">
                <span className="font-semibold">담당</span>
                {role === 'admin' ? (
                  <select
                    className={selectCls + ' h-6 text-[11px]'}
                    value={p.staff_id ?? ''}
                    disabled={updatePaymentStaff.isPending}
                    onChange={(e) =>
                      updatePaymentStaff.mutate({
                        paymentId: p.id,
                        memberId: id,
                        staffId: e.target.value || null,
                      })
                    }
                  >
                    <option value="">미지정</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-gray-700">{p.staff_id ? staffName[p.staff_id] ?? '-' : '미지정'}</span>
                )}
              </div>
            </div>
            )}
          />
        </div>
      )}

      {tab === 'sms' && (
        <div>
          {/* 문자 발송 */}
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-accent-100 bg-accent-50 p-2.5">
            <MessageSquare className="h-4 w-4 text-accent-600" />
            <select className={selectCls} value={smsTpl} onChange={(e) => setSmsTpl(e.target.value)}>
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.title}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="acc"
              icon={<Send className="h-3.5 w-3.5" />}
              disabled={!smsTpl || sendSms.isPending}
              onClick={() =>
                sendSms.mutate(
                  { ids: [id], templateKey: smsTpl },
                  { onError: (e) => window.alert(e instanceof Error ? e.message : '문자 발송에 실패했습니다.') },
                )
              }
            >
              발송
            </Button>
          </div>
          {/* 직접 입력 발송(현장 피드백 <회원정보창> 3) */}
          <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
            <div className="mb-1.5 text-[11.5px] font-semibold text-gray-500">직접 입력 발송</div>
            <textarea
              value={smsBody}
              onChange={(e) => setSmsBody(e.target.value)}
              rows={3}
              placeholder="발송할 문자 내용을 직접 입력하세요."
              className="w-full rounded-md border border-gray-300 p-2 text-[12.5px] text-gray-700 outline-none focus:border-primary-500"
            />
            <div className="mt-1.5 flex items-center justify-between">
              <span className="font-mono text-[10.5px] tnum text-gray-400">
                {koByteLength(smsBody)}byte · {classifyMsgType(smsBody)}
              </span>
              <Button
                size="sm"
                variant="acc"
                icon={<Send className="h-3.5 w-3.5" />}
                disabled={!smsBody.trim() || sendCustomSms.isPending}
                onClick={() =>
                  sendCustomSms.mutate(
                    { ids: [id], body: smsBody },
                    {
                      onSuccess: () => setSmsBody(''),
                      onError: (e) => window.alert(e instanceof Error ? e.message : '문자 발송에 실패했습니다.'),
                    },
                  )
                }
              >
                직접 발송
              </Button>
            </div>
          </div>
          <TabList
            rows={sms}
            empty="발송된 문자가 없습니다."
            render={(s) => {
              const issue = canDeleteReco ? linkedRecoIssue(s, readWeeklyRecos(member.meta)) : null
              return (
                <div key={s.id} className="border-b border-gray-100 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <StatusChip tone="info" label={SMS_TYPE_LABEL[s.type]} />
                      {/* 접수 결과(문자사 접수성공=발송완료) — 추후 회원 분쟁 대처용 증빙(현장 피드백) */}
                      {s.status && (
                        <span
                          className={
                            'rounded px-1.5 py-0.5 text-[10px] font-semibold ' +
                            (s.status.includes('완료')
                              ? 'bg-success/10 text-success'
                              : s.status.includes('실패')
                                ? 'bg-danger/10 text-danger'
                                : 'bg-gray-100 text-gray-500')
                          }
                        >
                          {s.status}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-mono text-[10.5px] tnum text-gray-400">{datetime(s.sent_at)}</span>
                      {issue && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-[10.5px] font-semibold text-danger hover:bg-danger-bg disabled:opacity-50"
                          disabled={deleteRecoIssue.isPending}
                          onClick={() => setRecoToDelete(issue)}
                        >
                          <Trash2 className="h-3 w-3" />
                          삭제
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-gray-600">{s.body}</p>
                </div>
              )
            }}
          />
        </div>
      )}

      {tab === 'assignments' && role === 'admin' && (
        <TabList
          rows={assignments}
          empty="배정 이력이 없습니다."
          render={(a) => (
            <div key={a.id} className="flex items-center justify-between border-b border-gray-100 py-2.5">
              <div className="flex items-center gap-2">
                <StatusChip
                  tone={a.type === 'auto' ? 'info' : 'success'}
                  label={a.type === 'auto' ? '자동' : '수동'}
                />
                <span className="text-[12.5px] font-semibold text-ink-800">
                  {a.staff_id ? staffName[a.staff_id] ?? a.staff_id : '미지정(리셋)'}
                </span>
                {a.assigned_by && (
                  <span className="text-[11px] text-gray-400">by {staffName[a.assigned_by] ?? a.assigned_by}</span>
                )}
              </div>
              <span className="font-mono text-[10.5px] tnum text-gray-400">{datetime(a.created_at)}</span>
            </div>
          )}
        />
      )}

      {/* 메모 — 별도 탭이 아니라 기본정보 탭 최하단(현장 피드백 7/3) */}
      {tab === 'info' && (
        <div className="mt-4 border-t border-gray-200 pt-4">
          <div className="mb-2.5 text-[12px] font-bold text-gray-600">
            메모{' '}
            <span className="font-normal text-gray-400">
              · {readMemos(member).filter((x) => !x.deleted_at).length}건
            </span>
          </div>
          {/* 새 콜메모 추가 — 리스트형 누적(현장 피드백) */}
          <textarea
            value={memoDraft}
            onChange={(e) => setMemoDraft(e.target.value)}
            rows={3}
            placeholder="상담 메모를 입력하고 추가하세요. (기존 메모는 보존됩니다)"
            className="w-full rounded-md border border-gray-300 p-2.5 text-[13px] text-gray-700 outline-none focus:border-primary-500"
          />
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="pri"
              disabled={!memoDraft.trim() || addMemo.isPending}
              onClick={() =>
                addMemo.mutate(
                  { id, body: memoDraft },
                  { onSuccess: () => setMemoDraft('') },
                )
              }
            >
              메모 추가
            </Button>
          </div>

          {/* 누적 콜메모(최신순) — 삭제는 최고관리자만, 삭제분도 최고관리자만 표시(<회원정보창> 7) */}
          {(() => {
            const all = readMemos(member)
            const memos = role === 'admin' ? all : all.filter((m) => !m.deleted_at)
            if (memos.length === 0) {
              return (
                <div className="mt-4 py-8 text-center text-[12.5px] text-gray-400">
                  등록된 메모가 없습니다.
                </div>
              )
            }
            return (
              <ul className="mt-4 space-y-2">
                {memos
                  .slice()
                  .reverse()
                  .map((m) => (
                    <li
                      key={m.id}
                      className={
                        'rounded-md border p-2.5 ' +
                        (m.deleted_at ? 'border-gray-100 bg-gray-50' : 'border-gray-200 bg-white')
                      }
                    >
                      <div className="flex items-start gap-2">
                        <p
                          className={
                            'min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-relaxed ' +
                            (m.deleted_at ? 'text-gray-400 line-through' : 'text-ink-800')
                          }
                        >
                          {m.body}
                        </p>
                        {role === 'admin' && !m.deleted_at && (
                          <button
                            type="button"
                            title="메모 삭제(소프트) — 최고관리자만 열람 가능해집니다"
                            disabled={deleteMemo.isPending}
                            onClick={() => deleteMemo.mutate({ id, memoId: m.id })}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-danger hover:bg-danger-bg"
                          >
                            삭제
                          </button>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-gray-400">
                        <span className="font-mono tnum">{datetime(m.created_at)}</span>
                        {m.author && <span>· {staffName[m.author] ?? m.author}</span>}
                        {m.deleted_at && (
                          <span className="rounded bg-gray-200 px-1 font-semibold text-gray-500">
                            삭제됨 · {datetime(m.deleted_at)}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
              </ul>
            )
          })()}

          {role === 'admin' &&
            (() => {
              const archived = (member.meta?.reset_memos as ResetMemo[] | undefined) ?? []
              if (archived.length === 0) return null
              return (
                <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3">
                  <div className="mb-1.5 text-[12px] font-bold text-gray-600">
                    초기화로 삭제된 콜메모 · {archived.length}건{' '}
                    <span className="font-normal text-gray-400">(최고관리자 전용)</span>
                  </div>
                  <ul className="space-y-1.5">
                    {archived
                      .slice()
                      .reverse()
                      .map((a, i) => (
                        <li key={i} className="flex flex-wrap gap-x-1.5 text-[12.5px]">
                          <span className="text-gray-800">{a.body}</span>
                          <span className="text-[11px] text-gray-400">· {datetime(a.archived_at)}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              )
            })()}
        </div>
      )}

      {tab === 'reco' && (
        <div>
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-accent-100 bg-accent-50 px-3 py-2 text-[11.5px] text-ink-700">
            <span>
              무료회원 주간 발급 번호입니다(매주 금 09:00, 문자 발송 없음). 회원은 홈페이지에서{' '}
              <b className="font-mono">{homepageId(member.phone)}</b> / 뒷4자리{' '}
              <b className="font-mono">{homepagePw(member.phone)}</b> 로 로그인해 확인합니다.
            </span>
          </div>

          {/* 수동 발급(현장 피드백 <회원정보창> 4) — 즉시 조합 생성·발급, 옵션 문자 발송 */}
          <div className="mb-3 rounded-lg border border-primary-100 bg-primary-50 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-bold text-primary-700">
              <Dices className="h-4 w-4" /> 수동 발급
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={selectCls + ' w-[120px]'}
                inputMode="numeric"
                placeholder={`세트 수(기본 ${metaNum(member.meta, 'weekly_reco_count') ?? 30})`}
                value={issueCount}
                onChange={(e) => setIssueCount(e.target.value.replace(/\D/g, ''))}
              />
              <label className="flex items-center gap-1.5 text-[12px] text-gray-600">
                <input type="checkbox" checked={issueSms} onChange={(e) => setIssueSms(e.target.checked)} />
                문자로도 발송
              </label>
              <Button
                size="sm"
                variant="pri"
                className="ml-auto"
                disabled={manualIssue.isPending}
                onClick={() =>
                  manualIssue.mutate({
                    memberId: id,
                    setCount: Number(issueCount) || metaNum(member.meta, 'weekly_reco_count') || 30,
                    alsoSms: issueSms,
                  })
                }
              >
                지금 발급
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              회원 등급의 고정/제외 규칙(없으면 공통)으로 즉시 생성됩니다. 발급 즉시 아래 목록·홈페이지에 반영
              {issueSms ? ' + 문자 발송' : ''}됩니다.
            </p>
          </div>
          {(() => {
            const issues = readWeeklyRecos(member.meta)
            if (issues.length === 0) {
              return (
                <div className="py-10 text-center text-[12.5px] text-gray-400">
                  발급된 번호가 없습니다.
                </div>
              )
            }
            return (
              <div className="space-y-4">
                {issues.map((iss) => (
                  <div key={`${iss.round_no}-${iss.issued_at}`} className="rounded-md border border-gray-200 p-3">
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <span className="text-[12.5px] font-bold text-ink-800">
                        {iss.round_no}회 · {iss.sets.length}세트
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-[10.5px] tnum text-gray-400">{datetime(iss.issued_at)}</span>
                        {canDeleteReco && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-[10.5px] font-semibold text-danger hover:bg-danger-bg disabled:opacity-50"
                            disabled={deleteRecoIssue.isPending}
                            onClick={() => setRecoToDelete(iss)}
                          >
                            <Trash2 className="h-3 w-3" />
                            삭제
                          </button>
                        )}
                      </div>
                    </div>
                    <ul className="space-y-1.5">
                      {iss.sets.map((set, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-500 tnum">
                            {i + 1}
                          </span>
                          <LottoBalls numbers={set} size="sm" />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}

      {/* 통화녹음(현장 피드백 7/3, 김형준 이사) — 상담원 수동 업로드 + STT 전사·키워드 탐지 */}
      {tab === 'calls' && (
        <div>
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
            <Mic className="h-4 w-4 text-gray-500" />
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) uploadCallRec.mutate({ id, file })
                e.target.value = ''
              }}
            />
            <Button
              size="sm"
              variant="sec"
              icon={<Upload className="h-3.5 w-3.5" />}
              disabled={uploadCallRec.isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadCallRec.isPending ? '업로드 중…' : '녹음 파일 업로드'}
            </Button>
            <span className="text-[11.5px] text-gray-400">
              통화 후 녹음 파일을 직접 업로드합니다. 텍스트 변환은 라이브 서버에서만 동작합니다.
            </span>
          </div>
          <TabList
            rows={readCallRecordings(member)}
            empty="업로드된 통화 녹음이 없습니다."
            render={(r) => (
              <CallRecordingRow
                key={r.id}
                memberId={id}
                rec={r}
                canDelete={role === 'admin'}
                onDelete={() => deleteCallRec.mutate({ id, recId: r.id, filePath: r.file_path })}
              />
            )}
          />
        </div>
      )}

      {/* 민원관리(현장 피드백 7/6) — 메모+유형(카드/경찰/소보원)+처리결과(성공/실패), 민원횟수=건수 */}
      {tab === 'complaints' && (
        <div>
          <div className="mb-3 rounded-lg border border-danger-bd bg-danger-bg/40 p-2.5">
            <div className="mb-2 flex items-center justify-between text-[12px] font-bold text-ink-700">
              <span>민원 등록</span>
              <span className="text-[11.5px] font-semibold text-danger">
                민원횟수 {readComplaints(member).length}건
              </span>
            </div>
            <div className="mb-2 flex flex-wrap gap-2">
              <select
                className={selectCls}
                value={complaintType}
                onChange={(e) => setComplaintType(e.target.value)}
              >
                {COMPLAINT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                className={selectCls}
                value={complaintResult}
                onChange={(e) => setComplaintResult(e.target.value)}
              >
                {COMPLAINT_RESULTS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              value={complaintBody}
              onChange={(e) => setComplaintBody(e.target.value)}
              rows={3}
              placeholder="민원 내용을 메모로 남기세요."
              className="w-full rounded-md border border-gray-300 p-2.5 text-[13px] text-gray-700 outline-none focus:border-primary-500"
            />
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="dng"
                disabled={!complaintBody.trim() || addComplaint.isPending}
                onClick={() =>
                  addComplaint.mutate(
                    { id, body: complaintBody, type: complaintType, result: complaintResult },
                    { onSuccess: () => setComplaintBody('') },
                  )
                }
              >
                민원 등록
              </Button>
            </div>
          </div>

          <TabList
            rows={[...readComplaints(member)].reverse()}
            empty="등록된 민원이 없습니다."
            render={(c) => (
              <div key={c.id} className="border-b border-gray-100 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-gray-600">
                    {c.type}
                  </span>
                  <span
                    className={
                      'rounded px-1.5 py-0.5 text-[10.5px] font-semibold ' +
                      (c.result === '성공' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')
                    }
                  >
                    {c.result}
                  </span>
                  <span className="ml-auto font-mono text-[10.5px] tnum text-gray-400">{datetime(c.created_at)}</span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-800">{c.body}</p>
                {c.author && (
                  <span className="mt-1 block text-[10.5px] text-gray-400">
                    · {staffName[c.author] ?? c.author}
                  </span>
                )}
              </div>
            )}
          />
        </div>
      )}

      <ConfirmModal
        open={confirmSuspend}
        onClose={() => setConfirmSuspend(false)}
        onConfirm={() =>
          updateMember.mutate(
            { id, patch: { status: 'suspended' } },
            { onSuccess: () => setConfirmSuspend(false) },
          )
        }
        title="회원 정지"
        description={`${member.name}(${member.user_id}) 회원을 정지 처리합니다.`}
        confirmText="정지"
        tone="danger"
        loading={updateMember.isPending}
      />
      <ConfirmModal
        open={recoToDelete !== null}
        onClose={() => setRecoToDelete(null)}
        onConfirm={() => {
          if (!recoToDelete) return
          deleteRecoIssue.mutate(
            { memberId: id, roundNo: recoToDelete.round_no, issuedAt: recoToDelete.issued_at },
            {
              onSuccess: () => setRecoToDelete(null),
              onError: (error) => window.alert(error instanceof Error ? error.message : '조합 발급내역 삭제에 실패했습니다.'),
            },
          )
        }}
        title="조합 발급·발송내역 삭제"
        description={
          recoToDelete
            ? `${recoToDelete.round_no}회차 ${recoToDelete.sets.length}세트와 연결된 문자내역을 삭제합니다. 해당 조합은 당첨 집계 대상에서도 제외되며 복구할 수 없습니다.`
            : undefined
        }
        confirmText="삭제"
        tone="danger"
        loading={deleteRecoIssue.isPending}
      />
    </Drawer>
  )
}

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.3px] text-gray-400">{label}</dt>
      <dd className={mono ? 'font-mono text-[12.5px] text-ink-800' : 'text-[12.5px] text-ink-800'}>
        {children}
      </dd>
    </div>
  )
}

// 회원 당첨내역(현장 피드백) — 회차/날짜/조합순번/당첨금액 리스트 + 등수별 통합정리(최상단).
const WIN_RANKS = [1, 2, 3, 4, 5] as const
const WIN_SOURCE_LABEL: Record<WinRecord['source'], string> = { reco: '추천조합', bet: '베팅' }

function WinHistorySection({ meta }: { meta: Record<string, unknown> }) {
  const records = readWinRecords(meta)
  const summary = summarizeWinRecords(records)

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3">
      <div className="mb-2.5 flex items-center gap-1.5 text-[12px] font-bold text-gray-600">
        <Trophy className="h-3.5 w-3.5 text-accent-500" />
        당첨내역
      </div>
      {records.length === 0 ? (
        <p className="text-[12.5px] text-gray-400">당첨 이력이 없습니다.</p>
      ) : (
        <>
          {/* 통합정리(최상단) — 등수별 당첨 건수 */}
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {WIN_RANKS.filter((r) => summary[r] > 0).map((r) => (
              <span
                key={r}
                className="rounded-full bg-accent-50 px-2.5 py-1 text-[11.5px] font-semibold text-accent-600"
              >
                {r}등 {summary[r]}회
              </span>
            ))}
          </div>
          {/* 리스트 — 회차/날짜/조합순번/당첨금액(최신순) */}
          <div className="max-h-56 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-100">
            {records.map((w) => (
              <div
                key={`${w.source}:${w.round_no}:${w.combo_index}`}
                className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-[12px]"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-mono tnum text-ink-800">{w.round_no}회</span>
                  <span className="font-mono text-[11px] tnum text-gray-400">
                    {w.draw_date ? date(w.draw_date) : '-'}
                  </span>
                  <span className="whitespace-nowrap rounded bg-gray-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-gray-500">
                    {w.combo_index}번째 조합
                  </span>
                  <span className="text-[10.5px] text-gray-400">({WIN_SOURCE_LABEL[w.source]})</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-semibold text-accent-600">{w.rank}등</span>
                  <span className="font-mono tnum text-ink-800">{krw(w.prize)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function TabList<T>({
  rows,
  render,
  empty,
}: {
  rows: T[]
  render: (row: T) => ReactNode
  empty: string
}) {
  if (rows.length === 0) {
    return <div className="py-10 text-center text-[12.5px] text-gray-400">{empty}</div>
  }
  return <div>{rows.map(render)}</div>
}

// 통화녹음 1건 — 재생(서명 URL 발급) + 텍스트 변환(STT, 라이브 전용) + 삭제.
function CallRecordingRow({
  memberId,
  rec,
  canDelete,
  onDelete,
}: {
  memberId: string
  rec: CallRecording
  canDelete: boolean
  onDelete: () => void
}) {
  const getUrl = useCallRecordingUrl()
  const transcribe = useTranscribeCallRecording()
  const analyze = useAnalyzeCallRecording()
  const [playUrl, setPlayUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  return (
    <div className="border-b border-gray-100 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[12.5px] font-semibold text-ink-800">{rec.file_name}</p>
            <span
              className={
                'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ' +
                (rec.source === 'auto' ? 'bg-info/10 text-info' : 'bg-gray-100 text-gray-500')
              }
            >
              {rec.source === 'auto' ? '자동' : '수동'}
            </span>
          </div>
          <span className="font-mono text-[10.5px] tnum text-gray-400">{datetime(rec.created_at)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="sec"
            icon={<Play className="h-3.5 w-3.5" />}
            disabled={getUrl.isPending}
            onClick={() => getUrl.mutate(rec.file_path, { onSuccess: setPlayUrl })}
          >
            재생
          </Button>
          <Button
            size="sm"
            variant="sec"
            icon={<Sparkles className="h-3.5 w-3.5" />}
            disabled={transcribe.isPending}
            onClick={() => {
              setErr(null)
              transcribe.mutate(
                { id: memberId, recId: rec.id, filePath: rec.file_path },
                { onError: (e) => setErr(e instanceof Error ? e.message : '전사에 실패했습니다.') },
              )
            }}
          >
            {rec.transcript ? '다시 변환' : '텍스트 변환'}
          </Button>
          {rec.transcript && (
            <Button
              size="sm"
              variant="sec"
              icon={<Wand2 className="h-3.5 w-3.5" />}
              disabled={analyze.isPending}
              onClick={() => {
                setErr(null)
                analyze.mutate(
                  { id: memberId, recId: rec.id, transcript: rec.transcript as string },
                  { onError: (e) => setErr(e instanceof Error ? e.message : 'AI 분석에 실패했습니다.') },
                )
              }}
            >
              {analyze.isPending ? '분석 중…' : rec.ai_analysis ? '다시 분석' : 'AI 분석'}
            </Button>
          )}
          {canDelete && (
            <button
              type="button"
              title="삭제"
              onClick={onDelete}
              className="rounded p-1.5 text-gray-400 hover:bg-danger-bg hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {playUrl && <audio className="mt-2 w-full" controls src={playUrl} />}
      {err && <p className="mt-1.5 text-[11.5px] text-danger">{err}</p>}
      {rec.transcript && (
        <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-2.5">
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-gray-700">{rec.transcript}</p>
          {rec.keyword_hits && rec.keyword_hits.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {rec.keyword_hits.map((h) => (
                <span
                  key={h.keyword}
                  className="rounded-full bg-warning-bg px-2 py-0.5 text-[10.5px] font-semibold text-warning"
                >
                  ‘{h.keyword}’ {h.count}회
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {rec.ai_analysis && (
        <div className="mt-2 rounded-md border border-primary-100 bg-primary-50/40 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold text-primary-700">
            <Wand2 className="h-3.5 w-3.5" />
            AI 통화분석
            {rec.analyzed_at && (
              <span className="font-mono text-[10px] font-normal text-gray-400 tnum">
                · {datetime(rec.analyzed_at)}
              </span>
            )}
          </div>
          {rec.ai_analysis.summary && (
            <p className="mb-1.5 text-[12px] leading-relaxed text-gray-700">{rec.ai_analysis.summary}</p>
          )}
          {rec.ai_analysis.successFactors.length > 0 && (
            <div className="mb-1">
              <span className="text-[11px] font-semibold text-success">성공요인</span>
              <ul className="ml-3.5 list-disc text-[12px] leading-snug text-gray-700">
                {rec.ai_analysis.successFactors.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          {rec.ai_analysis.failFactors.length > 0 && (
            <div className="mb-1">
              <span className="text-[11px] font-semibold text-danger">실패요인</span>
              <ul className="ml-3.5 list-disc text-[12px] leading-snug text-gray-700">
                {rec.ai_analysis.failFactors.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          {rec.ai_analysis.scriptMatch && (
            <div>
              <span className="text-[11px] font-semibold text-gray-600">스크립트 유사성</span>
              <p className="text-[12px] leading-snug text-gray-700">{rec.ai_analysis.scriptMatch}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
