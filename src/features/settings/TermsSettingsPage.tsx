// 이용약관 게시판 (/settings/terms) — 사이트별·등급별 약관 개정본을 글로 쌓는다(현장 10/14, 정의현 차장).
//  · "회원별 홈페이지에 약관은 각각 다르게 설정" → 사이트 탭(플러스·815·인포·일행·프리미엄).
//  · "약관보기를 누르면 게시판 형태로, 새로 수정된 약관을 업데이트" → 개정 시 새 글(새 시행일)을 올리면
//    고객 약관보기에 최신 시행 글이 '현행', 이전 글은 '이전 약관'으로 함께 보인다.
// 예전 단일 약관(site_settings.terms·terms_by_grade)은 첫 글로 옮겨졌다(마이그레이션 20261014140000).
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { FilePlus2, Pencil, Trash2 } from 'lucide-react'
import { usePageMeta } from '@/app/uiStore'
import { cn } from '@/lib/cn'
import { datetime } from '@/lib/format'
import { Button, ConfirmModal, Drawer, EmptyState, SkeletonRows, Tabs, type TabItem } from '@/design-system/components'
import type { Grade, TermsPost } from '@/types/db'
import {
  kstToday,
  sortTermsPosts,
  termsGradeLabel,
  termsGradesForSite,
  termsPostStates,
  TERMS_SITES,
  TERMS_STATE_LABEL,
  type TermsPostState,
} from '@/lib/termsPosts'
import type { PortalSourceSite } from '@/lib/portalScope'
import { SectionCard, errCls, hintCls, inputCls, labelCls, textareaCls } from './ui'
import { useDeleteTermsPost, useSaveTermsPost, useTermsPosts } from './api'

const COMMON = '__common'
const selectCls =
  'h-9 rounded-md border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-700 outline-none focus:border-primary-500'

const STATE_TONE: Record<TermsPostState, string> = {
  current: 'bg-success-bg text-success',
  scheduled: 'bg-info-bg text-info',
  previous: 'bg-gray-100 text-gray-500',
}

