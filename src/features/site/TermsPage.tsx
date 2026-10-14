// 고객 공개 등급별 약관 페이지 (/terms/:grade) — 사이트별 약관 게시판(현장 10/14, 정의현 차장).
// 그 사이트의 등급 전용 약관 + 공통 약관을 시행일 최신순 목록으로 보여 준다. 범위마다 가장 최근 시행 글이
// '현행'(기본 펼침), 시행일이 미래면 '시행 예정', 그 밖은 '이전 약관'(개정 이력).
import { useState } from 'react'
import { ArrowLeft, ChevronDown, FileText } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Badge } from '@/design-system/components'
import { cn } from '@/lib/cn'
import { isTierGrade, membershipTermsSourceSite } from '@/lib/membership'
import { CUSTOMER_LOGIN_SITE } from '@/lib/customerSiteContext'
import { siteScopeLabel } from '@/lib/siteScope'
import { kstToday, termsPostStates, TERMS_STATE_LABEL, type TermsPostState } from '@/lib/termsPosts'
import { useMembershipTiers, useTermsPosts, type PublicTermsPost } from './api'

const STATE_TONE: Record<TermsPostState, string> = {
  current: 'bg-success-bg text-success',
  scheduled: 'bg-info-bg text-info',
  previous: 'bg-gray-100 text-gray-500',
}

export function TermsPage() {
  const { grade = '' } = useParams<{ grade: string }>()
  const [searchParams] = useSearchParams()
  const sourceSite = membershipTermsSourceSite(CUSTOMER_LOGIN_SITE, searchParams.get('site'))
  const tierGrade = isTierGrade(grade) ? grade : null
  const { data: tiers } = useMembershipTiers(sourceSite)
  const tier = sourceSite && tierGrade ? tiers?.find((item) => item.grade === tierGrade) : undefined
  const { data: posts = [], isLoading, isError } = useTermsPosts(tierGrade ? sourceSite : null, tierGrade)
  const states = termsPostStates(posts, kstToday())

  return (
    <main className="mx-auto w-full max-w-[860px] px-4 py-10 sm:px-6 sm:py-14">
      <Link
        to="/membership"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-gray-500 hover:text-primary-600"
      >
        <ArrowLeft className="h-4 w-4" />
        멤버십으로 돌아가기
      </Link>

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <header className="border-b border-gray-200 bg-gray-50 px-5 py-5 sm:px-7">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary-600" />
            <h1 className="text-[22px] font-extrabold text-ink-900">{sourceSite && sourceSite !== 'pluslotto' ? `${siteScopeLabel(sourceSite)} ` : ''}등급별 이용약관</h1>
          </div>
          {tier && (
            <div className="mt-3 flex items-center gap-2">
              <Badge grade={tier.grade}>{tier.label}</Badge>
              <span className="text-[12.5px] text-gray-500">가입 전 약관 내용을 확인해 주세요. 가장 최근 시행 약관이 '현행'입니다.</span>
            </div>
          )}
        </header>

        <div className="min-h-64 px-5 py-6 sm:px-7">
          {isLoading && tierGrade && sourceSite ? (
            <p className="text-[13px] text-gray-400">약관을 불러오는 중입니다…</p>
          ) : isError && tier?.terms.trim() ? (
            // 게시판 조회가 안 되면(예: DB 반영 전) 기존 단일 약관을 그대로 보여 준다 — 배포 순서와 무관하게 약관이 비지 않게.
            <div className="whitespace-pre-wrap text-[13px] leading-7 text-gray-700">{tier.terms}</div>
          ) : isError ? (
            <p role="alert" className="text-[13px] text-gray-600">약관을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
          ) : posts.length > 0 ? (
            <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
              {posts.map((p) => (
                <TermsRow key={p.id} post={p} state={states.get(p.id) ?? 'previous'} gradeLabel={p.grade ? tier?.label ?? '' : '공통'} />
              ))}
            </ul>
          ) : (
            <div className="grid min-h-52 place-items-center text-center">
              <div>
                <p className="text-[15px] font-bold text-ink-900">등록된 약관이 없습니다.</p>
                <p className="mt-1 text-[12.5px] text-gray-500">고객센터로 문의해 주세요.</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

function TermsRow({ post, state, gradeLabel }: { post: PublicTermsPost; state: TermsPostState; gradeLabel: string }) {
  const [open, setOpen] = useState(state === 'current')
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
      >
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', STATE_TONE[state])}>
          {TERMS_STATE_LABEL[state]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-bold text-ink-900">{post.title}</span>
          <span className="mt-0.5 block text-[12px] text-gray-500">
            {gradeLabel && <>{gradeLabel} · </>}시행일 <span className="font-mono tabular-nums">{post.effective_on}</span>
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-t border-gray-100 bg-gray-50/50 px-4 py-4 text-[13px] leading-7 text-gray-700">
          {post.body}
        </div>
      )}
    </li>
  )
}
