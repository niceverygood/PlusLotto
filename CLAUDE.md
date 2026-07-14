# 플러스로또 ADMIN — CLAUDE.md

> 이 파일은 매 세션 시작 시 반드시 읽는다. 모든 결정의 단일 기준(Source of Truth)이다.
> 시각 스타일가이드 원본: `docs/pluslotto_admin_spec.html` (컬러·컴포넌트가 렌더된 살아있는 문서).
> 이 프로젝트는 [`88lotto`](../88lotto) 코드베이스에서 포크된 브랜드 형제 프로젝트다 — 같은 아키텍처를
> `src/lib/brand.ts`(VITE_BRAND) 멀티테넌트 구조로 공유하되, Supabase·Vercel·도메인·SMS 발신 계정은 완전히
> 분리한다(88lotto의 실 운영 데이터와 절대 공유하지 않음). 두 프로젝트를 함께 바꿔야 하는 변경(예: 공용
> 컴포넌트 버그 수정)은 양쪽에 각각 반영한다.

---

## 0. 프로젝트 개요

**플러스로또 운영 콘솔** — 로또 번호 추천 서비스를 운영하는 **아웃바운드 텔레마케팅 CRM 백오피스**.
일반 사용자 프론트가 아니라 **내부 운영툴**이다. 약 15만 명 규모 회원 DB를 다룬다.

기존 「일행로또」 백오피스(스크린샷 56장)를 역설계해 **기능은 100% 보존**하고 **UX/UI만 직관적으로 재설계**한다.

### 핵심 운영 흐름 (모든 기능은 이 흐름을 중심으로 유기적으로 연동된다)
```
유입(유입코드/분류) → 담당 배정(수동/자동할당) → 아웃콜(미아웃콜 관리)
 → 전환(무료→유료등급) → 결제(다중 PG) → 번호발송(SMS 스케줄) → 매출 귀속(담당/팀장)
```

### 13개 대분류 (전부 구현 대상)
1. 메인(대시보드·신규) · 2. 커뮤니티 · 3. 고객센터 · 4. 나의고객 · 5. **이용자(26 세그먼트·핵심)**
6. 결제 · 7. 매출 · 8. 관리자/권한 · 9. 로그(5종) · 10. 통계 · 11. 로또기록 · 12. 베팅 · 13. 설정

---

## 1. 기술 스택 (확정)

| 영역 | 선택 | 비고 |
|---|---|---|
| 빌드 | **Vite + React 18 + TypeScript** | strict 모드 |
| 스타일 | **Tailwind CSS** | 토큰은 §3, 임의 hex 금지 |
| 라우팅 | **React Router v6** | 역할 가드 포함 |
| 서버 상태 | **TanStack Query v5** | 모든 데이터 fetch/캐시/뮤테이션 |
| 테이블 | **TanStack Table v8** | DataTable 엔진(정렬·컬럼토글·선택) |
| 백엔드 | **Supabase** | Auth + Postgres + RLS + Storage |
| 폼 | **react-hook-form + zod** | 설정/편집 화면 |
| 차트 | **recharts** | 통계/대시보드 |
| 날짜 | **date-fns** + ko locale | |
| 아이콘 | **lucide-react** | 원본 이모지 대체 |
| 경량 UI 상태 | **zustand** | 사이드바 접힘·테이블 밀도·필터 drawer |
| 폰트 | **Pretendard** | 숫자 tabular-nums |
| 배포 | **Vercel** | env는 Supabase URL/anon key |

원칙: **서버 상태는 전부 TanStack Query**, 클라이언트 UI 상태만 zustand. 컴포넌트에서 직접 fetch 금지 → `features/*/api.ts` 훅으로만.

---

## 2. 폴더 구조

