import { BRAND } from './brand'
import { resolveCustomerSite } from './customerSites'

// Client homepage context only; admin branding and SMS branding continue to use BRAND.
export const CUSTOMER_SITE = typeof window === 'undefined' ? null : resolveCustomerSite(
  window.location.hostname, BRAND.name, import.meta.env.DEV,
)
export const CUSTOMER_BRAND = CUSTOMER_SITE
  ? { name: CUSTOMER_SITE.name, short: CUSTOMER_SITE.name.replace(/로또$/, ''), rest: '로또' }
  : BRAND
export const CUSTOMER_LOGIN_SITE = CUSTOMER_SITE?.key ?? null
