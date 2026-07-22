// 회원 단건 등록 폼 (§V2-2 DB 입력). 신규 리드를 미배분·무료·미아웃콜 상태로 생성.
// react-hook-form + zod. 유입 프리셋 선택 시 코드/분류 동시 채움. 담당자 지정 시 배정 이력 동반.
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button, Drawer } from '@/design-system/components'
import { GRADE_LABEL } from '@/design-system/labels'
import { useStaff } from '@/lib/staff'
import type { Grade } from '@/types/db'
import { useCreateMember } from './api'
import { AGE_BANDS, CONSULT_STATUSES, GENDERS, INFLOW_TYPES, TENDENCIES } from './views'

const inputCls =
  'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] text-gray-800 outline-none focus:border-primary-500'
const textareaCls =
  'min-h-[80px] w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-800 outline-none focus:border-primary-500'
const labelCls = 'mb-1.5 block text-[12px] font-semibold text-gray-600'
const errCls = 'mt-1 text-[11.5px] text-danger'

const GRADES: Grade[] = ['simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss']
// 유입경로(채널) 프리셋 — inflow_code(채널)만 채운다. 유입구분(콜 단계)은 별도 선택.
const INFLOW_CODE_PRESETS = [
  { code: 'NAVER', label: '네이버검색' },
  { code: 'FB', label: '페이스북' },
  { code: 'KAKAO', label: '카카오' },
  { code: 'TOSS', label: '토스DB' },
  { code: 'REF', label: '지인추천' },
  { code: 'BANNER', label: '배너광고' },
]

const schema = z.object({
  name: z.string().min(1, '이름을 입력하세요.'),
  phone: z.string().min(9, '휴대폰 번호를 입력하세요.'),
  inflow_code: z.string(),
  inflow_type: z.string(),
  consult_status: z.string(),
  tendency: z.string(),
  age_band: z.string(),
  gender: z.string(),
  grade: z.enum(['simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss']),
  assigned_staff_id: z.string(),
  nickname: z.string(),
  memo: z.string(),
})
type Form = z.infer<typeof schema>

export function MemberCreateDrawer({ onClose }: { onClose: () => void }) {
  const create = useCreateMember()
  const { data: staff = [] } = useStaff()
  const [serverErr, setServerErr] = useState<string | null>(null)
  const [serverNotice, setServerNotice] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      phone: '',
      inflow_code: '',
      inflow_type: INFLOW_TYPES[0], // 신규
      consult_status: CONSULT_STATUSES[0], // 신규
      tendency: '',
      age_band: '',
      gender: '',
      grade: 'free',
      assigned_staff_id: '',
      nickname: '',
      memo: '',
    },
  })

  const onPreset = (code: string) => {
    setValue('inflow_code', code)
  }

  const submit = handleSubmit((v) => {
    setServerErr(null)
    setServerNotice(null)
    create.mutate(
      {
        name: v.name,
        phone: v.phone,
        nickname: v.nickname || null,
        grade: v.grade,
        inflow_code: v.inflow_code || null,
        inflow_type: v.inflow_type || null,
        consult_status: v.consult_status || null,
        tendency: v.tendency || null,
        age_band: v.age_band || null,
        gender: v.gender || null,
        memo: v.memo || null,
        assigned_staff_id: v.assigned_staff_id || null,
      },
      {
        onSuccess: (result) => {
          if (result.created) onClose()
          else setServerNotice('이미 등록된 번호입니다. 신규 등록하지 않고 기존 DB를 ‘중복 DB’로 표시했습니다.')
        },
        onError: (e) => setServerErr(e instanceof Error ? e.message : '등록에 실패했습니다.'),
      },
    )
  })

  return (
    <Drawer
      open
      onClose={onClose}
      title="신규 회원 등록"
      footer={
        <>
          <Button variant="sec" size="sm" onClick={onClose} disabled={create.isPending}>
            취소
          </Button>
          <Button variant="pri" size="sm" onClick={submit} disabled={create.isPending}>
            등록
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>이름 *</label>
            <input className={inputCls} {...register('name')} />
            {errors.name && <p className={errCls}>{errors.name.message}</p>}
          </div>
          <div>
            <label className={labelCls}>휴대폰 *</label>
            <input className={inputCls} placeholder="010..." inputMode="numeric" {...register('phone')} />
            {errors.phone && <p className={errCls}>{errors.phone.message}</p>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>유입경로(채널)</label>
            <select className={inputCls} defaultValue="" onChange={(e) => onPreset(e.target.value)}>
              <option value="">직접입력</option>
              {INFLOW_CODE_PRESETS.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>성향</label>
            <select className={inputCls} {...register('tendency')}>
              <option value="">미지정</option>
              {TENDENCIES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>연령대</label>
            <select className={inputCls} {...register('age_band')}>
              <option value="">미지정</option>
              {AGE_BANDS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>성별</label>
            <select className={inputCls} {...register('gender')}>
              <option value="">미지정</option>
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>유입코드</label>
            <input className={inputCls} placeholder="NAVER, KAKAO…" {...register('inflow_code')} />
          </div>
          <div>
            <label className={labelCls}>유입구분</label>
            <select className={inputCls} {...register('inflow_type')}>
              {INFLOW_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={labelCls}>상담상태</label>
          <select className={inputCls} {...register('consult_status')}>
            {CONSULT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>등급</label>
            <select className={inputCls} {...register('grade')}>
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {GRADE_LABEL[g]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>담당자</label>
            <select className={inputCls} {...register('assigned_staff_id')}>
              <option value="">미지정</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={labelCls}>닉네임</label>
          <input className={inputCls} {...register('nickname')} />
        </div>
        <div>
          <label className={labelCls}>메모</label>
          <textarea className={textareaCls} {...register('memo')} />
        </div>

        {serverErr && <p className={errCls}>{serverErr}</p>}
        {serverNotice && <p className="text-[12px] font-semibold text-warning">{serverNotice}</p>}
        <p className="rounded-md bg-gray-50 px-3 py-2 text-[11.5px] leading-relaxed text-gray-500">
          신규 리드는 미배분·무료·미아웃콜 상태로 등록됩니다. 담당자를 지정하면 배정 이력이 함께 남습니다. 이미
          등록된 번호면 새로 등록하지 않고 기존 DB를 ‘중복 DB’로 표시합니다.
        </p>
      </div>
    </Drawer>
  )
}
