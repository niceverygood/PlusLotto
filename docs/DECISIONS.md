# DECISIONS — 설계 결정 기록

> 형식: 결정 · 이유 · 영향. 접근/구조가 바뀌면 여기에 추가한다.

## 2026-06-01 · Phase 0

### D1. 데이터 계층 — Supabase 스키마 호환 로컬 폴백
- **결정**: 실 Supabase 자격증명이 없어, `features/*/api.ts` 훅 뒤에 Supabase와 동일한 형태의 로컬 데이터 계층(seed + localStorage 영속)을 둔다. `.env`의 `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`가 있으면 실 Supabase, 없으면 로컬 mock으로 자동 전환(`VITE_DATA_SOURCE`로 강제 지정 가능).
- **이유**: 자격증명 없이도 §8 교차연동·CRUD를 end-to-end로 시연할 수 있어야 함(DoD). 컴포넌트는 데이터 출처를 모르고 훅이 경계.
- **영향**: "컴포넌트 직접 fetch 금지" 규칙과 정합. 실서버 전환은 env 한 줄 + `supabase gen types`. 타입은 `types/db.ts` 단일.

### D2. 색 토큰은 CSS 변수, Tailwind는 var() 매핑
- **결정**: 모든 색을 `design-system/tokens.css`의 CSS 변수로 단일 정의하고 `tailwind.config.ts`는 hex가 아닌 `var(--token)`을 가리킨다(CLAUDE §3.2의 hex 나열을 변수 참조로 대체).
- **이유**: §10 "등급색 변경이 전 화면 Badge에 반영(토큰 연동)" 충족 — 런타임에 토큰만 바꿔도 전체 반영. 단일 소스.
- **영향**: 토큰 색에는 tailwind opacity 수식어 미지원(필요 시 rgba 직접). 등급색 설정(Phase 10)은 tokens 변수 오버라이드로 동작.

### D3. 스펙 문서 위치
- **결정**: `pluslotto_admin_spec.html`을 `docs/`로 이동(CLAUDE.md/BUILD_PROMPTS 참조 경로와 일치).

### D4. 빌드 — `tsc --noEmit && vite build`
- **결정**: 프로젝트 레퍼런스(`tsc -b`)/composite 대신 `tsc --noEmit`로 타입체크 후 `vite build`.
- **이유**: 레퍼런스/composite 설정 오류 리스크 제거. strict는 유지(noUnusedLocals/Parameters 포함).

### D5. 사이드바 = 4그룹 NAV 상수, 접힘 상태 zustand persist
- **결정**: 13개 메뉴를 `AppShell.tsx`의 `NAV` 상수(운영/고객·세일즈/로또/시스템 4그룹)로 정의. 접힘(64px)/펼침(248px)은 `uiStore`에 persist. 카운트 뱃지는 `navCounts` 플레이스홀더(빈 값, Phase 9 실시간 집계로 대체 — 하드코딩 금지).
- **이유**: 스펙 App Shell 프리뷰와 일치 + 메뉴 추가/역할 게이팅(Phase 2)을 상수 한 곳에서 처리.
- **영향**: Phase 0 은 전 메뉴 노출 + `관` 핀만 표기. 역할별 숨김은 Phase 2 에서 `useRole`로 필터.

### D6. React Router v7 future flag 선반영
- **결정**: `BrowserRouter`에 `v7_startTransition`/`v7_relativeSplatPath` future flag 적용.
- **이유**: 콘솔 경고 제거 + v7 마이그레이션 대비.

## 2026-06-01 · Phase 1

### D7. DataTable = 데이터 주도 + 전역 밀도 + 정렬 모드 자동
- **결정**: `<DataTable>`은 `data: T[]` + `isLoading`만 받고 TanStack Query 결합은 각 모듈 `api.ts`가 담당(컴포넌트 직접 fetch 금지 규칙 유지). 밀도는 `uiStore.density` 전역 상태. 정렬은 `onSortingChange` 제공 시 서버(manual), 미제공 시 클라이언트(`getSortedRowModel`). 행 선택은 내부 state + `bulkActions(ctx)` 렌더프롭으로 `selectedIds/selectedRows/clear` 노출. 세로 스크롤 sticky 헤더는 `maxBodyHeight` 지정 시 활성.
- **이유**: 한 컴포넌트로 정렬·선택·밀도·컬럼토글·일괄작업·페이지네이션·로딩/빈 상태를 흡수(스펙 "화면의 80%"). 서버/클라 정렬을 prop 유무로 분기해 데모·모듈 모두 커버.
- **영향**: 모듈은 selectedIds를 받아 일괄 뮤테이션 → 관련 쿼리 무효화(§8)만 연결하면 됨.

### D8. 컴포넌트 배럴 export + 라벨 단일 소스
- **결정**: `design-system/components/index.ts` 배럴로 전 컴포넌트 export, feature는 배럴만 import(CLAUDE §2 "공유는 design-system/lib 경유"). 등급/상태/결제수단/문자유형 한글 라벨은 `design-system/labels.ts` 단일 정의.
- **영향**: StatusChip은 `status` 키 매핑 또는 `tone+label` 임의 사용 둘 다 지원(문의 상태 등 확장).

### D9. /dev/components 검수 라우트
- **결정**: Phase 1 검수용 데모 페이지를 `/dev/components`에 둠.
- **이유**: 모든 컴포넌트의 기본/로딩/빈/선택/접힘 상태를 한 화면에서 확인(BUILD_PROMPTS Phase 1 검수).
- **영향**: TODO(Phase 11): 프로덕션 빌드에서 dev 라우트 제외 검토.

## 2026-06-01 · Phase 2

### D10. mock 데이터 계층 — 버전드 localStorage 단일 저장소
- **결정**: `lib/db/store.ts`가 `DbShape`(11개 테이블) 전체를 `localStorage['pluslotto-db']`에 `{__v, data}`로 영속. `readDb()`/`mutateDb(fn)`/`resetDb()` 3개 API + `genId/nowIso`. 시드는 `lib/db/seed.ts`. `DB_VERSION` 불일치 시 자동 재시드.
- **이유**: D1의 "Supabase 동일 형태 로컬 폴백"을 단일 저장소로 구체화 — api 훅이 readDb로 읽고 mutateDb로 쓰며 §8 교차연동을 로컬에서 end-to-end 시연. 시드 구조 변경(Phase 3 회원/Phase 11 대량)은 DB_VERSION만 올리면 안전 재시드.
- **영향**: 컴포넌트 직접 접근 금지(여전히 api.ts 경유). 실 Supabase 전환 시 이 계층은 우회.

### D11. 세션 = zustand persist + mock 데모 로그인 / supabase 자동 분기
- **결정**: `lib/auth.ts`를 `useSessionStore`(persist `pluslotto-session`, currentUser)로 재작성. `signIn(identifier, password?)`은 `dataSource`에 따라 분기 — mock은 `staff.login_id` 매칭(비번 무시), supabase는 `signInWithPassword`. 로그인 성공 시(mock) `staff.last_login_at` 갱신 + `admin_log` 적재(§8). `useCurrentUser/useRole`은 `CurrentUser|null` 반환.
- **이유**: 자격증명 없이도 4역할 로그인 시연(DoD). 훅 시그니처가 nullable이 되어 RequireAuth/RequireRole가 미인증을 명시적으로 처리.
- **영향**: 라우트는 `/login`(셸 밖) + `RequireAuth`로 셸 보호. supabase 세션 복원(onAuthStateChange)은 TODO.

### D12. 메뉴 노출 = permissions 매트릭스, 데이터 접근 = RLS 초안
- **결정**: `lib/permissions.ts`의 `NAV_ACCESS: Record<NavKey, Role[]>` + `canAccess(role,key)`로 사이드바를 역할 필터. RLS는 `lib/rls/policies.sql` 초안(rep=assigned_staff_id, leader=team_id, manager·admin=전체)으로 두고 실 전환 시 적용. 매트릭스 추정은 ASSUMPTIONS 기록.
- **이유**: §5 "메뉴 노출은 useRole 가드 + 데이터는 RLS 이중 통제". mock 모드엔 RLS가 없으므로 메뉴 게이팅으로 역할 차이를 시연.
- **영향**: AppShell이 `canAccess`로 그룹/항목 필터(빈 그룹 숨김). 모듈 라우트에는 Phase 3+에서 `RequireRole` 부착.

## 2026-06-01 · Phase 4 (결제)

### D13. 교차모듈 쿼리 키 단일 출처 = `lib/queryKeys.ts`
- **결정**: `memberKeys`/`paymentKeys`를 `lib/queryKeys.ts`로 옮겨 공유. members/api·payments/api는 여기서 import 후 re-export. payments 뮤테이션이 members 캐시를 무효화해야 하는데(§8 결제승인→등급), feature 간 직접 import는 §2 금지이므로 lib 경유.
- **이유**: §8 "쿼리 키 공유/무효화" + §2 "feature 간 직접 import 금지, lib 경유"를 동시에 만족.
- **영향**: 새 모듈도 교차 무효화가 필요하면 키를 여기에 추가. `memberKeys`는 내부 사용만(외부 importer 없음 확인 후 이동).

### D14. 결제 승인/취소 = §8 부수효과 + 등급 롤백 휴리스틱
- **결정**: 승인 시 `applyApproval`(payment.status=approved, paid_at/period 설정, member.grade=product.grade_granted, status=active). 취소 시 status=cancelled + **등급 롤백 검토**: 이 결제가 부여한 등급이고 다른 승인 결제가 그 등급을 더는 받쳐주지 않으면 member.grade='free'. 매출은 별도 컬럼 없이 "승인 결제 합계"로 자동 산출(차감=취소 시 자연 반영). 각 뮤테이션은 payment_log 적재.
- **이유**: §8 표 "결제 승인/취소 → member 등급·상태·매출·로그 동시 반영". 등급 롤백은 원본 미확인이라 합리적 휴리스틱으로 구현(ASSUMPTIONS 기록).
- **영향**: 매출 모듈(Phase 5)은 payments(status='approved')만 집계하면 됨 — 별도 매출 테이블 불필요. 롤백 규칙은 라이브 확인 대상.

### D15. 결제 무효화는 detail 키까지 — `['payments']` ≠ `['payment',id]`
- **결정**: 승인/취소 onSuccess에서 `paymentKeys.all`(`['payments']`)뿐 아니라 `paymentKeys.detail(id)`(`['payment',id]`)도 무효화. 둘은 접두사가 달라(복수/단수) all 무효화가 detail을 커버하지 못함 → 열린 상세 Drawer가 즉시 갱신 안 되는 버그를 브라우저 검증 중 발견·수정.
- **영향**: 단/복수 키 분리 패턴을 쓰는 모듈은 동일 주의. detail 무효화 누락 시 Drawer stale.

### D16. 수기결제 폼 참조데이터 = payments/api 내 스토어 직접 조회
- **결정**: `/payments/manual`의 회원검색·활성상품 목록은 members/api(useProducts 등)를 import하지 않고 payments/api에 `useMemberSearch`(스코프 적용·20건 캡)·`useActiveProducts`를 두어 스토어를 직접 읽는다.
- **이유**: §2 feature 간 직접 import 금지. 상품/회원은 참조데이터지만 lib 이동 대신 feature-local 조회로 경계 유지(추후 다수 feature가 상품을 쓰면 lib/products로 승격 검토).
- **영향**: 약간의 조회 로직 중복. 폼은 react-hook-form + zod(프로젝트 첫 폼) — 이후 설정/편집 폼의 패턴 기준.

## 2026-06-01 · Phase 5 (매출)

### D17. 매출 = payments(approved) 파생, 3뷰는 단일 `/revenue` + `?view` 탭
- **결정**: 별도 매출 테이블 없이 `payments.status='approved'` 를 기간/스코프로 집계(D14 연장). BUILD_PROMPTS 의 `/revenue/real|conversion|team` 3경로는 **사이드바 IA 단일 '매출' 진입**과 정합하도록 한 페이지(`RevenuePage`)의 탭 `?view=real|conversion|team` 으로 실현(members `?view=` 패턴 D7/§7 과 동일). 실매출은 담당/팀/상품/PG 그룹 토글(`?group=`), 팀장매출은 팀 고정, 전환매출은 담당자(귀속) 고정.
- **이유**: §7 URL-동기화 saved-view 패턴 재사용 + 사이드바 active 상태 단순. 3뷰가 공통 골격(DateRangeFilter+KPI+차트+표)이라 단일 페이지가 DRY.
- **영향**: 라우트 1개. 뷰별 차이는 집계 차원/대상 집합만 분기.

### D18. 매출 귀속/인식 규칙은 `lib/revenueRules.ts` 상수로 분리
- **결정**: 매출 인식 시점(`recognitionDate='paid_at'`)·귀속 대상(`attribution='payment_staff'`)·전환 정의(`conversion='first_approved_paid'`)를 `REVENUE_RULES` 상수 + `recognitionIso(p)` 헬퍼로 한 곳에 둔다. 원본 정산 스펙 미확인이라 라이브 확인 후 한 줄 교체(ASSUMPTIONS 기록).
- **이유**: BUILD_PROMPTS Phase 5 "귀속 공식은 가정 → 상수화" + §9 "가정을 명시적 상수로".
- **영향**: 전환 정의/귀속 변경 시 집계 로직 수정 없이 상수만 교체.

### D19. 결제→매출 무효화(§8) + recharts 첫 도입 + 라우트 역할 가드 첫 적용
- **결정**: `revenueKeys`(`['revenue']`) 추가 → 결제 승인/취소/수기등록 onSuccess 에서 `revenueKeys.all` 무효화(§8 "결제 승인/취소 → 매출 반영/차감"). 차트는 recharts `AreaChart` 첫 사용 — 색은 토큰 `var(--primary-500)`/`var(--gray-*)` 로 지정(임의 hex 금지 유지). `/revenue` 에 `RequireRole(['admin','manager','leader'])` 부착(rep 차단) — 메뉴 노출(NAV_ACCESS)+라우트 가드 이중(§5), 프로젝트 첫 RequireRole 적용.
- **영향**: 결제와 매출이 동일 QueryClient 캐시에서 일관. 이후 모듈도 매출 영향 액션이면 revenueKeys 무효화. recharts 번들 증가(빌드 경고는 Phase 11 코드분할 대상). 다른 모듈 라우트 가드도 동일 패턴으로 부착.

## 2026-06-01 · Phase 6 (로또기록 · 베팅)

### D20. 채점 로직은 `lib/lotto.ts` 순수 함수 — seed(lib)와 feature 공유
- **결정**: 등수 산정(`gradeRank`)·당첨금(`prizeForRank`)·합/홀짝(`lottoSum`/`oddEven`)·일치수(`matchCount`)를 `lib/lotto.ts` 순수 함수로 단일 정의. 시드(`lib/db/seed.ts`)와 feature(`features/lotto/api.ts`, `features/bets/columns.tsx`)가 모두 여기서 import. 한국 로또 6/45 규칙: 6일치=1등, 5+보너스=2등, 5=3등, 4=4등, 3=5등, 그 외 미당첨.
- **이유**: 시드가 만든 당첨/베팅과 런타임 '당첨 확정'이 **동일 채점 결과**를 내야 함(검증 일관성). seed는 lib, feature는 features — 양쪽이 공유하려면 채점 로직이 lib 에 있어야 §2(feature 간 import 금지) 위반 없이 단일 소스 유지.
- **영향**: 등수/당첨금 규칙 변경은 `lib/lotto.ts` 한 곳. 4·5등 고정상금(5만/5천원)은 `FIXED_PRIZE` 상수.

### D21. `confirmed_at` 필드로 '당첨 확정' 멱등 워크플로
- **결정**: `LottoRound` 에 `confirmed_at: string|null` 추가(§4 원본 스키마엔 없음). null=미확정. `useConfirmRound` 가 해당 회차 전 베팅을 `gradeRank`/`prizeForRank` 로 채점하고 `confirmed_at=nowIso()` 설정. 베팅에서 등수 유무를 추론하지 않고 회차에 명시 상태를 둠.
- **이유**: 미확정→확정 전이를 한 플래그로 멱등하게(재확정 시 재산정) 표현. UI 탭(전체/미확정/확정)·상태 칩·'당첨 확정' 버튼 노출이 이 한 필드로 분기.
- **영향**: §8 "회차 등록/당첨 확정" 트리거 — 확정 시 `lottoKeys.all`+`betKeys.all`+`memberKeys.all` 무효화. 1~3등 당첨자(회원 연결분)는 `member.win_history=\`${회차}회 ${등수}등\`` 갱신 → 당첨자 세그먼트 자동 반영(브라우저 검증: 1180회 확정 시 전유진 win_history 갱신·당첨금 합계 KPI 일치 확인).

### D22. LottoBalls 컴포넌트 + 공 색 토큰(동행복권 공식 색대)
- **결정**: 당첨번호 시각화는 `design-system/components/LottoBalls.tsx` 단일 컴포넌트(원형 공, 보너스는 `+` 구분, `highlight` 로 일치 강조·비강조 dim). 공 색은 `tokens.css` 의 `--ball-y/b/r/k/g`(1–10 노랑·11–20 파랑·21–30 빨강·31–40 회색·41–45 초록) + tailwind `ball.*` 매핑. 임의 hex 금지 규칙 준수(토큰화).
- **이유**: 로또기록·베팅·회차등록 미리보기 3곳이 동일 시각화를 재사용(§6 컴포넌트 조립). 동행복권 공식 색대를 재현해 운영자 친숙도 확보.
- **영향**: 번호 일치 강조(`highlight`)로 베팅의 등수 근거를 시각적으로 즉시 확인.

### D23. 베팅은 전역 데이터(역할 스코프 없음) + 회차필터 `?round=` URL 동기화
- **결정**: 베팅(`features/bets`)은 회원 스코프(§5 RLS 에뮬)를 적용하지 않고 전역 조회. 로또기록 행 클릭 → `/bets?round=N` 으로 이동해 해당 회차 필터(검수 흐름). 회차 옵션은 `useBetRoundOptions` 가 `lib/db/store` 를 직접 읽어 lotto feature import 회피(§2).
- **이유**: 베팅/회차는 회원 담당과 무관한 운영 공통 데이터(발행처가 외부 지점·온라인 포함). 회차→베팅 드릴다운이 핵심 검수 동선.
- **영향**: 베팅 KPI(베팅수·당첨건수·당첨금합계)는 필터된 집합 기준 집계. rep 도 전체 베팅 열람 가능(라우트 가드 없음).

## 2026-06-02 · Phase 7 (나의고객 · 커뮤니티 · 고객센터)

### D24. 나의고객은 members feature 내부 페이지 · 공유는 lib 경유
- **결정**: 나의고객(`/my/customers`·`/my/sms`)을 별도 feature 가 아니라 `features/members/` 안의 `MyCustomersPage`·`MySmsPage` 로 둔다 — 동일 데이터 도메인이라 `MemberDrawer`·`columns`·`bulk`·뮤테이션을 §2 위반 없이 재사용. 나의고객 스코프는 RLS 역할 스코프와 별개인 **`assigned_staff_id === currentUser.id`(본인 케이스로드)** — manager/leader 도 여기선 본인 담당만 본다(`useMyCustomers`/`useMyCustomerCounts`/`useMySmsLog`). 문자 렌더(`renderSms`)·템플릿→유형 매핑(`smsTypeForTemplate`)은 members·나의고객 양쪽이 쓰므로 `lib/sms.ts` 로 추출. 고객센터의 공지 노출은 community feature 를 import 하지 않고 `lib/db/store` 의 `readDb().notices` 를 직접 읽고 `communityKeys.notices` 키를 공유(공지 뮤테이션 시 함께 무효화).
- **이유**: §2 "feature 간 직접 import 금지(공유는 design-system/lib 경유)" 와 코드 재사용을 동시에 만족. 나의고객은 이용자 모듈의 포커스 뷰일 뿐 새 도메인이 아님.
- **영향**: 라우트는 in-page write-gating(커뮤니티/FAQ 작성은 admin·manager) — `RequireRole` 미부착(문의 답변은 전 역할 가능). 향후 상품 등 다수 feature 공유 참조데이터가 늘면 lib 승격 검토(D16 연장).

### D25. mock 스토어 `mutateDb` = copy-on-write (§8 라이브 반영 보장)
- **결정**: `lib/db/store.ts` 의 `mutateDb` 를 in-place 변경에서 **copy-on-write**(현재 캐시를 깊은 복제 → fn 으로 변경 → `cache` 통째 교체 → persist)로 바꿨다. `readDb()` 는 여전히 캐시를 그대로 반환(읽기 무복제). feature 의 뮤테이션 코드는 그대로(여전히 `db` 인자를 in-place 로 변경).
- **이유**: 기존 in-place 변경은 React Query 가 들고 있는 직전 스냅샷의 **객체 참조를 오염**시켜, 무효화 후 재조회해도 structural sharing(`replaceEqualDeep`)이 "변경 없음"으로 판단 → 활성 옵저버가 리렌더되지 않았다(열린 목록/Drawer 가 stale, 리마운트해야 반영). 브라우저 검증 중 고객센터 문의 답변(대기→답변완료) 시 발견. copy-on-write 로 매 뮤테이션이 새 객체 그래프를 만들어 직전 스냅샷을 보존 → §8 "여러 모듈 동시 반영"이 리마운트 없이 즉시 동작.
- **영향**: 전 기능(이용자·결제·매출·로또·베팅·나의고객·커뮤니티·고객센터)의 §8 라이브 반영이 일괄 정상화. 검증: 문의 답변 시 대기/답변완료 카운트 즉시 변동, /my/sms 발송 시 발송내역 19→62 즉시 증가, 커뮤니티 공지 작성 시 목록 6→7 즉시 반영 + admin 로그 적재. 쓰기마다 전체 DB 깊은 복제 비용이 있으나 mock 한정(쓰기는 사용자 액션 빈도)·실 Supabase 전환 시 이 계층 우회라 무영향. 복제는 `structuredClone` 우선, 폴백 JSON.

## 2026-06-02 · Phase 8 (관리자 · 권한관리 · 로그)

### D26. 권한 매트릭스를 DB화(`nav_access`) — 사이드바+라우트가드 단일 출처
- **결정**: §5 메뉴 노출을 정적 `NAV_ACCESS` 상수가 아니라 **편집 가능한 DB 행 `nav_access: Record<NavKey, Role[]>`** 로 승격(`DbShape.nav_access`, 시드는 `DEFAULT_NAV_ACCESS` 복제). 읽기는 `lib/navAccess.ts` 의 `useNavAccess()`(TanStack Query, key `['nav-access']`), 판정은 `lib/permissions.ts` 의 `canAccessWith(map, role, key)`. AppShell(사이드바 그룹/항목 필터)과 새 `app/RequireNav.tsx`(라우트 가드)가 **동일 맵**을 사용 → 권한관리(`/admins/roles`)에서 모듈을 끄면 메뉴 숨김과 직접 URL 진입 차단이 한 번에 적용(§5 "메뉴+데이터 이중 통제"의 메뉴 절반을 런타임 편집화).
- **이유**: BUILD_PROMPTS Phase 8 "권한관리=역할×기능 체크박스 매트릭스" 를 시연하려면 매트릭스가 **저장되고 즉시 반영**돼야 함(§8). 정적 상수면 편집 불가.
- **영향**: 기존 `canAccess(role,key)`(정적)는 fallback 으로 유지하되 런타임 판정은 전부 `canAccessWith(navMap, …)` 경유. `nav_access` 누락 시 `DEFAULT_NAV_ACCESS` 로 안전 폴백(`readNavAccess`). DB_VERSION 4→5 로 올려 기존 localStorage 자동 재시드.

### D27. RequireNav 가 RequireRole 대체 — 매트릭스 기반 가드로 일원화(RequireRole 삭제)
- **결정**: 라우트 가드를 역할 하드코딩(`RequireRole(['admin','manager','leader'])`, D19)에서 **매트릭스 기반 `RequireNav navKey="…"`** 로 교체하고 `app/RequireRole.tsx` 를 삭제(데드코드). 허용 안 되면 항상 `/dashboard` 로 리다이렉트. `/dashboard` 자신은 가드하지 않음(리다이렉트 폴백 — 루프 방지). `/dev/components` 도 비가드(검수용).
- **이유**: 가드 기준이 두 곳(정적 배열 vs DB 맵)으로 갈리면 권한관리 저장이 라우트에 반영 안 되는 불일치 발생. 단일 출처(`nav_access`)로 통일.
- **영향**: 매출 가드도 `RequireNav navKey="revenue"` 로 전환(rep 차단은 기본 맵이 유지). 모든 모듈 라우트가 매트릭스에 종속 → 권한관리 한 화면이 메뉴+진입을 동시 통제.

### D28. 자기잠금(self-lockout) 3중 방어
- **결정**: 관리자가 자신의 권한/계정을 잠그지 못하도록 (1) 권한 매트릭스에서 `ADMIN_LOCKED=['admins','logs']` × `admin` 셀은 **항상 체크+disabled**(`isLockedCell`), (2) `canAccessWith` 가 ADMIN_LOCKED 키는 저장값과 무관히 **admin 에게 항상 허용**, (3) AdminsPage 에서 **현재 로그인 계정 자신의 비활성화 토글 disabled**. 비활성화는 `ConfirmModal tone="danger"` 필수(§10 위험 액션).
- **이유**: 권한관리/로그는 운영 복구 경로 — admin 이 실수로 끄면 자기 자신이 관리 화면에 못 들어가 잠김. 데이터·UI·판정 3계층에서 차단.
- **영향**: 매트릭스 저장값이 손상돼도 admin 의 admins/logs 접근은 보장. rep/leader/manager 의 admins/logs 는 정상적으로 토글 가능(잠금은 admin 행에 한정).

