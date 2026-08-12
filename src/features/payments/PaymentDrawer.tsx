// 결제 상세 Drawer (CLAUDE §6·§8). 회원 상세의 '결제내역'과 동일 데이터 소스(usePayment).
// 액션: 승인 / PG취소 — 둘 다 회원 등급·매출에 §8 부수효과가 있으므로 확인 모달(§10).
// 결제내역 수정(금액·결제수단·PG사·입금자명·상품(등급)·담당자·결제일시)은 실장 이상 전용
// (현장 피드백 7/21, 등급/담당/일시 확장은 7/23). 승인된 결제의 상품을 바꾸면 회원 등급도 같이 갱신된다.
import { useMemo, useState, type ReactNode } from 'react'
import { Check, Pencil, UserRound, X, XCircle } from 'lucide-react'
import { Badge, Button, ConfirmModal, Drawer, StatusChip } from '@/design-system/components'
import { GRADE_LABEL, PAYMENT_METHOD_LABEL } from '@/design-system/labels'
import { datetime, krw } from '@/lib/format'
import { useStaff } from '@/lib/staff'
import { useRole } from '@/lib/auth'
import { useMemberDrawerStore } from '@/lib/memberDrawerStore'
import { canAmendPayment } from '@/lib/permissions'
import type { PaymentMethod } from '@/types/db'
import { cn } from '@/lib/cn'
import { useActiveProducts, useApprovePayment, useCancelPayment, usePayment, useUpdatePayment } from './api'

type Confirm = 'approve' | 'cancel' | null
const METHODS: PaymentMethod[] = ['bank', 'manual', 'pg']
const inputCls =
  'h-8 w-full rounded-md border border-gray-300 px-2 text-[12.5px] text-ink-900 outline-none focus:border-primary-500'

