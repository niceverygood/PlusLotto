import { Link } from 'react-router-dom'
import { ArrowRight, Headphones, UserRound } from 'lucide-react'
import type { CustomerSite } from '@/lib/customerSites'
import { useMemberAuth } from './auth'

export function CustomerJoinPage({ site }: { site: CustomerSite }) {
  return (
    <section className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-extrabold text-ink-900">{site.name} 가입 문의</h1>
        <p className="mt-4 text-sm leading-relaxed text-gray-600">고객센터에서 멤버십의 이용 조건과 가입 방법을 안내해드립니다.</p>
        <a href={`tel:${site.business.support_phone}`} className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary-600 px-5 py-3 font-mono text-lg font-bold tabular-nums text-white hover:bg-primary-700"><Headphones className="h-5 w-5" />{site.business.support_phone}</a>
        <p className="mt-5 text-sm text-gray-600">이메일 <a className="text-primary-700 underline" href={`mailto:${site.email}`}>{site.email}</a></p>
        <div className="mt-8 flex flex-wrap gap-4 text-sm font-semibold text-primary-700"><Link to="/membership">멤버십 안내</Link><Link to="/login">기존 회원 로그인</Link></div>
      </div>
    </section>
  )
}

/** The supplied homepage sheet defines package prices, not monthly subscriptions. */
export function CustomerMembership({ site }: { site: CustomerSite }) {
  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-extrabold text-ink-900">{site.name} 멤버십</h1>
      <p className="mt-3 text-sm text-gray-600">등급별 이용금액과 제공 기간을 확인하세요.</p>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {site.plans.map((plan) => (
          <article key={plan.grade} className="flex flex-col rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-extrabold text-ink-900">{plan.label}</h2>
            <p className="mt-6 text-xs font-semibold text-gray-500">이용금액</p>
            <p className="mt-1 font-mono text-2xl font-extrabold tabular-nums text-primary-700">
              {plan.soldOut ? '판매 종료' : plan.price}
            </p>
            <p className="mt-3 text-sm text-gray-600">{plan.period}</p>
            <Link to={`/terms/${plan.grade}`} className="mt-6 text-sm font-semibold text-primary-700 underline underline-offset-4">약관 안내</Link>
            {!plan.soldOut && <Link to="/support" className="mt-4 rounded-md bg-primary-600 px-4 py-3 text-center text-sm font-bold text-white hover:bg-primary-700">가입 문의</Link>}
          </article>
        ))}
      </div>
      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-bold text-ink-900">입금계좌 안내</h2>
        <p className="mt-3 text-sm text-gray-700">{site.bank.bank_name} <span className="font-mono tabular-nums">{site.bank.account_no}</span></p>
        <p className="mt-1 text-sm text-gray-600">예금주 {site.bank.holder}</p>
        <p className="mt-3 text-sm text-gray-500">가입 조건과 입금금액은 고객센터에서 확인해주세요.</p>
      </section>
    </section>
  )
}

export function CustomerHomePage({ site }: { site: CustomerSite }) {
  const { member } = useMemberAuth()
  return (
    <>
      <section className="bg-ink-900 text-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <p className="text-sm font-semibold text-accent-100">{site.name} 회원 서비스</p>
          <h1 className="mt-4 text-3xl font-extrabold leading-tight sm:text-4xl">내 멤버십과 추천번호를<br />한곳에서 확인하세요.</h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-gray-200">가입하신 {site.name} 회원 정보로 로그인하면 내 등급과 발급된 추천번호를 확인할 수 있습니다.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to={member ? '/mypage' : '/login'} className="inline-flex items-center gap-2 rounded-md bg-accent-500 px-5 py-3 text-sm font-bold text-white hover:bg-accent-600"><UserRound className="h-4 w-4" />{member ? '내 추천번호 확인' : '회원 로그인'}</Link>
            <Link to="/membership" className="inline-flex items-center gap-2 rounded-md border border-white/30 px-5 py-3 text-sm font-bold text-white hover:bg-white/10">멤버십 안내<ArrowRight className="h-4 w-4" /></Link>
          </div>
        </div>
      </section>
      <CustomerMembership site={site} />
      <section className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-5 rounded-lg bg-primary-50 p-6">
          <div><h2 className="text-lg font-bold text-ink-900">이용에 도움이 필요하신가요?</h2><p className="mt-2 text-sm text-gray-600">로그인과 멤버십 문의는 {site.name} 고객센터로 연락해주세요.</p></div>
          <a href={`tel:${site.business.support_phone}`} className="inline-flex items-center gap-2 font-mono text-xl font-bold tabular-nums text-primary-700"><Headphones className="h-5 w-5" />{site.business.support_phone}</a>
        </div>
      </section>
    </>
  )
}