### D29. 감사 로그 5종 = 단일 `logs` 테이블 + kind 필터, 항상 최신 조회
- **결정**: 로그를 종류별 테이블(admin/payment/sms/inflow/point) 대신 **단일 `logs: LogEntry[]`**(공통 `kind, actor, action, target_type, target_id, meta, created_at`)로 두고 `/logs/:kind` 가 kind 필터+최신순. §8 액션들이 각자 `kind` 로 1행씩 적재(`features/admins/api.ts` 의 `adminLog`, auth 로그인, 결제/문자/유입 뮤테이션). `useLogs` 는 **staleTime:0 + refetchOnMount:'always'** 로 진입 시 항상 최신 — 다른 feature 가 `logKeys` 를 별도 무효화하지 않아도(§2 교차 무효화 회피) 적재분이 보임.
- **이유**: 5종이 동일 스키마라 단일 테이블이 DRY. 로그는 append-only 감사 화면이라 "항상 최신 재조회"가 무효화 그물망보다 단순·안전.
- **영향**: 액션 코드→한글 라벨은 `LogsPage.ACTION_LABEL` 한 곳(미정의 코드는 원문 노출). `actor=null` 은 '시스템'(자동 적립 등). 시드는 `genLogs` 가 실제 staff/member/payment/sms 참조로 admin19·payment·sms12·inflow8·point10 생성(브라우저 검증: 5탭 렌더 + 검색·기간 필터 동작).

### D30. ROLE_LABEL 을 lib/permissions 로 이동 + auth 액션코드 표준화
- **결정**: 역할 한글 라벨 `ROLE_LABEL`(관리자/실장/팀장/담당자)을 AppShell 로컬 상수에서 `lib/permissions.ts` 로 끌어올려 단일 정의(admins·logs·shell 공유). 로그인 감사 로그 액션코드를 `'login'` → `'auth.login'` 로 통일(로그 화면 `ACTION_LABEL` 키 체계 `domain.verb` 와 정합).
- **이유**: 라벨/코드가 화면마다 흩어지면 표기 불일치. §2 공유는 lib 경유.
- **영향**: 관리자·로그·셸이 동일 라벨. 기존 적재된 `'login'` 로그가 있다면 라벨 폴백(원문)으로 표시되나 재시드로 정리됨.

## 2026-06-02 · Phase 9 (통계 · 운영 대시보드)

### D31. 대시보드 = 보는 사람 스코프 실시간 집계, KPI 딥링크는 nav_access 로 게이팅
- **결정**: `/dashboard` 4개 KPI(오늘 신규유입·미아웃콜·결제대기·오늘매출)·14일 추이·처리대기 목록을 `readDb()` 에서 매번 파생(하드코딩 금지, §8). 수치는 보는 사람의 데이터 스코프(admin/manager=전체, leader=팀, rep=본인 담당)로 한정. KPI 카드/“전체보기” 딥링크는 `canAccessWith(navMap, role, navKey)` 가 true 일 때만 클릭 가능 — 아니면 숫자만 표시(라우트 가드 RequireNav 로 튕기는 것 방지).
- **이유**: 대시보드는 전 역할의 랜딩(가드 없음)이므로 rep 도 본인 책임 범위 수치를 봐야 유용. 그러나 매출/통계 등 rep 비접근 화면으로의 딥링크는 가드에 막혀 UX 가 깨지므로 클릭 자체를 비활성화.
- **영향**: 같은 화면이 역할마다 다른 수치를 보이되 일관. 딥링크 타깃: 신규유입→`/members?view=today-join`, 미아웃콜→`/members?view=no-outcall-all`, 결제대기→`/payments?st=wait`, 오늘매출→`/revenue`. 결제대기 카드는 PaymentsPage 의 `st` URL 파라미터를 그대로 사용(딥링크-필터 정합).

### D32. 통계 = 단일 `/stats` + `?view` 3뷰, 항상 최신 조회(D29), 결제뷰는 매출과 동일 파생
- **결정**: 가입·결제·유입 3통계를 별도 화면이 아니라 `/stats` 1개 + `?view=` 탭(매출 모듈 §7 패턴 재사용)으로 구현. `useStats(view,from,to)` 단일 훅이 view 로 분기해 통일된 `StatsResult{kpis,trend,breakdowns}` 반환. 집계 화면이므로 `staleTime:0 + refetchOnMount:'always'`(D29) — §8 액션 결과를 진입 시 즉시 반영.
- **이유**: 3뷰 골격(기간필터+KPI4+추이차트+분해표)이 동일 → 단일 페이지가 DRY. URL 동기화로 뒤로가기/공유 가능.
- **영향**: 결제뷰 매출 추이는 매출 모듈과 같은 `payments(status='approved')` 파생이라 수치 정합(§8). 단, 통계 결제뷰는 rep 도 본인 담당분을 보지만 매출 모듈은 rep 비접근(`scopeApproved` 가 rep→[]) — 스코프 규칙이 모듈별로 다름은 D31 의도(ASSUMPTIONS 기록).

### D33. 사이드바 뱃지 = 기존 무효화 프리픽스에 얹은 파생 쿼리
- **결정**: `lib/navBadges.ts` 의 `useNavBadges()` 가 결제대기(역할 스코프)·미답변 문의(공유 큐) 건수를 `paymentKeys.counts('nav:…')`·`supportKeys.inquiries({nav:…})` 키로 노출. 사이드바는 상주(remount 없음)라 refetchOnMount 가 안 먹으므로, 기존 §8 무효화(`['payments']`/`['support']` prefix invalidate)에 얹혀 결제 승인·문의 답변 시 자동 갱신되도록 같은 프리픽스 아래 다른 scope 로 키를 둠. 0/로딩은 생략, `admins`·`logs` 는 뱃지 대신 ‘관’ 칩 유지(count 미주입).
- **이유**: 뱃지를 위해 feature 훅을 import 하면 §2 위반 → lib 에서 `readDb()` 직접 파생. 별도 무효화 배선 없이 기존 액션이 뱃지를 살아있게 함.
- **영향**: 결제 승인 시 사이드바 ‘결제’ 뱃지·대시보드 결제대기 KPI 가 동시 감소(§8). scope 문자열에 uid/role 포함 → 역할 전환 시 캐시 분리.

## 2026-06-02 · Phase 10 (설정)

