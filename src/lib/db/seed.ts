// mock DB 시드 (DECISIONS D1). staff/팀/상품/템플릿 + 회원 ~160건과 보조
// payments/sms/assignments 를 결정적 PRNG 로 생성 → 26 세그먼트·필터·Drawer 가 실제로 채워짐.
// Phase 11 에서 대량/정교화. 시드 구조 변경 시 store.ts DB_VERSION 을 올린다.
import type {
  Assignment,
  Bet,
  CampaignEvent,
  Faq,
  Grade,
  Inquiry,
  LogEntry,
  LogKind,
  LottoRound,
  Member,
  MemberStatus,
  Notice,
  Payment,
  SiteSettings,
  SmsSend,
  Staff,
} from '@/types/db'
import { gradeRank, lottoSum, oddEven, prizeForRank } from '@/lib/lotto'
import { DEFAULT_NAV_ACCESS, type NavAccessMap } from '@/lib/permissions'
import type { DbShape } from './store'

// ── 결정적 PRNG (xorshift32) — 매 빌드 동일 분포 ──────────────────
function makeRng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0xffffffff
  }
}
type Rng = () => number
const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]
const intIn = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1))
function weighted<T>(rng: Rng, pairs: readonly (readonly [T, number])[]): T {
  const total = pairs.reduce((a, [, w]) => a + w, 0)
  let r = rng() * total
  for (const [v, w] of pairs) {
    if ((r -= w) <= 0) return v
  }
  return pairs[pairs.length - 1][0]
}
const isoOffset = (now: number, days: number, hours = 0) =>
  new Date(now - days * 864e5 - hours * 36e5).toISOString()
