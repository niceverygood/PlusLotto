import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const forced = import.meta.env.VITE_DATA_SOURCE as 'mock' | 'supabase' | undefined

export const isSupabaseConfigured = Boolean(url && anonKey)

/**
 * 데이터 소스 결정 (DECISIONS D1):
 * - VITE_DATA_SOURCE 가 있으면 그 값을 강제 사용
 * - 없으면 Supabase 자격증명 유무로 자동 판단
 */
export const dataSource: 'mock' | 'supabase' =
  forced ?? (isSupabaseConfigured ? 'supabase' : 'mock')

// TODO(live-verify): supabase gen types → createClient<Database> 제네릭 적용
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string)
  : null