```
src/
├─ app/
│  ├─ routes.tsx            # 라우트 정의 + 역할 가드
│  ├─ providers.tsx         # QueryClient, Supabase, Theme, Router
│  └─ AppShell.tsx          # 사이드바 + 상단바 + <Outlet/>
├─ design-system/
│  ├─ tokens.css            # CSS 변수 (§3 그대로)
│  ├─ components/           # Button Badge StatusChip DataTable FilterBar
│  │                        #   KpiCard Drawer Modal Tabs Pagination EmptyState ...
│  └─ icons.ts              # lucide 매핑
├─ features/
│  ├─ members/              # 이용자 (★ 수직 슬라이스 기준)
│  │  ├─ api.ts             # useMembers, useMember, useUpdateMember, useBulk...
│  │  ├─ views.ts           # 26개 세그먼트 = 필터 프리셋 배열
│  │  ├─ columns.tsx        # 컬럼 정의 + 역할별 프리셋
│  │  ├─ MembersPage.tsx
│  │  ├─ MemberDrawer.tsx   # 상세/편집 + 결제·문자·배정 히스토리 탭
│  │  └─ bulk.ts            # 상태/담당/유입분류 일괄 + 자동할당/리셋
│  ├─ payments/  revenue/  community/  support/  myCustomers/
│  ├─ admins/    logs/      stats/   lotto/   bets/   settings/
│  └─ dashboard/
├─ lib/
│  ├─ supabase.ts           # client + Database 타입
│  ├─ auth.ts               # 세션·역할 훅 (useRole)
│  ├─ format.ts             # krw() phone() datetime() (tabular)
│  └─ rls/policies.sql      # RLS 정책 (참조/마이그레이션)
├─ types/db.ts              # Supabase 생성 타입
└─ main.tsx
docs/
├─ pluslotto_admin_spec.html
├─ ASSUMPTIONS.md           # 미확인 화면 추정 결정 로그 (필수 유지)
└─ DECISIONS.md             # 설계 결정 기록
```

**규칙**: feature 간 직접 import 금지. 공유는 `design-system/` 또는 `lib/`를 경유. 교차 데이터는 §8 흐름대로 쿼리 키를 공유/무효화.

---

## 3. 디자인 시스템 (토큰 — 임의 색·폰트 금지)

### 3.1 `design-system/tokens.css`
```css
:root{
  /* Ink / Brand */
  --ink-900:#0B1530; --ink-800:#101D3D; --ink-700:#182A52; --ink-600:#243A66; --ink-500:#34507F;
  /* Primary (action/link/active) */
  --primary-700:#1E47B0; --primary-600:#2756D6; --primary-500:#3D6EEC; --primary-100:#DCE6FF; --primary-50:#EEF3FF;
  /* Accent (능동 신호: 문자/아웃콜) */
  --accent-600:#D97706; --accent-500:#F59E0B; --accent-100:#FDECC8; --accent-50:#FFF7E6;
  /* Semantic */
  --success:#16A34A; --success-bg:#E7F6EE; --success-bd:#BCE6CC;
  --warning:#D97706; --warning-bg:#FEF3E2; --warning-bd:#FAD9A6;
  --danger:#DC2626;  --danger-bg:#FCEBEB;  --danger-bd:#F4C2C2;
  --info:#0EA5E9;    --info-bg:#E6F6FE;    --info-bd:#B8E6FA;
  /* Neutral */
  --gray-50:#F7F8FA; --gray-100:#EDF0F4; --gray-200:#E1E6EC; --gray-300:#CCD3DD; --gray-400:#99A3B2;
  --gray-500:#6B7585; --gray-600:#4B5565; --gray-700:#343C49; --gray-800:#212732; --gray-900:#0F1420;
  /* Membership grade (직관적 의미로 재정의) */
  --g-simple:#64748B; --g-free:#94A3B8; --g-gold:#C99700; --g-goldp:#B45309;
  --g-vip:#0F9D6B; --g-royal:#7C3AED; --g-ovr:#0F1420; --g-toss:#0EA5E9;
  /* Layout */
  --radius-sm:6px; --radius-md:8px; --radius-lg:12px; --radius-full:999px;
  --sb-w:248px; --topbar-h:56px; --row-comfortable:44px; --row-compact:36px;
  --shadow-sm:0 1px 2px rgba(15,20,32,.06); --shadow-md:0 4px 14px rgba(15,20,32,.08); --shadow-lg:0 16px 40px rgba(15,20,32,.14);
}
```

### 3.2 `tailwind.config.ts` (토큰 → 유틸 매핑)
```ts
import type { Config } from 'tailwindcss'
const config: Config = {
  content: ['./index.html','./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink:{900:'#0B1530',800:'#101D3D',700:'#182A52',600:'#243A66',500:'#34507F'},
        primary:{700:'#1E47B0',600:'#2756D6',500:'#3D6EEC',100:'#DCE6FF',50:'#EEF3FF'},
        accent:{600:'#D97706',500:'#F59E0B',100:'#FDECC8',50:'#FFF7E6'},
        success:'#16A34A', warning:'#D97706', danger:'#DC2626', info:'#0EA5E9',
        gray:{50:'#F7F8FA',100:'#EDF0F4',200:'#E1E6EC',300:'#CCD3DD',400:'#99A3B2',500:'#6B7585',600:'#4B5565',700:'#343C49',800:'#212732',900:'#0F1420'},
        grade:{simple:'#64748B',free:'#94A3B8',gold:'#C99700',goldp:'#B45309',vip:'#0F9D6B',royal:'#7C3AED',ovr:'#0F1420',toss:'#0EA5E9'},
      },
      fontFamily:{ sans:['Pretendard Variable','Pretendard','system-ui','sans-serif'], mono:['JetBrains Mono','ui-monospace','monospace'] },
      borderRadius:{ sm:'6px', DEFAULT:'8px', lg:'12px' },
      boxShadow:{ sm:'0 1px 2px rgba(15,20,32,.06)', md:'0 4px 14px rgba(15,20,32,.08)', lg:'0 16px 40px rgba(15,20,32,.14)' },
    },
  },
  plugins: [],
}
export default config
```