export function TermsSettingsPage() {
  usePageMeta('설정', '이용약관 게시판(사이트별)')
  const [site, setSite] = useState<PortalSourceSite>('pluslotto')
  const [gradeFilter, setGradeFilter] = useState<string>('')
  const [edit, setEdit] = useState<TermsPost | 'new' | null>(null)
  const [del, setDel] = useState<TermsPost | null>(null)
  const { data: posts = [], isLoading, isError, refetch } = useTermsPosts(site)
  const remove = useDeleteTermsPost()

  const grades = termsGradesForSite(site)
  const states = termsPostStates(posts.filter((p) => p.published), kstToday())
  const visible = sortTermsPosts(posts).filter((p) =>
    !gradeFilter ? true : gradeFilter === COMMON ? p.grade === null : p.grade === gradeFilter,
  )
  const tabs: TabItem[] = TERMS_SITES.map((s) => ({ key: s.key, label: s.label }))

  return (
    <div>
      <SectionCard
        title="이용약관 게시판 (사이트별)"
        desc="사이트마다 약관을 따로 올립니다. 고객 홈페이지 '약관보기'를 누르면 그 등급 약관과 공통 약관이 시행일 최신순 목록으로 보이고, 가장 최근 시행 글이 '현행'으로 표시됩니다. 약관이 바뀌면 기존 글을 고치지 말고 새 글로 올려 주세요 — 이전 약관이 이력으로 남습니다."
      >
        <Tabs tabs={tabs} value={site} onChange={(k) => { setSite(k as PortalSourceSite); setGradeFilter('') }} className="mb-3" />
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-[12px] font-semibold text-gray-500">
            대상
            <select className={selectCls} value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
              <option value="">전체</option>
              <option value={COMMON}>공통(전 등급)</option>
              {grades.map((g) => (
                <option key={g} value={g}>
                  {termsGradeLabel(site, g)}
                </option>
              ))}
            </select>
          </label>
          <Button variant="pri" size="sm" onClick={() => setEdit('new')}>
            <FilePlus2 className="h-4 w-4" /> 새 약관 올리기
          </Button>
        </div>

        {isLoading ? (
          <SkeletonRows rows={4} cols={5} />
        ) : isError ? (
          <div role="alert" className="rounded-md border border-gray-200 p-4 text-[13px] text-gray-700">
            약관 목록을 불러오지 못했습니다.
            <Button variant="sec" size="sm" className="ml-3" onClick={() => void refetch()}>다시 시도</Button>
          </div>
        ) : visible.length === 0 ? (
          <EmptyState title="등록된 약관이 없습니다" description="비어 있으면 고객 화면에는 '고객센터로 문의해 주세요'가 표시됩니다." />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-gray-100 bg-gray-50 text-[11px] font-bold text-gray-500">
              <tr>
                <th className="w-28 px-3 py-2.5">시행일</th>
                <th className="w-40 px-2 py-2.5">대상</th>
                <th className="px-2 py-2.5">제목</th>
                <th className="w-28 px-2 py-2.5">상태</th>
                <th className="w-36 px-2 py-2.5 text-right">등록·수정</th>
                <th className="w-24 px-3 py-2.5 text-right">관리</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const state = states.get(p.id)
                return (
                  <tr key={p.id} className="border-t border-gray-100 hover:bg-gray-50/60">
                    <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-gray-700">{p.effective_on}</td>
                    <td className="px-2 py-2.5 text-[12px] text-gray-600">{termsGradeLabel(site, p.grade)}</td>
                    <td className="px-2 py-2.5 font-semibold text-ink-800">{p.title}</td>
                    <td className="px-2 py-2.5">
                      {!p.published ? (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">비공개</span>
                      ) : state ? (
                        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', STATE_TONE[state])}>
                          {TERMS_STATE_LABEL[state]}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-[11.5px] tabular-nums text-gray-500">{datetime(p.updated_at)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="inline-flex gap-1">
                        <Button variant="sec" size="sm" aria-label="수정" onClick={() => setEdit(p)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="sec" size="sm" aria-label="삭제" onClick={() => setDel(p)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </SectionCard>

      {edit && (
        <TermsEditor
          site={site}
          grades={grades}
          post={edit === 'new' ? null : edit}
          defaultGrade={gradeFilter && gradeFilter !== COMMON ? (gradeFilter as Grade) : null}
          onClose={() => setEdit(null)}
        />
      )}
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        onConfirm={() => del && remove.mutate(del.id, { onSuccess: () => setDel(null) })}
        title="약관 글을 삭제할까요?"
        description={del ? `"${del.title}" (${del.effective_on})이 고객 약관보기에서도 사라집니다. 개정 이력을 남기려면 삭제 대신 새 글을 올려 주세요.` : undefined}
        confirmText="삭제"
        tone="danger"
        loading={remove.isPending}
      />
    </div>
  )
}

const schema = z.object({
  grade: z.string(),
  title: z.string().trim().min(1, '제목을 입력해 주세요.').max(200, '제목은 200자 이내로 입력해 주세요.'),
  effective_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '시행일을 선택해 주세요.'),
  published: z.boolean(),
  body: z.string().refine((v) => v.trim().length > 0, '약관 내용을 입력해 주세요.'),
})
type TermsForm = z.infer<typeof schema>

function TermsEditor({ site, grades, post, defaultGrade, onClose }: {
  site: PortalSourceSite
  grades: Grade[]
  post: TermsPost | null
  defaultGrade: Grade | null
  onClose: () => void
}) {
  const save = useSaveTermsPost()
  const [serverErr, setServerErr] = useState<string | null>(null)
  const { register, handleSubmit, watch, formState: { errors } } = useForm<TermsForm>({
    resolver: zodResolver(schema),
    defaultValues: {
      grade: post ? (post.grade ?? COMMON) : (defaultGrade ?? COMMON),
      title: post?.title ?? '',
      effective_on: post?.effective_on ?? kstToday(),
      published: post?.published ?? true,
      body: post?.body ?? '',
    },
  })
  const bodyLen = watch('body').length
  // 기존 글의 등급이 현재 사이트 목록에 없더라도(예: 이후 상품 변경) 그대로 고를 수 있게 둔다.
  const gradeOptions = post?.grade && !grades.includes(post.grade) ? [...grades, post.grade] : grades

  const onSubmit = handleSubmit(async (v) => {
    setServerErr(null)
    try {
      await save.mutateAsync({
        id: post?.id,
        input: {
          source_site: site,
          grade: v.grade === COMMON ? null : (v.grade as Grade),
          title: v.title,
          body: v.body,
          effective_on: v.effective_on,
          published: v.published,
        },
      })
      onClose()
    } catch (e) {
      setServerErr(e instanceof Error ? e.message : '저장하지 못했습니다.')
    }
  })

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${post ? '약관 수정' : '새 약관 올리기'} · ${TERMS_SITES.find((s) => s.key === site)?.label ?? site}`}
      width={720}
      footer={
        <>
          <Button variant="sec" size="sm" onClick={onClose} disabled={save.isPending}>취소</Button>
          <Button variant="pri" size="sm" onClick={() => void onSubmit()} disabled={save.isPending}>
            {save.isPending ? '저장 중…' : '저장'}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void onSubmit() }} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>대상 등급</label>
            <select className={cn(inputCls, 'mt-1.5')} {...register('grade')}>
              <option value={COMMON}>공통(전 등급)</option>
              {gradeOptions.map((g) => (
                <option key={g} value={g}>{termsGradeLabel(site, g)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>시행일</label>
            <input type="date" className={cn(inputCls, 'mt-1.5')} {...register('effective_on')} />
            {errors.effective_on && <p className={errCls}>{errors.effective_on.message}</p>}
          </div>
        </div>
        <div>
          <label className={labelCls}>제목</label>
          <input className={cn(inputCls, 'mt-1.5')} placeholder="예: 골드 등급 이용약관 (2026년 10월 개정)" {...register('title')} />
          {errors.title && <p className={errCls}>{errors.title.message}</p>}
        </div>
        <div>
          <label className={labelCls}>약관 내용</label>
          <textarea rows={18} className={cn(textareaCls, 'mt-1.5 text-[12.5px] leading-relaxed')} {...register('body')} />
          {errors.body ? <p className={errCls}>{errors.body.message}</p> : <p className={hintCls}>{bodyLen.toLocaleString()}자</p>}
        </div>
        <label className="flex items-center gap-2 text-[13px] text-gray-700">
          <input type="checkbox" {...register('published')} /> 고객 홈페이지에 공개
        </label>
        {serverErr && <p className={errCls}>{serverErr}</p>}
      </form>
    </Drawer>
  )
}
