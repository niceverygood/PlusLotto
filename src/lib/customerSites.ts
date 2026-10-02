import type { BankTransferSettings, BusinessInfo, MembershipTier } from '../types/db'
import type { PortalSourceSite } from './portalScope'

// Source: 홈페이지_사이트별 내용.xlsx, Sheet2!B3:C14 and E3:F14, received 2026-09-29.
// Public homepage copy only. This does not change existing contracts, payments or sender accounts.
// 88 remains a separate deployment/database and is deliberately absent from this host map.
// TODO(live-verify): DNS/TLS, actual member login, supplied terms, and the source B10 company-name typo.
export type CustomerSiteKey = Exclude<PortalSourceSite, 'pluslotto'>
export interface CustomerPlan {
  grade: 'goldp' | 'vip' | 'royal'
  label: string
  price: string
  period: string
  soldOut: boolean
}
export interface CustomerSite {
  key: CustomerSiteKey
  name: string
  hostname: string
  plans: readonly CustomerPlan[]
  bank: BankTransferSettings
  business: BusinessInfo
  representative: string
  email: string
}

export const CUSTOMER_SITES: readonly CustomerSite[] = [
  {
    "key": "infolotto",
    "name": "인포로또",
    "hostname": "infolotto.co.kr",
    "plans": [
      {
        "grade": "goldp",
        "label": "베이직",
        "price": "431,900원",
        "period": "1년+서비스6개월",
        "soldOut": false
      },
      {
        "grade": "vip",
        "label": "스마트",
        "price": "3,800,000원",
        "period": "1년+서비스2년",
        "soldOut": false
      },
      {
        "grade": "royal",
        "label": "시그니쳐",
        "price": "sold out",
        "period": "1년+서비스2년",
        "soldOut": true
      }
    ],
    "bank": {
      "bank_name": "하나은행",
      "account_no": "608-910030-63704",
      "holder": "시나브로",
      "guide": ""
    },
    "business": {
      "name": "주시회사 시나브로",
      "reg_no": "133-81-45913",
      "address": "대전광역시 서구 둔산동 1014 피카소빌딩 6층 우측",
      "support_phone": "1833-6755"
    },
    "representative": "이주훈",
    "email": "info-lotto@naver.com"
  },
  {
    "key": "lotto815",
    "name": "815로또",
    "hostname": "815korean.co.kr",
    "plans": [
      {
        "grade": "goldp",
        "label": "패밀리",
        "price": "399,900원",
        "period": "1년+서비스6개월",
        "soldOut": false
      },
      {
        "grade": "vip",
        "label": "매니아",
        "price": "4,690,000원",
        "period": "1년+서비스2년",
        "soldOut": false
      },
      {
        "grade": "royal",
        "label": "퍼스트",
        "price": "sold out",
        "period": "1년+서비스2년",
        "soldOut": true
      }
    ],
    "bank": {
      "bank_name": "하나은행",
      "account_no": "608-910044-71205",
      "holder": "다을컴퍼니",
      "guide": ""
    },
    "business": {
      "name": "주식회사 다을컴퍼니",
      "reg_no": "461-86-03171",
      "address": "대전광역시 서구 둔산동 1014 피카소빌딩 6층 우측",
      "support_phone": "1661-5333"
    },
    "representative": "이주훈",
    "email": "815market@naver.com"
  },
  {
    "key": "cplotto",
    "name": "일행로또",
    "hostname": "ilhanglotto.co.kr",
    "plans": [
      {
        "grade": "goldp",
        "label": "골드플러스",
        "price": "490,000원",
        "period": "1년+서비스6개월",
        "soldOut": false
      },
      {
        "grade": "vip",
        "label": "VIP",
        "price": "3,300,000원",
        "period": "1년+서비스2년",
        "soldOut": false
      },
      {
        "grade": "royal",
        "label": "로얄퍼스트",
        "price": "sold out",
        "period": "1년+서비스2년",
        "soldOut": true
      }
    ],
    "bank": {
      "bank_name": "하나은행",
      "account_no": "608-910029-71104",
      "holder": "이루다컴퍼니",
      "guide": ""
    },
    "business": {
      "name": "주식회사 이루다컴퍼니",
      "reg_no": "562-81-02354",
      "address": "대전광역시 서구 둔산동 1014 피카소빌딩 6층 우측",
      "support_phone": "1661-9414"
    },
    "representative": "이주훈",
    "email": "ilhang-lotto@naver.com"
  },
  {
    "key": "best",
    "name": "프리미엄로또",
    "hostname": "premiumlotto.co.kr",
    "plans": [
      {
        "grade": "goldp",
        "label": "프리미엄플러스",
        "price": "431,900원",
        "period": "1년+서비스6개월",
        "soldOut": false
      },
      {
        "grade": "vip",
        "label": "VIP",
        "price": "6,160,000원",
        "period": "1년+서비스2년",
        "soldOut": false
      },
      {
        "grade": "royal",
        "label": "로얄퍼스트",
        "price": "sold out",
        "period": "1년+서비스2년",
        "soldOut": true
      }
    ],
    "bank": {
      "bank_name": "하나은행",
      "account_no": "608-910030-63704",
      "holder": "시나브로",
      "guide": ""
    },
    "business": {
      "name": "주식회사 시나브로",
      "reg_no": "133-81-45913",
      "address": "대전광역시 서구 둔산동 1014 피카소빌딩 6층 우측",
      "support_phone": "1833-2090"
    },
    "representative": "이주훈",
    "email": "premium-lotto@naver.com"
  }
]

/** Exact host allowlist. Never derive a tenant from an arbitrary subdomain or query parameter. */
export function resolveCustomerSite(hostname: string, deploymentBrand: string, allowLocalPreview = false): CustomerSite | null {
  if (deploymentBrand !== '플러스로또') return null
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  return CUSTOMER_SITES.find((site) => site.hostname === host
    || (allowLocalPreview && host === `${site.key}.localhost`)) ?? null
}

export function customerSiteTiers(site: CustomerSite): MembershipTier[] {
  return site.plans.map((plan) => ({
    grade: plan.grade, label: plan.label, price: plan.soldOut ? '판매 종료' : plan.price,
    tagline: plan.period, weekly_sets: '', highlights: [], featured: false, terms: '',
  }))
}