function isSameDayMs(aMs: number, bMs: number): boolean {
  const a = new Date(aMs)
  const b = new Date(bMs)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function shuffle<T>(rng: Rng, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '전', '홍']
const GIVEN = ['민준', '서연', '도윤', '하은', '시우', '지우', '주원', '지호', '하준', '예준', '수아', '지민', '유진', '현우', '준서', '지아', '은우', '다은', '시윤', '채원']
const TENDENCY = ['적극', '보통', '신중', '무응답'] as const
const MEMOS = ['상담 거부', '재콜 예정', '관심 높음', '가격 문의', '부재중', '번호 변경 요청']
// 유입경로(채널) — inflow_code
const INFLOW = [
  { code: 'NAVER' },
  { code: 'FB' },
  { code: 'KAKAO' },
  { code: 'TOSS' },
  { code: 'REF' },
  { code: 'BANNER' },
] as const

// 유입구분(콜 단계) — inflow_type. 현장 피드백(2026-06): 채널명이 아니라 콜 단계로 운영.
// features/members/views.ts 의 INFLOW_TYPES 와 동일 값(레이어 분리상 시드에 인라인).
const INFLOW_STAGE_W: readonly (readonly [string, number])[] = [
  ['신규', 26], ['하루전부재', 20], ['하루전거절', 16], ['이틀전', 14], ['삼일전', 12], ['구디비', 12],
]

// 상담상태(현장 피드백)
const CONSULT_W: readonly (readonly [string, number])[] = [
  ['신규', 30], ['부재', 16], ['가망', 14], ['통화예약', 10], ['결번', 8],
  ['승인', 8], ['일반거절', 7], ['도입거절', 5], ['기타', 2],
]

const GRADE_W: readonly (readonly [Grade, number])[] = [
  ['simple', 18], ['free', 34], ['gold', 14], ['goldp', 9], ['vip', 7], ['royal', 4], ['ovr', 3], ['toss', 11],
]
const STATUS_W: readonly (readonly [MemberStatus, number])[] = [
  ['active', 78], ['suspended', 7], ['deleted', 8], ['withdrawn', 7],
]
const ASSIGN_W: readonly (readonly [string | null, number])[] = [
  [null, 20], ['staff-rep1', 28], ['staff-rep2', 24], ['staff-leader1', 16], ['staff-manager', 12],
]
const STAFF_TEAM: Record<string, string> = {
  'staff-rep1': 'team-1',
  'staff-leader1': 'team-1',
  'staff-manager': 'team-1',
  'staff-rep2': 'team-2',
}
const PAID_PRODUCT: Partial<Record<Grade, string>> = {
  gold: 'prod-gold', goldp: 'prod-goldp', vip: 'prod-vip', royal: 'prod-royal',
}
const PRODUCT_PRICE: Record<string, number> = {
  'prod-gold': 33000, 'prod-goldp': 55000, 'prod-vip': 132000, 'prod-royal': 264000,
}

function genMembers(rng: Rng, now: number): Member[] {
  const N = 160
  const out: Member[] = []
  for (let i = 0; i < N; i++) {
    const status = weighted(rng, STATUS_W)
    const assigned = weighted(rng, ASSIGN_W)
    // 처음 8건은 오늘 가입, 그중 6건은 KAKAO 동일코드(중복유입 오늘) 시연용
    const isToday = i < 8
    const inflow = isToday && i < 6 ? INFLOW[2] : pick(rng, INFLOW)
    const regDays = isToday ? 0 : intIn(rng, 1, 60)
    const grade = inflow.code === 'TOSS' && rng() < 0.5 ? 'toss' : weighted(rng, GRADE_W)
    const hasMemo = rng() < 0.3
    const neverActive = rng() < 0.15
    const lastActiveDays = intIn(rng, 0, 55)
    const num = String(1000 + i)
    out.push({
      id: `m_${num}`,
      user_id: `pl${num}`,
      name: pick(rng, SURNAMES) + pick(rng, GIVEN),
      nickname: rng() < 0.5 ? `${pick(rng, GIVEN)}${intIn(rng, 1, 99)}` : null,
      phone: `010${intIn(rng, 2000, 9999)}${intIn(rng, 1000, 9999)}`,
      grade,
      status,
      tendency: rng() < 0.8 ? pick(rng, TENDENCY) : null,
      consult_status: isToday ? '신규' : weighted(rng, CONSULT_W),
      inflow_code: inflow.code,
      // 유입구분(콜 단계): 오늘 유입은 '신규', 과거 유입은 단계 분포.
      inflow_type: isToday ? '신규' : weighted(rng, INFLOW_STAGE_W),
      assigned_staff_id: assigned,
      team_id: assigned ? STAFF_TEAM[assigned] : null,
      memo: hasMemo ? pick(rng, MEMOS) : null,
      win_history: rng() < 0.06 ? `${pick(rng, ['3등', '4등', '5등'])} ${intIn(rng, 1, 3)}회` : null,
      outcall_done: rng() < 0.55,
      registered_at: isoOffset(now, regDays, isToday ? intIn(rng, 0, 8) : intIn(rng, 0, 23)),
      last_active_at: neverActive ? null : isoOffset(now, lastActiveDays, intIn(rng, 0, 23)),
      is_suspended: status === 'suspended',
      is_deleted: status === 'deleted',
      is_withdrawn: status === 'withdrawn',
      meta: {},
    })
  }
  return out
}

function genSupport(rng: Rng, members: Member[]) {
  const payments: Payment[] = []
  const assignments: Assignment[] = []
  const sms_sends: SmsSend[] = []
  let p = 0
  let a = 0
  let s = 0

  const nowMs = Date.now()
  for (const m of members) {
    const regMs = Date.parse(m.registered_at)
    // 배정 이력 — 오늘 유입 회원은 오늘 배정으로 기록(관리자 '금일 디비' 집계 시연용).
    if (m.assigned_staff_id) {
      const regIsToday = isSameDayMs(regMs, nowMs)
      assignments.push({
        id: `as_${++a}`,
        member_id: m.id,
        staff_id: m.assigned_staff_id,
        assigned_by: rng() < 0.5 ? 'staff-manager' : 'staff-admin',
        type: rng() < 0.7 ? 'manual' : 'auto',
        created_at: regIsToday
          ? m.registered_at
          : new Date(Math.min(regMs + intIn(rng, 0, 3) * 864e5, nowMs)).toISOString(),
      })
    }
    // 결제: 유료 등급은 승인 1건, 그 외 일부는 대기/실패로 변동
    const paidProduct = PAID_PRODUCT[m.grade]
    if (paidProduct) {
      const start = new Date(regMs + intIn(rng, 1, 10) * 864e5)
      payments.push({
        id: `pay_${++p}`,
        member_id: m.id,
        product_id: paidProduct,
        amount: PRODUCT_PRICE[paidProduct],
        method: weighted(rng, [['pg', 6], ['bank', 3], ['manual', 1]] as const),
        pg_provider: rng() < 0.6 ? pick(rng, ['웰컴페이먼츠', '페이허브', '플러스페이']) : null,
        status: 'approved',
        period_start: start.toISOString(),
        period_end: new Date(start.getTime() + 30 * 864e5).toISOString(),
        depositor_name: m.name,
        staff_id: m.assigned_staff_id,
        paid_at: start.toISOString(),
        created_at: start.toISOString(),
      })
    } else if (rng() < 0.16) {
      const created = new Date(regMs + intIn(rng, 1, 20) * 864e5)
      payments.push({
        id: `pay_${++p}`,
        member_id: m.id,
        product_id: 'prod-gold',
        amount: PRODUCT_PRICE['prod-gold'],
        method: weighted(rng, [['bank', 5], ['pg', 4], ['manual', 1]] as const),
        pg_provider: null,
        status: weighted(rng, [['wait', 5], ['failed', 3], ['cancelled', 2]] as const),
        period_start: null,
        period_end: null,
        depositor_name: m.name,
        staff_id: m.assigned_staff_id,
        paid_at: null,
        created_at: created.toISOString(),
      })
    }
    // 문자 발송 이력
    const smsCount = rng() < 0.4 ? intIn(rng, 1, 2) : 0
    for (let k = 0; k < smsCount; k++) {
      const isJoin = k === 0
      sms_sends.push({
        id: `sms_${++s}`,
        member_id: m.id,
        template_key: isJoin ? 'join' : 'recommend',
        phone: m.phone,
        body: isJoin
          ? `[플러스로또] ${m.name}님 가입을 환영합니다.`
          : `[플러스로또] ${m.name}님 이번 회차 추천번호 안내드립니다.`,
        type: isJoin ? 'join' : 'recommend',
        status: '발송완료',
        sent_at: new Date(regMs + (k + 1) * intIn(rng, 1, 5) * 864e5).toISOString(),
      })
    }
  }
  return { payments, assignments, sms_sends }
}

const ISSUERS = ['강남점', '종로점', '부산서면점', '대전둔산점', '광주충장점', '온라인'] as const

/** 당첨번호 6개(1..45 정렬·중복없음) + 보너스 1개. */
function drawNumbers(rng: Rng): { numbers: number[]; bonus: number } {
  const pool = Array.from({ length: 45 }, (_, i) => i + 1)
  shuffle(rng, pool)
  const seven = pool.slice(0, 7)
  return { numbers: seven.slice(0, 6).sort((a, b) => a - b), bonus: seven[6] }
}

/** 목표 등수(0=미당첨, 1..5=등수)가 나오도록 당첨번호와 공유 개수를 맞춘 베팅 6개. */
function buildBet(rng: Rng, win: number[], bonus: number, target: number): number[] {
  const others: number[] = []
  const winSet = new Set(win)
  for (let n = 1; n <= 45; n++) if (!winSet.has(n) && n !== bonus) others.push(n)
  shuffle(rng, others)
  let share: number
  let useBonus = false
  switch (target) {
    case 1: share = 6; break
    case 2: share = 5; useBonus = true; break
    case 3: share = 5; break
    case 4: share = 4; break
    case 5: share = 3; break
    default: share = intIn(rng, 0, 2); break // 미당첨: 0~2 일치
  }
  const w = [...win]
  shuffle(rng, w)
  const chosen = w.slice(0, share)
  if (useBonus) chosen.push(bonus)
  let oi = 0
  while (chosen.length < 6) chosen.push(others[oi++])
  return chosen.slice(0, 6).sort((a, b) => a - b)
}

const RANK_W: readonly (readonly [number, number])[] = [
  [0, 56], [5, 28], [4, 10], [3, 3], [2, 1.5], [1, 1],
]

/**
 * 로또 회차 16건(주간, 최신 1180회=2026-05-30) + 회차별 베팅 8~16건.
 * 최신 2회차는 '당첨 미확정'(confirmed_at=null, 베팅 등수/당첨금 null) — 확정 액션 시연용.
 * 확정 회차의 1~3등 당첨 베팅은 연결 회원의 win_history 에 반영(§8 당첨자 세그먼트).
 */
function genLotto(rng: Rng, members: Member[]): { rounds: LottoRound[]; bets: Bet[] } {
  const rounds: LottoRound[] = []
  const bets: Bet[] = []
  const ROUND_COUNT = 16
  const LATEST_NO = 1180
  const UNCONFIRMED = 2
  const latestDraw = Date.parse('2026-05-30T20:45:00+09:00')
  const memberById: Record<string, Member> = {}
  for (const m of members) memberById[m.id] = m
  let betSeq = 0

  for (let i = 0; i < ROUND_COUNT; i++) {
    const round_no = LATEST_NO - i
    const drawMs = latestDraw - i * 7 * 864e5
    const { numbers, bonus } = drawNumbers(rng)
    const unconfirmed = i < UNCONFIRMED
    const round: LottoRound = {
      round_no,
      draw_date: new Date(drawMs).toISOString(),
      numbers,
      bonus,
      sum: lottoSum(numbers),
      odd_even: oddEven(numbers),
      // TODO(live-verify): appear_rate 의미 미상 → '당첨번호 평균 출현율(%)' 로 가정.
      appear_rate: Math.round((58 + rng() * 18) * 10) / 10,
      prize_1: intIn(rng, 18, 28) * 100_000_000,
      prize_2: intIn(rng, 40, 75) * 1_000_000,
      prize_3: intIn(rng, 120, 170) * 10_000,
      total_sales: intIn(rng, 850, 1150) * 100_000_000,
      confirmed_at: unconfirmed ? null : new Date(drawMs + 36e5).toISOString(),
    }
    rounds.push(round)

    const betCount = intIn(rng, 8, 16)
    for (let b = 0; b < betCount; b++) {
      const target = weighted(rng, RANK_W)
      const betNumbers = buildBet(rng, numbers, bonus, target)
      const member = rng() < 0.7 ? pick(rng, members) : null
      const rank = unconfirmed ? null : gradeRank(betNumbers, numbers, bonus)
      const prize = unconfirmed ? null : prizeForRank(round, rank)
      bets.push({
        id: `bet_${++betSeq}`,
        round_no,
        issuer: pick(rng, ISSUERS),
        member_ref: member ? member.id : `EXT-${intIn(rng, 10000, 99999)}`,
        numbers: betNumbers,
        rank,
        prize,
      })
      // §8: 확정 회차의 1~3등 당첨자는 win_history 에 기록(당첨자 세그먼트와 정합).
      if (!unconfirmed && member && rank != null && rank <= 3) {
        member.win_history = `${round_no}회 ${rank}등`
      }
    }
  }
  return { rounds, bets }
}

// ── 커뮤니티(공지·이벤트) · 고객센터(문의·FAQ) 시드 ────────────────────
// TODO(live-verify): 02 커뮤니티 / 03 고객센터 원본 구조 미확인 — 합리적 게시판 패턴으로 구성(ASSUMPTIONS).
const NOTICE_SEED: readonly (readonly [string, string, boolean])[] = [
  ['서비스 점검 안내 (6/8 02:00~04:00)', '서버 안정화를 위한 정기 점검이 진행됩니다. 점검 시간 동안 번호 발송이 일시 중단됩니다.', true],
  ['개인정보 처리방침 개정 안내', '개인정보 처리방침이 2026년 6월 1일자로 개정되었습니다. 자세한 내용은 약관에서 확인해 주세요.', true],
  ['추천번호 발송 시간 변경 안내', '매주 추천번호 발송 시간이 추첨 3일 전 오전 10시로 변경됩니다.', false],
  ['고객센터 운영시간 안내', '평일 09:00~18:00 운영하며, 주말·공휴일은 휴무입니다.', false],
  ['결제수단 추가 안내 (토스페이)', '간편결제에 토스페이가 추가되었습니다.', false],
  ['앱 업데이트 안내 v2.4', '당첨 알림 푸시 기능이 추가되었습니다.', false],
]
const EVENT_SEED: readonly (readonly [string, string, number, number])[] = [
  ['신규 가입 첫 달 50% 할인', '6월 한 달간 신규 가입 회원에게 첫 결제 50% 할인 혜택을 드립니다.', -3, 27],
  ['친구 추천 이벤트', '친구 추천 시 추천인·피추천인 모두에게 7일 이용권을 드립니다.', -10, 20],
  ['VIP 전환 사은품 증정', '이번 달 VIP 이상 전환 시 사은품을 증정합니다.', -1, 14],
  ['여름맞이 로얄 패키지 특가', '로얄 6개월 패키지를 한정 특가로 제공합니다.', 2, 32],
  ['지난달 당첨자 후기 이벤트(종료)', '후기 작성 시 추첨을 통해 경품을 드렸습니다.', -40, -10],
]
const FAQ_SEED: readonly (readonly [string, string, string])[] = [
  ['결제', '결제 후 등급이 바로 반영되나요?', '결제 승인 즉시 등급이 상향되며, 무통장입금은 입금 확인 후 반영됩니다.'],
  ['결제', '결제 취소·환불은 어떻게 하나요?', '고객센터 1:1 문의로 신청하시면 결제 정책에 따라 처리해 드립니다.'],
  ['번호', '추천번호는 언제 발송되나요?', '매 회차 추첨 3일 전에 등록하신 번호로 발송됩니다.'],
  ['번호', '추천번호를 못 받았어요.', '스팸 차단 여부를 확인하시고, 계속 수신되지 않으면 문의해 주세요.'],
  ['계정', '비밀번호를 잊어버렸어요.', '로그인 화면의 비밀번호 찾기를 이용하거나 고객센터로 문의해 주세요.'],
  ['계정', '휴대폰 번호를 변경하고 싶어요.', '본인 확인 후 변경 가능합니다. 고객센터로 문의해 주세요.'],
  ['기타', '이용권 기간은 어떻게 확인하나요?', '마이페이지 또는 회원 상세에서 이용 기간을 확인할 수 있습니다.'],
  ['기타', '당첨 시 안내를 받을 수 있나요?', '당첨 확정 시 등록된 번호로 당첨 안내 문자가 발송됩니다.'],
]
const INQUIRY_CATS = ['결제', '번호', '계정', '기타'] as const
const INQUIRY_TITLES: Record<string, readonly [string, string]> = {
  결제: ['결제했는데 등급이 안 올라갔어요', '카드 결제 승인이 났는데도 무료 등급으로 표시됩니다. 확인 부탁드립니다.'],
  번호: ['추천번호 문자를 못 받았습니다', '이번 회차 추천번호 문자가 오지 않았어요. 재발송 가능할까요?'],
  계정: ['로그인이 안 됩니다', '비밀번호를 맞게 입력했는데 로그인이 되지 않습니다.'],
  기타: ['이용권 기간 문의', '제 이용권이 언제까지인지 알고 싶습니다.'],
}

function genContent(
  rng: Rng,
  now: number,
  members: Member[],
): { notices: Notice[]; events: CampaignEvent[]; inquiries: Inquiry[]; faqs: Faq[] } {
  const notices: Notice[] = NOTICE_SEED.map(([title, body, pinned], i) => {
    const created = isoOffset(now, intIn(rng, 0, 40), intIn(rng, 0, 23))
    return {
      id: `ntc_${i + 1}`,
      title,
      body,
      pinned,
      published: i !== NOTICE_SEED.length - 1 ? true : false, // 마지막 1건은 임시저장 시연
      author_id: rng() < 0.5 ? 'staff-admin' : 'staff-manager',
      view_count: intIn(rng, 30, 1200),
      created_at: created,
      updated_at: created,
    }
  })

  const events: CampaignEvent[] = EVENT_SEED.map(([title, body, startOff, endOff], i) => {
    const created = isoOffset(now, Math.max(0, -startOff) + intIn(rng, 0, 3))
    return {
      id: `evt_${i + 1}`,
      title,
      body,
      starts_at: new Date(now + startOff * 864e5).toISOString(),
      ends_at: new Date(now + endOff * 864e5).toISOString(),
      published: true,
      author_id: 'staff-manager',
      view_count: intIn(rng, 50, 2000),
      created_at: created,
      updated_at: created,
    }
  })

  // 1:1 문의 14건 — 약 절반은 답변완료. 회원 연결 70%.
  const inquiries: Inquiry[] = []
  for (let i = 0; i < 14; i++) {
    const cat = pick(rng, INQUIRY_CATS)
    const [title, body] = INQUIRY_TITLES[cat]
    const linked = rng() < 0.7 ? pick(rng, members) : null
    const createdMs = now - intIn(rng, 0, 25) * 864e5 - intIn(rng, 0, 23) * 36e5
    const answered = rng() < 0.5
    inquiries.push({
      id: `inq_${i + 1}`,
      member_id: linked?.id ?? null,
      author_name: linked?.name ?? `비회원${intIn(rng, 100, 999)}`,
      category: cat,
      title,
      body,
      status: answered ? 'answered' : 'open',
      answer: answered ? '확인 후 처리해 드렸습니다. 추가 문의사항 있으시면 회신 부탁드립니다.' : null,
      answered_by: answered ? pick(rng, ['staff-rep1', 'staff-rep2', 'staff-manager']) : null,
      answered_at: answered ? new Date(createdMs + intIn(rng, 1, 24) * 36e5).toISOString() : null,
      created_at: new Date(createdMs).toISOString(),
    })
  }
  inquiries.sort((a, b) => b.created_at.localeCompare(a.created_at))

  const faqs: Faq[] = FAQ_SEED.map(([category, question, answer], i) => ({
    id: `faq_${i + 1}`,
    category,
    question,
    answer,
    sort_order: i,
    published: true,
  }))

  return { notices, events, inquiries, faqs }
}

// ── 로그 5종 시드 (§8 액션이 자동 생성하는 레코드의 과거분) ──────────────
// admin / payment / sms / inflow / point. actor·target 은 실제 staff/member/payment/sms id 를 참조.
// TODO(live-verify): point(포인트 적립/차감) 시스템 존재 여부 미확인 — 표준 적립/차감 로그로 시연(ASSUMPTIONS).
const ADMIN_ACTORS = ['staff-admin', 'staff-manager'] as const
const ALL_ACTORS = ['staff-admin', 'staff-manager', 'staff-leader1', 'staff-rep1', 'staff-rep2'] as const

function genLogs(
  rng: Rng,
  now: number,
  src: { staff: Staff[]; members: Member[]; payments: Payment[]; sms_sends: SmsSend[] },
): LogEntry[] {
  const { staff, members, payments, sms_sends } = src
  const out: LogEntry[] = []
  let n = 0
  const push = (
    kind: LogKind,
    actor: string | null,
    action: string,
    target_type: string | null,
    target_id: string | null,
    meta: Record<string, unknown>,
    daysAgo: number,
  ) => {
    out.push({
      id: `log_seed_${++n}`,
      kind,
      actor,
      action,
      target_type,
      target_id,
      meta,
      created_at: isoOffset(now, daysAgo, intIn(rng, 0, 23)),
    })
  }

  // admin: 로그인(staff 별 1건) + 회원 변경/배정/상태 + 계정/권한
  for (const s of staff) push('admin', s.id, 'auth.login', 'staff', s.id, { role: s.role }, intIn(rng, 0, 6))
  for (let i = 0; i < 12; i++) {
    const m = pick(rng, members)
    const actor = pick(rng, ADMIN_ACTORS)
    const which = weighted(rng, [['update', 4], ['assign', 3], ['status', 3]] as const)
    if (which === 'assign') {
      push('admin', actor, 'member.assign', 'member', m.id, { staff_id: m.assigned_staff_id ?? pick(rng, ['staff-rep1', 'staff-rep2']) }, intIn(rng, 0, 25))
    } else if (which === 'status') {
      push('admin', actor, 'member.status', 'member', m.id, { from: 'active', to: pick(rng, ['suspended', 'active', 'withdrawn']) }, intIn(rng, 0, 25))
    } else {
      push('admin', actor, 'member.update', 'member', m.id, { field: pick(rng, ['memo', 'tendency', 'grade']) }, intIn(rng, 0, 25))
    }
  }
  push('admin', 'staff-admin', 'staff.update', 'staff', 'staff-rep2', { field: 'team_id', to: 'team-2' }, intIn(rng, 5, 20))
  push('admin', 'staff-admin', 'roles.update', 'nav_access', null, { module: 'revenue', roles: ['admin', 'manager', 'leader'] }, intIn(rng, 10, 28))

  // payment: 승인/취소 (실제 payment id 참조)
  const approved = payments.filter((p) => p.status === 'approved')
  const cancelled = payments.filter((p) => p.status === 'cancelled')
  for (let i = 0; i < Math.min(14, approved.length); i++) {
    const p = approved[intIn(rng, 0, approved.length - 1)]
    push('payment', p.staff_id ?? pick(rng, ADMIN_ACTORS), 'payment.approve', 'payment', p.id, { amount: p.amount, member_id: p.member_id, method: p.method }, intIn(rng, 0, 25))
  }
  for (const p of cancelled.slice(0, 6)) {
    push('payment', pick(rng, ADMIN_ACTORS), 'payment.cancel', 'payment', p.id, { amount: p.amount, member_id: p.member_id, reason: 'PG취소' }, intIn(rng, 0, 20))
  }

  // sms: 발송 (실제 sms_send 의 member/template 참조)
  for (let i = 0; i < Math.min(12, sms_sends.length); i++) {
    const sm = sms_sends[intIn(rng, 0, sms_sends.length - 1)]
    push('sms', pick(rng, ALL_ACTORS), 'sms.send', 'member', sm.member_id, { template_key: sm.template_key, type: sm.type }, intIn(rng, 0, 20))
  }

  // inflow: 유입분류 변경
  for (let i = 0; i < 8; i++) {
    const m = pick(rng, members)
    push('inflow', pick(rng, ADMIN_ACTORS), 'inflow.update', 'member', m.id, { from: m.inflow_type, to: pick(rng, ['신규', '하루전부재', '하루전거절', '이틀전', '삼일전']) }, intIn(rng, 0, 25))
  }

  // point: 적립/차감 (시스템 자동 적립은 actor=null)
  for (let i = 0; i < 10; i++) {
    const m = pick(rng, members)
    const grant = rng() < 0.6
    const actor = grant && rng() < 0.5 ? null : pick(rng, ADMIN_ACTORS)
    push('point', actor, grant ? 'point.grant' : 'point.deduct', 'member', m.id, {
      amount: intIn(rng, 1, 50) * 100,
      reason: grant ? pick(rng, ['가입축하', '이벤트', '추천보상']) : pick(rng, ['사용', '회수']),
    }, intIn(rng, 0, 28))
  }

  out.sort((a, b) => b.created_at.localeCompare(a.created_at))
  return out
}

// ── 설정 기본값 (site_settings) ───────────────────────────────────────
// 등급색 기본값은 tokens.css :root 의 --g-* 와 동일 → 변경 전까지 시각 차이 없음.
// PG api_key / SMTNT 키는 데모용 가짜값(시크릿 아님) — UI 에서 마스킹 시연. TODO(live-verify).
function buildSiteSettings(): SiteSettings {
  return {
    bank: {
      bank_name: '국민은행',
      account_no: '12345601234567',
      holder: '(주)플러스로또',
      guide: '입금자명을 주문자명과 동일하게 입력해 주세요. 미입금 시 24시간 후 자동 취소됩니다.',
    },
    business: {
      name: '(주)플러스로또',
      reg_no: '000-00-00000',
      address: '서울특별시 강남구 테헤란로 000',
      support_phone: '1660-0681',
    },
    winner_stats: {
      enabled: true,
      current: {
        round_no: 1180,
        rank1: 2,
        rank2: 11,
        rank3: 187,
        rank4: 4230,
        rank5: 51840,
        updated_at: '2026-05-31T00:00:00.000Z',
      },
    },
    grade_colors: {
      free: { fg: '#94a3b8', bg: '#eef1f5' },
      simple: { fg: '#64748b', bg: '#eaedf2' },
      gold: { fg: '#c99700', bg: '#fbf2d2' },
      goldp: { fg: '#b45309', bg: '#fbebd9' },
      vip: { fg: '#0f9d6b', bg: '#e3f6ee' },
      royal: { fg: '#7c3aed', bg: '#f1eafe' },
      ovr: { fg: '#0f1420', bg: '#e5e7eb' },
      toss: { fg: '#0ea5e9', bg: '#e4f4fd' },
    },
    pg_providers: [
      { id: 'pg_welcome', name: '웰컴페이먼츠', enabled: true, mid: 'welcome_pllotto', api_key: 'wc_live_8f3a2b1c9d7e4a6b', tids: ['TID0012345678'], memo: null },
      { id: 'pg_payhub', name: '페이허브', enabled: true, mid: 'payhub_pllotto', api_key: 'ph_live_4c6d8e2f1a3b5c7d', tids: ['PH99001122'], memo: null },
      { id: 'pg_pluspay', name: '플러스페이', enabled: true, mid: 'pluspay_main', api_key: 'pp_live_1a2b3c4d5e6f7a8b', tids: ['PP10000001'], memo: null },
      { id: 'pg_kovan', name: '코밴', enabled: false, mid: 'kovan_pllotto', api_key: 'kv_live_7d9e1f3a5b2c4d6e', tids: ['KOVAN0001'], memo: '백업 채널' },
      { id: 'pg_onmir', name: '온미르', enabled: true, mid: 'onmir_pllotto', api_key: 'om_live_2b4d6f8a0c1e3f5a', tids: ['OM-TID-001', 'OM-TID-002', 'OM-TID-003'], memo: 'TID 다수 운영' },
      { id: 'pg_hivep', name: '하이브플러스', enabled: false, mid: 'hivep_pllotto', api_key: 'hv_live_9c8b7a6d5e4f3a2b', tids: ['HIVE000123'], memo: null },
    ],
    sms: {
      sender_no: '1588-0000',
      smtnt_id: 'lotto_dream_api',
      smtnt_key: '',
      oneshot_enabled: false,
      ad_optout: '',
    },
    win_messages: [
      { rank: 1, body: '[플러스로또] 축하합니다! $name님 $contents 1등에 당첨되셨습니다. 자세한 안내는 고객센터로 연락드리겠습니다.' },
      { rank: 2, body: '[플러스로또] 축하합니다! $name님 $contents 2등에 당첨되셨습니다.' },
      { rank: 3, body: '[플러스로또] 축하합니다! $name님 $contents 3등에 당첨되셨습니다.' },
      { rank: 4, body: '[플러스로또] $name님 $contents 4등에 당첨되셨습니다. 축하드립니다.' },
      { rank: 5, body: '[플러스로또] $name님 $contents 5등에 당첨되셨습니다. 축하드립니다.' },
    ],
    // 당첨 안내문자 자동발송(현장 7/28) — 실제 고객에게 나가는 문자라 기본은 꺼짐, 설정에서 켠다.
    win_sms: { enabled: false, ranks: [1, 2, 3, 4, 5], paid: true, free: false },
    // 가입환영문자 자동발송(현장 7/28) — 실제 고객에게 나가는 문자라 기본은 꺼짐, 설정에서 켠다.
    join_sms_auto: false,
    // 자동배분 라운드로빈 커서(현장 7/28) — 아직 아무도 배정 안 함.
    auto_assign_cursor: null,
    report: {
      enabled: true,
      frequency: 'weekly',
      weekday: 1, // 월요일
      day_of_month: 1,
      time: '09:00',
      recipients: ['ops@pluslotto.co.kr'],
      sections: ['revenue', 'signup', 'payment'],
    },
    lotto_exclude: { fixed: [7], excluded: [13, 40] },
    lotto_exclude_history: [
      { id: 'lxr_1179', round_no: 1179, grade: null, fixed: [3], excluded: [11, 28], effective_from: '2026-05-18', created_at: '2026-05-16T02:00:00.000Z', created_by: 'staff-admin' },
      { id: 'lxr_1180', round_no: 1180, grade: null, fixed: [7], excluded: [13, 40], effective_from: '2026-05-25', created_at: '2026-05-23T02:00:00.000Z', created_by: 'staff-admin' },
      // 등급별 규칙 시연(VIP): 공통과 다른 고정/제외
      { id: 'lxr_1180_vip', round_no: 1180, grade: 'vip', fixed: [17], excluded: [1, 45], effective_from: '2026-05-25', created_at: '2026-05-23T02:05:00.000Z', created_by: 'staff-admin' },
    ],
    weekly_free_reco: { enabled: true, set_count: 30, logic_ratio: 100 },
    terms: [
      '제1조 (목적)',
      '본 약관은 플러스로또(이하 "회사")가 제공하는 로또 번호 추천 서비스(이하 "서비스")의 이용과 관련하여 회사와 회원 간의 권리·의무 및 책임사항을 규정함을 목적으로 합니다.',
      '',
      '제2조 (정의)',
      '1. "회원"이란 본 약관에 동의하고 서비스 이용 자격을 부여받은 자를 말합니다.',
      '2. "유료 서비스"란 회사가 유료로 제공하는 번호 추천 및 부가 서비스를 말합니다.',
      '',
      '제3조 (서비스의 제공)',
      '회사는 회원에게 회차별 번호 추천, 당첨 안내 등 서비스를 제공합니다. 추천 결과는 당첨을 보장하지 않습니다.',
      '',
      '제4조 (결제 및 환불)',
      '유료 서비스의 결제·환불은 관련 법령 및 회사의 환불 정책에 따릅니다.',
    ].join('\n'),
  }
}

/** 기본 권한 매트릭스를 깊은 복제(편집 가능한 DB 초기값). */
function cloneNavAccess(): NavAccessMap {
  const out: NavAccessMap = {}
  for (const k of Object.keys(DEFAULT_NAV_ACCESS) as (keyof typeof DEFAULT_NAV_ACCESS)[]) {
    out[k] = [...DEFAULT_NAV_ACCESS[k]]
  }
  return out
}

/** 매 호출마다 새 배열을 반환해 시드 객체를 공유하지 않는다. */
export function buildSeed(): DbShape {
  const rng = makeRng(20260601)
  const now = Date.now()
  const members = genMembers(rng, now)
  const { payments, assignments, sms_sends } = genSupport(rng, members)
  const { rounds: lotto_rounds, bets } = genLotto(rng, members)
  const { notices, events, inquiries, faqs } = genContent(rng, now, members)
  const staff: Staff[] = [
    { id: 'staff-admin', login_id: 'admin01', name: '관리자', role: 'admin', team_id: null, is_active: true, auto_assign_enabled: false, last_login_at: isoOffset(now, 0, 2) },
    { id: 'staff-manager', login_id: 'two001', name: '실장 김', role: 'manager', team_id: 'team-1', is_active: true, auto_assign_enabled: false, last_login_at: isoOffset(now, 0, 5) },
    { id: 'staff-leader1', login_id: 'leader01', name: '팀장 이', role: 'leader', team_id: 'team-1', is_active: true, auto_assign_enabled: false, last_login_at: isoOffset(now, 1, 3) },
    { id: 'staff-rep1', login_id: 'rep01', name: '담당 박', role: 'rep', team_id: 'team-1', is_active: true, auto_assign_enabled: true, last_login_at: isoOffset(now, 0, 8) },
    { id: 'staff-rep2', login_id: 'rep02', name: '담당 최', role: 'rep', team_id: 'team-2', is_active: true, auto_assign_enabled: true, last_login_at: isoOffset(now, 2, 1) },
  ]
  const logs = genLogs(rng, now, { staff, members, payments, sms_sends })
  logs.push(
    {
      id: 'log_winner_1180',
      kind: 'admin',
      actor: 'staff-admin',
      action: 'settings.winner_stats.upsert',
      target_type: 'winner_stats',
      target_id: '1180',
      meta: {
        winner_stats: { round_no: 1180, rank1: 2, rank2: 11, rank3: 187, rank4: 4230, rank5: 51840, updated_at: '2026-05-31T00:00:00.000Z' },
      },
      created_at: '2026-05-31T00:00:00.000Z',
    },
    {
      id: 'log_winner_1179',
      kind: 'admin',
      actor: 'staff-admin',
      action: 'settings.winner_stats.upsert',
      target_type: 'winner_stats',
      target_id: '1179',
      meta: {
        winner_stats: { round_no: 1179, rank1: 1, rank2: 8, rank3: 164, rank4: 3982, rank5: 50120, updated_at: '2026-05-24T00:00:00.000Z' },
      },
      created_at: '2026-05-24T00:00:00.000Z',
    },
  )

  return {
    teams: [
      { id: 'team-1', name: '1팀', leader_id: 'staff-leader1' },
      // TODO(live-verify): 팀 구성/팀장 매핑은 실제 운영 데이터로 확정.
      { id: 'team-2', name: '2팀', leader_id: null },
    ],
    staff,
    products: [
      { id: 'prod-gold', name: '골드 1개월', price: 33000, duration_months: 1, grade_granted: 'gold', is_active: true },
      // 상품명 = 실사용 고객 홈페이지 등급명(현장 피드백 7/21) — goldp→실버·vip→골드·royal→다이아.
      { id: 'prod-goldp', name: '실버', price: 55000, duration_months: 1, grade_granted: 'goldp', is_active: true },
      { id: 'prod-vip', name: '골드', price: 132000, duration_months: 3, grade_granted: 'vip', is_active: true },
      { id: 'prod-royal', name: '다이아', price: 264000, duration_months: 6, grade_granted: 'royal', is_active: true },
    ],
    sms_templates: [
      { key: 'join', title: '가입 환영', body: '[플러스로또] $name님 가입을 환영합니다. 아이디: $id / 임시비밀번호: $pw', category: 'join' },
      { key: 'recommend', title: '추천번호 안내', body: '[플러스로또] $name님 이번 회차 추천번호: $num', category: 'recommend' },
      { key: 'win', title: '당첨 안내', body: '[플러스로또] $name님 $contents', category: 'win' },
      // 약관 안내(현장 피드백 7/22) — 전문 대신 회원 등급의 공개 약관 페이지 링크 발송.
      { key: 'terms', title: '약관 안내', body: '[플러스로또] $name님, 가입하신 등급의 이용약관을 확인해 주세요.\n$link', category: 'terms' },
    ],
    members,
    payments,
    sms_sends,
    assignments,
    lotto_rounds,
    bets,
    logs,
    notices,
    events,
    inquiries,
    faqs,
    nav_access: cloneNavAccess(),
    site_settings: buildSiteSettings(),
  }
}
