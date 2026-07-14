import {
  LayoutDashboard,
  Users,
  CreditCard,
  TrendingUp,
  UserCheck,
  Megaphone,
  Headphones,
  Target,
  Ticket,
  ShieldCheck,
  ScrollText,
  BarChart3,
  Settings,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

export type { LucideIcon }

/** 13개 대분류 메뉴 ↔ lucide 아이콘 매핑 (원본 이모지 대체). */
export const navIcons = {
  dashboard: LayoutDashboard,
  members: Users,
  payments: CreditCard,
  revenue: TrendingUp,
  myCustomers: UserCheck,
  community: Megaphone,
  support: Headphones,
  lotto: Target,
  bets: Ticket,
  admins: ShieldCheck,
  logs: ScrollText,
  stats: BarChart3,
  settings: Settings,
  payroll: Wallet,
} satisfies Record<string, LucideIcon>