### D34. 설정 = 단일 `site_settings` 행 전체 교체 + 서브페이지 슬라이스 머지
- **결정**: 무통장·등급색·PG·문자·당첨문자·리포트·로또고정제외·약관을 별도 테이블이 아닌 **단일 `site_settings` 객체**(8 슬라이스)로 두고, 저장은 `useSaveSiteSettings(next)` 가 행 전체를 교체. 4개 화면(사이트설정 1 + 서브 3)은 각자 공유 캐시(`useSiteSettings`)에서 전체 settings 를 읽어 `{ ...settings, <슬라이스> }` 만 바꿔 제출 → 다른 슬라이스 보존. `SiteSettingsPage.toSettings(v, prev)` 도 미편집 슬라이스(report·lotto_exclude·terms)를 `prev` 에서 그대로 전달.
- **이유**: §4 "site_settings 단일 행" 추정 + 설정은 저빈도 편집이라 행 전체 교체가 슬라이스별 머지 로직보다 단순·안전. 캐시가 무효화로 항상 동기화되므로 머지 충돌 없음.
- **영향**: 브라우저 검증으로 교차 슬라이스 보존 확인(등급색 #ff0000 저장 후 리포트·로또·약관을 따로 저장해도 색 유지). 새 설정 항목 추가는 `SiteSettings` 타입 + seed `buildSiteSettings` 한 곳만 확장. DB_VERSION 5→6(시드에 site_settings 추가).

### D35. 등급색 런타임 토큰 오버라이드 — DB 값 → CSS 변수 주입으로 전 화면 Badge 즉시 반영
- **결정**: `grade_colors`(8등급 fg/bg)를 `lib/gradeTheme.ts` 가 `document.documentElement.style` 에 `--g-{grade}`/`--g-{grade}-bg` CSS 변수로 주입. `useGradeColorSync()`(providers 에 `<GradeThemeSync/>` 상주, key `settingsKeys.site()`)가 마운트·무효화 시 재적용. Badge/StatusChip 은 `bg-grade-*-bg text-grade-*`(=`var(--g-*)`) 클래스를 쓰므로 별도 구독 없이 색이 바뀜. 저장 → `settingsKeys.all` 무효화 → 재적용 → 전 화면 반영.
- **이유**: §3 "등급색은 토큰 한 곳에서만 정의, 운영진 익숙도 따라 추후 변경 가능". 토큰을 런타임 편집 가능하게 하려면 정적 CSS 가 아닌 변수 오버라이드가 필요. 등급 enum 값이 곧 변수 접미사(1:1)라 매핑 테이블 불요.
- **영향**: seed 기본색 = `tokens.css` 와 동일 hex → 편집 전 시각 변화 없음. 검증: 골드 fg `#ff0000` 저장 시 /members 의 골드 Badge 16개가 즉시 빨강, 새로고침 후에도 유지(상주 sync 가 재적용). 색은 사용자 데이터라 인라인 `style`(토큰 금지 예외 — DECISIONS 기존 합의).

### D36. 시크릿 = 마스킹 표시 + 회전 입력(SecretField), PG 키 매칭은 폼 값의 실제 id 로
- **결정**: API키/SMTNT키는 `SecretField` 가 저장값의 끝 4자리만 마스킹(`••••••••3f5a`) 표시, "변경" 클릭 시에만 빈 입력 노출, 빈 값으로 저장하면 기존 키 유지(`apiKeyNew.trim() || prev.api_key`). 실제 시크릿을 가시 필드로 왕복시키지 않음. PG 행의 저장키 조회는 `useFieldArray` 의 `field.id`(RHF 가 부여해 비즈니스 id 를 가림) 대신 **`getValues(\`pg.${i}.id\`)`(폼 값의 실제 id)** 로 매칭.
- **이유**: §10 "시크릿 마스킹 + 라이브 확인 TODO", 시크릿 비노출. `field.id` 직접 매칭은 useFieldArray 의 키 shadowing 때문에 항상 불일치 → 모든 PG 키가 '미설정' 으로 보이는 버그(브라우저 검증서 발견·수정).
- **영향**: 시드 키는 전부 가짜 데모값(`*_live_*`) — 실 시크릿 아님. 라이브 전환 시 실제 키 입력으로 교체. 6개 PG + SMTNT 모두 끝4자리 마스킹 확인, 원문 키 DOM 비노출 확인.

### D37. 프로덕션 번들 = 벤더 manualChunks 분할 (Phase 11 마감)
- **결정**: `vite.config.ts` `build.rollupOptions.output.manualChunks` 로 react/query/charts/supabase 4개 벤더 청크 분리. 단일 1.25MB 청크 → 최대 청크 < 500KB(앱 394KB·charts 383KB·supabase 211KB·react 157KB·query 101KB).
- **이유**: Vite 의 500KB 청크 경고 해소 + 벤더 캐시 분리(앱 코드만 바뀌면 무거운 recharts/supabase 청크는 재다운로드 안 함). 빌드 설정만 변경 — 앱 코드·런타임 무영향(라우트 lazy/Suspense 도입 안 함, 마감 시점 회귀 위험 회피).
- **영향**: `npm run build` 경고 없이 통과. 추가 최적화(라우트 코드 스플리팅)는 필요 시 후속.

## 2026-06-03 · 계정관리 계층 위임

### D38. 계정관리 = admin 단독 → 상위→하위 계층 위임 (실장·팀장에게 본인 하위 직원 관리 위임)
- **결정**: 사용자 요청("총괄관리자에서 하위 관리자 관리 + 하이라키 권한", 옵션 "계층 위임" 확정)에 따라 `/admins` 계정관리를 admin 전용에서 **상위→하위 위임**으로 확장.
  - 권한 규칙(`lib/permissions.ts`): `canManageStaff(actor,target)` = admin 은 전원 true / 그 외는 `ROLE_ORDER` 인덱스로 자신보다 하위만 / 팀장(leader)은 추가로 `teamId` 일치(본인 팀)만. `assignableRoles(actor)` = admin → 전원(자신 포함), 그 외 → 자신보다 하위만.
  - 화면(`AdminsPage.tsx`): 목록을 `canManageStaff(me,·)` 로 스코프(admin=전원, 실장=팀장·담당, 팀장=본인팀 담당) / 역할 드롭다운을 `assignableRoles(me.role)` 로 제한 / 본인 행 편집 시 역할 select 잠금(+안내) / 팀장은 팀 select 를 본인 팀으로 고정 / "권한관리" 버튼은 admin 에게만 노출 / 비활성화 버튼은 본인(isMe) 비활성.
  - 서버측(mock, `admins/api.ts`): `useSaveStaff`·`useToggleStaffActive` 진입부에서 동일 가드를 재검증(부여 역할 범위·대상 관리권한·본인 역할변경/본인 토글 차단) — UI 우회 방지.
  - 메뉴 노출(`DEFAULT_NAV_ACCESS.admins` = `['admin','manager','leader']`): 실장·팀장 사이드바에 '관리자' 노출. `nav_access` 는 시드 스냅샷이므로 `store.ts` DB_VERSION 6→7 로 올려 기존 localStorage 자동 재시드.
  - 매트릭스 편집 분리: `/admins`·`/admins/roles` 가 같은 navKey `'admins'` 를 공유하므로, 권한 매트릭스(`RolesPage`)는 컴포넌트 내부에서 `me.role !== 'admin'` 이면 `<Navigate to="/admins"/>` 로 admin 전용 가드. (별도 navKey 신설 시 매트릭스 행이 늘어나는 부작용 회피.)
- **이유**: §5 역할 계층(admin>manager>leader>rep)을 계정 운영 권한에도 반영. "동급·상위 관리 불가, 본인 역할 변경 불가" 로 권한 상승·자기잠금을 차단. admin 은 슈퍼관리자로 전원 관리(D35/자기잠금 방지와 일관).
- **영향**: 프리뷰 E2E 검증 — admin=5명 전원+권한관리 노출, 실장=팀장·담당 3명(본인·admin 제외)+역할[팀장·담당]+팀 선택 가능+`/admins/roles` 리다이렉트, 팀장=본인팀 담당 1명만+역할[담당]+팀 1팀 고정, admin 본인 편집 시 역할 잠금. `tsc --noEmit`·`vite build`(3595 모듈) 통과, 콘솔 에러 없음. **라이브(M단계) 미반영**: 현재 `supa.ts` staff 쓰기는 security-definer RPC 로 admin 전용이라, 실장·팀장 위임을 라이브에서 살리려면 `supabase/migrations/0002_rls.sql` 에 동일 계층(상위→하위, 팀장=팀 스코프) staff write 정책 추가가 필요 → `TODO(live-verify)` 로 표시, dataSource=mock 유지(M8 게이트).

## 2026-06-04 · 정의현 차장 현장 피드백 v0.2 (입력/배분·초기화·고정제외·문자)

> 현장 피드백 4건. "입력/배분이 가장 중요". mock-first 구현 후 M8 라이브에 함께 반영. 항목별 사용자 확정 답변 반영.

### D39. 자동배분 = '자동배분 대상' 플래그 풀 + 실행 시 임시 가감 (지정 담당자만 라운드로빈)
- **결정**: 기존 자동할당은 *활성 rep 전원* 라운드로빈이라 "지정한 담당자만 자동배분"(차장 요구)이 불가능 → **풀 지정 메커니즘** 도입.
  - 데이터: `Staff.auto_assign_enabled: boolean` 추가(타입·시드·`0001_schema.sql` staff 컬럼 `default false`). 시드 = rep 2명 true, 그 외 false. `store.ts` DB_VERSION 7→8 로 기존 localStorage 자동 재시드.
  - 풀 헬퍼(`lib/staff.ts`): `assignableReps()` = 활성 rep **중 플래그 ON** 만(자동배분 기본 풀). `autoAssignCandidates()` = 활성 rep 전체(모달에서 가감용 후보).
  - 실행(`members/api.ts useAutoAssign`, `members/supa.ts autoAssign`): `staffIds?: string[]` 인자 추가 — 지정 시 그 풀, 없으면 `assignableReps()`. 라운드로빈 후 로그 meta 에 `{count, pool}` 기록.
  - UI 1(`members/bulk.tsx` 자동할당): ConfirmModal → Modal 로 교체. 활성 rep 체크박스 목록, 기본 풀(플래그 ON)은 사전 체크 + '기본' 칩, 전체/해제, "대상 N명" 카운트. 체크된 staffIds 만 배정 → **이번 실행에 한해 가감**(확정 답변: "기본은 플래그, 실행 시 임시 가감").
  - UI 2(`admins/AdminsPage.tsx`): 운영자 편집 Drawer 에 rep 한정 '자동배분 대상' 체크박스(`role==='rep'` 일 때만, 비-rep 은 저장 시 false 강제). 목록 역할셀에 풀 멤버는 '자동'(accent) 칩.
- **이유**: 차장 피드백 "자동으로 배분시에도 지정한 담당자들만 자동배분". 플래그(운영 기본값) + 실행 시 가감(유연성) 2단을 모두 충족. 풀 비면 배정 0(no-op).
- **영향**: 프리뷰 E2E — v8 재시드(rep1·rep2 플래그 ON), /admins 역할셀 '자동' 칩 표시, 편집 Drawer rep 체크박스 노출. 자동할당 모달에서 담당 최 해제(풀=담당 박 1명) 후 3건 실행 → 신규 assignment 3건 전부 `staff-rep1`, 로그 `{count:3, pool:1}` 확인(rep2 제외 입증). `tsc --noEmit`·`vite build`(3595 모듈) 통과. **라이브 staff 테이블**: 이미 0001 을 적재한 DB 는 컬럼 추가 ALTER 필요(`alter table staff add column auto_assign_enabled boolean not null default false;`) — M8 체크리스트.

### D40. 회원 단건 등록(DB 입력 ①) — useCreateMember + 신규 리드 기본값 + user_id 자동 채번
- **결정**: `members/api.ts useCreateMember`(+`supa.createMember` 미러) + `MemberCreateDrawer`(rhf+zod). 신규 리드 기본값 = **미배분·무료(free)·정상(active)·미아웃콜(false)**. `user_id`(로그인 ID)는 기존 `pl####` 최대값+1 자동 채번. 담당자 지정 시 manual `assignment` 동반 생성. **전화 중복 허용**(차장 확정) + `meta.dup_phone` 로 표시. MembersPage 헤더에 '신규 등록' 버튼(rep 제외 노출 — DB 입력은 관리 기능).
- **이유**: 차장 "DB 입력" 핵심. 기존엔 회원 생성 경로 자체가 없었음(조회 전용) → 단건 입력 신설. 중복은 허용(차장 확정, V2-3 임포트와 동일 정책).
- **영향**: 프리뷰 E2E — 등록 시 회원 160→161, 신규 행이 최상단(최신가입), **오늘가입 카운트 8→9 즉시 반영(§8)**, manual assignment 1건 + `member.create` 로그(dup:false). `tsc`·`vite build`(3595 모듈) 통과. 라이브도 동일(`supa.createMember`).

### D41. 엑셀/CSV 일괄 임포트(DB 입력 ②) — SheetJS 파싱 + 자동 컬럼매핑 + 중복표시 + 청크 insert
- **결정**: `members/import.ts`(`parseLeadFile`: CSV 는 UTF-8/EUC-KR 디코드 후 `type:'string'`, 엑셀은 `type:'array'`; `autoMapHeaders` 키워드 자동매핑) + `ImportMembersModal`(업로드→컬럼매핑→미리보기→결과 4스텝) + `useBulkImportMembers`(+`supa.bulkImportMembers`, 청크 500건). 공통값(유입코드·분류·등급·담당자 일괄)으로 빈 컬럼 보강. 유효성 = **이름·전화 필수**(미충족 행 제외). **전화 중복 허용 + `meta.dup_phone` 표시**(파일 내 + 기존 DB 모두 검사). 단건/일괄 기본값은 `buildLeadMember` 로 단일화.
- **이유**: 차장 "DB 입력" 핵심(엑셀/CSV 둘 다 + 중복 허용 — 확정). 한국 엑셀 CSV 는 CP949(EUC-KR) 가 많아 **인코딩 폴백 필수** — 브라우저 검증 중 UTF-8 강제읽기로 한글 헤더 mojibake(`ì´ë¦`) 발견·수정.
- **영향**: 프리뷰 E2E — CSV 5행(유효4·무효1·파일내중복1) 임포트 시 회원 160→164, `박중복`만 `meta.dup_phone`, `이름없음행` 제외, 로그 `{count:4, dup:1}`, **오늘가입·담당미지정 카운트 즉시 반영(§8)**. `tsc`·`vite build` 통과. **보안**: `xlsx@0.18.5` 는 알려진 CVE(prototype pollution 등) 존재 → 내부 신뢰 업로드 한정으로 수용, 프로덕션 강화 시 패치 SheetJS 빌드로 교체(코드 TODO + ASSUMPTIONS 기록).

### D42. 문자 실발송 = OneShot/SMTNT(msgagent) REST 연동 — Edge Function 프록시 + 설정 토글
- **결정**: 매뉴얼(Agent2 Webshot REST V2.6.4) 기준. 단건 발송 `POST https://api2.msgagent.com/api/webshot/send/general/{msgType}/{id}`(multipart/form-data; id·dest_phone·send_phone·msg_body[·subject]). **인증 = 요청 IP/도메인 화이트리스트, API 키 없음**(웹패널 PW 는 API 에 미사용). 구현:
  - `supabase/functions/send-sms/index.ts`(Deno Edge Function) — multipart 구성·OneShot 호출·result_code/cmid 파싱. ONESHOT_ID/SEND_PHONE 은 함수 시크릿.
  - `src/lib/oneshot.ts` — SMS(≤90byte)/LMS 자동분류(`koByteLength`), 결과코드·전송결과 맵, `supabase.functions.invoke('send-sms')` 어댑터.
  - `SmsSettings` 확장: `oneshot_enabled`(실발송 토글)·`ad_optout`(무료거부 번호). `sender_no`=발신번호, `smtnt_id`=OneShot 아이디, `smtnt_key`=미사용(키 없음). 설정 '문자 설정' 카드 갱신.
  - `useSendSms`: `oneshot_enabled && supabase && sender_no` 일 때 수신자별 `sendOneShot` 실발송(상태=성공/실패), 아니면 기존 mock 기록. 마케팅 문자는 `ad_optout` 있으면 본문에 `(광고)`+무료거부 자동표기.
- **이유**: 차장 "이 업체로 문자전송 연결". IP 화이트리스트 + CORS 로 브라우저 직접 호출 불가 → 서버 경유 필수. 키가 없어 site_settings 노출 우려도 없음(아이디·발신번호는 비밀 아님).
- **영향**: `tsc`·`build` 통과. xlsx 를 정적→**동적 import**로 바꿔 메인 번들 433KB 유지(xlsx 429KB 별도 lazy 청크, 500KB 경고 해소). 설정 카드 OneShot 필드 4종 렌더, mock 발송 정상(`real:false`). **실발송은 고의 미실행**(비용+발신동작=운영자 승인 필요). **라이브 게이트(운영자)**: ① `supabase functions deploy send-sms` ② `ONESHOT_ID`/`ONESHOT_SEND_PHONE` 시크릿 ③ **호출 서버 IP/도메인을 OneShot 에 등록** — 서버리스 egress IP 는 가변이라 도메인 등록 또는 정적 IP 프록시 필요(차장↔OneShot 확인) ④ 발신번호 사전등록 ⑤ 설정 실발송 ON + 테스트 1건. msgType path 값(`SMS` 문자열 vs `4`)은 첫 테스트로 확인(실패 시 1줄 교체).

### D43. DB 초기화(재사용) — 신규 리드 상태 완전 리셋 + 콜메모 소프트삭제(admin 전용) + 결제 보존
- **결정**: `useResetMembers`(+`supa.resetMembers`) — 선택 회원을 입력 시점 상태로 되돌린다: 등급→무료·상태→정상·담당/팀 해제·아웃콜/성향/최근접속/상태플래그 초기화. **콜메모(`member.memo`)는 소프트삭제 → `meta.reset_memos[]`(body·archived_at·reset_by)로 보존**하고, 회원 상세 메모탭에서 **최고관리자(admin)만 '초기화로 삭제된 콜메모'로 열람**. 결제행은 물리삭제 금지(감사 보존). 배정해제 이력 + `member.reset_db` 로그. `bulk.tsx` 'DB초기화' 위험 액션(ConfirmModal, tone=danger).
- **이유**: 차장 "한번 쓴 DB 를 1~2일 후 재사용, 입력 시점 상태로 초기화" + "최고관리자는 삭제된 메모도 열람"(확정: 옵션3 완전초기화 + 콜메모 admin 한정). 결제는 금전·감사 기록이라 회원이 신규로 돌아가도 행은 보존(비가역 삭제 회피).
- **영향**: 프리뷰 E2E — `m_1004`(골드·팀장배정·메모 '관심 높음'·결제 1건) 초기화 시 → 무료·미배분·성향 null·메모 null, `reset_memos=[{body:'관심 높음', reset_by:'staff-admin'}]`, **결제 1건 보존**, 로그 `{count:1}`, 확인모달 문구·결제내역 탭 보존 확인. `tsc`·`build` 통과. 드로어 메모탭의 admin 전용 표시는 Drawer 가 `createPortal(document.body)`라 **자동 클릭이 React 합성이벤트를 못 타** 미검증(실사용 정상) — JSX 가드(`role==='admin' && reset_memos.length`)와 데이터로 검증.

### D44. 고정/제외 효력일자 + 회차별 이력 — 토요일 입력→익주 월요일 적용, 활성 규칙만 추천 반영
- **결정**: `site_settings.lotto_exclude_history[]`(`LottoExcludeRule`: round_no·fixed·excluded·effective_from·created_at·created_by). `LottoExcludePage` 를 즉시저장형 → **회차 예약형**으로 개편: 적용회차(기본 최신+1) · 적용시작일(기본 **익주 월요일**) + 1~45 그리드 + '이력에 추가' + **회차별 이력 테이블**(상태=예정/적용중/이전). `useLottoExclude`(lotto/api) `select` 가 **effective_from<=오늘 중 최신(활성)** 규칙을 추천 생성에 적용, 없으면 레거시 `lotto_exclude` 폴백. 저장 시 `lotto_exclude` 를 활성 스냅샷으로 동기화. `DB_VERSION` 8→9 재시드(시드 이력 2건).
- **이유**: 차장 "매주 토요일 입력 → 익주 월요일 적용 + 회차별 이력 리스트". 효력일자로 미래 규칙은 '예정' 대기, 날짜 도달 시 자동 활성(별도 배치 불요).
- **영향**: 프리뷰 E2E — v9 재시드(1179 이전·1180 적용중), 1181 추가 시 `effective_from=2026-06-08`(익주 월요일)·상태 **예정**, **활성 스냅샷은 1180 유지**(미래 규칙 미적용), 이력 테이블 예정/적용중/이전 3상태 정확. `useLottoExclude` 활성=1180(fixed[7]) 확인. `tsc`·`build` 통과. 자정 경과 시 활성 갱신은 settings 쿼리 리패치 시점에 반영(데일리 운영툴 허용). 라이브: site_settings jsonb 에 history 포함(M8). **TODO(live-verify)**: 토요일 입력 요일 락 여부·실 회차번호 자동매핑(현재 수동, 기본 최신+1).

### D45. 문자 발송 호스팅 = Edge Function → Vercel 함수 + 고정 IP 프록시 (OneShot IP 화이트리스트 대응)
- **결정**: SMTNT 회신 — OneShot 인증은 **요청 IP/도메인 화이트리스트**(도메인 우선→안되면 고정 IP). 서버리스 가변 egress 로는 통과 불가 → **고정 IP 프록시(옵션 A)** 채택. 호스팅을 Supabase Edge Function(Deno, 프록시 지원 불확실)에서 **Vercel 서버리스 함수 `api/send-sms`(Node + `undici` ProxyAgent)**로 전환. 클라이언트 `lib/oneshot.ts` 는 `supabase.functions.invoke` → `fetch('/api/send-sms')`. `useSendSms` 실발송 게이트도 `!!supabase` 제거(=`oneshot_enabled && sender_no`). env: `ONESHOT_ID`·`ONESHOT_SEND_PHONE`·`PROXY_URL`(고정IP)·`ONESHOT_RESELLER`(특부가만).
- **이유**: Node 의 프록시 지원이 확실하고 앱이 이미 Vercel. 프록시의 **고정 IP 1개만 OneShot 에 등록**하면 서버리스에서도 발송 가능. (브라우저 직접 호출은 IP/CORS 로 불가, 키는 애초에 없음.)
- **영향**: `supabase/functions/send-sms` 제거, `undici` 의존성 추가(api/ 전용 — Vite 앱 번들 미포함, tsconfig include=src 밖이라 앱 tsc 무영향). `tsc`·`build` 통과. 발신번호 = **1522-6385(`15226385`)** OneShot 등록 확인(사용가능). **미검증(고의)**: 프록시 IP 확보·OneShot 등록·실발송은 비용+발신동작이라 운영자 절차 후. 게이트: ① 고정IP 프록시 가입→`PROXY_URL`·고정IP ② 그 IP 를 OneShot 에 등록(1566-6639) ③ 특부가 여부(아니면 resellerCode 생략) ④ Vercel env 설정 ⑤ 배포 + 설정 실발송 ON + 테스트 1건. 참고: 가능하면 KR/아시아 IP 프록시 권장(지연·차단 리스크↓), 여의치 않으면 KR VPS(옵션 B) 폴백.
- **✅ 실발송 검증 완료(2026-06-05)**: Fixie(Vercel Marketplace 통합, US-East, Tricycle 무료) 고정 IP 2개(`52.5.155.132`·`52.87.82.133`)를 OneShot(`lotto_dream_api`)에 등록 → `vercel --prod` 배포 → `POST /api/send-sms` curl 테스트 결과 `result_code:0, cmid:84489887` + **실제 단말 수신 확인**. `FIXIE_URL` 은 Fixie-Vercel 통합이 자동 주입(수동 env 불필요). 발신번호 `15226385`(env `ONESHOT_SEND_PHONE`). 운영 한도: Fixie 무료 500건/월(현 사용량 월 246건) — 발송 늘면 유료 전환. IP 화이트리스트는 additive(기존 발송 무영향).

### D46. 프로덕션 라이브 컷오버(M8) — dataSource=supabase 전환 + 라이브 QA·RLS 검증 완료
- **결정**: 프로덕션(Vercel `plus-lotto.vercel.app`)을 mock→**supabase 모드**로 전환. Vercel 프로덕션 env 에 `VITE_SUPABASE_URL`·`VITE_SUPABASE_ANON_KEY`·`VITE_DATA_SOURCE=supabase` 설정 후 `vercel --prod` 재배포(VITE_ 변수는 빌드타임에 번들 주입). 라이브 인증: Auth 사용자 5명(`<login_id>@pluslotto.local`) 생성 + `staff.auth_user_id` 연결, 테스트 비번 `Test1234!` 통일(SQL `crypt`+`email_confirmed_at`). 스키마 catch-up: `staff.auto_assign_enabled`·`site_settings.lotto_exclude_history` ALTER(멱등).
- **이유**: 정차장 QA 핸드오프를 위해 외부 접속 가능한 라이브 URL 필요. 로컬(.env.local supabase) 검증 후 프로덕션 플립.
- **영향(검증 완료 2026-06-05)**: ① 프로덕션 번들 supabase 모드 확정(`index-*.js`에 Supabase URL 주입). ② **라이브 인증 5계정 전부 로그인 OK**. ③ **RLS 계층 스코프 정확** — admin/manager 160건(전체)·leader 86건(팀)·rep01 43건·rep02 46건(본인 담당). ④ 브라우저 E2E — admin01 로그인→대시보드 실시간 KPI(신규8·미아웃콜65·결제대기8/₩264,000) + 이용자 160건·26세그먼트·인라인편집·일괄임포트 렌더, **콘솔 에러 0건**. SMS 함수 env(FIXIE_URL·ONESHOT_ID·ONESHOT_SEND_PHONE) 프로덕션 존재. **잔여**: git main 병합(현 `feat/v0.2-oneshot-live`)=사용자 실행 / D38 계층 staff_write RLS(실장·팀장 위임)=선택 적용 / 라이브 160건은 데모 QA 시드(실데이터는 V2 임포트로 적재). **보안**: service_role 키는 로컬 `.env.local`(gitignore) 한정, 브라우저 미노출(anon=RLS 보호).

### D47. 현장 피드백 1차(디비입력 관련) — 유입구분 콜단계화 + 유입시간 정렬 고정 + 페이지크기 선택 + 콜메모 리스트화 + 관리자 금일 디비 집계
- **결정**: 정의현 차장 카톡 피드백(2026-06-08, "디비입력 관련") 6건 반영.
  1. **유입구분(=유입분류) 재정의**: 채널명(네이버/카카오…)이 아니라 **콜 단계** `신규/하루전부재/하루전거절/이틀전/삼일전`. `inflow_code`(채널, NAVER/KAKAO)와 분리. `INFLOW_TYPES` 를 `features/members/views.ts` 단일 출처로 정의 → bulk·생성·임포트·필터가 공유. 신규 등록 기본값=`신규`.
  2. **유입시간 정렬 고정**: `sortMembers` 타이브레이커를 `registered_at` 내림차순+id 로 고정(`inflowTimeCmp`). 무정렬 기본도 유입시간 desc. 유입분류/기타 수정 후에도 목록 순서 불변.
  3. **유입구분 필터 추가**: FilterBar 5번째 드롭다운(URL `?it=`) + 활성 칩. `MemberFilter.inflowType` 술어 추가.
  4. **페이지 크기 선택**: 50 고정 → `25/50/100/200/500/1000`(`PAGE_SIZE_OPTIONS`). `Pagination`/`DataTablePagination` 에 `pageSizeOptions`+`onPageSizeChange` 추가, URL `?size=`(기본 50 은 생략).
  5. **콜메모 리스트화**: `member.meta.memos[]`(MemoEntry: id·body·author·created_at) 누적. `useAddMemo`(+`supa.addMemo`) append 시 `member.memo`=최신 동기화(컬럼/메모있음 세그먼트 호환). 드로어 메모탭=입력칸+최신순 리스트(작성자·시각). DB초기화는 `meta.memos` 전체를 `reset_memos` 로 아카이브 후 비움.
  6. **관리자 금일 디비**: `useTodayDbCounts`(+`supa.fetchTodayDbCounts`) — 오늘 `assignments`(staff_id·type) 를 관리자별 `{전체/수동/자동}` 집계. 관리자 화면 '금일 디비' 컬럼. 시드: 오늘 유입 회원 배정은 오늘 날짜로 기록(집계 시연).
- **이유**: 운영 현장 용어(콜 단계)와 일치, 리스트 흔들림 방지, 대량 조회 편의, 상담 이력 누적 보존, 관리자별 일일 실적 가시화.
- **영향**: `tsc`·`vite build` 통과(3601 모듈). mock 프리뷰 E2E(admin01) 전 항목 검증 — 유입 컬럼 '신규/KAKAO' 2단, 필터 유입구분 6옵션, `?size=25`→25행, 메모 2건 최신순 누적(이전 보존), 관리자 금일 디비(팀장 이 3=수동2·자동1 등), **콘솔 에러 0**. 공유 순수함수(listFrom/filterMembers/sortMembers)·supabase 쓰기경로 동일 코드라 라이브(supabase) 동작 동치. inflow_type 은 free-text 컬럼이라 라이브 기존 채널값 회원은 잔존(신규 편집부터 콜단계 적용). **TODO(live-verify)**: '금일 디비'=배정 이벤트 기준(중복배정 시 다건) — 차장 확인 후 distinct 회원 기준 전환 가능. 대량(15만) 페이지크기 1000 은 현 클라이언트 슬라이스(서버 페이지네이션 이관 TODO 유효).

### D48. 현장 피드백 2차 — 고정/제외 등급별 규칙 + DB초기화 시 가입일시 갱신
- **결정**: 정의현 차장 피드백 2건 반영.
  1. **고정수/제외수 등급별 지정**: `LottoExcludeRule` 에 `grade: Grade|null`(null=공통). 설정 '로또 고정·제외'에 **대상 등급 선택** 추가, 이력 테이블에 **등급 컬럼** + **등급 그룹별 '적용중'** 산정(`activeIds`). 추천(`resolveExcludeForGrade`): 선택 등급 활성 규칙 → 없으면 공통(grade=null) → 없으면 레거시 `lotto_exclude` 폴백. `useLottoExclude` 는 SiteSettings 반환(select 제거), `RecommendPage` 에 **대상 등급 셀렉트** 추가(등급 변경 시 결과 무효화). 레거시 스냅샷은 공통 활성 규칙으로 동기화.
  2. **DB초기화 시 가입일시=초기화 시점**: `useResetMembers`(+`supa.resetMembers`) 가 `registered_at`=초기화 ts 로 갱신(재사용 신규 리드는 입력=초기화 시점이 자연스러움). 확인모달 문구에 명시. supa 경로도 `meta.memos` 아카이브 정합성 보강.
- **이유**: 등급(유료 티어)별로 추천 번호 구성을 달리 운영, 초기화된 디비를 '오늘 들어온 신규'로 취급(리스트 상단 노출·금일 디비 집계 일관).
- **영향**: `DB_VERSION` 9→10 재시드(공통 1179/1180 + **VIP 1180 데모 규칙** fixed[17]·excluded[1,45]). `tsc`·`vite build`(3601 모듈) 통과. mock 프리뷰 E2E — 추천 공통 고정수=[7]/VIP 고정수=[17] 분기 확인, 설정 이력 등급 컬럼(공통/VIP 각각 '적용중'), DB초기화 시 pl1086 가입일시 `2026-04-08`→`2026-06-08`(초기화 시점) 이동 확인, **콘솔 에러 0**. 라이브 호환: 기존 history 규칙은 `grade` 누락 → `grade ?? null`=공통 처리(폴백 안전). site_settings jsonb 는 `select('*')` 통과라 grade 보존. **TODO(live-verify)**: 등급별 규칙을 어느 등급까지 운영할지(현재 8등급+공통 전체 노출)·추천 발송 시 회원 등급 자동 매핑 여부.

### D49. 무료회원 주간 자동발급(매주 금 09:00, 30조합, 문자발송 X) + 홈페이지 자격증명(전화/뒷4자리)
- **결정**: 정의현 차장 피드백. 운영콘솔에는 **발급·저장·조회 + 자격증명**만 구현(차장 확정: 고객 홈페이지는 별도 프론트). 조합 생성은 **기존 추천엔진**(`generateRecommendation`) 사용(차장 확정).
  - **데이터**: `SiteSettings.weekly_free_reco { enabled, set_count(기본 30) }` + `member.meta.weekly_recos: WeeklyRecoIssue[]`(round_no·issued_at·sets, 최근 8회 보관).
  - **발급 로직** `useIssueWeeklyFreeReco`(+`supa.issueWeeklyFreeReco`): 무료회원 전원에게 대상 회차(=최신 회차+1) 조합 `set_count`개 생성(회원별 결정적 시드 → 회원마다 다른 번호, 무료등급 고정/제외 규칙 적용→없으면 공통 폴백). **문자 발송 없음**, `reco.weekly_issue` 로그. **멱등**(이미 해당 회차 받은 회원 skip). 자동 스케줄(금 09:00)은 운영 환경 예약함수(pg_cron/Edge)가 동일 로직 호출 — 콘솔엔 **수동 트리거 '지금 발급'**(admin/manager) 제공.
  - **조회**: 회원 상세 **'발급번호' 탭**(회차·30세트 LottoBalls) + 기본정보에 **홈페이지 ID(전화번호)/PW(뒷4자리)** 표시. `lib/homepage.ts`(`homepageId`/`homepagePw`)로 파생.
  - **설정**: 설정›로또 고정·제외에 '무료회원 주간 발급' 카드(사용 토글 + 발급 조합수).
- **이유**: 무료회원 리텐션(매주 무료 번호 제공)을 문자비용 없이 홈페이지 유도로 운영. 자격증명 기본세팅(전화/뒷4자리)은 고객 진입장벽 최소화. 콘솔은 발급/조회 책임만, 고객 홈페이지·실제 크론은 별도 인프라(기존 OneShot·효력일자 패턴과 동일하게 게이트).
- **영향**: `DB_VERSION` 10→11 재시드(site_settings.weekly_free_reco 기본값). `tsc`·`vite build`(3601 모듈) 통과. mock 프리뷰 E2E(admin01) — 추천화면 발급카드(대상 무료 48명·30세트), '지금 발급'→**1181회 48명 발급 완료**(멱등 재실행 시 skip), 회원 드로어 발급번호 탭 30세트(전세트 고정수 7 포함=공통 규칙)·홈페이지 ID `01050338493`/PW `8493`(=010-5033-8493 뒷4자리), 설정 카드 렌더, **콘솔 에러 0**. 라이브 호환: weekly_free_reco 누락 시 기본값(30) 폴백, member.meta jsonb 에 weekly_recos 저장. **TODO(live-verify)**: ① 금 09:00 예약함수 배포(Supabase pg_cron 또는 scheduled Edge Function)가 `issueWeeklyFreeReco` 호출 ② 고객 홈페이지(전화/뒷4자리 인증 + 본인 weekly_recos 조회)는 별도 프론트 — anon 키로 본인 행만 읽도록 RLS/RPC 설계 필요 ③ 15만 무료회원 대량 발급은 서버측 배치(RPC/Edge)로 이관(현 행단위 update 는 데모 규모) ④ 비밀번호 변경 시 저장 위치(홈페이지측).

### D50. 현장 피드백 — 유입구분 '구디비' 추가 + 상담상태 신규 필드 + 유입코드 필터 동적화
- **결정**: 정의현 차장 피드백 3건.
  1. **유입구분 '구디비' 추가**: `INFLOW_TYPES` 에 '구디비' 추가(신규/하루전부재/하루전거절/이틀전/삼일전/구디비).
  2. **상담상태(consult_status) 신규 필드**: `신규/결번/부재/가망/승인/통화예약/도입거절/일반거절/기타`. 라이브 `members.consult_status text` 컬럼 추가(apply_migration `add_members_consult_status`). 회원 등록 폼·상세(빠른액션 인라인+기본정보)·테이블 인라인 컬럼·임포트 매핑·이용자 필터(?cs=) 전반 반영. 신규 등록 기본값 '신규'.
  3. **유입코드 필터 동적화**: 기존 하드코딩(NAVER/KAKAO 6종) → **실제 데이터의 distinct inflow_code**로 채움(`useInflowCodes`/`supa.fetchInflowCodes`). 라이브 실데이터는 secret·dc-news·l1·kp 등 다수 코드라 하드코딩으론 필터 불가였음(빨간박스 미동작 원인).
- **이유**: 라이브 데이터 확인 결과 inflow_code 가 임포트 배치별 실코드 다수(고정 목록 불가) → 동적화가 정답. consult_status 는 텔레마케팅 콜 결과 추적 핵심 필드라 실컬럼으로(필터/리포트 대비). 유입구분은 고정 카테고리라 드롭다운 유지.
- **영향**: 라이브 마이그레이션 적용 완료(nullable, 기존행 영향 없음). `DB_VERSION` 11→12 재시드(consult_status 분포 + 구디비). `tsc`·`vite build` 통과. mock E2E — 유입코드 동적(BANNER/FB/KAKAO/NAVER/REF/TOSS), 유입구분 구디비 포함, 상담상태 9종 필터(`?cs=가망` 27건 정합)·인라인 컬럼·등록폼 확인, 콘솔 에러 0. **TODO(live-verify)**: 기존 라이브 회원 consult_status=null(신규 입력부터 채워짐, 필요시 일괄 '신규' 백필)·유입구분 옛 채널명 데이터 잔존(점진 정리).

### D51. 역할 명칭변경 + 권한/스코프 개편 (현장 피드백)
- **결정**: 정의현 차장 피드백 — 역할 라벨 변경 + 데이터 스코프/기능 권한 재정의(내부 role 키 admin/manager/leader/rep 는 유지, 표시 라벨만 변경).
  - **명칭변경**: admin=**최고관리자** > manager=**관리자**(최고관리자 준하는 권한) > leader=**실장**(일부 기능 제외) > rep=**팀장**(본인 회원만). `ROLE_LABEL` + 데모 로그인 라벨.
  - **데이터 스코프**: 최고관리자·관리자·**실장=전체 이용자**, 팀장=본인 담당만. (실장이 기존 팀 한정 → 전체로 확대) — mock `scopeMembers` + 라이브 RLS `members_rw` 정책 갱신(leader 를 all 분기에 포함).
  - **유입코드/유입구분 노출**: **최고관리자만**. 그 외(관리자·실장·팀장)에는 이용자 테이블 '유입' 컬럼·필터·상세 행 모두 숨김. (`memberColumnVisibility`, MembersPage 필터 가드, MemberDrawer 정보행 가드)
  - **디비 배분·입력·담당자 변경 = 최고관리자만**: 신규 등록/일괄 임포트 버튼, 셀 인라인 담당 변경(`canEditStaff`), 상세 담당 셀렉트(그 외 읽기전용), 일괄작업 바의 담당배정/자동할당/담당리셋/유입분류/DB초기화 모두 admin 가드. 상태변경·문자발송은 전 역할 유지.
- **이유**: 운영조직 명칭 체계 정렬 + 정보 보안(유입 출처는 최고관리자 전용) + 디비 배분/담당 변경 권한 집중.
- **영향**: 라이브 RLS 마이그레이션 적용(`members_rls_leader_all_scope`). `tsc`·`vite build` 통과. mock E2E — 데모 라벨 최고관리자/관리자/실장/팀장, 실장 로그인=전체 160건·유입필터/컬럼/상세 없음·등록임포트 없음·상세 담당 읽기전용, 팀장 로그인=본인 47건·일괄작업 상태변경/문자발송만, 콘솔 에러 0. **미해결/후속**: ① 담당자변경 admin-only 의 **RLS 강제**(현재 members_rw 는 manager/leader 도 write 가능 — UI 가드로 1차 통제, 컬럼/트리거 정책은 후속) ② 관리자(manager)의 유입코드/유입구분 가시성은 '최고관리자만' 문구대로 admin-only 로 구현(관리자 포함 여부 차장 확인 시 1줄 조정) ③ 매출 '팀장매출' 등 leader 기반 집계 라벨은 명칭변경 영향 검토 필요(이번 범위 외).

### D52. 회원정보창 추가 — 결제 요청 / 회원별 발송요일·갯수 / 홈페이지 비번 변경 (현장 피드백)
- **결정**: 정의현 차장 `<회원정보창>` 추가 항목을 권장안(자율 진행)으로 구현.
  - **결제 요청**: 회원 상세 결제내역 탭에 상품·결제수단 선택 → '결제 요청' = **대기(wait) 결제 생성**(`useRequestPayment`/`supa.requestPayment`). 최고관리자/관리자가 결제 모듈에서 승인. 담당(팀장)은 본인 회원만 요청·조회(결제 리스트 스코프: 팀장=본인 담당, 그 외=전체로 `scopePayments`/`useMemberSearch` 갱신).
  - **상품**: 결제 요청의 상품 선택(활성 상품, 금액 자동).
  - **회원 등급**: 기존 빠른액션 등급 셀렉트 유지.
  - **조합발송요일/조합발송갯수**: 회원별 개별 지정(`member.meta.weekly_reco_day` 0=일..6=토, `weekly_reco_count`). 미설정 시 전역 기본(금/30). 무료 주간발급 로직이 **회원별 갯수 우선 적용**(mock+supa). 요일은 저장(운영 스케줄러가 사용 — 별도 인프라).
  - **비밀번호 변경**: 홈페이지 로그인 비번을 `member.meta.homepage_pw` 로 재설정(미설정 시 전화 뒷4자리). 상세에 변경 입력 + 표시.
  - 회원 설정/비번/발송 저장은 `useUpdateMemberSettings`(meta 병합, mock+`supa.updateMemberMeta`).
- **이유**: 담당이 본인 회원 결제를 직접 올리되 타 회원 결제는 비노출(스코프), 회원별 발송 커스터마이즈, 홈페이지 비번 운영 관리.
- **영향**: `tsc`·`vite build` 통과. mock E2E(팀장 로그인) — 결제내역 탭 결제 요청 폼(상품 골드 1개월/무통장)→대기 결제 ₩33,000 생성, 기본정보 회원설정 카드(발송요일/갯수/비번), 비번 8888 변경 후 재오픈 시 유지 확인, 담당 셀렉트 읽기전용, 콘솔 에러 0. **TODO(live-verify)**: ① 회원별 '조합발송요일'을 실제로 그날 발송하려면 운영 스케줄러가 매일 돌며 요일 매칭 발송(현재 수동 '지금 발급'은 요일 무시 전체 발급, 요일은 저장만) ② 결제요청 권한/한도(담당이 임의 금액 변경 불가 — 상품가 고정) ③ 등급/발송설정 편집 권한 범위(현재 상세 접근 가능한 전 역할 편집 가능 — 필요시 admin 한정).

### D53. 회원정보창 — 직접 입력 문자발송 + 수동 조합 발급/발송 (현장 피드백 3·4)
- **결정**: 정의현 차장 `<회원정보창>` 3·4번(2026-06-10 카톡).
  - **직접 입력 문자발송**: 문자내역 탭에 자유 본문 textarea + '직접 발송'. `SmsType` 에 `direct`('직접입력') 추가, `useSendCustomSms`(+`supa.sendCustomSms`) — 템플릿 없이 발송, byte/SMS·LMS 표시, 실발송 게이트(oneshot_enabled+sender_no)는 기존과 동일.
  - **수동 조합 발급/발송**: 발급번호 탭에 '수동 발급' 패널(세트 수 입력, 기본=회원별 갯수→30, '문자로도 발송' 체크). `useManualIssueReco`(+`supa.manualIssueReco`) — **회원 등급의 고정/제외 규칙**(resolveExcludeForGrade, 없으면 공통)으로 즉시 생성 → `meta.weekly_recos` 누적(발급번호 탭·홈페이지 노출), 옵션 시 조합 본문 SMS(type=recommend) 발송. `reco.manual_issue` 로그.
  - **구조**: `resolveExcludeForGrade` 를 features/lotto/api → **lib/lotto.ts 로 이동**(members 모듈과 공유, §2 feature 간 직접 import 금지 — lotto/api 는 재노출로 기존 import 호환).
- **이유**: 담당이 템플릿 외 상담 문자를 즉석 발송, 유료회원 등 개별 회원에게 조합을 수동으로 발급·문자 전달(주간 자동발급과 별개 운영 플로우).
- **영향**: `tsc`·`vite build` 통과. mock E2E(팀장 rep01) — 직접 발송 → 문자내역 '직접입력' 기록, 수동 발급 5세트 → 1181회 발급(전 세트 고정수 7=공통 규칙)+추천 SMS 기록, 콘솔 에러 0. **TODO(live-verify)**: ① 기존 `supa.sendSms`(템플릿 발송 live 경로)는 기록만 하고 실발송 미호출 — sendCustomSms/manualIssueReco 는 실발송 게이트 포함으로 구현했으니 템플릿 경로도 정합 필요 ② 수동 발급 권한 범위(현재 상세 접근 가능 전 역할) ③ 조합 LMS 길이(30세트 문자 발송 시 2,000byte 초과 가능 — 분할 발송 검토).

### D54. 고객 포털(/portal) 최소버전 + 금 09:00 자동발급 크론 — 라이브 게이트 2종 해소
- **결정**: 남은 외부 게이트 2종을 본 레포 안에서 해결(차장 "모두 진행" 승인).
  - **고객 포털**: 공개 라우트 `/portal`(셸·staff 인증 밖) — 전화번호+비밀번호(기본 뒷4자리, meta.homepage_pw 우선) 로그인 → 본인 발급번호(회차·세트 LottoBalls) 조회. 모바일 우선 단일 카드 UI. 라이브 인증은 **security-definer RPC `portal_member_recos(p_phone,p_pw)`**(anon 실행 허용, 자격 일치 시 name/grade/recos 만 반환 — members RLS 우회 최소화). mock 은 동일 규칙 로컬 검증. 풀 홈페이지(분석/멤버십/고객센터, ilhanglotto 참고)는 후속 — 현재는 최소 '내 번호 확인'.
  - **자동발급 크론**: `api/weekly-reco.ts`(Vercel 함수) + `vercel.json crons`(매일 00:00 UTC=09:00 KST). 매일 돌며 **회원별 발송요일(meta.weekly_reco_day, 기본 금=5)이 오늘(KST)인 무료회원**에게 발급 — 회원별 갯수 override·회차 멱등·`reco.weekly_issue`(channel=cron) 로그. `?force=1` 수동 트리거. 보안: `CRON_SECRET` Bearer 검증(Vercel 크론 자동 첨부). env `SUPABASE_SERVICE_ROLE_KEY`·`CRON_SECRET` 프로덕션 등록 완료.
  - **구조**: `lib/lotto`·`lib/lottoGenerator` 의 `@/types/db` import 를 상대경로로 변경(api/ 함수가 alias 없이 동일 생성 로직 번들 — 콘솔·크론 단일 출처 유지).
- **이유**: 6/14 데드라인 — 별도 프론트/인프라 없이 기존 Vercel 프로젝트 안에서 포털·크론 모두 충족. RPC 방식이라 향후 독립 홈페이지(별도 도메인)로 분리해도 동일 API 재사용.
- **영향**: 라이브 RPC 검증(정상 로그인 true/오답 거부/미등록 거부). mock E2E — /portal 로그인(변경비번 8888 통과·기본값 거부) → '1181회 추천번호 5조합' 표시, 콘솔 에러 0. `tsc`·`vite build` 통과. **TODO(live-verify)**: ① 배포 후 `force=1` 실발급 1회 검증 ② 포털 rate-limit(현재 없음 — 무차별 대입은 RPC 자격검증만, 필요시 edge rate limit) ③ Vercel Hobby 크론은 일 1회·정시 ±1h 허용 오차 ④ 전화번호 중복 회원은 최신 가입 1명 기준.
- **✅ 라이브 검증 완료(2026-06-10)**: Vercel 프로덕션 배포 후 — `/portal` 200 · 크론 무인증 401 · 시크릿+요일게이트(수요일 207명 day-skip) · `force=1` 실발급 **1181회 207명** · 재실행 멱등(207 skippedRound) · 포털 RPC 로 발급분(1181회) 조회 정합. 단, **Vercel 함수는 api/ 밖 TS 모듈 해석 불가**(ESM ERR_MODULE_NOT_FOUND) → `api/weekly-reco.ts` 를 생성 로직 인라인 **자급자족 단일 파일**로 재구성(원본 src/lib/lottoGenerator 수정 시 동기화 필요 — 헤더 명시). env `SUPABASE_SERVICE_ROLE_KEY`·`CRON_SECRET`(.env.local 보관) 프로덕션 등록.

### D55. 등급별 권한 서버측 강제 — 디비 입력/배분/담당변경 admin-only 트리거 + 실장 종속데이터 정합 (D51 후속 마감)
- **결정**: 차장 피드백(회원정보창·권한) 재점검에서 발견된 라이브 구멍 2건을 `supabase/migrations/0003_admin_only_db_ops.sql` 로 마감.
  1. **실장(leader) 종속 데이터 불일치**: D51 마이그레이션이 members 정책만 leader=전체로 풀고 `app_can_see_member`(결제·문자·배정이 종속)는 팀 스코프로 남음 → 실장이 회원 329명 전체를 보면서 결제는 41/67건만 보임. 함수의 leader 분기를 전체로 갱신(피드백 "실장은 모든 이용자의 정보").
  2. **디비 입력/배분/담당변경 admin-only 가 UI 가드뿐**: 라이브 행동테스트(무변경 PATCH) 결과 **관리자·실장·팀장 전원이 REST 직접 호출로 `assigned_staff_id` 변경 가능**(members_rw 가 쓰기 허용). RLS 는 컬럼 단위 차단 불가 → **BEFORE 트리거 `members_admin_ops`**: INSERT(디비 입력)=admin 외 거부, UPDATE 는 `assigned_staff_id`/`team_id` 변경시에만 admin 검사(상태·메모·문자·회원설정 등 일반 갱신 무영향). `auth.uid() is null`(service_role 크론·시드·SQL Editor)은 면제. assignments 는 select=가시회원/insert=admin/update·delete=거부(이력 불변)로 분리.
- **이유**: "담당자 변경·디비 배분·입력은 최고관리자만"은 보안 요구라 클라 가드만으론 미충족(API 우회 가능). 트리거는 어떤 정책/경로로 들어와도 강제됨.
- **영향**: **✅ 라이브 적용+검증 완료(2026-06-10)** — 실제 담당변경 시도: 관리자/실장/팀장 전부 `담당자 변경(디비 배분)은 최고관리자만 가능합니다` 거부, admin 만 변경 성공(테스트 후 원복·최종값 무변경 확인). 디비 입력: 실장 INSERT `회원 입력(디비 입력)은 최고관리자만 가능합니다` 거부. 일반 수정(상담상태 등)은 관리자·팀장 정상 허용(트리거가 담당/팀 변경시에만 검사). service_role(크론·시드) 면제 정상. 실장 payments 41→67(전체) 정합. 주의: 무변경(no-op) PATCH 는 '변경 없음'이라 트리거 통과가 정상(허용으로 오인 금지). 관리자(manager)도 차단·유입 숨김 대상(피드백 문구 "최고관리자만" 직역 — 관리자 허용 원하면 트리거 `app_role() is distinct from 'admin'` 을 `not in ('admin','manager')` 로 1줄 조정). mock 경로는 UI 가드 유지(데모 전용). 앱 코드 무변경(SQL 만).

### D56. 현장 피드백 6/10 오후 — 이용자 중복/가입일 필터 + 배정이력·메모삭제 권한 + 등급 일괄발급·로직비율
- **결정**: 카톡(6/10 15:48~16:05) 미반영분 일괄 반영. (추천번호 임의 제외수·등급별 이력, 로또기록 엑셀·등수별 누적은 타 계정 세션에서 기반영 확인)
  1. **이용자 필터 '중복'**: 전화번호(숫자)가 2건 이상 등록된 디비만(`dupPhone` — 동적 계산, URL `?dup=1`).
  2. **이용자 필터 '가입일'**: from/to date 범위(`?rf=&rt=`, 로컬 날짜 기준 포함 비교).
  3. **배정이력 = 최고관리자만**(<회원정보창> 6): 드로어 탭·내용 admin 가드.
  4. **메모 삭제 = 최고관리자**(<회원정보창> 7): MemoEntry 소프트삭제(deleted_at/by). admin=삭제 버튼+삭제분 취소선 '삭제됨' 표시, 그 외 역할=삭제분 비표시. member.memo 는 미삭제 최신으로 동기화. `member.memo_delete` 로그.
  5. **등급별 일괄 발급**(<추천번호> 4): 추천번호 발급 카드에 등급 셀렉트(8등급) — `useIssueGradeReco`/`issueGradeReco` 가 해당 등급 전원에게 발급(등급 고정/제외 규칙 적용, 멱등, 문자 X). 기존 무료 전용 훅 대체(`useWeeklyRecoStatus(grade)`).
  6. **회원별 저장 조합수 적용**(<추천번호> 5): 모든 발급 경로(콘솔 일괄·크론)에서 `meta.weekly_reco_count` 우선, 없으면 전역 기본.
  7. **로직:랜덤 비율**(<추천번호> 6): `weekly_free_reco.logic_ratio`(%) — 발급 N세트 = 로직 round(N×r%) + 완전랜덤 나머지(중복 조합 회피). 공유 헬퍼 `lib/lottoGenerator.generateIssueSets` — 콘솔 일괄·수동 발급·크론(인라인 사본) 전 경로 적용. 설정 카드('추천조합 발급 설정')에 비율 입력.
- **영향**: `tsc`(앱+크론 단독)·`vite build` 통과. mock E2E — 중복 필터(동일번호 등록 후 정확히 2건), 가입일 범위(6/1~6/9=31건+칩), 배정이력 탭 admin 표시/팀장 숨김, 메모 삭제(admin 버튼·삭제됨 취소선/팀장 버튼 없음), 골드 일괄 발급 13명·1181회, **logic_ratio 70% → 30세트 중 고정수 포함 22(로직 21+랜덤 우연)** 정합, 콘솔 에러 0. **TODO(live-verify)**: ① 중복 필터는 클라 계산(15만 시 서버 이관 대상) ② 랜덤 조합은 품질필터 미적용('완전랜덤' 직역 — 적용 원하면 1줄) ③ 메모 소프트삭제의 서버측 강제(현 UI 가드, 트리거 후보).

### D57. 현장 피드백 6/11 — 유료 자동발송·역할 메뉴 축소·결제 날짜필터·등급별 약관
- **결정**: 카톡(6/11 오전) 4건 반영.
  1. **유료회원 자동발송**(<추천번호> 7): 크론을 전 등급으로 확장 — 무료=기본 금요일(회원별 weekly_reco_day 우선), **그 외 등급=회원정보창에 발송요일이 설정된 회원만** 그 요일에 자동 발급(미설정 유료는 수동/등급일괄만). 등급별 고정/제외 규칙 캐시 적용, 회원별 갯수·로직비율 동일.
  2. **메인메뉴 축소**: 팀장(rep)=이용자·나의고객만 / 실장(leader)=로또기록·추천번호 제외. `DEFAULT_NAV_ACCESS` + 라이브 `nav_access` UPDATE(`nav_access_role_menu_v2`) + 랜딩 분기 `RoleHome`(팀장→/members, LoginPage 기본 from='/'). 권한 매트릭스 화면에서 운영 중 조정 가능(기존 기능).
  3. **결제내역 날짜 필터**(<결제> 2): 결제일(paid_at, 미승인=created_at) from/to 범위(`?rf/?rt`) + 칩.
  4. **등급별 이용약관**(<설정> 1): `site_settings.terms_by_grade`(등급→본문, 미설정 등급은 공통 폴백). 설정>이용약관을 '공통(기본)+8등급 탭'으로 개편(● = 전용 약관 있음).
- **영향**: `DB_VERSION` 12→13. `tsc`(앱+크론)·`build` 통과. mock E2E — 팀장 랜딩 /members·메뉴 [이용자, 나의고객]만, 실장 메뉴에서 lotto 부재, 결제 5월 범위 37/67건+칩, 약관 골드 탭 저장 → terms_by_grade.gold + ● 표시, 콘솔 에러 0. 라이브 nav_access 갱신 적용. **미해결**: <결제> 1번 문구가 카톡 캡처에서 잘림 — 차장 재전달 요청. 약관 노출처(가입/결제 화면)는 고객 프론트 영역 — terms_by_grade 폴백 규칙 문서화.

### D58. 결제요청 금액 수기 입력 (<결제> 1 — 잘렸던 문구 확인분)
- **결정**: 회원정보창 결제요청에 **금액 입력칸** 추가 — 상품 선택 시 상품가가 기본값으로 채워지고 수기 수정 가능. 상품가와 다르면 안내 문구 표시. 요청은 입력 금액으로 '대기' 결제 생성(승인 흐름 동일).
- **영향**: `tsc`·`build` 통과. mock E2E — 골드(33,000) 선택 → 기본값 33000 자동, 25000 수정 → '상품가와 다름' 힌트 + 대기 결제 amount=25000 생성, 콘솔 에러 0.

### D59. 역대 회차 실데이터 적재(1~1227) + PostgREST 1000행 캡 수정
- **결정**: 차장 승인("역대회차 데이터는 일괄 등록")에 따라 라이브 `lotto_rounds`를 동행복권 **공식 데이터 1~1227회**로 교체(QA 가짜 16회 덮어씀).
  - **수집**: 동행복권 사이트 개편(6/9 점검)으로 구 API(`common.do?getLottoNumber`)·curl 전부 WAF 차단 → 실제 Chrome(브라우저 자동화)에서 **신규 내부 API `/lt645/selectPstLt645Info.do?srchStrLtEpsd=&srchEndLtEpsd=`**(범위 조회, 번호·보너스·추첨일·1~3등 1게임당 당첨금·총판매금액)를 100회 단위로 호출해 1,227회 전량 수집(Blob 다운로드로 회수).
  - **검증(3중)**: 공식↔smok95/lotto(262~1227) **966회 전수 일치** / 공식↔happylie(1~1204) 1070·1071 불일치 → 공식 단건 조회로 **happylie 스왑 오류 확정**(공식이 기준) / 전 회차 토요일 추첨·번호 유효성 전수 통과. 적재는 **공식 데이터만** 사용. 백업: `supabase/seed-data/lotto_rounds_1-1227.json`.
  - **버그 수정**: 적재 후 크론 target 이 1181로 나오는 회귀 발견 — **PostgREST 기본 1000행 캡**으로 `select('*')` 가 잘림. `lib/db/remote.selectAll` 을 range 페이지네이션으로 전환(로또기록·통계 등 fetchTables 전 소비처 해소), 발급 경로 3곳(lotto/supa·members/supa·크론)도 페이지네이션 적용(크론은 members 조회도 — 15만 대비).
- **영향**: 라이브 1,227행(1회 10,23,29,33,37,40+16 ~ 1227회 1,14,16,34,41,44+13, 전회차 확정). 크론 재실행 → **1228회 208명 발급**(무료 207+금요일 유료 1, 멱등 재확인) · 포털 RPC 1228회 30조합 노출 ✓. 토(6/13) 1228 추첨 후 결과 등록하면 다음 발급 자동 1229. **TODO(live-verify)**: 1~261회 prize_1~3 은 공식 API 미제공 시기라 null 가능(표시 0원) — 통계·발급엔 무관.

### D60. 문자 설정(및 전체 site_settings) 저장 실패 버그 — 라이브 누락 컬럼 추가 (0004)
- **원인**: 라이브 `site_settings` 에 `weekly_free_reco`(D49)·`terms_by_grade`(D57) 컬럼이 ALTER 누락. `settings/supa.saveSiteSettings` 가 `update({ ...next })` 로 SiteSettings 전체를 쓰므로, 없는 컬럼에서 **PGRST204**("Could not find the 'weekly_free_reco' column ... in the schema cache") → 발신번호·실발송 포함 **모든 설정 저장이 통째로 실패**. (차장 6/18 "문자설정 저장이 안 된다" 신고로 발견)
- **수정**: `supabase/migrations/0004_settings_missing_columns.sql` — 두 컬럼 `add column if not exists`(jsonb, 기본값).
- **검증(2026-06-18, 라이브)**: 재현 — `weekly_free_reco` 포함 PATCH=PGRST204 실패 / `sms` 단독 PATCH=성공. 적용 후 — 두 컬럼 존재 ✅ / **앱과 동일한 전체 update({...next}) HTTP 200** ✅ / 저장값 재조회 영속 ✅ / 원복.
- **발신번호 흐름(실발송 테스트 가이드)**: 실발송 게이트 = `oneshot_enabled && sender_no`(둘 다 필요). 발송 `send_phone` = **설정 `sms.sender_no`(요청 body)가 env `ONESHOT_SEND_PHONE`(15226385)보다 우선**(`api/send-sms.ts:25`). 현재 라이브 발신번호=`1588-0000` → OneShot 미등록 번호면 `316 발신번호 미등록`으로 실패. **검증된 등록번호=`15226385`**.
- **TODO(재발방지)**: `update({...next})` 는 SiteSettings 필드 추가 시마다 라이브 ALTER 누락에 취약(반복: `lotto_exclude_history`→M8, `weekly_free_reco`/`terms_by_grade`→이번). **새 설정필드 추가 시 마이그레이션 동반을 규칙화**하거나 supa.saveSiteSettings 를 화이트리스트 컬럼만 쓰도록 강화 검토.

### D61. 유료회원 지정요일 조합 SMS 자동발송 (현장 피드백 6/18)
- **결정**: 차장 확정("유료회원에게 지정 요일에 조합을 문자(SMS)로 자동발송", 익주 운영 예정). 크론(`api/weekly-reco.ts`)을 확장 — 유료등급(골드/골드+/VIP/로얄) 중 회원정보창에 발송요일(`meta.weekly_reco_day`)이 설정된 회원에게, 그 요일 09:00 발급 + **조합을 SMS 발송**. 무료회원은 기존대로 발급만(문자 X).
  - **3중 안전 게이트**: `weekly_free_reco.paid_sms`(전용 토글, jsonb 하위필드라 마이그레이션 불요) && `sms.oneshot_enabled`(실발송 마스터) && `sms.sender_no`. 둘 다 ON이어야 실제 발송 → 실발송만 켜도 유료에 자동 안 나가게 분리(오발송 방지).
  - **발송 경로**: 검증된 `/api/send-sms`(Fixie 프록시) 재사용 — 크론이 `fetch(selfBase+'/api/send-sms')` 로 1건씩(selfBase=SELF_BASE_URL‖VERCEL_URL‖plus-lotto.vercel.app). 멱등 — 신규 발급분만 발송(재실행 시 skippedRound→미발송). 발송분 `sms_sends` 기록(type=recommend).
  - **본문(LMS)**: `[플러스로또] {이름}님 {회차}회 추천번호 {N}조합` + 조합목록 + 홈페이지 안내.
  - **UI**: 설정>로또 고정·제외 '추천조합 발급 설정' 카드에 토글 + 경고문(실발송 캐쉬 차감). `WeeklyFreeRecoSettings.paid_sms?` 추가. PAID_GRADES=gold/goldp/vip/royal(MEMBER_VIEWS 'paid' 정의), simple/free/ovr/toss는 발급만.
- **영향**: 앱 빌드(3604모듈)·크론 단독 tsc 통과. 게이트 OFF(현 oneshot_enabled=False·paid_sms 미설정)라 배포해도 자동발송 없음 — 차장이 두 토글 ON + 유료회원 발송요일 설정부터 동작. **운영 주의**: paid_sms+실발송 ON 시 매일 09시 '오늘=발송요일'인 유료회원에게 자동 발송되므로 발송요일 설정한 유료회원 번호 정확성 확인 필수. **TODO**: ① 30조합 LMS 길이(현 ~600byte, 2000 한도 여유) ② mock '지금 발급'은 SMS 미연동(프로덕션 크론 전용; 수동 SMS는 D53 회원정보창) ③ SMS 실패 재시도 없음(발급 성공·SMS best-effort).

### D62. 템플릿 문자 실발송 누락 수정 + '미발송' 라벨 + 죽은 '발송 스케줄' 제거 (현장 6/18)
- **핵심 버그**: supabase 모드에서 `useSendSms`가 `supa.sendSms`만 호출했는데, `supa.sendSms`는 템플릿 문자(가입/추천/당첨/마케팅)를 status='발송완료'로 **기록만 하고 OneShot 을 호출하지 않음** → 운영에서 템플릿 문자가 실제로 안 나감(직접발송 `sendCustomSms`·수동조합 `manualIssueReco` 만 실발송됐음). mock 경로(api.ts)는 sendOneShot 호출했으나 supabase 경로 누락. 차장 6/18 "문자 발송내역 이상" 신고로 발견.
- **수정**: ① `supa.sendSms` 에 실발송 게이트(`realSend = oneshot_enabled && sender_no`) + `sendOneShot` 호출 추가(sendCustomSms 동일 패턴), 마케팅 `(광고)`+무료거부 표기, `fetchSmsConfig` 에 `adOptout` 추가. ② **실발송 OFF면 status='미발송'**(기존 '발송완료' 오인 라벨 → 전 발송경로 supa·mock 일괄). ③ 죽은 '발송 스케줄' 카드(`schedule_*`, 동작 안 하던 잔재) 전면 제거 — `SmsSettings` 타입·zod·toForm·toSettings·UI·seed 6곳. UI 자리엔 '회원별 발송요일은 회원정보창' 안내로 교체.
- **영향**: 앱 빌드(3604모듈) 통과. 발송 `send_phone`=설정 `sms.sender_no`(요청 우선). **검증**: 차장 재발송 시 실수신 + sms_sends 기록 일치 예정. **데이터 참고**: 과거 라이브 sms_sends 의 '발송완료' 중 실발송 OFF 시기 기록은 **실제 미발송분**일 수 있음(라벨만 발송완료였음). 테스트 회원 m_d42878d2(정의현/VIP) 담당=staff-rep1 → 팀장(rep) 계정으로 보면 RLS상 본인 담당만 보이므로, 발송내역 확인은 admin/관리자/실장 계정 권장.

### D63. 직접입력 문자 발송내역 미표시 — sms_type enum 'direct' 누락 (0005) + 발송 silent-실패 가시화
- **근본원인(워크플로 다각조사, high confidence)**: D53 '직접 입력 문자발송'이 `sms_sends` 를 `type:'direct'` 로 INSERT 하나 DB enum `sms_type`(0001_schema.sql)엔 'direct' 가 없음 → 런타임 **22P02**(invalid input value for enum). 발송 순서가 OneShot 실발송(먼저) → insert(나중)라 **문자는 수신되나 기록 행이 안 생김** → 모든 발송내역 화면 영구 0건. 타입드리프트: `types/db.ts` SmsType엔 'direct' 있어 컴파일만 통과. + MemberDrawer 발송 mutate에 onError 없어 운영자에겐 에러도 안 떠 silent no-op(차장 "수신은 되나 내역 없음" 정확 일치).
- **라이브 재현(2026-06-18, rep01)**: `type='direct'` INSERT=22P02 / `type='join'`=201. 전체 96건 distinct type=['join','recommend'](direct 0건). 부차 가설 기각: sms_sends 조회/RLS 정상(rep 본인담당 21건 정확), logs insert도 rep01 201 정상.
- **수정**: ① `supabase/migrations/0005_sms_type_direct.sql` — `alter type sms_type add value if not exists 'direct'`(SQL Editor 단독 실행). ② `pushLog` best-effort(throw→console.warn) — 감사로그 실패가 발송/캐시무효화를 막지 않게. ③ MemberDrawer 템플릿·직접 발송 버튼 onError(window.alert)로 silent 실패 가시화.
- **영향**: enum 추가 후 직접발송 insert 201 통과 → 드로어 문자내역·MySmsPage 즉시 노출. 앱 빌드 통과. **검증 예정**: enum SQL 실행 후 직접발송 1건 → sms_sends 적재 + 화면 노출 확인.

### D64. 현장 피드백 6/22 — 고정/제외 수정·삭제 + 추천발송 본문 통일 + 일괄 직접입력
- **항목2 (고정수/제외수 수정·삭제)**: `LottoExcludePage.tsx` 이력 테이블 각 행에 **수정/삭제** 버튼 + 삭제 `ConfirmModal`(§10) + 편집 폼 로드(editingId)·`recalcSnapshot`(공통 활성규칙 스냅샷 재계산). 데이터계층 무변경 — `useSaveSiteSettings`가 history 배열 통째 저장(mock+supa 자동 반영). `resolveExcludeForGrade`가 history 직접 읽어 삭제/수정 즉시 추천에 반영.
- **항목3 (추천번호 발송 내용/이력 통일)**: recommend 템플릿 발송 본문을 회원정보창 조합발송과 **동일 포맷**으로 통일. `lib/sms.recoSmsBody(round,sets)` 공유 함수 신설(기존 supa 인라인·api 로컬 중복 제거). `sendSms`(supa+mock)가 templateKey='recommend'일 때 회원의 발급조합(meta.weekly_recos 최신 회차분 재사용, 없으면 generateIssueSets 즉석 발급+meta 적재)으로 recoSmsBody 본문 생성 → type='recommend'·template_key='recommend' 동일 이력. 즉석 발급수=회원별 weekly_reco_count 우선, 없으면 weekly_free_reco.set_count(기본 30).
- **항목4 (이용자 일괄발송 직접입력)**: `bulk.tsx` 문자발송 모달에 **템플릿/직접입력 탭** 추가. 직접입력은 **최고관리자·관리자만**(현장 확정, 자유본문 대량발송 오발송·스팸 위험). useSendCustomSms(ids[] 다건 기지원) 호출 + onError 알림 + 바이트/SMS·LMS 카운터. 데이터계층 무변경.
- **항목1 (수동조합 발송 회차 오류)**: 코드 아닌 **데이터 밀림** — lotto_rounds 최신=1227(6/6)에 정지, target=max+1=1228이 이미 지난 회차. **운영자가 1228·1229 회차등록(즉시 해소)** + **주간 자동적재 크론(별도 구현)** 으로 결정(대표 승인). 본 커밋엔 항목1 코드변경 없음.
- **영향**: 앱 빌드(3604모듈) 통과. mock 라벨 '발송완료'→'미발송'(직접발송·수동조합 일관, D62 연장). 발송 onError 알림은 일괄에도 적용.

### D65. 로또 회차 주간 자동적재 크론 — 회차오류 재발 방지 (현장 피드백 6/22 항목1)
- **결정**: 항목1(회차 오류) 근본원인은 lotto_rounds 데이터 밀림(1227 정지). 즉시해소는 운영자 1228·1229 회차등록, 재발방지는 자동크론(대표 "둘 다" 승인). `api/weekly-lotto-sync.ts`(Vercel 함수) + `vercel.json` cron(매일 23:00 UTC=08:00 KST, 추천발급 09:00 직전). 매 실행 시 lotto_rounds max+1 부터 동행복권 내부 API(`selectPstLt645Info.do`, Mozilla UA+Referer)로 추첨 완료 신규 회차를 받아 upsert(번호·보너스·sum·홀짝·1~3등 당첨금·추첨일). CRON_SECRET Bearer + SERVICE_ROLE.
- **검증**: 동행복권 내부 API 로컬 curl 정상(1229=12,13,29,34,37,42 b16 / 6/20 추첨, 워크플로 보고와 일치). 1228=24,29,30,31,35,44 b1. **WAF/egress 주의**: 레거시 common.do 는 차단, 내부 API 는 Mozilla UA 로 통과. Vercel egress(US) 차단 가능성 있어 크론은 실패 시 no-op+로그(크래시 안 함), 운영자 회차등록이 안전망. 배포 후 `?force`(현재 무인증 401 가드만, secret 필요) 또는 secret 으로 실호출 검증.
- **영향**: 크론 단독 tsc 통과. prize_1=rnk1WnAmt(1인당, D59 관례). confirmed_at=now(자동 확정 표기, 베팅 채점은 크론 미수행 — 미래회차 베팅 없음). **잔여(운영자)**: 1228·1229 즉시 회차등록(아래 안내) — 크론은 다음 추첨(1230, 6/27)부터 자동.

### D66. 전산 명칭 변경 플러스로또 → 88로또 (현장 피드백 6/23)
- **결정**: 운영사 요청으로 서비스 표시명을 '플러스로또' → '88로또'. 코드 사용자노출 문자열 일괄 변경(sed): UI 로고 4곳(AppShell·LoginPage·PortalPage·Dashboard title)·`lib/sms.recoSmsBody`·`api/weekly-reco` 조합SMS·`seed.ts`(템플릿/당첨문자/약관/은행)·`index.html` title. 라이브 DB도 업데이트: `sms_templates` 3건·`site_settings`(win_messages 5·terms·bank.holder). 잔존 '플러스로또'는 내부 주석 3곳(types/db.ts·rls/policies.sql·tokens.css)만 — 코드네임/레포명 PlusLotto 는 유지.
- **영향**: 앱 빌드·크론 tsc 통과. 검증: 가입 템플릿 '[88로또] …', sms_templates 잔존 0건. recoSmsBody/추천발송/크론 본문 '[88로또]'. **별건(운영자)**: 기존 테스트 회원 DB 삭제는 운영자 SQL 실행(아래 안내, `delete from members` cascade) — 금일 실데이터 입력 준비.

### D67. 신규/이름변경 운영자 로그인 불가 수정 + 최고관리자 비밀번호 변경 (현장 피드백 6/23)
- **근본원인(라이브 확인)**: 앱의 운영자 생성/이름변경(`admins/supa.saveStaff`)은 `staff` 행만 쓰고 **Supabase Auth 계정(로그인 주체)을 만들지/갱신하지 않음**. → ① 신규 생성 계정(two011·two029)은 Auth 유저가 없어 로그인 불가, ② login_id 변경 계정(two053·045·066, 원래 rep01/leader01/rep02)은 staff.login_id 만 바뀌고 Auth 이메일은 옛 `<옛id>@pluslotto.local` 그대로라 새 아이디로 로그인 실패. M8 수동생성 5명(admin01·two001 등)만 동작했음.
- **수정**: ① `api/staff-set-password.ts`(Vercel 함수, service_role) 신설 — 호출자가 `admin`(최고관리자)인지 access token 으로 재검증 후, `<login_id>@pluslotto.local` 기준 Auth 유저를 **보장**(없으면 createUser·있으면 updateUserById 비번변경, email_confirm:true) + `staff.auth_user_id` 를 그 유저로 **재링크(스테일 교정)**. ② `admins/supa.setStaffPassword(login_id, password)` 클라이언트 헬퍼(세션 토큰 Bearer 전달). ③ `AdminsPage` StaffEditor 에 **비밀번호 설정/변경** 입력 — `canPw = me.role==='admin' && dataSource==='supabase'` 일 때만 노출, 저장 성공 후 6자+ 입력 시 setStaffPassword 호출(실패 시 드로어 유지·재시도), pwBusy 중 버튼 잠금. 비우면 비번 미변경. (인증 도메인 `@pluslotto.local` 은 사용자 비노출·내부용이라 88로또 개명 후에도 유지 — 변경 시 기존 로그인 깨짐.)
- **검증(2026-06-23, 라이브)**: 배포된 `/api/staff-set-password` 를 admin01 토큰으로 호출 — 깨진 5계정(two011·029·053·045·066) 전부 status=200 프로비저닝 → 5계정 모두 `signInWithPassword` 성공(uid 확보). staff 링크 7/7 OK(각 login_id↔동일 이메일). 임시 비번=`Test1234!`(차장 최초 로그인 후 본인이 변경 권장). 잔재: 옛 rep01/rep02/leader01 Auth 유저 3건은 staff 미연결 고아(무해·역할 미해석 → 접근 불가)로 방치.
- **영향**: 앱 빌드(3604모듈)·함수 단독 tsc 통과. 최고관리자는 이제 관리자>계정수정에서 임의 운영자 비번을 설정/변경 가능(신규 계정 로그인 활성화 동일 경로). **운영 주의**: 비번 6자 이상, 설정/변경은 admin 전용(서버 재검증), mock 모드는 종전대로 로그인ID 인증(비번칸 비노출).

### D68. 프로덕션 준비 적대적 감사 후속 수정 — 보안·크론 견고성·설정·UI (자체 점검, 6/23)
- **배경**: 멀티에이전트 워크플로(6차원 × 적대적 검증, 26 에이전트)로 라이브 시스템을 전수 감사 → 확인된 결함 15건을 severity 순으로 수정. 실데이터 입력 임박 대비 사전 하드닝.
- **🔴 critical-2 (보안) `/api/send-sms` 무인증 공개**: 인증 게이트가 전혀 없어 누구나 회사 검증 발신번호(15226385)로 임의 수신자에게 임의 본문 SMS 를 무제한 발송 가능(스미싱·요금폭탄·평판훼손)했음. **수정**: send-sms 에 `isAuthorized()` 추가 — ① 서버-서버(크론)=`x-internal-secret===CRON_SECRET`, ② 브라우저(운영자)=`Authorization Bearer`=로그인 staff 의 Supabase access token(service_role `getUser`→staff 활성 확인), 둘 다 실패 시 401. `src/lib/oneshot.sendOneShot` 가 세션 토큰을 Bearer 로 첨부, `weekly-reco.sendComboSms` 가 x-internal-secret 헤더 첨부. **라이브 검증(2026-06-23)**: 무인증/위조토큰/잘못된시크릿 = 401(차단), 올바른 내부시크릿·운영자토큰 = 400 필수값누락(인증통과·실발송 X). 두 정상 경로 보존 확인.
- **🟠 high-1 `/api/send-sms` 직접호출 우회**: 위 critical 의 한 단면(직접입력 대량발송 admin/manager 가드가 클라뿐) — send-sms 인증으로 외부 우회 차단(같은 수정으로 해소). per-mode 역할 강제는 클라 가드 유지 + 후속과제로 기록.
- **🟠 high-2 크론 fail-open 인증**: `if(secret && auth!==...)` 패턴은 CRON_SECRET 미설정 시 게이트가 통째로 꺼짐. **수정**: weekly-reco·weekly-lotto-sync 둘 다 fail-closed — secret 없으면 500(차단·가시화), 있으면 Bearer 일치 강제. (현재 프로덕션엔 CRON_SECRET 설정돼 있어 노출 중은 아니었음 — 확인됨.)
- **🟠 high-3 유료조합 SMS 길이초과 전건실패**: 크론 sendComboSms 가 msgType 미지정→send-sms 가 SMS(90byte)로 처리→조합본문(~849byte) 402 길이초과로 전건 실패(D61 기능 무력화). **수정**: `koByteLength` 인라인 + body 길이로 SMS/LMS 분류해 명시 전송.
- **🟡 medium-4 `saveSiteSettings` update({...next})**: 폼이 실은 여분키·신규 타입필드를 그대로 PATCH → D60 같은 PGRST204 재발 구조. **수정**: 11개 실컬럼만 명시 picking(화이트리스트, D62 TODO 이행).
- **🟡 medium-5 SMS 기록 insert-after-send**: 3개 supa 발송경로 모두 OneShot 발송 후 sms_sends INSERT → INSERT throw 시 "수신O·기록X"(D63 재발구조). **수정**: 세 경로 insert 실패를 throw 대신 console.warn + best-effort `sms.record_failed` 로그(실발송 후 '실패' 오표시·재발송 방지).
- **🟡 medium-6 크론 부분실패 비격리**: 회원 meta update 실패가 `throw`→그 시점 이후 전원 발급중단. **수정**: `if(error){errCount++;continue}` 로 단건 격리 + errCount 로그/응답 노출.
- **🟡 medium-7 운영자 부분성공 재시도 막힘(D67 후속)**: 신규 생성 후 비번 프로비저닝 실패 시 재시도가 'ID 중복'으로 막힘. **수정**: AdminsPage 에 `savedId` 보존 — 재시도 시 `id: staff?.id ?? savedId` 로 UPDATE 경로 → 중복오류 회피, 안내문에 '저장을 다시 눌러 재시도' 추가.
- **🟢 low (코드수정)**: ⑪ weekly-lotto-sync 응답파싱 가드(ltRflYmd 8자리·번호 1~45 정수 검증, 드리프트 시 행 스킵+skipped 카운트, 크래시 방지) ⑫ 무료추천 토글이 유료SMS 차단 → paidSmsOn 계산을 early-return 위로 옮기고 루프에서 무료/기타만 cfg.enabled 게이트(유료 SMS 독립 동작) ⑬ 최신회차 8일+ 경과 시 적재지연 staleRound 경고(비차단 로그) ⑭ 직접입력 SMS 카운터 인코딩 불일치(UTF-8 Blob→실발송분류 `koByteLength`/`classifyMsgType` 로 통일, bulk.tsx·MemberDrawer.tsx).
- **🟢 low (문서화·코드무변경)**: ⑩ 크론 formatComboSms 본문이 recoSmsBody 와 다른 건 **의도된 차이**(자동발송은 이름+홈페이지 안내 포함, src import 불가한 Vercel 함수 제약) → 통일대상서 제외 명시. ⑮ 고정/제외 이력 동시편집 last-write-wins 는 소규모팀·주간 저빈도 admin 작업이라 **수용**(근본해결=서버 jsonb append RPC, 후속과제).
- **#1 레포↔라이브 스키마 드리프트**: `members.consult_status` 는 라이브엔 존재(수기 추가, 동작 중)하나 마이그레이션 누락 → `0006_members_consult_status.sql`(멱등 add column if not exists)로 동기화. 라이브 적용은 no-op(이미 존재). **재발방지 일반화 미이행**: updateMember/bulkUpdateMembers 의 `.update({...patch})` 화이트리스트, 타입↔마이그레이션 CI 점검은 후속과제.
- **영향**: 앱 빌드(3604모듈)·함수 단독 tsc 통과. 배포·라이브 보안검증 완료. data-layer-integrity 차원은 confirmed 0(이중모드 분기 견고). **후속과제(별건)**: send-sms per-mode 역할 서버강제, settings/members 화이트리스트 일반화, 동시편집 RPC, bulk getUser 호출 N회 레이턴시(저volume 내부툴이라 수용).

### D69. 일괄 담당배정 "일부만 배정" — 회원 목록 1000행 캡 버그 (현장 피드백 6/23, 정의현 차장)
- **증상**: 담당미지정(953건) 뷰에서 리스트 100개·전체선택 후 담당배정 시 100건 전부가 아닌 **일부만 배정**됨. 반복해도 미지정 카운트가 0 으로 안 떨어짐.
- **근본원인(라이브 확인)**: `members/supa.fetchScopedMembers` 가 `sb().from('members').select('*')` **단건 조회** — PostgREST 기본 **max-rows=1000 캡**에 걸려 전체 1,985명 중 **앞 1000명만 로드**(라이브 확인: 인증된 admin01 세션도 `content-range: 0-999/1985`, HTTP 206). 목록·26세그먼트·일괄선택이 전부 이 클라이언트 스냅샷 위에서 동작하므로, **1000번째 이후 985명은 화면에 아예 안 뜨고 선택 자체가 불가**. 미지정 뱃지(953)는 별도 정확한 COUNT 라, 로드된 1000명 안의 미지정만 배정해도 캡 너머 미지정이 남아 "일부만 배정"으로 보였음. (회원 1000명 미만이던 개발·초기엔 잠복, 실데이터 1,985명 적재로 발현. D65 회차 1,227건 적재 때 같은 캡을 발견해 `remote.selectAll` 로 우회했으나, 회원 목록 경로는 그 헬퍼를 안 거치고 있었음 — D68 정적 감사도 이 런타임 캡은 미검출.)
- **수정**: ① `remote.ts` 에 range 페이지네이션 코어 `paginateAll<T>(build)` 추출(기존 `selectAll` 도 이걸 사용하도록 리팩터, 동작 동일). ② `fetchScopedMembers` → `selectAll<Member>('members')` 로 교체(전량 적재). ③ `fetchMineMembers`(나의고객) → `paginateAll` + `eq(assigned_staff_id)` 로 전량. ④ 같은 캡에 노출된 회원 테이블 무한정 read 동반 수정: `fetchInflowCodes`(유입코드 드롭다운 누락 방지), `createMember`·`bulkImportMembers` 의 **중복검사·user_id 채번**(`select('phone,user_id')` — 캡 너머 회원과 전화중복을 못 잡아 **15만 실데이터 임포트 시 중복 유입** → range 전량으로 차단). 안전상한 50만행.
- **검증(2026-06-23, 라이브)**: service_role·인증 admin01 양쪽에서 단건 select=1000행 vs range 페이지네이션=**1,985행 전량**(2페이지: 1000+985) 일치 확인. 빌드(3604모듈)·tsc 통과.
- **영향**: 이제 전체 회원이 목록/세그먼트/일괄작업에 노출 → 100건 전체선택·담당배정이 100건 전부 반영. **후속과제(별건, 미이행)**: (a) 수만~15만 규모에선 전량 클라 적재가 무거움 → server-side 필터/정렬/페이지네이션+COUNT 이관 필요(remote.ts:5 기존 TODO). (b) `lotto/supa` bets(round별)·`fetchMineSmsLog` 등 잔여 무한정 read 는 현 볼륨 안전, 동일 패턴으로 추후 정리. (c) 페이지크기 1000 + `.in(1000 ids)` 일괄작업 시 URL 길이·업데이트 캡 — 청크 분할 검토.

### D70. 일괄 등급변경 + 일괄 자동조합(발송요일·갯수) 액션 (현장 피드백 6/23, 정의현 차장)
- **요청**: 김형준 담당으로 배정한 100명을 ① 모두 골드플러스 등급으로 일괄적용 ② 익일 오전 자동조합 받게 설정 ③ 조합발송수=10. 기존엔 등급 일괄변경 UI 가 없었고(상태/유입분류만), 자동조합 발송요일·갯수는 회원정보창(MemberDrawer)에서 1명씩만 가능했음.
- **구현(일괄작업바 MemberBulkActions, 최고관리자 전용 블록)**: ② 신규 액션 2종.
  - **등급변경**: `useBulkUpdateMembers({ patch: { grade } })` 재사용(supa 는 `.update({...patch}).in(ids)` 라 grade 그대로 반영, D55 트리거는 담당/팀 변경에만 발동→등급은 무관). 8등급 드롭다운(GRADE_LABEL).
  - **자동조합**: 신규 `useBulkUpdateMemberSettings` → `supa.bulkUpdateMemberMeta(ids, patch)` — 선택 회원 meta 를 25건씩 병렬로 `weekly_reco_day`(0=일..6=토, ''=전역기본 금)·`weekly_reco_count` 병합 갱신(jsonb 병합이라 회원별 개별 update). 발송요일+갯수 모달.
- **연동(기존 크론 그대로)**: `api/weekly-reco.ts` 가 매일 09:00 KST, `meta.weekly_reco_day===오늘요일`인 회원에게 `meta.weekly_reco_count`(없으면 전역 set_count)개 조합 발급→`meta.weekly_recos[]`(홈페이지 조회). PAID_GRADES=gold/goldp/vip/royal 는 발송요일 지정 회원만 대상. 라이브 `weekly_free_reco.enabled=true`라 유료회원도 발급됨. (SMS 자동발송은 `weekly_free_reco.paid_sms` 토글 별도 — 현재 OFF 라 홈페이지 발급만, 문자는 안 나감.)
- **검증(2026-06-23, 라이브)**: 빌드(3604모듈) 통과. 회원 1명 캡처→`grade=goldp`+`meta.weekly_reco_day=2/count=10` 적용→정확 반영 확인→원복 정상(되돌릴 1명만 사용, 100명 실데이터는 미변경). **실행 주체**: 100명 적용은 운영자가 UI 에서(김형준 담당 필터→전체선택→등급변경 골드플러스→자동조합 요일·10조합). 익일 오전 발급되려면 내일 09:00 KST 전에 '내일 요일'로 설정 필요.

### D71. 한글검색 IME 수정 + 문자내역 접수상태 + 크론 타임아웃 + 조합로직 문서 (현장 6/24)
- **한글 검색 IME 수정**: `FilterBar` 검색 input 이 URL 파라미터로 완전제어돼, 키 입력마다 URL→재렌더→value 재설정으로 **한글 조합이 자모마다 끊김**("정의현"→"ㅈㅓㅇㅇㅡㅣㅎㅕㄴ"). → 로컬 상태 + `compositionStart/End` 로 분리(조합 중엔 부모 전파 안 함, 종료 시 반영). 전 FilterBar 사용처 공통 수정.
- **문자내역 접수상태 표시**: `MemberDrawer` 문자내역 탭에 `status`(발송완료=문자사 접수성공/실패/미발송) 칩 추가. 추후 회원 분쟁 대처 증빙(현장: "전산이 문자업체에 접수한 기록을 나중에라도 찾을 수 있나" → 회원 상세 문자내역에 시각·내용·상태 영구보존). 접수성공≠실발송(업체 발송확인) 구분도 안내.
- **크론 타임아웃**: `vercel.json` `functions.maxDuration` — `weekly-reco` 300s(유료 SMS ON 시 100+통 순차발송이 기본 10s 초과해 일부만 나가던 위험 차단), `weekly-lotto-sync` 60s, `send-sms` 30s.
- **조합생성 로직 문서**: `docs/조합생성_로직_구현현황.md`(+`.docx`, 생성기 `scripts/build-logic-doc.cjs`) — 제공 「제외수 프로그램」 5규칙·압축·품질필터·로직:랜덤·고정/제외·확률정직성을 구현(`lib/lottoGenerator.ts`)과 1:1 대조.
- **라이브 운영 기록(코드 아님)**: 김형준 100명→골드플러스+수요일 10조합(6/24 09시 크론 발급·SMS 발송, 업체 92/100=접수100·실발송92, 8건 결번 추정). 이윤선 1883명→골드 일괄(임시 스크립트 bare-GET 캡으로 1차 1000명만→전량 페이지네이션 재적용 1883/1883). UI 일괄선택은 페이지당 최대 1000이라 1000초과 담당은 백엔드/2페이지 처리.

### D72. 주간 추천 크론 병렬화 — 대량(1883명) 발송 타임아웃 차단 (현장 6/24)
- **문제**: 정의현 차장 이윤선 담당 1883명 조합발송 직전. paid_sms ON 상태라 1883명 × 순차 SMS(~1초+) ≈ 30분+ → vercel maxDuration 300s 한참 초과 → 수백명만 발송되고 함수 타임아웃. (100명일 땐 300s로 충분했으나 1883명은 불가.)
- **수정(api/weekly-reco.ts)**: 단일 for-루프를 ① 적격 선별(게이트: 요일·등급·멱등, CPU만) → ② 발급+SMS 동시성 제한 병렬(CONC=12, `Promise.all` 청크)로 분리. 게이트·실패격리(errCount)·멱등(recos[0].round_no===targetRound)·counters 로직 1:1 보존. 병렬 동시삽입 PK 충돌 방지 위해 sms_sends id 에 난수 추가.
- **처리량**: 1883 / 12 × ~1s ≈ 160~220s < 300s(여유). CPU(generateRecommendation×1883)는 ~15s 직렬이나 I/O와 겹쳐 무영향. 동시성 12는 OneShot/Fixie 부담도 완만.
- **검증**: tsc(strict)·빌드 통과, 배포 Ready. (실 1883 SMS 발사 없이 검증 — 로직 보존 + 타입체크. 실송출은 차장님이 발송요일 설정 후 그날 9시.)
- **남은 한계(스케일)**: 동시성12로 ~3500명/실행까지 300s 내. 그 이상(수만 동일요일)은 배치/큐 분할 필요(향후).

### D73. SMS 인프라 — Fixie 무료한도 소진 → 신규 계정(hybrid) 이관 + 1488 재발송 + 화요일 정기 (현장 6/24~25)
- **문제**: paid_sms ON 후 이윤선 1,883명 대량발송 시 Fixie 무료(tricycle 월 500건) 한도 소진 → 395 성공 후 `TypeError: fetch failed`(EXCEPTION) 1,488건 실패. (서버리스=동적IP라 OneShot IP화이트리스트 통과용 Fixie 고정IP 중계 사용 중. 무료 500/월이 대량발송에 부적합.)
- **이관**: 회사 신규 Fixie 계정(LJCOMPANY, **hybrid $49/월·25만건**) 생성 → `FIXIE_URL` env 교체(criterium.usefixie.com) + 재배포. 신규 outbound IP **52.87.82.133 / 52.5.155.132** 를 OneShot(lotto_dream_api) 화이트리스트 등록.
- **재발송**: 막힌 1,488건 본문 보존 재발송(동시성10) → **1,487 성공 / 1 결번**. 이윤선 1,883 중 1,882 도달. (테스트 1건 cmid 85432309 선검증.)
- **화요일 정기**: 전체 **1,985명** weekly_reco_day=2(화)·count=10 설정 → 다음 화 09:00부터 매주 자동발송(파싱된 크론 동시성12 + hybrid 25만건으로 처리량 확보).
- **교훈**: 발신번호/발송IP 변경 시 OneShot 재등록 필수. 로또문자 받아주는 업체(OneShot) 유지가 자산 — 업체 교체보다 IP 한도 해결이 정답.

### D74. 회원정보창 종료일 표시·수정 + 조합발송 일시정지 (현장 6/26, 정의현 차장)
- **① 종료일 표시**: MemberDrawer 기본정보에 '종료일' Row 추가. 종료일 = `meta.end_date`(수정 override) → 없으면 승인결제의 최신 `period_end`. (회원 레벨 종료일 필드가 없어 결제 period_end 파생 + meta override 구조.)
- **② 조합발송 일시정지**: 차장 질문("발송갯수 0이면 문자 나가나?") → 기존 크론 `count>0 ? count : baseCount` 라 **0이면 전역기본(30)으로 발송됨(차단 안 됨)**. → 별도 일시정지 추가. MemberDrawer 회원설정에 '조합발송 일시정지' 체크박스(`meta.reco_paused`). 크론: `is_suspended=false` 필터(정지회원 제외) + `meta.reco_paused===true || weekly_reco_count===0` skip(0=중단 직관 반영).
- **③ 종료일 수정**: 회원설정에 종료일 date input → `meta.end_date` 저장(updateMemberMeta 병합). 빈값=결제 종료일 사용.
- `MemberSettingsPatch` 에 `end_date?`, `reco_paused?` 추가. 검증: 빌드·크론 tsc 통과.

### D75. 추천조합 당첨집계 구현 + 회차1230 백필 (현장 6/29, 정의현 차장)
- **문제**: 토요일 추첨 후 당첨자 집계 안됨. 원인 — `confirmRound`/`weekly-lotto-sync` 모두 `bets` 테이블만 채점(0건). 실서비스는 추천조합(`meta.weekly_recos`) 발급이라 당첨 판정 로직이 **아예 없어** win_history 보유 0 = 당첨자 0.
- **수정**: ① `confirmRound`(수동 확정) ② `api/weekly-lotto-sync`(자동) 양쪽에 '추천조합 당첨집계' 추가 — 회차별 회원 weekly_recos 조합을 당첨번호와 `gradeRank` 대조 → 최고등수로 `win_history` 갱신(다건이면 'N건' 표기). lotto-sync maxDuration 300.
- **백필**: 회차 1230(번호 3·8·9·22·28·42/보너스45) 즉시 집계 → **당첨자 1명(4등)**.
- ⚠️ **추천로직 미스 발견**: 1230 당첨번호 6개 중 **5개(3·9·22·28·42)가 제외수에 걸려** 추천조합에 거의 미등장(샘플 300명×10조합 중 3매치=0건). 제외수 로직이 이번 추첨번호를 조직적으로 회피 → 당첨자 극소. (코드 '확률 정직성'대로 제외는 당첨확률을 높이지 못하며, 추첨이 제외수를 맞히면 오히려 미스↑.) **제외수 전략 재검토 가치 — 제공업체와 협의 권장.**
- ① D74(종료일·일시정지)는 프로덕션 번들에 정상 반영 확인 — 차장 미표시는 브라우저 캐시(하드 새로고침).

### D75+. 당첨집계 시점을 토요일 추첨 직후로 (현장 6/29 — 당첨전화 워크플로)
- **요구**: 운영팀이 토 21~22시 당첨전화 발신 → 그 전(10시 이전)에 당첨자 집계 완료 필요.
- **문제**: weekly-lotto-sync 가 `0 23 * * *`(매일 08:00 KST)만 돌아 토 추첨분이 **일 08시**에야 집계(회차1230도 그랬음) → 전화 워크플로에 늦음.
- **수정**: vercel.json 에 토요일 크론 추가 `0,30 12 * * 6`(토 21:00·21:30 KST, 추첨 20:45 직후). 기존 일 08:00 보강 유지. → 토 21:00경 자동집계(늦어도 21:30), 22시 전화 전 완료. 수동 '당첨확정'(confirmRound)에도 추천조합 집계 포함되어 즉시 재집계 가능.

### D76. 종료일 기본값 = 결제일(없으면 가입일)+1년 (현장 6/29)
- MemberDrawer 종료일: 기존 'meta.end_date || 결제 period_end' → **'meta.end_date(override) || (최신 승인결제 paid_at, 없으면 registered_at) + 1년'**. 수정창도 그 값으로 기본 프리필(payments 로드 후). 라벨 '(기본 결제일+1년)'.
- 참고(현장 질문): 전산↔홈페이지는 이미 연결됨 — 고객 포털 `/portal`(전화+뒷4자리 로그인 → 본인 weekly_recos 조회, `portal_member_recos` RPC, 동일 Supabase). 전산이 발급하면 포털에서 즉시 조회.

### D76. 고객 홈페이지(/portal) 신설 — 회원 로그인·내 추천번호·등급/회차/공지 (현장 6/29)
- **요구(정의현 차장)**: "전산과 홈페이지가 연동되어야 하고, 회원이 로그인해서 본인등급/발급번호를 확인할 수 있어야 함"(일행로또 ilhanglotto.co.kr 참고). 88로또(88lotto.co.kr) 회원용 홈페이지 필요.
- **구현**: `src/features/site/` 신설 — SiteLayout(헤더/푸터/네비) + MemberAuthProvider(staff 인증과 분리, 전화+비번) + 8페이지: 홈/88시스템/88로또자료/88멤버십/마이페이지/로그인/회원가입/고객센터. 라우트 `/portal/*`. admin(`/`)·기존 코드 무수정.
- **데이터**: 회원 로그인·추천번호 조회는 `portal_member_recos` RPC(security definer)라 anon 정상. 회차/공지/FAQ 읽기·문의 접수는 anon 차단(0002 RLS=authenticated) → **0007_public_site_anon.sql 로 anon 공개 SELECT(lotto_rounds/notices·faqs published) + inquiries INSERT 정책 추가 필요**. 셀프 가입은 members INSERT 불가(RLS+트리거)라 inquiries(가입문의)로 접수→운영자 후처리.
- 검증: 빌드·tsc 통과. 라이브 렌더는 배포 후 확인.

## v0.3 — 정의현 차장·김형준 이사 현장 피드백 7/3~7/6 (카톡 재확인분, 6/30 이후 누락분 반영)

### D77. 회원정보 연령대·성별 추가 + 성향 옵션 재정의 (현장 7/3)
- **요구**: "회원 연령대/성별/성향을 선택할 수 있는 기능 추가" — 연령대는 40미만/40~70/70이상, 성향은 좋음/보통/나쁨.
- **구현**: 연령대·성별은 신규 컬럼 없이 `member.meta.age_band`/`meta.gender`(기존 `MemberSettingsPatch`/`updateMemberMeta` 병합 경로 재사용, 마이그레이션 불필요). 성향(`member.tendency`, 기존 실컬럼)은 옵션 목록을 `TENDENCIES=['좋음','보통','나쁨']`로 교체(기존 자유값 '적극/신중/무응답' 등은 컬럼이 자유텍스트라 데이터 그대로 보존, 표시만 안 됨). 세 항목 모두 `MemberCreateDrawer`(등록 시) + `MemberDrawer` 기본정보 탭(즉시 저장 select)에서 편집 가능. `features/members/views.ts`에 `AGE_BANDS`/`GENDERS`/`TENDENCIES` 단일 출처로 정의.

### D78. 회원정보창 위치 이동은 기 구현 확인 (현장 7/3 재문의)
- 7/3에 "상세정보창을 창 형태로 위치 임의 이동 가능하게" 재요청 — 6/30에 이미 구현된 `Drawer(movable)`(좌/우 도킹 + 자유 드래그 + 폭조절 + localStorage 기억)로 충족 확인. 추가 변경 없음.

### D79. 메모를 기본정보 탭 하단으로 통합 + 3열 레이아웃 (현장 7/3)
- **요구**: "메모기능은 회원 기본정보 안으로 이동, 최하단에 표시" + "기본정보 2열 → 3열".
- **구현**: `MemberDrawer` 탭에서 '메모' 탭 제거, 기존 메모 UI(입력창·누적 리스트·삭제·초기화 archive)를 '기본정보' 탭 조건부 렌더 블록으로 이동해 최하단 배치. 기본정보 `<dl>` grid `grid-cols-2 gap-x-5` → `grid-cols-3 gap-x-4`.

### D80. "녹화기능" → 조합 생성 과정 감사기록으로 구현 (현장 7/3)
- **요구(원문)**: "제외수 세팅작업시 자료를 남기기 위한 녹화기능... 번호 생성과정을 녹화나 다른 방법으로 기록을 남길 수 있는 방법이 있을까요?" — 화면 녹화 여부를 개발자 판단에 위임한 열린 질문으로 판단.
- **결정**: 실제 화면 녹화(브라우저 getDisplayMedia + 영상 저장) 대신, [추천번호] 미리보기가 이미 계산해 두는 상세 근거(번호별 제외 사유·남은 풀·최종 조합)를 그대로 저장하는 **생성 과정 감사기록**을 택함 — 특허·불기소이유서 근거자료로는 영상보다 사유가 명시된 텍스트 기록이 더 직접적인 증빙이 되고, 구현·저장비용도 훨씬 낮음(화면 녹화는 별도 스토리지·인코딩·재생 인프라 필요).
- **구현**: `site_settings.generation_records`(jsonb, 0009 마이그레이션) — [추천번호] 화면에서 '기록 저장' 클릭 시 규칙 스냅샷·등급·회차·고정/제외·번호별 사유·풀·조합·작성자·시각을 통째로 append. 목록은 접이식 '생성 기록' 패널(펼치면 상세 + JSON 다운로드), 삭제는 최고관리자만.
- **확인필요**: 이 방식이 요구하신 증빙 형태로 충분한지 실사용 후 피드백 요망(부족하면 별도로 실제 화면 녹화 기능을 재검토).

### D81. 회원 연령대/성별 확장 시 main 설정 폼의 잠재 초기화 버그 발견·수정
- `SiteSettingsPage.toSettings()`가 `membership_tiers`/`generation_records`(그리고 신규 `call_keywords`/`call_volume_alert_threshold`)를 반환 객체에서 누락하고 있어, 이 폼("설정 > 사이트 설정")에서 저장할 때마다 다른 화면(멤버십 등급 편집·생성기록)에서 저장한 값이 조용히 빈 배열/기본값으로 되돌아가는 잠재 버그였음(§10 정합성). `prev.X` 로 보존하도록 수정.

### D82. 통화 녹음·키워드 탐지·통화량 경고 (현장 7/3, 김형준 이사) — 사용자 확인 3건 반영
- **요구**: ①법인폰 통화 녹음 전산 저장 ②녹취 텍스트 변환 후 특정 단어('보장' 등) 자동탐지 ③월 발신 통화량(예 1000건) 초과 시 경고.
- **확인(질문 응답)**: ①상담원 수동 업로드로 시작(PBX/통신사 API 연동 정보 없음) ②STT 외부 유료 연동 진행 승인 ③통화량은 상담상태 변경 건수로 근사 집계.
- **구현**:
  - 녹음: Storage 버킷 `call-recordings`(비공개, 0010 마이그레이션) + `member.meta.call_recordings[]`. `MemberDrawer` 신규 탭 '통화녹음' — 업로드·재생(서명URL 1시간)·삭제(최고관리자).
  - 전사: `/api/transcribe-call`(Vercel 함수, service_role 다운로드 → OpenAI `gpt-4o-transcribe`) — `OPENAI_API_KEY` 환경변수 필요. 전사 후 `site_settings.call_keywords`(설정 > 사이트 설정에서 편집, 기본 `['보장']`) 기준으로 키워드 등장 횟수 계산해 함께 저장.
  - 통화량 경고: `member.update` 로그 중 `patch.consult_status` 있는 건을 이번 달 집계(`lib/callVolume.ts`, mock/live 공유) → `관리자` 화면에 임계치(기본 1000, 설정에서 편집) 초과 시 경고 배너.
- **확인필요**: 법인폰 PBX/통신사 API 정보가 확보되면 수동 업로드를 자동 수집으로 대체 검토. 통화량 집계 기준(상담상태 변경=통화 1건)이 실제 발신 횟수와 얼마나 근접한지 운영 중 재검증 필요.

### D83. 기본정보(이름·핸드폰) 인라인 수정 + 민원관리 탭 신설 (현장 7/6)
- **요구**: ①회원정보창 기본정보의 이름·핸드폰번호를 수정 가능하게 ②기존 탭 옆에 '민원관리' 탭 추가 — 메모 남기기 + 민원유형(카드/경찰/소보원) 선택 + 민원처리결과(성공/실패) 선택 + 민원횟수 생성.
- **구현**: `MemberPatch`에 `name`/`phone` 추가(기존 `updateMember` 뮤테이션 그대로 재사용, 컬럼 실존 — 마이그레이션 불필요). `MemberDrawer` 기본정보 탭의 이름·핸드폰 Row를 인라인 입력으로 변경(포커스 아웃 시 변경분만 저장). 민원은 메모(`meta.memos`)와 동일한 "리스트형 누적" 패턴으로 `meta.complaints[]`에 저장(`ComplaintEntry{body,type,result,author,created_at}`) — 민원횟수는 별도 카운터 컬럼 없이 이 배열 길이로 파생(메모 카운트와 동일 방식, §10 일관성).

### D84. 통화녹음 자동업로드 백엔드 — Android 동반 앱 대응 (현장 7/6, 정의현 차장 확인 후 사용자 결정)
- **배경**: D82(수동 업로드)를 정의현 차장이 카톡에서 재확인 — "상담원 핸드폰에 특정 어플을 사용해서 자동으로 업로드되는 방식으로 알고 있었다". 사용자가 "특정 앱을 만들어서 자동 연동"으로 확정.
- **설계**: 앱이 직접 녹음하지 않고(Android가 통화 녹음 API를 막아놔 비현실적), 폰 기본 통화녹음 폴더의 기존 파일을 감지해 업로드만 한다(사용자 확인). 배포는 Play스토어 없이 APK 사이드로딩(사용자 확인).
- **신규 백엔드**: `api/ingest-call-recording.ts`(멀티파트, `busboy` 신규 의존성) — Bearer 토큰(스태프 계정) 인증 후 전화번호를 `members.phone`과 매칭(숫자만 추출 + 국가코드 보정 + 하이픈 포함/미포함 후보로 `.in()` 조회). 1건 매치 시 그 회원 `meta.call_recordings[]`에 `source:'auto'`로 append, 0/2건 이상이면 `unmatched_call_recordings`(0011 마이그레이션) 테이블에 보관.
- **어드민 신규 화면**: `/admins/recordings`(미매칭 통화녹음) — 이름·전화·로그인ID로 회원 검색 후 수동 연결. `AdminsPage`에 진입 버튼 추가(라우팅은 `/admins/roles`와 동일하게 `navKey="admins"` 게이트, 사이드바 메뉴 항목은 추가하지 않음 — 기존 권한관리 페이지와 동일한 "관리자 하위 버튼" 관례를 따름).
- **Android 앱**(`android-call-uploader/`, 별도 Gradle 프로젝트, 패키지 `kr.bottlecorp.pluslotto.recuploader`): Kotlin+Compose, minSdk26/target35. 로그인(Supabase Auth 직접) → 15분 주기 WorkManager 스캔(+MediaStore 보조) → Room 중복방지 → `/api/ingest-call-recording` 업로드. 이 Mac에 이미 설치돼 있던 Android SDK/AVD 로 이 세션에서 직접 빌드·에뮬레이터 설치·검증함:
  - 단위테스트(`RecordingFileMatcherTest`) 11/11 통과 — OEM별 파일명 정규식(삼성/샤오미/LG)·타임스탬프 파싱.
  - 실제 라이브 Supabase Auth(`/auth/v1/token`)로 로그인 네트워크 왕복 확인(틀린 계정으로 400 응답 → 에러 UI 정상 표시).
  - 포그라운드 서비스(Android14 `dataSync` 타입)+알림+WorkManager 15분 주기 작업 등록 확인.
  - 더미 녹음파일 배치 → 스캔이 감지·전화번호 파싱·Room에 적재·업로드 워커 큐잉까지 확인(실토큰 없어 최종 업로드 자체는 재시도 상태로 정지 — 정상 동작).
  - 검증 후 테스트용 임시 설정(서비스 exported=true, 로그인 게이트 우회)은 전부 원복하고 최종 빌드 재확인함.
  - **확인필요(후속)**: 실기기 폴더 경로·파일명 규칙은 삼성/샤오미/LG 각 1대 이상 실사용 검증 필요 — 앱 안 진단화면 로그로 운영 중 튜닝.

### D85. 결제건별(1차/2차/3차결제) 담당자 배정 (현장 7/6)
- **요구**: "개별 회원의 담당자는 '팀장'으로 되어있는데, 결제가 이루어진 회원에 관련해서는 1차결제·2차결제·3차결제 각각에 따른 담당자 배정이 이루어질 수 있도록."
- **조사 결과**: `payments.staff_id` 컬럼과 매출 귀속 로직(`lib/revenueRules.ts` `attribution:'payment_staff'`, `features/revenue/api.ts` groupOf)이 **이미 결제건 단위로 담당자를 구분해서 집계하도록 구현돼 있었음** — 다만 그 값을 결제 생성 시 회원의 현재 `assigned_staff_id`로만 채우고 이후 바꿀 UI가 없었던 것이 문제. 신규 컬럼·마이그레이션 불필요.
- **구현**: `MemberDrawer` 결제내역 탭 각 행에 ①시간순 회차 배지(1차결제/2차결제…, `payments`를 오름차순 재정렬해 계산) ②담당자 인라인 select(최고관리자만 변경, 회원 상세 상단 '담당' 컨트롤과 동일 패턴) 추가. `useUpdatePaymentStaff`(members/api.ts+supa.ts) 저장 시 `paymentKeys`·`revenueKeys`·`memberKeys.payments` 무효화 → 매출 화면에 즉시 반영.

### D86. 프로젝트 정체성 전면 rename: PlusLotto/pluslotto → 88lotto (현장 7/14, 사용자 확정 요청)
- **배경**: D66(6/23)에서 고객·운영 노출 브랜드는 '88로또'로 확정했지만, 레포명·폴더명·Vercel 프로젝트·package.json 등 **코드 인프라 식별자는 계속 'PlusLotto'/'pluslotto'로 남아 불일치**했다(D66 코멘트: "코드네임/레포명 PlusLotto 는 유지"). 이후 실제로 별도 '플러스로또' 신규 전산이 착수되면서(7/9~) 이 이름이 재사용 대상이 되어, 사용자가 이번엔 **인프라 식별자까지 전부 88lotto로 통일**하도록 명시 요청.
- **변경(라이브 URL 깨짐 감수 — 사용자 명시 확인 후 진행)**:
  - GitHub 저장소: `niceverygood/PlusLotto` → `niceverygood/88lotto` (`gh repo rename`, 로컬 origin 자동 갱신)
  - Vercel 프로젝트: `plus-lotto` → `88lotto` (`vercel project rename`). **주의**: 프로젝트 rename은 `*.vercel.app` 프로덕션 도메인을 자동으로 옮기지 않음 — `vercel alias set`으로 `88lotto.vercel.app`을 신규 배포에 명시적으로 바인딩해야 했음. 기존 `plus-lotto.vercel.app`은 **의도적으로 유지**(제거 시 제3자가 그 이름을 선점해 피싱 등에 악용할 수 있는 위험 — 보안상 남겨두고 새 URL을 정식으로 병행 사용 권장).
  - `package.json`/`package-lock.json` name: `pluslotto-admin` → `88lotto-admin`.
  - localStorage 키 3곳: `pluslotto-ui`(uiStore)·`pluslotto-db`(mock DB, store.ts)·`pluslotto-drawer:*`(Drawer 위치기억) → `88lotto-*`. Zustand persist 세션 캐시 키 `pluslotto-session`(auth.ts) → `88lotto-session`(실제 인증은 Supabase 자체 세션이라 재로그인 불필요, 캐시만 재생성).
  - 문서: `CLAUDE.md`·`README.md`·`BUILD_PROMPTS.md` 제목/본문의 프로젝트명 + `docs/pluslotto_admin_spec.html` → `docs/88lotto_admin_spec.html`(git mv, 코드 임포트 없음 확인 후 안전 rename). `docs/DECISIONS.md`(이 파일)·`docs/SUPABASE_MIGRATION.md`는 **과거 시점을 기록한 체인지로그라 그대로 보존**(역사 왜곡 방지) — 그 시점엔 실제로 pluslotto였던 게 맞음.
  - mock 시드(`lib/db/seed.ts`)의 데모용 리포트 수신 이메일 `ops@pluslotto.co.kr` → `ops@88lotto.co.kr`(실제 발송 없는 mock 데이터).
- **의도적으로 유지(변경 안 함)**:
  - `AUTH_EMAIL_DOMAIN`(`lib/auth.ts`) / `api/staff-set-password.ts`의 `@pluslotto.local` — 전 직원 로그인 계정의 실제 합성 이메일 도메인. 변경 시 Supabase Auth의 모든 staff 계정 이메일을 함께 마이그레이션해야 하며, 사용자에게 전혀 노출되지 않는 내부 값이라 변경 실익이 없음(D66에서도 동일하게 유지 결정됨).
  - `android-call-uploader/`(통화녹음 자동업로드 앱, D84)의 Gradle `applicationId`/Kotlin 패키지 `kr.bottlecorp.pluslotto.recuploader` — 이미 상담원 실기기에 빌드·설치된 앱. 패키지명 변경 시 Android가 "다른 앱"으로 인식해 전 기기 삭제 후 재설치가 필요(Kotlin 패키지 트리 전체 이동도 수반) — 별도 조율 없이 이번 작업 범위에서 제외.
- **검증**: `tsc --noEmit`·`npm run build` 통과. `https://88lotto.vercel.app` 200 확인(새 배포), `https://plus-lotto.vercel.app` 200 유지 확인(구 URL 병행 생존).
- **후속 필요**: 로컬 프로젝트 폴더명(`/Users/seungsoohan/Projects/PlusLotto`) 변경, Supabase 프로젝트 표시명(대시보드 라벨, API로 변경 불가 — 사용자가 대시보드에서 직접) 안내.

---

> 아래부터는 **PlusLotto 자체** 프로젝트의 결정 기록이다. 위 D1~D86 은 88lotto 저장소에서 포크해온 이력으로,
> 이 코드베이스가 그 시점까지 실제로 그렇게 만들어졌음을 그대로 보존한다(역사 왜곡 방지 — D86 과 동일 원칙).

## 2026-07-14 · PlusLotto 신규 배포

### D87. 88lotto 코드베이스 포크 → PlusLotto 신규 브랜드 배포
- **배경**: D86(88lotto, 같은 날)에서 "실제로 별도 플러스로또 신규 전산이 착수되어(7/9~)"라고 언급된 바로 그 신규 전산을 이 저장소(`/Users/seungsoohan/Projects/PlusLotto`)에 시작한다. 88lotto 는 c7e7fe0(7/9)에서 이미 `src/lib/brand.ts` 멀티테넌트 구조(VITE_BRAND 로 배포별 브랜드 주입, 같은 코드 1벌을 브랜드별로 별도 Vercel+Supabase+도메인에 배포)를 갖추고 있었으므로, 그 설계 의도대로 88lotto 전체를 복사해 브랜드 상수만 교정하는 방식으로 만든다.
- **범위(이번 라운드)**: 웹 운영 콘솔(src/·api/·supabase/·scripts/·docs/)만. Android 통화녹음 업로더(`android-call-uploader/`)는 제외 — 패키지명·Supabase 연결·API URL 재구성 + 상담원 실기기 재설치가 필요한 완전히 별도 작업이라 사용자가 다음으로 미루기로 확정.
- **복사 방식**: `rsync` 로 88lotto 전체 복사 후 `node_modules/`·`dist/`·`.git/`·`.vercel/`·`android-call-uploader/`·`.env.local`·`.claude/settings.local.json` 제외(빌드 산출물·88lotto 전용 인프라 연결·시크릿·개인 로컬 설정). 새 로컬 git 저장소를 별도로 init(88lotto 원격과 무관 — 원격 저장소 생성/푸시는 이번엔 하지 않음).
- **브랜드 교정**: `src/lib/brand.ts` 기본값을 `'88로또'` → `'플러스로또'` 로 전환(VITE_BRAND 미설정 시 안전한 기본값이 이 배포 자신의 브랜드가 되도록). `seed.ts` 의 SMS 템플릿·당첨문자·약관·계좌예금주 등 하드코딩된 `88로또` 리터럴을 `플러스로또` 로 치환(런타임 실제 발송 문구는 DB `sms_templates`/`site_settings` 에서 오므로 mock 시드 데이터에 한정된 영향). localStorage/zustand persist 키 4곳(`88lotto-ui`·`88lotto-session`·`88lotto-db`·`88lotto-drawer:*`)을 `pluslotto-*` 로 변경. `docs/88lotto_admin_spec.html` 을 `docs/pluslotto_admin_spec.html` 로 rename(본문은 6/30 리브랜딩 잔재로 이미 전부 "플러스로또" 였음 — 파일명만 불일치했던 것, D3 참조).
- **의도적으로 유지(88lotto 와 동일 값)**:
  - `AUTH_EMAIL_DOMAIN`/`api/staff-set-password.ts` 의 `@pluslotto.local` — 88lotto D86 에서도 "노출 안 되는 내부 값이라 유지"로 결정됐던 값인데, PlusLotto 입장에선 오히려 이제서야 브랜드와 실제로 일치하게 됨. 변경 불필요.
  - `supabase/migrations/0001_schema.sql`·`0002_rls.sql` 상단 주석 `-- 플러스로또 ...` — 스키마 자체는 브랜드 무관이라 DDL 변경 없음. 주석은 우연히 이미 맞는 값이라 그대로 둠.
- **바로잡음**: `api/weekly-reco.ts` 의 `SELF_BASE_URL` 최종 폴백(Vercel 이 `VERCEL_URL` 을 자동 주입하지 않는 예외 상황에서만 쓰이는 마지막 수단, `/api/send-sms` 자기 자신을 호출하는 데 씀)이 원래 88lotto 코드에 `'https://plus-lotto.vercel.app'` 로 박혀 있었다. 이건 PlusLotto 의 실제 도메인이 아니라 **88lotto 자신의 구 Vercel URL 이 legacy alias 로 살아있는 것**(D86 참조 — 프로젝트 rename 후 피싱 선점 방지 목적으로 의도적으로 남겨둔 호스트네임 = 지금도 88lotto 배포로 연결됨). 그대로 두면 이 폴백이 실행되는 극단적 상황에서 PlusLotto 서버 함수가 88lotto 로 콜백할 위험이 있어, `http://localhost:3000`(존재하지 않으면 그냥 실패하는 안전한 값)으로 교정.
- **의도적으로 하지 않음(후속 필요)**:
  - **Supabase 프로젝트 미생성**: `.env.local` 은 전부 빈 값 — 로컬 mock/localStorage 계층으로만 동작(D1 과 동일 폴백 메커니즘). 88lotto 의 `.env.local` 값을 그대로 옮기는 것은 절대 금지(그러면 이 콘솔이 88lotto 의 실 운영 Supabase·Solapi 계정에 접속하게 됨) — 반드시 신규 Supabase 프로젝트 + 신규 SMS 발신 계정을 별도 발급받아야 함.
  - **GitHub 원격 저장소·Vercel 프로젝트 미생성**: 로컬 git 저장소만 init. 원격 생성/연결/배포는 사용자 요청 시 별도 진행.
  - **사업자명/정산 계좌**: `seed.ts` 의 `holder:'(주)플러스로또'`, 약관의 "플러스로또(이하 "회사")" 는 브랜드명만 88lotto 패턴을 그대로 따라 치환한 **mock 시드 placeholder**. 실제 운영 법인명·정산계좌·고객센터 연락처는 미확인 → `docs/ASSUMPTIONS.md` 참조.
- **검증**: `npm install`·`tsc --noEmit`·`npm run dev` 로 브라우저에서 로그인/대시보드에 "플러스로또" 브랜드가 정상 표시되는지 확인.

### D88. PlusLotto 전용 Supabase 신규 발급 + 로컬 라이브 전환 (현장 7/15)
- **배경**: 정의현 차장 확정(7/15 카톡) — "플러스로또 홈페이지랑 전산 두 개 다 88로또랑 별개로" → D87 후속으로 PlusLotto 전용 Supabase 프로젝트를 신규 발급받아 연결. 88lotto 인프라와 완전 분리(D87 의 금지 원칙 그대로).
- **인프라**: Supabase ref `xmfdbmlpvvqqkhqemfay`(ap-northeast-2, PostgreSQL 17). 로컬 macOS 가 IPv6 미지원이라 직결 대신 **세션 풀러**(`aws-1-ap-northeast-2.pooler.supabase.com:5432`, user `postgres.<ref>`) 경유로 작업.
- **적재 절차(런북 `docs/SUPABASE_MIGRATION.md` 변형)**: psql 미설치 환경이라 스크래치패드에서 `pg` 드라이버로 직접 실행 —
  1. 마이그레이션 `0001`~`0012` 전부 순차 적용(테이블 18개).
  2. 시드: `buildSeed()` JSON 덤프 → 직결 적재(회원 160·결제 67·문자 106·베팅 199·배정 135 등, `seedSupabase.ts` 와 동일 순서/순환 FK 규칙). `lotto_rounds` 는 데모 16회차 대신 **공식 백업 `seed-data/lotto_rounds_1-1227.json` 1,227회차 전량**(중복 회차는 공식 우선 병합).
  3. 인증: service_role 키 없이 **SQL 직접 생성**으로 5계정(`admin01`·`two001`·`leader01`·`rep01`·`rep02` @pluslotto.local) — GoTrue 호환 위해 token 계열 컬럼을 `''` 로 채움(NULL 이면 스캔 에러 나는 알려진 이슈). `staff.auth_user_id` 5건 연결. 초기 비밀번호는 88lotto 전환 때와 동일 규약의 임시값 — **운영 전 필수 변경**.
- **검증**: REST password grant 토큰 발급 OK / 앱 로그인 → 대시보드 KPI 실집계 렌더 OK / RLS 스코프 — admin·manager 160/160, leader 160/160(D51 leader=전체 정책 반영 확인), rep01 47/160(본인 담당만) / 콘솔 에러 0.
- **주의(로그인 UX)**: 라이브 로그인 폼 입력이 `type="email"` 이라 `admin01` 같은 login_id 는 브라우저 기본 검증에 막힘 → **`admin01@pluslotto.local` 전체 이메일로 입력**해야 함(88lotto 도 동일). login_id 입력 허용하려면 type 을 text 로 바꾸는 개선 여지.
- **후속(미완)**: Vercel 신규 프로젝트+도메인 미생성 / Solapi 신규 계정 미발급(`SOLAPI_API_KEY` 빈 값) / `sb_secret_...`(service role) 키 미수령 — `npm run seed:supabase` 재시드·Vercel 크론(`weekly-reco`) env 등록에 필요 / 실 운영 계정 생성·임시 비밀번호 교체.

### D89. GitHub 연결 + Vercel 프로덕션 배포 — pluslotto.vercel.app (현장 7/15, D88 직후)
- **GitHub**: 원격 `niceverygood/PlusLotto` 는 7/14 부트스트랩 때 이미 생성·푸시돼 있었음(로컬 origin 연결 확인). D88 커밋 푸시. ⚠️ **저장소가 public 상태** — 내부 운영툴 코드이므로 private 전환 필요(소유자 권한 작업이라 운영자가 직접: `gh repo edit niceverygood/PlusLotto --visibility private --accept-visibility-change-consequences`).
- **Vercel**: 88lotto 와 같은 개인 스코프(`malshues-projects`)에 `pluslotto` 프로젝트 신규 생성, GitHub 저장소 자동 연결(main push = 프로덕션 자동배포). 정식 URL **`https://pluslotto.vercel.app`** — 88lotto 의 legacy alias `plus-lotto.vercel.app` 과는 별개 호스트.
- **env(Production)**: `VITE_SUPABASE_URL`·`VITE_SUPABASE_ANON_KEY`(D88 신규 프로젝트)·`VITE_DATA_SOURCE=supabase`·`VITE_BRAND=플러스로또`·`CRON_SECRET`(신규 생성, 로컬 `.env.local` 과 동일값). Preview 환경은 CLI 버그(`--yes` 무시, git 브랜치 요구 루프)로 미등록 — preview 배포는 env 없음 → mock 폴백이라 무해, 필요 시 대시보드에서 추가.
- **검증**: `pluslotto.vercel.app/login` → `admin01@pluslotto.local` 로그인 → 대시보드 KPI 가 신규 Supabase 시드와 일치(미아웃콜 75·결제대기 5건 ₩165,000) 확인.
- **미완 env(등록 필요 시 크론/문자/통화분석 활성화)**: `SUPABASE_SERVICE_ROLE_KEY`(sb_secret — weekly-reco·weekly-lotto-sync 크론 필수), `SOLAPI_API_KEY/SECRET`(문자 발송), `OPENAI_API_KEY`(통화 전사/분석). 등록 전까지 해당 서버 함수만 비활성, 콘솔 본체는 정상.
- **커스텀 도메인**: 미정 — 도메인 구매/연결은 운영진 결정 대기.

### D90. 문자 = 기존 원샷 계정 재사용 + 도메인 lotto-plus.co.kr 연결 (현장 7/15, 정의현 차장 결정)
- **문자(SMS)**: D87/D88 에서 "별도 SMS 계정 신규 발급" 을 가정했으나, 정의현 차장이 **기존 원샷(OneShot/msgagent) 계정 재사용** 방침 제시 → 수용. 코드가 원래 원샷 기반(D59~D60: Solapi 는 `SOLAPI_ENABLED='true'` 일 때만, 활성화 이력 없음)이라 env 만 등록하면 됨. pluslotto Vercel production 에 `ONESHOT_ID=lotto_dream_api`·`ONESHOT_SEND_PHONE=15226385`(88로또와 동일 발신번호 — 플러스로또 전용 번호 추가 등록 여부는 운영진 결정 대기) 등록 + 재배포.
  - **잔여**: `FIXIE_URL`(고정IP 프록시 — 원샷 인증이 IP 화이트리스트 방식이라 88lotto 와 같은 Fixie(LJCOMPANY, criterium.usefixie.com, IP 52.87.82.133/52.5.155.132) 프록시 필수). 88lotto Vercel env 가 **sensitive 타입이라 CLI/대시보드로 값 조회 불가** → usefixie.com 대시보드에서 proxy URL 재확인해 등록해야 함. 그 전까지 실발송 불가(콘솔 본체 무관). 실발송은 env 외에 site_settings 문자설정(`oneshot_enabled`·`sender_no`)도 켜야 작동.
- **도메인**: 정의현 차장이 카페24에서 **`lotto-plus.co.kr`** 등록(주의: pluslotto 아님 — 표기 그대로). Vercel pluslotto 프로젝트에 apex+www 연결 완료. 잔여: 카페24 DNS 에 `A lotto-plus.co.kr → 76.76.21.21`, `CNAME www → cname.vercel-dns.com` 추가(또는 네임서버를 ns1/ns2.vercel-dns.com 으로 이관). 카페24 로그인 자격증명 입력은 보안정책상 운영자 직접 수행.
- **갱신(7/16 완료분)**: ① 운영자가 카페24 로그인 → Claude 가 크롬 이어받아 DNS 관리에서 A(루트→76.76.21.21)·CNAME(www→cname.vercel-dns.com) 추가, DNS 전파 1분·SSL 발급 후 **`https://lotto-plus.co.kr` / www 둘 다 200 라이브**(로그인 페이지 렌더 확인). ② Supabase 대시보드(로그인 세션)에서 **sb_secret 키 회수 → `.env.local`+Vercel production `SUPABASE_SERVICE_ROLE_KEY` 등록·재배포**, `weekly-lotto-sync` 크론 실호출 검증 — 회차 1228~1232 5건 자동 적재 성공(`{"ok":true,"added":5}`). ③ **Fixie 는 로그인 세션 없음** → 운영자 로그인 대기(app.usefixie.com), 로그인 후 FIXIE_URL 회수·등록하면 문자 실발송 활성화 가능.
- **갱신(7/17 — 원샷 연동 완료)**: `FIXIE_URL` 을 Fixie 로그인 없이 회수 — 88lotto Vercel 의 **Development 환경** 변수는 sensitive 가 아니어서 `vercel env pull --environment development` 로 복호화 성공(Production 은 sensitive 라 불가했던 것). 로컬 프록시 검증: egress IP **52.5.155.132** = 원샷 화이트리스트 IP 일치. pluslotto production 에 등록·재배포. 라이브 `site_settings.sms` 갱신: `sender_no 1588-0000(시드 placeholder)→1522-6385`, `oneshot_enabled false→true`. 스모크 테스트: `/api/send-sms` 스태프 토큰 인증 통과 → 파라미터 검증 단계 도달(실발송은 미실행 — 운영자 테스트 발송으로 최종 확인 권장). ⚠️ 사고 기록: 재배포 명령이 스크래치패드 cwd 에서 실행돼 의도치 않은 `scratchpad` Vercel 프로젝트가 생성·배포됨 → 즉시 `vercel remove` 로 삭제(404 확인). 이후 배포는 반드시 프로젝트 루트에서.
- **고객용 홈페이지 주소**(정의현 문의 7/17): **`https://lotto-plus.co.kr/portal`** (루트=운영 콘솔, /portal=고객 — 88lotto 와 동일 구조). 루트↔포털 스왑 여부는 방침 결정 대기.

### D91. URL 구조 스왑 — 루트=고객 홈페이지, /admin=직원 콘솔 (현장 7/20, 정의현 차장 확정)
- **요청**: "직원용 lotto-plus.co.kr/admin · 고객용 lotto-plus.co.kr 이렇게 변경 가능할까요?" → 수용. D90 에서 방침 대기로 남긴 루트↔포털 스왑.
- **구현**: 포털을 루트로 진짜 마운트(리다이렉트 셔밍 아님) + 직원 콘솔을 `/admin/*` 로 이전. 포털 children 이 `/support`·`/login` 을 차지하므로 직원 로그인은 `/admin/login`, 직원 고객센터는 `/admin/support` 로 이동(충돌 해소).
  - `routes.tsx`: 루트=SiteLayout(고객), `/admin`=RequireAuth+AppShell(children 상대경로), `/admin/login` 셸 밖.
  - 호환 리다이렉트 2종: ① `/portal/*` → 루트 등가 경로(기존 안내링크·북마크 보존, `LegacyPortalRedirect`) ② 구 루트 직원 경로(`/members` 등 14개 접두, `LEGACY_ADMIN_PREFIXES`) → `/admin` 접두(`LegacyAdminRedirect`) — 코드 내 잔존 절대경로 링크(13개 파일)는 스윕 없이 이 리다이렉트로 동작 유지.
  - 직접 수정: AppShell NAV 16곳 `/admin` 접두(사이드바 active 정상화)·로그아웃 `/admin/login` / RequireAuth·RequireNav 폴백 / 스태프 LoginPage 기본 랜딩 `'/'→'/admin'` / SiteSettingsPage 고객센터 버튼 / features/site 내 `/portal` 링크 54곳 → 루트 기준(sed 스윕, RPC 명 `portal_*` 은 불변).
- **검증**: typecheck·build green. 로컬+프로덕션 — `/`=포털 홈 렌더 / `/portal/mypage`→`/mypage` / `/members?view=paid`→`/admin/members?view=paid`→(미로그인)`/admin/login`→로그인 후 **원 목적지 복귀** / 사이드바 이동·active 정상 / `https://lotto-plus.co.kr/admin` → 로그인 화면. 88lotto 와 구조 분기됨(브랜드별 결정) — 공용 컴포넌트 수정 시 양쪽 반영 원칙은 유지하되 라우팅은 이제 별개.

### D92. 고객 홈페이지 5건 수정 요청 (현장 7/20, 정의현 차장 — 최종 테스트 라운드)
- **①당첨자 수 수동표시**: `site_settings.winner_stats{enabled,count}` 신규(0013 마이그레이션 컬럼) — 설정 > 사이트 설정에서 토글+숫자 입력, 고객 홈페이지 히어로 아래 "TRACK RECORD / 누적 당첨자 N명과 함께한 {브랜드}" 배너로 노출(`HomePage.tsx`). enabled=false 또는 count=0 이면 미노출(graceful).
- **②조합 문자 포맷 확정**: `[플러스]\n(이름)님\n[1] 1,2,3,4,5,6\n[2] ...` 로 전면 교체 — 기존엔 회차·조합수·안내문구가 붙어 있었음(`src/lib/sms.ts` recoSmsBody: 시그니처 `(roundNo,sets)→(name,sets)`, 대괄호=BRAND.short 사용). mock(`members/api.ts`)·supabase(`members/supa.ts`, `manualIssueReco` select 에 `name` 컬럼 추가)·크론(`api/weekly-reco.ts` formatComboSms, ESM 제약상 동일 로직 자급자족 복제 + `BRAND_SHORT` 인라인 파생) 3곳 모두 동기화.
- **③고객 홈페이지 등급 3종만**: `MembershipTier.hidden?: boolean` 필드 추가(`resolveTiers`가 정규화). `무료`(free)·`미정`(gold, 실제로는 gold 등급의 미확정 라벨) 를 라이브 DB 에서 `hidden:true` 로 전환 — 이제 실버(goldp)·골드(vip)·다이아(royal) 3장만 고객 홈페이지 미리보기·전체 카드·비교표에 노출(`lib/membership.ts::visibleTiers()`). 회원 **본인**의 실제 등급 배지(마이페이지·멤버십 히어로)는 숨김 등급이어도 정확히 표시되도록 `labelOf` 는 비필터 `allTiers` 기준 유지(버그 방지 포인트). 전산(설정 > 멤버십 등급)엔 "고객 홈페이지에 이 등급 표시" 체크박스 추가 — 5개 전부 계속 편집 가능, 숨김 등급은 탭에 "(숨김)" 표기. `DEFAULT_MEMBERSHIP_TIERS` 코드 기본값도 free/gold `hidden:true` 로 맞춤(신규 배포 시에도 3종 원칙 유지).
- **④무통장 계좌 고객 노출**: 결제 온라인화 없이 가입문의(inquiry) 흐름이라, 계좌 정보는 `/membership` 페이지 하단(비교표·약관 다음, CTA 앞)에 "결제 안내(무통장 입금)" 카드로 노출.
- **⑤사업자 정보 편집**: `site_settings.business{name,reg_no,address,support_phone}` 신규 — 설정 > 사이트 설정에 "사업자 정보" 섹션 추가, 고객 홈페이지 푸터(`SiteLayout.tsx`)가 기존 TODO 하드코딩 자리표시자를 대체해 실값 렌더(값 없으면 상호만 BRAND.name 폴백, 나머지 줄 조건부 숨김).
- **보안/인프라**: ①④⑤ 는 site_settings 에 PG api_key 등 비밀이 같이 있어 anon SELECT 금지(0002/0008 유지) → 신규 security-definer RPC **`portal_site_public()`**(0013 마이그레이션)이 `{bank, business, winner_stats}` 3개 컬럼만 반환. 라이브 DB 에 마이그레이션 적용 + free/gold `hidden:true` 데이터 패치 완료(스크래치패드 pg 직결, 앞선 라운드와 동일 절차). mock `seed.ts` 에도 동일 필드 기본값 추가, `store.ts` `DB_VERSION` 13→14.
- **검증**: typecheck·build green. 브라우저(라이브 Supabase 연결) 확인 — 멤버십 미리보기/전체카드/비교표 3종만(실버·골드·다이아) 렌더 / `/membership` 무통장 계좌 카드(하나은행 608-910044-71205) 노출 / 설정에서 사업자정보 4필드 입력→저장→고객 홈페이지 푸터 즉시 반영 / 당첨자수 토글+1284 입력→저장→히어로 하단 "TRACK RECORD" 배너 렌더 / 멤버십등급 설정 탭에 "무료 (숨김)"·"미정 (숨김)" 정확히 표시. SMS 포맷은 코드 검토로 확정(실 회원에게 테스트 발송은 하지 않음 — 운영자가 콘솔에서 직접 1건 테스트 권장).

### D93. 후속 피드백 3건 반영 (현장 7/21, 정의현 차장)
- **①당첨자 수 재정의**: D92 "누적 당첨자 수"를 정의현이 즉시 정정 — "당첨자수는 누적이 아니라 지난회차 결과가 보여야 합니다 (예: 1233회차 1등 ~명/2등~명/.../5등~명)". `WinnerStats` 를 `{enabled, count}` → `{enabled, rank1..rank5}` 로 전면 교체. 회차 라벨("제N회")은 운영자 입력 없이 `useRecentRounds(1)` 최신 확정 회차를 자동 사용 — 등수별 인원만 수동 입력(회차 갱신 실수 방지). 설정 화면도 숫자 1개 입력에서 1~5등 5칸 입력으로 교체. 라이브 DB 의 구 `{enabled:true,count:1284}` 값은 새 shape 로 초기화(`{enabled:false, rank1..5:0}`) — 운영자가 실제 지난회차 등수별 인원으로 채워야 함. mock DB_VERSION 14→15.
- **②유입구분/유입코드 열람 제한 강화**: 기존엔 "최고관리자(admin)만" 이었는데(D 이전 현장 피드백), 이번엔 "최고관리자/관리자(admin+manager)만"으로 범위 확대 요청. 두 곳 수정 — (a) `MemberDrawer.tsx` 상세창: 기존 `role==='admin'` 하드 조건부 렌더를 `role==='admin'||role==='manager'`로 확장(이미 하드 차단 방식이라 조건만 확장). (b) `columns.tsx` 목록 컬럼: 기존엔 `memberColumnVisibility()`가 초기 노출값만 껐다 켰다 하는 **소프트** 방식이라 leader/rep 도 컬럼토글 드롭다운에서 다시 켜서 볼 수 있는 구멍이 있었음 → `memberColumns(ctx)`가 `ctx.role` 을 받아 admin/manager 가 아니면 `inflow` 컬럼 정의 자체를 배열에서 제거하는 **하드** 방식으로 전환(토글 자체가 없어짐). 호출부 2곳(`MembersPage.tsx`, `MyCustomersPage.tsx`) 에 `role` 전달 추가.
- **③"생성 기록"(추천번호 화면) 재현 실패**: "지난번 수정이 안되었습니다"라는 지적을 받아 라이브(Supabase 연결) 환경에서 실제 재현 시도 — 조합 생성 → 기록 저장 → 새로고침 → 목록에 정상 유지(1건, 회차/제외/풀/세트 요약 정상 렌더) 확인. 코드·라이브 데이터 모두 정상 동작해 재현 실패. 구체적으로 어떤 부분이 다르게 보이는지 확인 질문 필요(카톡 회신 예정) — 억측 수정 금지 원칙에 따라 임의 변경 보류.
- **부수 발견**: 이 작업 중 라이브 DB 확인 결과 데모 시드가 아닌 **실 운영 staff 38명·members 361명**이 이미 적재돼 있고, D88 테스트 계정(`rep01`/`rep02`)은 삭제된 상태(7/21 "테스트 디비 삭제" 요청건과 연결되는 것으로 추정) — 이후 라이브 DB 직접 조회/수정 작업은 실 운영 데이터라는 전제로 더 신중히 진행할 것.
- **검증**: typecheck·build green. `admin01` 세션에서 이용자 목록 헤더에 '유입' 컬럼 노출 확인(admin 경로). leader/rep 세션 재현은 테스트 계정 삭제로 보류 — 코드 로직(하드 필터)으로 대체 확신.

### D94. 긴급 — 고객 홈페이지 로그인 전면 불가 (RPC 누락) 수정 (현장 7/21)
- **증상**: "무료회원/유료회원 고객용 홈페이지에 로그인 안되고 있습니다" — 신규·기존 회원 구분 없이 전화번호+비밀번호 로그인이 전부 실패.
- **원인**: 고객 로그인(`src/features/site/auth.tsx::doLogin`)이 호출하는 **`portal_member_recos(p_phone,p_pw)` RPC 가 애초에 라이브 DB에 생성된 적이 없었다.** 코드 주석·DECISIONS 여러 건(§ 고객 포털 도입 당시)이 이 RPC 존재를 전제로 작성돼 있었지만, 실제 CREATE FUNCTION 마이그레이션 파일이 어디에도 없었음 — 88lotto 개발 당시 Supabase 대시보드 SQL Editor 에서 수동 생성되고 마이그레이션 이력에 백업되지 않은 것으로 추정. D88 에서 88lotto 마이그레이션(0001~0012)을 그대로 복사·적용했을 때 이 함수가 통째로 빠졌고, 이후 D91~D93 라우팅/기능 변경과는 무관하게 애초부터 존재하지 않았던 상태.
- **조치**: `0014_portal_member_recos.sql` 신규 — `members` 를 전화번호(숫자만 비교, 삭제·탈퇴 제외, 동일 번호면 최신 가입자)로 조회 → 비밀번호는 `meta.homepage_pw` 우선, 없으면 전화번호 뒷 4자리(`lib/homepage.ts::homepagePw` 와 동일 규칙) 검증 → 일치 시 `{name,grade,recos}` 만 반환(security definer, members 테이블 RLS 우회 최소화). `anon,authenticated` 실행 권한 부여. 라이브 DB 즉시 적용(코드 배포 불필요 — DB 함수만 추가).
- **검증**: ① DB 직결로 무료회원 1건 로그인 → 실제 발급된 추천조합(30세트, 1233회) 정상 반환. ② 유료(gold)회원 1건 로그인 → 성공(이번 주 미발급이라 recos 빈 배열, 정상). ③ **anon publishable key 로 REST RPC 직접 호출**(프론트가 실제 쓰는 경로와 동일) → 정상 응답 확인. 브라우저 UI 재현은 실 회원 전화번호 노출 우려로 생략(RPC 레벨 검증으로 충분).
- **후속 확인 필요**: 이 RPC 가 원래 88lotto 에도 마이그레이션 파일 없이 존재한다면, 향후 88lotto Supabase 프로젝트를 새로 만들 일이 생기면 동일하게 재현될 잠재 버그 — 88lotto 쪽에도 이 함수를 마이그레이션 파일로 백업해두는 것을 권장(별도 세션에서 처리).

### D95. 회차별 당첨자 이력 + 등급별 생성 로직 기록 재설계 (현장 7/21, 정의현 차장)
- **요청 재확정**: ① 당첨자 수는 매 회차 수동 입력하고 해당 회차만 고객 홈페이지에 노출, 과거 회차는 관리자 화면에 리스트로 보관. ② 생성기록은 10~20개 특정 조합 목록이 아니라, 예를 들어 1233회에 등급별 제외수가 몇 개 적용됐고 어떤 규칙과 압축 과정을 거쳐 번호가 추려졌는지 전체 관점의 자료가 필요.
- **당첨자 수 구조**: 공개 설정 `winner_stats` 는 `{enabled,current}` 로 전환하고, 과거 회차는 기존 `logs` 에 `settings.winner_stats.upsert` 감사기록으로 별도 적재한다. 설정 > 사이트 설정에 회차 번호 + 1~5등 수동 입력과 과거 기록 표(회차/등수별/합계/저장일시)를 추가. 새 회차 저장 시 고객 홈은 입력한 `current` 한 건만 렌더하고 과거 값은 로그에서 회차별 최신 1건으로 복원한다.
- **공개 경계**: 기존 `portal_site_public()` 은 `winner_stats` 만 반환하므로 그 값 자체에 과거 이력을 넣지 않았다. 과거 기록은 anon 정책이 없는 `logs`(RLS: 최고관리자 SELECT)에만 존재해 UI 숨김이 아닌 데이터 접근 경계로 관리자 전용을 보장한다. 신규 DDL 없이 라이브에 즉시 배포 가능한 구조다.
- **생성기록 구조**: `GenerationRecord` 에 `source`·`stages`·`basis`·`set_count`·`logic_ratio`·`issued_count` 를 추가하고 `sets` 는 레거시 호환 optional 로만 유지. 신규 기록은 특정 추천조합을 저장하지 않는다. `lottoGenerator.computeExclusions()` 가 규칙 6단계(직전 상하위/보너스/월별 저출현/전체 저빈도/40번대/수동)의 최초 후보와 최종 적용 번호를 함께 반환해 중복·우선순위 압축 과정을 재구성할 수 있게 했다.
- **실제 발급 연동**: 콘솔 등급 일괄발급과 Vercel 주간 자동발급 모두 발급 성공 시 회차+등급당 로직 스냅샷 1건을 자동 저장한다. 같은 회차·등급을 재기록하면 최신 기록으로 교체한다. 추천번호 화면의 수동 저장도 `로직 기록 저장`으로 재정의했으며, 기록 상세는 산정 기준 → 규칙별 후보/적용 → 최종 제외수/남은 풀 순서로 표시한다.

### D95. 결제 후속 요청 3건 — 결제내역 수정권한·매출귀속 담당자·상품명 (현장 7/21, 정의현 차장)
- **①결제내역 수정(실장 이상)**: 기존엔 결제 필드(금액·결제수단·PG사·입금자명)를 고치는 UI 자체가 없어 승인/취소만 가능했다. `PaymentDrawer.tsx`에 인라인 수정 모드 추가 — "수정" 버튼은 `role==='leader'||'manager'||'admin'`(실장 이상)에만 노출, 팀장(rep)은 종전대로 승인/취소만. 신규 뮤테이션 `useUpdatePayment`(mock `api.ts`+supabase `supa.ts` 양쪽) 추가, 상품·회원·담당자·상태·기간은 수정 범위에서 제외(등급/매출 연쇄효과가 있어 위험 — 담당자는 이미 `useUpdatePaymentStaff`(admin 전용, D85)로 별도 존재).
- **②매출 귀속 로직 반전**: "1차결제를 조선민 팀장이, 2차를 김민영 실장이 처리했는데 2차결제 담당자가 여전히 조선민으로 나온다"는 버그 리포트. 원인 — 결제 생성 시 `staff_id: member?.assigned_staff_id ?? user?.id`(D85 당시 로직)로 **회원의 현재 담당자를 우선**해 채우고 있어, "회원 담당자는 안 바뀐 채 다른 직원이 대신 결제를 등록"하는 케이스에서 실제 등록자가 무시됐다. 우선순위를 `user?.id(=actor) ?? member?.assigned_staff_id`로 반전 — "결제를 요청/등록한 사람"이 최우선, 회원 담당자는 폴백(둘 다 없을 때만 null). 4곳 동시 수정: `payments/api.ts`(mock 수기결제), `payments/supa.ts:createManualPayment`, `members/api.ts`(회원상세 결제요청 mock), `members/supa.ts:requestPayment`. 기존에 이미 저장된 결제건은 소급 수정하지 않음(요청 문구가 "자동으로 될 수 있도록"이라 향후 생성 건 기준으로 해석).
- **③상품명 변경**: 결제 요청 화면 상품 드롭다운이 구 등급명("골드플러스 1개월", "VIP 3개월", "로얄 6개월")이었는데, 실사용 등급명(D92 membership_tiers.label: goldp→실버·vip→골드·royal→다이아)과 맞춰 `products.name` 을 "실버"·"골드"·"다이아"로 변경(라이브 DB 직접 UPDATE + mock seed.ts 동기화, DB_VERSION 16→17). `gold`(구 "미정", 고객 홈페이지엔 이미 숨김)의 "골드 1개월"은 언급 밖이라 유지. 표시 템플릿도 `{name} · {가격} · {개월}개월` → `{name}` 만 남기도록 `ManualPaymentPage.tsx` 드롭다운 옵션 수정(가격 자동입력 로직 `onSelectProduct` 는 그대로 유지 — 표시만 간소화, 데이터 흐름 불변).
- **검증**: typecheck·build green. 라이브(Supabase) 브라우저로 확인 — 결제 요청 드롭다운 3종 표시(가격/개월 없이) / PaymentDrawer 수정모드 진입→PG사 입력→저장→목록 즉시 반영→원복까지 실제 라이브 DB 라운드트립 확인.

### D96. 카톡방 수정요청 6건 — 당첨내역·관리자 정렬/필터·금일디비 정합·계좌/고객센터 노출 (현장 7/22, 정의현 차장)
- **①회원별 당첨내역 리스트화**: 기존엔 `member.win_history` 가 최근 1건만 덮어쓰는 단일 문자열이었음(§4·ASSUMPTIONS 기존 기록). 신규 `member.meta.win_records`(jsonb, 컬럼 추가 없이 즉시 배포 — §9-5 원칙) 에 회차/추첨일/등수/당첨금/조합순번을 누적 저장(`lib/winHistory.ts`: `WinRecord`/`upsertWinRecords`/`summarizeWinRecords`, 재확정 시 `(source,round_no,combo_index)` 키로 upsert해 멱등). `useConfirmRound`(mock `lotto/api.ts`)·`confirmRound`(live `lotto/supa.ts`) 양쪽에서 베팅(`source:'bet'`)·추천조합(`source:'reco'`, 발급 세트 내 인덱스=조합순번) 당첨을 모두 기록하도록 확장(기존엔 mock 이 추천조합 매칭을 아예 안 하고 있던 mock/live 괴리도 함께 해소). `MemberDrawer.tsx` 기본정보 탭에 `WinHistorySection` 신설 — 최상단에 등수별 통합정리(예: "1등 1회"), 아래 리스트에 회차·추첨일·N번째 조합·등수·당첨금.
- **②관리자 리스트 ID순 정렬**: `lib/staff.ts::useStaff()` 한 곳에서 `login_id.localeCompare` 정렬(모든 화면이 이 훅을 공유하므로 전 화면 동시 적용). `AdminsPage.tsx` 자체 정렬(역할→이름)도 동일 기준으로 교체.
- **③관리자 등급(실장·팀장 등) 필터**: `AdminsPage.tsx` 에 역할 select(전체/최고관리자/실장/팀장/담당) 추가.
- **④금일 배분디비 — 자동할당 모달에도 표시**: 기존엔 관리자 화면(`AdminsPage`)에만 있던 `useTodayDbCounts` 를 `lib/todayDb.ts` 로 이관(feature 간 직접 import 금지 원칙 — 공유는 lib 경유, §2)해 `members/bulk.tsx` 자동할당 대상 체크리스트에도 담당자별 "금일 N (수동/자동)" 노출.
- **⑤자동/수동배분 갯수 정합성**: "자동/수동배분 갯수처리 오류" 리포트 — 코드 검토 결과 `members/supa.ts` 의 `assignStaff`/`autoAssign`/`resetAssign` 이 "회원 갱신 → assignments 로그 insert" 순서였음. 다건 배정 도중 로그 insert(특히 `autoAssign` 은 회원 수만큼 순차 update 후 마지막에 한 번에 로그 insert) 가 실패하면 회원은 이미 재배정됐는데 감사로그(=금일 디비 집계 소스)엔 안 남는 상태가 생겨, 관리자 화면 집계가 실제 배정보다 적게 나올 수 있음(정확한 프로덕션 재현은 라이브 DB 접근 없이 확인 불가 — 코드 레벨 위험요인으로 확정 후 선제 수정). 순서를 "로그 먼저 insert → 회원 갱신"으로 반전(로그 실패 시 회원도 안 바뀌어 유령 상태 방지) + `autoAssign` 을 회원별 개별 update N회에서 rep 별 그룹 update(pool 크기만큼)로 축소해 라운드트립·부분실패 구간을 줄임. mock(`members/api.ts`)은 단일 동기 트랜잭션이라 이 위험이 없어 변경하지 않음.
- **⑥고객 홈페이지 계좌·고객센터 번호 노출**: 무통장 계좌 카드가 `/membership` 페이지에만 있어 실제 랜딩(`/`, D91 이후 "홈페이지"=고객 루트)에서 안 보인다는 지적 — `HomePage.tsx` 에도 동일 카드(§ 결제 안내) 추가. 고객센터(`/support`) 전화번호가 `설정 > 사이트 설정 > 사업자 정보 > 고객센터 번호`(`business.support_phone`, D92 ⑤에서 이미 만들어 둔 필드)와 무관하게 `1588-0000` 하드코딩이었던 것을 `usePublicSiteInfo().business.support_phone` 연동으로 교체(값 없을 때만 안내용 기본값 `1660-0681` 폴백). mock 시드 기본값도 `1660-0681` 로 동기화.
- **확인필요**: ⑤는 실제 라이브 assignments 테이블 데이터로 재현하지 못했다(운영 DB 직접 접근 없이 코드 검토로 도출한 가설) — 재발 시 실 assignments 로그와 members.assigned_staff_id 를 대조해 이번 수정으로 해소됐는지 확인 요망. ⑥ 고객센터 번호는 코드가 `설정` 값을 그대로 표시하도록만 바꿨으므로, 라이브 사업자 정보에 `1660-0681` 을 실제로 입력해야 고객 홈페이지에 반영됨.
- **검증**: typecheck·build green. mock 데이터로 브라우저 확인 — 관리자 목록 ID순 정렬 + 등급 필터, 자동할당 모달 담당자별 "금일 N(수동/자동)" 표시, 로또기록에서 회차 확정 실행 → 회원상세 당첨내역에 "등수 N회" 요약 + 회차/추첨일/조합순번/당첨금 리스트 정상 렌더, 고객 홈페이지 계좌카드·고객센터 1660-0681 노출 확인.

### D97. 약관 SMS 발송 템플릿 (현장 7/22, 정의현 차장 — D96 병행 작업)
- **동시 작업 경합**: D96(위)이 별도 세션(claude.ai/code, GitHub PR #1)에서 같은 시각 "카톡방 수정요청 6건"을 처리해 먼저 origin/main 에 병합됐다. 이 세션은 그와 별개로 동일 요청 중 "①자동/수동배분 순서" · "②관리자 리스트 정렬/필터"를 병행 구현했으나, 병합 시 **D96 쪽 구현(더 개선됨 — `autoAssign` 을 rep 별 배치 update 로 축소, `order('id')` 로 라운드로빈 결정성 확보)을 채택**하고 이 세션의 중복 구현은 폐기했다. 아래 ③만 이 세션의 고유 기여로 유지.
- **③약관 SMS 템플릿**: 신규 템플릿 키 `terms`(카테고리 `terms`) 추가 — 발송 시 `$contents` 변수가 고정 문구가 아니라 **수신 회원의 등급에 해당하는 `membership_tiers[grade].terms`**(설정 > 멤버십 등급의 개별약관)로 자동 치환되어, 등급이 다른 회원들에게 일괄 발송해도 각자 자기 등급 약관을 받는다(요청한 "등급별로 구분해서 발송" 요건). `renderSms()` 시그니처에 `overrides` 파라미터 추가(템플릿별 특수 발송이 회원 기본값 대신 값을 주입할 수 있게, `recommend` 의 별도 `recoSmsBody()` 와 달리 이번엔 범용 치환 경로 재사용). `SmsType` enum 에 `'terms'` 추가 — DB `sms_type` 이 Postgres ENUM(0001_schema.sql)이라 D63(0005, 'direct' 추가) 때와 동일하게 `0015_sms_type_terms.sql` 로 값 추가 후 라이브 즉시 적용, `sms_templates` 라이브 테이블에도 기본 템플릿 1건 INSERT.
- **검증**: typecheck·build green. 라이브(Supabase) 확인 — 설정 > 사이트 설정에 `terms` 템플릿 카드와 안내문구("$contents 는 등급별 개별약관으로 자동 치환") 정상 노출.
- **보류(추가 확인 필요)**: 가입환영 메시지 "수정요청" — 현재 발송 문구(`[플러스] $name님 가입을 환영합니다. 아이디: $id / 임시비밀번호: $pw`) 캡처만 전달받고 구체적으로 어떻게 바꿀지는 미확정 → 카톡으로 재질문, 확정 후 반영 예정.

### D98. 간헐적 전산 지연 — 회원 전량조회 중복 제거 (현장 7/22, 정의현 차장)
- **현상/원인**: “전산이 중간중간 느려진다”는 문의 시점의 라이브 DB는 전일 회원 삭제 후 이미 **2,339명**이 재유입된 상태였다. Vercel 정적 페이지는 반복 측정 p50 18ms(5xx/런타임 오류 없음), Supabase 단건 조회도 p50 77~124ms로 인프라 장애는 아니었다. 반면 이용자 화면은 `useMembers`·`useMemberViewCounts`·`useInflowCodes`가 서로 다른 query key로 같은 회원 전체를 각각 내려받아, 한 번 진입할 때 `members` 2,339행을 최대 3회 읽었다. 전역 staleTime 30초가 지난 뒤 페이지·필터·정렬 query key가 바뀌면 전량 요청이 다시 실행되어 간헐 지연처럼 체감되는 구조였다.
- **조치**: 역할 스코프별 `memberKeys.snapshot()` 쿼리를 추가해 회원 원본+담당 역할맵을 하나의 TanStack Query 스냅샷으로 공유한다. 목록·26개 세그먼트 건수·유입코드는 이 스냅샷에서 메모리 파생하며, 나의고객 목록/건수도 동일 패턴으로 통합했다. 스냅샷 staleTime은 2분 — 다른 운영자의 변경은 최대 2분 내 재조회하고, 현재 사용자의 회원/결제/배정 뮤테이션은 기존 `memberKeys.all` invalidate가 스냅샷까지 즉시 무효화하므로 로컬 반영 지연은 없다.
- **효과/한계**: 이용자 첫 진입 회원 전량조회 최대 3회→1회, 같은 화면의 페이지·검색·필터·정렬 전환은 네트워크 재요청 없이 즉시 계산된다. 현재 2천 건대 운영에는 즉시 효과가 있으나 목표 규모 15만 건에서는 여전히 전량 스냅샷 자체가 한계이므로, 별도 Phase에서 Supabase 서버 필터·카운트·페이지네이션 RPC로 이관해야 한다.

### D99. 재발 방지 — 핵심 조회 전면 서버 페이지·집계화 (현장 7/22)
- **배경**: D98은 당일 체감 지연을 빠르게 줄인 1차 조치였지만, 회원 15만 명 목표에서는 브라우저가 회원 원본을 1회라도 전량 받는 구조 자체가 한계다. 추가 전수 감사에서 전역 AppShell 뱃지·대시보드·결제·매출·통계·베팅도 각 화면 진입 시 회원 전체 또는 연관 테이블 전체를 읽는 경로가 확인됐다.
- **조치**: `0016_admin_read_performance.sql`에 RLS를 그대로 적용하는 `security invoker` RPC 12개를 추가했다. 회원 목록(필터·검색·정렬·페이지), 26개 세그먼트/유입코드, 수기결제 회원검색, 결제 목록/건수/상세, 대시보드, 사이드바 뱃지, 베팅, 매출, 가입·유입·결제 통계, 상담 리포트가 브라우저 원본 전량조회 없이 DB에서 조인·집계 후 필요한 행/숫자만 반환한다. TanStack Query는 화면별 RPC 결과만 캐시하고 회원/결제/문의 뮤테이션이 `operationalKeys`까지 무효화해 대시보드·뱃지를 즉시 갱신한다. D98의 전량 스냅샷은 Supabase 경로에서 완전히 대체됐고 mock 경로만 기존 순수 계산을 유지한다.
- **DB 방어선**: 검색용 `pg_trgm`, 담당·팀·유입·미아웃콜·결제상태 복합/부분 인덱스와 RLS helper init-plan 최적화를 적용했다. `0017_performance_guardrails.sql`은 KST 일자 expression index, 누락 FK index, 미매칭 녹취 RLS의 `(select auth.uid())` 최적화, `app_can_see_member` anon 실행권한 제거를 추가하고, `0018_trigram_search_paths.sql`은 회원·결제 부분검색 식을 trigram index가 사용할 수 있는 `LIKE` 형태로 고정한다. 주간 추천번호 일괄발급은 전 유료회원 처리가 업무 자체라 의도적 배치 전량조회로 남기고 일반 화면 경로에서는 제외했다.
- **라이브 검증**: 운영 DB(admin 세션, 회원 2,339명)에서 회원 목록은 50행/약 42.9KB·DB 실행 30.9ms, 세그먼트 전체 집계는 약 1.5KB·49.2ms였다. 결제 13행 약 9.2KB, 베팅 50행 약 18.4KB, 대시보드 약 2.5KB, 22일 매출 집계 약 3.6KB로 응답 크기가 전체 회원 수와 분리됐다. rep 세션은 본인 담당 58명·결제 2건만, leader/admin 함수도 각 역할 규칙대로 반환해 성능 변경으로 권한 범위가 넓어지지 않음을 확인했다.

### D100. 등급별 공개 약관 링크·결제 등급 필터·회원정보 연동 (현장 7/22, 정의현 차장)
- **등급별 약관 페이지**: 고객 멤버십의 각 등급 카드에서 `가입 문의하기` 바로 위에 `약관보기` 버튼을 추가하고 `/terms/:grade` 공개 페이지를 신설했다. 페이지 내용은 별도 복제하지 않고 전산 `설정 > 멤버십 등급`의 `membership_tiers[].terms`를 기존 anon 안전 RPC로 읽어 항상 최신 약관과 일치한다. 기존 멤버십 하단의 전체 등급 펼침 목록은 제거해 등급별 링크 진입으로 통일했다.
- **약관 SMS**: D97의 약관 전문 `$contents` 발송 방식을 철회하고, `$link` 변수에 회원 등급별 공개 약관 URL을 넣어 발송한다. 기존 라이브 템플릿이 `$contents`인 상태에서도 같은 URL로 치환해 전환 시점의 전문 오발송을 막고, `0020_terms_template_link.sql`로 기본/라이브 템플릿을 링크 문구로 변경했다.
- **결제 화면**: `0019_payment_grade_filter.sql`로 결제 RPC에 상품 부여등급 필터를 추가하고 결제 메뉴에 실버(`goldp`)·골드(`vip`)·다이아(`royal`) 필터를 노출했다. 결제 상세의 회원명을 클릭하면 `/admin/members?member=:id`로 이동해 해당 회원 기본정보 Drawer가 즉시 열린다. feature 간 직접 import 없이 URL deep-link로 연동했다.
- **미반영 항목**: 캡처의 가입환영 메시지는 현재 발송 문구만 제시되고 변경할 새 문안이 없어 임의 수정하지 않았다. 확정 문안을 받으면 `join` 템플릿만 교체한다.

### D101. 조합문자 회차 표기·오발송 발급내역 삭제 (현장 7/22, 정의현 차장)
- **회차 표기**: 모든 추천조합 문자 경로(회원 수동발급, 추천 템플릿 발송, 유료회원 자동발송)에 회차를 추가한다. 통신사 스팸 필터 회피 요청에 따라 1233회는 `12.33회차`로 표시하며, 클라이언트 공용 `recoSmsBody`와 자급자족 Vercel 크론 포맷을 함께 변경했다.
- **삭제의 실제 범위**: 당첨 집계는 `sms_sends`가 아니라 `member.meta.weekly_recos`를 읽으므로 문자 로그만 삭제해서는 오발송 조합의 당첨 안내를 막지 못한다. 회원정보 `문자내역`과 `발급번호` 탭에서 연결된 조합을 삭제할 수 있고, 해당 발급분·추천문자 이력·같은 회차가 더 없을 때 추천 출처의 당첨기록을 함께 제거한다. 감사로그 `reco.issue_delete`는 삭제하지 않고 보존한다.
- **권한·안전성**: 복구 불가능 확인 모달을 거치며 최고관리자·관리자(`admin`/`manager`)만 실행한다. `0021_delete_member_reco.sql`의 `security invoker` RPC가 기존 RLS를 적용한 상태에서 회원행 잠금 후 원자 처리하여 발급/삭제 경합 시 부분 삭제를 방지한다.

### D102. 결제목록 0건 회귀 긴급복구·조합문자 기본 체크 (현장 7/22, 정의현 차장)
- **결제 원인/복구**: D100 등급 필터 추가 시 클라이언트가 미선택값도 `{ grade: '' }`로 전송했고, RPC는 JSON key가 존재하면 실제 빈 등급을 찾도록 해 탭 건수는 17건인데 표만 0건이 됐다. 클라이언트는 값이 있을 때만 grade key를 보내고, `0022_payment_grade_empty_filter.sql`은 누락·빈값을 모두 전체 조건으로 처리해 구버전 브라우저 요청도 즉시 복구한다.
- **조합 문자**: 회원정보 `수동 발급`의 `문자로도 발송`을 회원 전환·재진입 시 항상 기본 체크 상태로 초기화한다. 운영자가 필요할 때는 발급 전 직접 해제할 수 있다.

### D103. 홈페이지 등급별 약관 저장원본 통합 (현장 7/22, 정의현 차장)
- **원인**: 전산 `설정 > 이용약관`의 골드(`vip`) 약관 8,779자는 `site_settings.terms_by_grade`에 정상 저장됐지만, D100 공개 페이지는 별도 필드인 `membership_tiers[].terms`만 읽어 "등록된 약관이 없습니다"를 표시했다. 같은 의미의 편집 UI가 두 화면에 존재해 저장원본이 갈라진 구조 문제였다.
- **조치**: 법적 약관은 기존 `설정 > 이용약관`의 `terms_by_grade`를 단일 원본으로 확정했다. `0023_membership_terms_source.sql`에서 과거 멤버십 개별약관을 누락 등급에 한해 먼저 보존 이관하고, 공개 RPC가 등급 전용 약관(없으면 공통 약관)을 멤버십 응답의 `terms`에 병합하도록 수정했다. `설정 > 멤버십 등급`의 중복 약관 입력란은 이용약관 화면 링크로 교체했다.
- **즉시성**: 설정 저장 시 운영·고객 쿼리 캐시를 함께 무효화하고 공개 등급 쿼리는 창 포커스 복귀 시 재조회하도록 변경했다. 다른 탭에서 약관을 확인해도 10분 캐시 때문에 이전 내용이 남지 않는다.

### D104. 전화번호 중복 DB 신규입력 차단·기존회원 표식 (현장 7/22, 정의현 차장)
- **요청**: 기존 회원과 전화번호가 같은 DB가 다시 들어오면 신규 행은 만들지 않고, 먼저 등록돼 있던 기존 회원이 `중복 DB` 필터에 잡혀야 한다.
- **원인**: 단건·엑셀 경로가 중복을 사전 조회한 뒤에도 의도적으로 새 회원행을 만들고 새 행에만 `meta.dup_phone=true`를 기록했다. 운영 DB에는 이미 전화번호 중복 47그룹·95행이 존재했고, 애플리케이션 사전 조회만으로는 동시 요청 경쟁조건도 막을 수 없었다.
- **조치**: `duplicate_member_guard` 마이그레이션이 숫자만 남긴 전화번호별 transaction advisory lock을 잡고, 기존 행이 있으면 그 행의 `meta`에 `dup_phone`·시도 횟수·최근 시각·유입정보를 기록한 뒤 `BEFORE INSERT`에서 `NULL`을 반환한다. 따라서 단건·엑셀·직접 API·동시 입력 모두 신규행이 생기지 않는다. 차단 이력은 `member.duplicate_rejected` 유입로그로 남긴다.
- **필터·호환**: `중복 DB` 필터는 새 표식과 과거 실제 중복행(`동일 번호 count>1`)을 함께 조회한다. 과거 95행은 운영정보 임의 병합 위험 때문에 삭제·합치지 않고 보존했다. 프론트는 실제 INSERT 반환 ID만 배정이력을 만들며, 엑셀 결과에는 `등록 N건 / 중복으로 건너뜀 N건`을 구분한다.
- **검증**: 프로덕션에서 서로 다른 형식의 동일 번호를 2회 입력해 회원행 1개·두 번째 ID 없음·기존행 표식/시도횟수/유입로그/필터 결과 각 1건을 확인했다. 검증용 회원과 로그는 즉시 삭제해 잔여 0건을 확인했다.

### D105. 실장 매출 0건 회귀 — 서버 집계의 역할 스코프 정합 (현장 7/22, 정의현 차장)
- **증상**: 최고관리자·관리자 계정에서는 매출이 보이지만 실장(`leader`) 계정에서는 매출내역이 0건으로 표시됐다. 라이브 권한 대입 재현 결과 관리자 33건/21,636,000원, 실장 0건이었다.
- **원인**: D51/D55에서 실장은 전체 회원·종속데이터를 조회하도록 확정했지만, D99의 대량조회 RPC가 이전 규칙(`leader=team_id`)을 복사했다. 운영 실장 계정은 `team_id`가 비어 있어 `admin_revenue`뿐 아니라 대시보드·사이드바 결제대기 뱃지·결제통계·상담리포트도 빈 집합으로 계산됐다. 기본 테이블 RLS와 결제목록 RPC는 이미 실장 전체 범위라 서버 집계 함수 사이에서만 권한이 갈렸다.
- **조치**: `leader_full_read_rpcs` 마이그레이션으로 관련 5개 `security invoker` RPC의 스코프를 `admin/manager/leader=전체, rep=본인 담당`으로 통일했다. mock 폴백의 매출·대시보드·통계·뱃지도 같은 규칙으로 수정해 환경별 괴리를 제거했다. 함수의 anon/public 실행권한은 계속 차단하고 authenticated만 허용한다.
- **검증**: 라이브 실장 계정으로 매출이 관리자와 동일한 33건·21,636,000원으로 복구됐고 대시보드 승인 33건·결제통계 33건·결제대기 뱃지 1건도 일치했다. 팀장(`rep`)은 본인 담당 회원 106명만 조회되고 매출 RPC는 0건을 유지했다. 5개 함수 모두 구 스코프 제거·anon 실행 차단·authenticated 실행 허용을 확인했다.