### 3.3 타이포 규칙
- 본문 **14px**(원본 8~9px 가독성 문제 해소). 테이블 셀 12~13px.
- 금액·전화·ID·일시는 **`font-mono` + `tabular-nums`** 로 자리 정렬, 금액/번호는 **우측 정렬**.
- 페이지 제목 28~30/800, 섹션 22~23/800, 카드 16~17/700.

### 3.4 등급/상태 토큰 매핑 (라벨 + 도트, 색약 대응)
| 등급 | 색 토큰 | 상태 | 색 토큰 |
|---|---|---|---|
| 간편가입 `grade-simple` / 무료 `grade-free` | 슬레이트/그레이 | 정상·승인 | success |
| 골드 `grade-gold` / 골드플러스 `grade-goldp` | 금색/브론즈 | 대기 | warning |
| VIP `grade-vip` / 로얄 `grade-royal` | 에메랄드/보라 | 실패 | danger |
| 인반언스* `grade-ovr` / 토스DB `grade-toss` | 옵시디언/시안 | 취소 | gray |
| | | 정지 | danger(muted) |

> `*` 인반언스 명칭/의미는 미확인 → `ASSUMPTIONS.md`에 기록하고 라이브 확인 대상.
> **결정 보류**: 원본 등급색은 임의(골드=청록)였음. 본 시스템은 직관적 색으로 재정의. 운영진 익숙도 따라 추후 변경 가능하도록 토큰 한 곳에서만 정의할 것.

---

## 4. 데이터 모델 (Supabase — 역설계 추정, 라이브로 확정)

> 컬럼/관계는 추정. 확정 전까지 nullable 관대하게, 모르는 필드는 `meta jsonb`로 흡수. 변경 시 `DECISIONS.md` 갱신.

```
members      회원   id, user_id, name, nickname, phone, grade(enum), status(enum),
                    tendency, inflow_code, inflow_type, assigned_staff_id→staff,
                    team_id→teams, memo, win_history, registered_at, last_active_at,
                    is_suspended, is_deleted, is_withdrawn, meta jsonb
staff        운영자 id, login_id, name, role(admin|manager|leader|rep), team_id, is_active, last_login_at
teams        팀     id, name, leader_id→staff
products     상품   id, name, price, duration_months, grade_granted, is_active
payments     결제   id, member_id→members, product_id→products, amount, method(무통장|수기|pg),
                    pg_provider, status(대기|승인|실패|취소), period_start, period_end,
                    depositor_name, staff_id→staff, paid_at
sms_sends    문자   id, member_id, template_key, phone, body, type(가입|추천|당첨|마케팅), status, sent_at
sms_templates       key, title, body(변수 $name $id $pw $num $contents), category
lotto_rounds 회차   round_no(pk), draw_date, numbers int[6], bonus, sum, odd_even, appear_rate,
                    prize_1, prize_2, prize_3, total_sales
bets         베팅   id, round_no→lotto_rounds, issuer, member_ref, numbers int[], rank, prize
assignments  배정   id, member_id, staff_id, assigned_by, type(manual|auto), created_at
*_logs       감사   admin_logs point_logs sms_logs payment_logs inflow_logs
                    (공통: actor, action, target_type, target_id, meta jsonb, created_at)
view_presets 뷰     key, label, filter jsonb, role_visibility[]   ← 26 세그먼트
site_settings       단일 행 또는 key-value: 무통장, pg_configs jsonb, sms schedule, grade_colors
notices events inquiries faqs terms   게시 콘텐츠
```

타입은 `supabase gen types typescript` 로 `types/db.ts` 생성, 절대 수기 작성 금지.

---

## 5. 권한 모델 & RLS

