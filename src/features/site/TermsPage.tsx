// 고객 공개 등급별 약관 페이지 (/terms/:grade). 전산의 멤버십 등급 약관을 그대로 노출한다.
import { ArrowLeft, FileText } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { Badge } from '@/design-system/components'
import { isTierGrade } from '@/lib/membership'
import { useMembershipTiers } from './api'

export function TermsPage() {
  const { grade = '' } = useParams<{ grade: string }>()
  const { data: tiers, isLoading } = useMembershipTiers()
  const tier = isTierGrade(grade) ? tiers?.find((item) => item.grade === grade) : undefined

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
            <h1 className="text-[22px] font-extrabold text-ink-900">등급별 이용약관</h1>
          </div>
          {tier && (
            <div className="mt-3 flex items-center gap-2">
              <Badge grade={tier.grade}>{tier.label}</Badge>
              <span className="text-[12.5px] text-gray-500">가입 전 약관 내용을 확인해 주세요.</span>
            </div>
          )}
        </header>

        <div className="min-h-64 px-5 py-6 sm:px-7">
          {isLoading ? (
            <p className="text-[13px] text-gray-400">약관을 불러오는 중입니다…</p>
          ) : tier?.terms.trim() ? (
            <div className="whitespace-pre-wrap text-[13px] leading-7 text-gray-700">{tier.terms}</div>
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