// datetime-local input 은 로컬시각 "YYYY-MM-DDTHH:mm" 문자열을 쓴다(members/MemberDrawer 와 동일 패턴).
function isoToLocalInput(iso: string): string {
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

export function PaymentDrawer({
  paymentId,
  onClose,
}: {
  paymentId: string | null
  onClose: () => void
}) {
  const open = !!paymentId
  const { data: payment } = usePayment(paymentId)
  const { data: staff = [] } = useStaff()
  const { data: products = [] } = useActiveProducts()
  // 회원상세는 전역 Drawer(현장 피드백 7/23) — 라우트 이동 없이 이 결제 상세 위에 그대로 뜬다.
  const openMemberDrawer = useMemberDrawerStore((s) => s.open)
  const approve = useApprovePayment()
  const cancel = useCancelPayment()
  const update = useUpdatePayment()
  const role = useRole()
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<{
    amount: string
    method: PaymentMethod
    pgProvider: string
    depositorName: string
    productId: string
    staffId: string
    paidAt: string
  } | null>(null)

  const staffName = useMemo(() => {
    const m: Record<string, string> = {}
    for (const s of staff) m[s.id] = s.name
    return m
  }, [staff])

  if (!payment) {
    return (
      <Drawer open={open} onClose={onClose} title="결제 상세">
        <div className="py-10 text-center text-[12.5px] text-gray-400">불러오는 중…</div>
      </Drawer>
    )
  }

  const currentPayment = payment
  const id = payment.id
  const busy = approve.isPending || cancel.isPending
  const canApprove = payment.status === 'wait' || payment.status === 'failed'
  const canCancel = payment.status === 'approved' || payment.status === 'wait'
  const member = payment.member
  // 결제내역 수정은 실장 이상(leader/manager/admin) 전용 — 팀장(rep)은 승인/취소만 가능(현장 피드백 7/21).
  const canEdit = canAmendPayment(role)

  function startEdit(): void {
    setDraft({
      amount: String(currentPayment.amount),
      method: currentPayment.method,
      pgProvider: currentPayment.pg_provider ?? '',
      depositorName: currentPayment.depositor_name ?? '',
      productId: currentPayment.product_id ?? '',
      staffId: currentPayment.staff_id ?? '',
      paidAt: currentPayment.paid_at ? isoToLocalInput(currentPayment.paid_at) : '',
    })
    setIsEditing(true)
  }

  function cancelEdit(): void {
    setIsEditing(false)
    setDraft(null)
  }

  function saveEdit(): void {
    if (!draft) return
    update.mutate(
      {
        id,
        patch: {
          amount: Math.max(0, Number(draft.amount) || 0),
          method: draft.method,
          pg_provider: draft.pgProvider.trim() || null,
          depositor_name: draft.depositorName.trim() || null,
          product_id: draft.productId || null,
          staff_id: draft.staffId || null,
          paid_at: localInputToIso(draft.paidAt),
        },
      },
      { onSuccess: () => cancelEdit() },
    )
  }

  const title = (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate font-bold text-ink-900">{payment.member?.name ?? '회원'}</span>
      {payment.member && (
        <span className="font-mono text-[12px] font-normal text-gray-400">{payment.member.user_id}</span>
      )}
      {payment.product && <Badge grade={payment.product.grade_granted}>{payment.product.name}</Badge>}
      <StatusChip status={payment.status} />
    </div>
  )

  return (
    <Drawer open={open} onClose={onClose} title={title} width={560}>
      {/* 액션 */}
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
        <div className="font-mono text-[15px] font-bold tnum text-ink-900">{krw(payment.amount)}</div>
        <div className="ml-auto flex items-center gap-2">
          {isEditing ? (
            <>
              <Button size="sm" variant="sec" icon={<X className="h-3.5 w-3.5" />} onClick={cancelEdit} disabled={update.isPending}>
                취소
              </Button>
              <Button size="sm" variant="pri" icon={<Check className="h-3.5 w-3.5" />} onClick={saveEdit} disabled={update.isPending}>
                저장
              </Button>
            </>
          ) : (
            <>
              {canEdit && (
                <Button size="sm" variant="sec" icon={<Pencil className="h-3.5 w-3.5" />} disabled={busy} onClick={startEdit}>
                  수정
                </Button>
              )}
              {canApprove && (
                <Button
                  size="sm"
                  variant="suc"
                  icon={<Check className="h-3.5 w-3.5" />}
                  disabled={busy}
                  onClick={() => setConfirm('approve')}
                >
                  승인
                </Button>
              )}
              {canCancel && (
                <Button
                  size="sm"
                  variant="dng"
                  icon={<XCircle className="h-3.5 w-3.5" />}
                  disabled={busy}
                  onClick={() => setConfirm('cancel')}
                >
                  PG취소
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
        <Row label="상태">
          <StatusChip status={payment.status} />
        </Row>
        <Row label="금액" mono>
          {isEditing && draft ? (
            <input
              type="number"
              className={cn(inputCls, 'text-right font-mono tnum')}
              value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            />
          ) : (
            krw(payment.amount)
          )}
        </Row>
        <Row label="상품(등급)">
          {isEditing && draft ? (
            <select
              className={inputCls}
              value={draft.productId}
              onChange={(e) => setDraft({ ...draft, productId: e.target.value })}
            >
              <option value="">미지정</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {GRADE_LABEL[p.grade_granted]}
                </option>
              ))}
            </select>
          ) : payment.product ? (
            <Badge grade={payment.product.grade_granted}>{payment.product.name}</Badge>
          ) : (
            '-'
          )}
        </Row>
        <Row label="결제수단">
          {isEditing && draft ? (
            <div className="flex gap-1.5">
              <select
                className={cn(inputCls, 'max-w-[84px]')}
                value={draft.method}
                onChange={(e) => setDraft({ ...draft, method: e.target.value as PaymentMethod })}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
              <input
                className={inputCls}
                placeholder="PG사"
                value={draft.pgProvider}
                onChange={(e) => setDraft({ ...draft, pgProvider: e.target.value })}
              />
            </div>
          ) : (
            <>
              {PAYMENT_METHOD_LABEL[payment.method]}
              {payment.pg_provider ? ` · ${payment.pg_provider}` : ''}
            </>
          )}
        </Row>
        <Row label="회원">
          {member ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 font-semibold text-primary-600 hover:underline"
              onClick={() => openMemberDrawer(member.id)}
            >
              <UserRound className="h-3.5 w-3.5" />
              {member.name} · 기본정보 보기
            </button>
          ) : (
            '-'
          )}
        </Row>
        <Row label="유저 ID" mono>
          {payment.member?.user_id ?? '-'}
        </Row>
        <Row label="입금자명">
          {isEditing && draft ? (
            <input
              className={inputCls}
              value={draft.depositorName}
              onChange={(e) => setDraft({ ...draft, depositorName: e.target.value })}
            />
          ) : (
            payment.depositor_name ?? '-'
          )}
        </Row>
        <Row label="담당자">
          {isEditing && draft ? (
            <select
              className={inputCls}
              value={draft.staffId}
              onChange={(e) => setDraft({ ...draft, staffId: e.target.value })}
            >
              <option value="">미지정</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : payment.staff_id ? (
            staffName[payment.staff_id] ?? '-'
          ) : (
            '미지정'
          )}
        </Row>
        <Row label="유입코드" mono>
          {payment.member?.inflow_code ?? '-'}
        </Row>
        <Row label="결제일시" mono>
          {isEditing && draft ? (
            <input
              type="datetime-local"
              className={inputCls}
              value={draft.paidAt}
              onChange={(e) => setDraft({ ...draft, paidAt: e.target.value })}
            />
          ) : payment.paid_at ? (
            datetime(payment.paid_at)
          ) : (
            '-'
          )}
        </Row>
        <Row label="이용시작" mono>
          {payment.period_start ? datetime(payment.period_start) : '-'}
        </Row>
        <Row label="이용종료" mono>
          {payment.period_end ? datetime(payment.period_end) : '-'}
        </Row>
        <Row label="등록일시" mono>
          {datetime(payment.created_at)}
        </Row>
      </dl>

      <ConfirmModal
        open={confirm === 'approve'}
        onClose={() => setConfirm(null)}
        onConfirm={() => approve.mutate({ id }, { onSuccess: () => setConfirm(null) })}
        title="결제 승인"
        description={`${payment.member?.name ?? '회원'}의 ${krw(payment.amount)} 결제를 승인합니다. 회원 등급이 상향되고 매출에 반영됩니다.`}
        confirmText="승인"
        tone="primary"
        loading={approve.isPending}
      />

      <ConfirmModal
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        onConfirm={() => cancel.mutate({ id }, { onSuccess: () => setConfirm(null) })}
        title="결제 취소 (PG취소)"
        description={`${payment.member?.name ?? '회원'}의 ${krw(payment.amount)} 결제를 취소합니다. 매출에서 차감되고 등급이 롤백될 수 있습니다.`}
        confirmText="결제취소"
        tone="danger"
        loading={cancel.isPending}
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