4역할: **admin > manager(실장) > leader(팀장) > rep(담당자)**

- **메뉴 노출**: 역할별로 라우트/사이드바 항목 자체를 표시/숨김 (`useRole()` 가드).
- **데이터 접근**: Supabase **RLS 정책**으로 이중 통제.
  - rep → 본인 `assigned_staff_id` 회원만
  - leader → 본인 팀(`team_id`) 회원만
  - manager → 전체(설정 일부 제한)
  - admin → 전체 + 관리자/권한/로그/설정 전체
- 권한 경계 상세는 `08 권한관리` 화면 미확인 → 위 기본값으로 구현 후 `ASSUMPTIONS.md` 기록.

---

## 6. 핵심 컴포넌트 규약

화면의 ~80%가 아래 3개로 조립된다. 먼저 만들고 전 모듈에서 재사용한다.

### `<DataTable>` (TanStack Table 래퍼)
- props: `columns`, `query`(TanStack Query 결과), `rowSelection`, `bulkActions`, `density`, `onRowClick`
- 기능: **sticky 헤더**, 밀도 토글(comfortable 44 / compact 36), **컬럼 토글**(역할별 기본 프리셋), 행 hover, 행 선택→ `<BulkActionBar>` 등장, 서버 페이지네이션, 빈 상태/로딩 스켈레톤.
- 숫자 컬럼은 `align:right + mono + tnum`. 셀 내 **인라인 편집**(상태/담당/유입분류)은 셀 렌더러로.

### `<FilterBar>`
- 접이식 패널(평소 접힘) + **활성 필터 칩**(항상 노출, 칩에서 개별 해제·전체 초기화).
- 우측에 통합 검색 input(ID·이름·핸드폰). URL query와 동기화 → 뒤로가기/공유 가능.

### `<Badge>` / `<StatusChip>`
- 등급/상태 토큰 자동 매핑. `<Badge grade="gold"/>`, `<StatusChip status="wait"/>`. 도트+라벨.

기타: `<BulkActionBar>`(하단 sticky, 선택 수 + 액션), `<KpiCard>`, `<Drawer>`(상세/편집), `<DateRangeFilter>`, `<Pagination>`, `<PageHeader>`(제목+설명+액션 슬롯), `<EmptyState>`.

---

## 7. 26 saved views 패턴 (코드 중복 제거 핵심)

이용자 26개 세그먼트는 **별도 화면이 아니다**. `features/members/views.ts` 의 필터 프리셋 배열로 정의하고, `MembersPage` 1개가 `?view=` 파라미터로 프리셋을 적용한다.

```ts
export const MEMBER_VIEWS = [
  { key:'all',          label:'전체',          filter:{} },
  { key:'today-dabi',   label:'오늘 다비',      filter:{ registeredToday:true } }, // 의미 라이브 확인
  { key:'normal',       label:'정상',          filter:{ status:'정상' } },
  { key:'paid',         label:'유료',          filter:{ gradeIn:['gold','goldp','vip','royal'] } },
  { key:'free',         label:'무료',          filter:{ grade:'free' } },
  { key:'manager-own',  label:'실장담당',       filter:{ roleScope:'manager' } },
  { key:'leader-own',   label:'팀장담당',       filter:{ roleScope:'leader' } },
  { key:'dup-today',    label:'중복유입(오늘)',  filter:{ dupInflow:'today' } },
  { key:'no-staff',     label:'담당미지정',      filter:{ assignedStaffId:null } },
  { key:'winner',       label:'당첨자',         filter:{ hasWin:true } },
  { key:'no-outcall-new', label:'미아웃콜(신규)', filter:{ outcall:false, segment:'new' } },
  { key:'long-inactive',label:'장기미접속',      filter:{ inactiveDays:30 } },
  { key:'suspended',    label:'정지',          filter:{ is_suspended:true } },
  { key:'deleted',      label:'삭제목록',       filter:{ is_deleted:true } },
  { key:'withdrawn',    label:'탈퇴목록',       filter:{ is_withdrawn:true } },
  // …나머지 세그먼트도 동일 패턴. 의미 모호한 것(다비/시도 등)은 ASSUMPTIONS.md 기록 후 합리적 정의.
] as const
```
자주 쓰는 5~6개는 페이지 상단 **탭**, 나머지는 "더보기" 드롭다운.

---

## 8. 교차 기능 데이터 흐름 (★ 유기적 연동 — 반드시 구현)

각 액션은 **여러 모듈에 동시에 반영**되어야 한다. TanStack Query 쿼리 키를 공유하고, 뮤테이션 성공 시 관련 키를 무효화한다.

