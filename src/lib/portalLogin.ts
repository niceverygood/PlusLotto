import { readDb } from './db/store'
import { dataSource, supabase } from './supabase'
import {
  isPortalSourceSite, loginPortalMock, normalizePortalPhone, type PortalMemberSession,
} from './portalScope'
import type { Grade, WeeklyRecoIssue } from '../types/db'

/** 양쪽 고객 로그인 화면이 사이트·전화·비밀번호를 같은 규칙으로 전달한다. */
export async function loginPortal(
  phone: string, password: string, sourceSite: unknown,
): Promise<PortalMemberSession | null> {
  if (!isPortalSourceSite(sourceSite)) return null
  const domestic = normalizePortalPhone(phone)
  const pw = password.trim()
  if (!/^0[0-9]{8,10}$/.test(domestic) || !pw) return null
  if (dataSource === 'supabase' && supabase) {
    const { data, error } = await supabase.rpc('portal_member_recos_for_site', {
      p_phone: domestic, p_pw: pw, p_source_site: sourceSite,
    })
    if (error) throw error
    if (!data) return null
    const result = data as { name: string; grade: Grade; recos: WeeklyRecoIssue[] }
    return {
      name: result.name, grade: result.grade, phone: domestic, sourceSite,
      recos: Array.isArray(result.recos) ? result.recos : [],
    }
  }
  return loginPortalMock(readDb().members, domestic, pw, sourceSite)
}
