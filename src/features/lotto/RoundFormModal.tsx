// 회차 등록 모달 (BUILD_PROMPTS P6-1 회차 등록 액션). 당첨번호 6 + 보너스 + 당첨금 입력.
// 미확정 상태로 추가되고, 이후 '당첨 확정'으로 베팅을 채점한다. 입력값은 zod 로 검증.
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { format, nextSaturday } from 'date-fns'
import { Button, LottoBalls, Modal } from '@/design-system/components'
import { LOTTO_MAX, LOTTO_MIN } from '@/lib/lotto'
import { useRegisterRound, useRounds } from './api'

const numStr = () => z.string().regex(/^\d+$/, '숫자만').transform(Number)
const schema = z.object({
  round_no: numStr().pipe(z.number().int().positive('회차는 양의 정수')),
  draw_date: z.string().min(1, '추첨일 필요'),
  numbers: z
    .array(z.number().int().min(LOTTO_MIN).max(LOTTO_MAX))
    .length(6),
  bonus: z.number().int().min(LOTTO_MIN).max(LOTTO_MAX),
})

const inputCls =
  'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] text-gray-800 outline-none focus:border-primary-500'
const ballInputCls =
  'h-11 w-full rounded-md border border-gray-300 bg-white text-center font-mono text-[15px] font-bold text-ink-800 outline-none focus:border-primary-500'
const labelCls = 'mb-1.5 block text-[12px] font-semibold text-gray-600'
const errCls = 'mt-1 text-[11.5px] text-danger'

function toInt(s: string): number | null {
  const t = s.trim()
  if (!/^\d+$/.test(t)) return null
  return Number(t)
}

export function RoundFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: rounds = [] } = useRounds('all')
  const register = useRegisterRound()

  const nextNo = useMemo(
    () => (rounds.length ? Math.max(...rounds.map((r) => r.round_no)) + 1 : 1181),
    [rounds],
  )
  const defaultDate = useMemo(() => format(nextSaturday(new Date()), 'yyyy-MM-dd'), [])

  const [roundNo, setRoundNo] = useState('')
  const [drawDate, setDrawDate] = useState('')
  const [nums, setNums] = useState<string[]>(['', '', '', '', '', ''])
  const [bonus, setBonus] = useState('')
  const [prize1, setPrize1] = useState('')
  const [prize2, setPrize2] = useState('')
  const [prize3, setPrize3] = useState('')
  const [sales, setSales] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 모달이 열릴 때 기본값 세팅(닫혀 있으면 렌더 안 함).
  const [seededFor, setSeededFor] = useState<number | null>(null)
  if (open && seededFor !== nextNo) {
    setRoundNo(String(nextNo))
    setDrawDate(defaultDate)
    setNums(['', '', '', '', '', ''])
    setBonus('')
    setPrize1('')
    setPrize2('')
    setPrize3('')
    setSales('')
    setError(null)
    setSeededFor(nextNo)
  }

  const parsedNums = nums.map(toInt).filter((n): n is number => n != null && n >= 1 && n <= 45)
  const parsedBonus = toInt(bonus)
  const previewNumbers = [...new Set(parsedNums)].sort((a, b) => a - b)
  const previewBonus = parsedBonus != null && parsedBonus >= 1 && parsedBonus <= 45 ? parsedBonus : null

  const close = () => {
    setSeededFor(null)
    onClose()
  }

  const submit = () => {
    setError(null)
    const numArr = nums.map(toInt)
    if (numArr.some((n) => n == null)) return setError('당첨번호 6개를 모두 입력하세요.')
    const parsed = schema.safeParse({
      round_no: roundNo,
      draw_date: drawDate,
      numbers: numArr,
      bonus: parsedBonus ?? -1,
    })
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? '입력값을 확인하세요.')
    const all = [...parsed.data.numbers, parsed.data.bonus]
    if (new Set(all).size !== all.length) return setError('번호와 보너스는 서로 중복될 수 없습니다.')
    if (rounds.some((r) => r.round_no === parsed.data.round_no))
      return setError('이미 존재하는 회차입니다.')

    register.mutate(
      {
        round_no: parsed.data.round_no,
        draw_date: parsed.data.draw_date,
        numbers: parsed.data.numbers,
        bonus: parsed.data.bonus,
        prize_1: toInt(prize1),
        prize_2: toInt(prize2),
        prize_3: toInt(prize3),
        total_sales: toInt(sales),
      },
      {
        onSuccess: (res) => {
          if (res.ok) close()
          else setError(res.error)
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="회차 등록"
      size="lg"
      footer={
        <>
          <Button variant="sec" size="sm" onClick={close} disabled={register.isPending}>
            취소
          </Button>
          <Button variant="pri" size="sm" onClick={submit} disabled={register.isPending}>
            등록
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>회차</label>
          <input
            className={`${inputCls} text-right font-mono tnum`}
            value={roundNo}
            onChange={(e) => setRoundNo(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div>
          <label className={labelCls}>추첨일</label>
          <input type="date" className={inputCls} value={drawDate} onChange={(e) => setDrawDate(e.target.value)} />
        </div>
      </div>

      <div className="mt-4">
        <label className={labelCls}>당첨번호 (6개) + 보너스</label>
        <div className="flex items-center gap-2">
          {nums.map((v, i) => (
            <input
              key={i}
              className={ballInputCls}
              value={v}
              inputMode="numeric"
              maxLength={2}
              aria-label={`번호 ${i + 1}`}
              onChange={(e) => {
                const next = [...nums]
                next[i] = e.target.value.replace(/\D/g, '').slice(0, 2)
                setNums(next)
              }}
            />
          ))}
          <span className="px-1 text-gray-400">+</span>
          <input
            className={`${ballInputCls} border-accent-500/60`}
            value={bonus}
            inputMode="numeric"
            maxLength={2}
            aria-label="보너스"
            onChange={(e) => setBonus(e.target.value.replace(/\D/g, '').slice(0, 2))}
          />
        </div>
        {previewNumbers.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[11.5px] font-semibold text-gray-400">미리보기</span>
            <LottoBalls numbers={previewNumbers} bonus={previewBonus} size="md" />
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>1등 당첨금 (원, 선택)</label>
          <input className={`${inputCls} text-right font-mono tnum`} value={prize1} inputMode="numeric" onChange={(e) => setPrize1(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div>
          <label className={labelCls}>2등 당첨금 (원, 선택)</label>
          <input className={`${inputCls} text-right font-mono tnum`} value={prize2} inputMode="numeric" onChange={(e) => setPrize2(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div>
          <label className={labelCls}>3등 당첨금 (원, 선택)</label>
          <input className={`${inputCls} text-right font-mono tnum`} value={prize3} inputMode="numeric" onChange={(e) => setPrize3(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div>
          <label className={labelCls}>총판매금액 (원, 선택)</label>
          <input className={`${inputCls} text-right font-mono tnum`} value={sales} inputMode="numeric" onChange={(e) => setSales(e.target.value.replace(/\D/g, ''))} />
        </div>
      </div>

      {error && <p className={errCls}>{error}</p>}
      <p className="mt-3 text-[11.5px] leading-relaxed text-gray-400">
        등록 시 미확정 상태로 추가됩니다. 이후 목록에서 <b className="text-gray-500">당첨 확정</b>을 실행하면 해당 회차
        베팅의 등수·당첨금이 산정됩니다.
      </p>
    </Modal>
  )
}
