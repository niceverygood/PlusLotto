// 수기결제 등록 (/payments/manual, CLAUDE §10 폼=react-hook-form+zod).
// 회원 검색→선택, 상품 선택(금액 자동), 결제수단·입금자명, 즉시승인 옵션.
// 즉시승인 시 §8(회원 등급↑·매출 반영)까지 적용된다.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Check, Search } from 'lucide-react'
import { Badge, Button, PageHeader } from '@/design-system/components'
import { PAYMENT_METHOD_LABEL } from '@/design-system/labels'
import { phone } from '@/lib/format'
import type { PaymentMethod } from '@/types/db'
import {
  useActiveProducts,
  useCreateManualPayment,
  useMemberSearch,
  type MemberOption,
} from './api'

const METHODS: PaymentMethod[] = ['bank', 'manual', 'pg']

const schema = z.object({
  memberId: z.string().min(1, '회원을 선택하세요.'),
  productId: z.string().min(1, '상품을 선택하세요.'),
  amount: z
    .number({ invalid_type_error: '금액을 입력하세요.' })
    .int('정수로 입력하세요.')
    .positive('금액은 0보다 커야 합니다.'),
  method: z.enum(['bank', 'manual', 'pg']),
  depositorName: z.string(),
  approveNow: z.boolean(),
})
type FormValues = z.infer<typeof schema>

const inputCls =
  'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] text-gray-800 outline-none focus:border-primary-500'
const labelCls = 'mb-1.5 block text-[12px] font-semibold text-gray-600'
const errCls = 'mt-1 text-[11.5px] text-danger'

export function ManualPaymentPage() {
  const navigate = useNavigate()
  const { data: products = [] } = useActiveProducts()
  const createPayment = useCreateManualPayment()

  const [term, setTerm] = useState('')
  const [queryTerm, setQueryTerm] = useState('')
  const [picked, setPicked] = useState<MemberOption | null>(null)
  const { data: results = [] } = useMemberSearch(queryTerm)

  useEffect(() => {
    const timer = window.setTimeout(() => setQueryTerm(term.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [term])

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      memberId: '',
      productId: '',
      amount: 0,
      method: 'bank',
      depositorName: '',
      approveNow: false,
    },
  })

  const productId = watch('productId')
  const approveNow = watch('approveNow')
  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId) ?? null,
    [products, productId],
  )

  const choose = (m: MemberOption) => {
    setPicked(m)
    setValue('memberId', m.id, { shouldValidate: true })
    setValue('depositorName', m.name)
    setTerm('')
  }

  const onSelectProduct = (id: string) => {
    setValue('productId', id, { shouldValidate: true })
    const pr = products.find((p) => p.id === id)
    if (pr) setValue('amount', pr.price, { shouldValidate: true })
  }

  const onSubmit = (v: FormValues) => {
    createPayment.mutate(
      {
        memberId: v.memberId,
        productId: v.productId,
        amount: v.amount,
        method: v.method,
        depositorName: v.depositorName,
        approveNow: v.approveNow,
      },
      { onSuccess: () => navigate(`/payments?st=${v.approveNow ? 'approved' : 'wait'}`) },
    )
  }

  return (
    <div>
      <PageHeader title="수기결제 등록" description="대기 결제 생성 · 즉시승인 시 회원 등급/매출 반영(§8)" />

      <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl">
        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          {/* 회원 검색/선택 */}
          <div className="mb-4">
            <label className={labelCls}>회원</label>
            {picked ? (
              <div className="flex items-center gap-2 rounded-md border border-primary-100 bg-primary-50 px-3 py-2">
                <Badge grade={picked.grade} />
                <span className="font-semibold text-ink-800">{picked.name}</span>
                <span className="font-mono text-[12px] text-gray-500">{picked.user_id}</span>
                <span className="font-mono text-[12px] text-gray-400">{phone(picked.phone)}</span>
                <button
                  type="button"
                  className="ml-auto text-[12px] font-semibold text-primary-600 hover:underline"
                  onClick={() => {
                    setPicked(null)
                    setValue('memberId', '', { shouldValidate: true })
                  }}
                >
                  변경
                </button>
              </div>
            ) : (
              <div className="relative">
                <div className="flex items-center gap-2 rounded-md border border-gray-300 px-3 focus-within:border-primary-500">
                  <Search className="h-4 w-4 text-gray-400" />
                  <input
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    placeholder="이름·ID·전화로 검색"
                    className="h-10 w-full bg-transparent text-[13px] text-gray-800 outline-none"
                  />
                </div>
                {term && (
                  <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-md">
                    {results.length === 0 ? (
                      <div className="px-3 py-3 text-[12.5px] text-gray-400">검색 결과 없음</div>
                    ) : (
                      results.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => choose(m)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
                        >
                          <Badge grade={m.grade} />
                          <span className="font-semibold text-ink-800">{m.name}</span>
                          <span className="font-mono text-[12px] text-gray-500">{m.user_id}</span>
                          <span className="ml-auto font-mono text-[11.5px] text-gray-400">{phone(m.phone)}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
            {errors.memberId && <p className={errCls}>{errors.memberId.message}</p>}
          </div>

          {/* 상품 */}
          <div className="mb-4">
            <label className={labelCls}>상품</label>
            <select
              className={inputCls}
              value={productId}
              onChange={(e) => onSelectProduct(e.target.value)}
            >
              <option value="">상품 선택</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {errors.productId && <p className={errCls}>{errors.productId.message}</p>}
          </div>

          {/* 금액 + 결제수단 */}
          <div className="mb-4 grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>금액 (원)</label>
              <input
                type="number"
                className={`${inputCls} text-right font-mono tnum`}
                {...register('amount', { valueAsNumber: true })}
              />
              {errors.amount && <p className={errCls}>{errors.amount.message}</p>}
            </div>
            <div>
              <label className={labelCls}>결제수단</label>
              <select className={inputCls} {...register('method')}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 입금자명 */}
          <div className="mb-4">
            <label className={labelCls}>입금자명</label>
            <input className={inputCls} placeholder="미입력 시 회원명" {...register('depositorName')} />
          </div>

          {/* 즉시승인 */}
          <label className="flex items-start gap-2.5 rounded-md border border-gray-200 bg-gray-50 p-3">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary-600" {...register('approveNow')} />
            <span className="text-[12.5px] leading-relaxed text-gray-600">
              <b className="text-ink-800">즉시 승인</b> — 체크 시 등록과 동시에 결제가 승인되어{' '}
              {selectedProduct ? (
                <>
                  회원 등급이 <Badge grade={selectedProduct.grade_granted}>{selectedProduct.name}</Badge> 로 상향되고
                </>
              ) : (
                '회원 등급이 상향되고'
              )}{' '}
              매출에 즉시 반영됩니다. 미체크 시 <b>대기</b> 상태로 등록됩니다.
            </span>
          </label>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="sec" onClick={() => navigate('/payments')} disabled={createPayment.isPending}>
            취소
          </Button>
          <Button
            type="submit"
            variant={approveNow ? 'suc' : 'pri'}
            icon={<Check className="h-4 w-4" />}
            disabled={createPayment.isPending}
          >
            {approveNow ? '등록 + 승인' : '대기 등록'}
          </Button>
        </div>
      </form>
    </div>
  )
}