| 액션 | 동시 반영되는 곳 |
|---|---|
| **담당자 배정/리셋/자동할당** | members 갱신 + `assignments` 로그 생성 + **나의고객** 목록 변동 + **매출** 귀속 대상 변경 + admin_log |
| **결제 승인** | payments 상태=승인 + member.grade 상향 + member.status=정상 + **매출(실/전환)** 반영 + payment_log + (옵션) 가입감사/번호 SMS 트리거 |
| **결제 실패/취소(PG취소)** | payments 상태 변경 + member 등급/상태 롤백 검토 + 매출 차감 + payment_log |
| **SMS 발송**(개별/일괄/스케줄) | `sms_sends` 생성 + **회원 상세 문자 히스토리** + **문자로그** 통계 반영 |
| **상태/유입분류 일괄변경** | members 갱신 + 해당 세그먼트(뷰) 카운트 재계산 + admin_log |
| **아웃콜 처리** | member.outcall 플래그 + 미아웃콜 세그먼트에서 제외 + **대시보드 '미아웃콜' KPI** 감소 |
| **회차 등록/당첨 확정** | lotto_rounds + 관련 bets.rank/prize 계산 + 당첨자 세그먼트 갱신 + (옵션) 당첨 SMS |
| **로그인** | staff.last_login_at + admin_log |

**회원 상세 Drawer**는 이 연동의 허브: 기본정보 / 결제내역 / 문자내역 / 배정이력 / 메모 탭을 한 곳에서 보고 액션(등급변경·담당변경·문자발송·정지) 실행 → 위 흐름 트리거.

대시보드 KPI(신규유입·미아웃콜·결제대기·오늘매출)는 위 데이터의 **실시간 집계**다. 하드코딩 금지.

---

## 9. 미확인 화면 처리 원칙 (스샷 빠진 19개)

대상: 매출(3) · 관리자/권한(2) · 로그(5) · 통계 중 가입·결제(2) · 커뮤니티(2) · 고객센터(3) · 나의고객(2).

규칙:
1. **IA(§ 사이트맵) + 데이터 모델(§4) + 흐름(§8) + 디자인 시스템(§3)** 으로 **직접 구현**한다. 빈 화면으로 두지 않는다.
2. CRM/이커머스 백오피스의 **합리적 표준 패턴**을 적용한다 (예: 매출=기간 필터+요약 KPI+표+차트, 로그=리스트형+필터, 권한관리=역할×기능 체크박스 매트릭스).
3. 추정한 모든 컬럼/지표/규칙은 `docs/ASSUMPTIONS.md`에 `[화면] / 추정내용 / 근거 / 확인필요` 형식으로 기록한다.
4. 코드에는 `// TODO(live-verify): ...` 주석을 남긴다.
5. 추정이 시스템 동작에 영향을 주면(예: 매출 귀속 공식) **가정을 명시적 상수/설정**으로 빼서 나중에 한 줄로 교체 가능하게 한다.

각 미확인 모듈의 구체 구현 지침은 `BUILD_PROMPTS.md` 해당 Phase에 있다.

---

## 10. 코딩 컨벤션 & Definition of Done

- TypeScript strict, `any` 금지. 모든 DB 접근은 `types/db.ts` 타입 경유.
- UI 텍스트는 **한국어**. 코드/주석은 한국어+영어 혼용 허용.
- 모든 색·간격·라운드는 토큰/Tailwind 유틸만. 임의 hex/px 금지.
- 데이터 fetch는 `features/*/api.ts`의 TanStack Query 훅으로만. 컴포넌트 직접 fetch 금지.
- 금액 `krw()`, 전화 `phone()`, 일시 `datetime()` 포매터만 사용.
- 위험 액션(PG취소·삭제·정지·일괄변경)은 **확인 모달** 필수.
- 반응형: 데스크톱 우선(운영툴), 1280px 기준. 테이블은 가로 스크롤 허용.

**DoD (기능 완료 기준)**: 화면 렌더 + 실제 Supabase 데이터 CRUD 동작 + §8 연동 반영 + 로딩/빈/에러 상태 + 역할 가드 + 토큰 준수 + (미확인 화면이면) ASSUMPTIONS 기록.

---

## 빌드 순서
`BUILD_PROMPTS.md`의 Phase 0 → 11 순서대로. **Phase 3(이용자)를 수직 슬라이스로 끝까지 완성**해 패턴을 확정한 뒤 나머지 모듈에 복제하는 것이 핵심 전략.
