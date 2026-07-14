# 플러스로또 ADMIN — Claude Code 빌드 프롬프트

> **사용법**
> 1. 새 폴더에서 `claude` 실행. 이 파일과 `CLAUDE.md`, `docs/pluslotto_admin_spec.html`을 프로젝트 루트에 둔다.
> 2. 아래 Phase 0부터 순서대로, 각 블록(``` 안의 텍스트)을 그대로 Claude Code에 붙여넣는다.
> 3. 한 Phase가 끝나면 직접 실행해 확인 → 다음 Phase. **Phase 3(이용자)는 끝까지 완성**한 뒤 진행한다(패턴 확정).
> 4. 매 Phase 공통 전제: "CLAUDE.md를 먼저 읽고 그 규칙을 100% 따른다. 토큰·구조·연동(§8)·DoD(§10)을 지킨다."
>
> 미확인 화면(매출·권한·로그·일부 통계·커뮤니티·고객센터·나의고객)은 Claude Code가 **직접 구현**하고 `docs/ASSUMPTIONS.md`에 추정을 기록한다(CLAUDE.md §9).

---

## Phase 0 — 스캐폴드 · 디자인 시스템 · Supabase · 앱 셸

```
CLAUDE.md를 읽고 따른다. 플러스로또 운영 콘솔 프로젝트를 초기화한다.

1. Vite + React 18 + TypeScript(strict) 스캐폴드. Tailwind, React Router v6, TanStack Query v5, TanStack Table v8, @supabase/supabase-js, react-hook-form, zod, recharts, date-fns, lucide-react, zustand 설치.
2. CLAUDE.md §3의 tokens.css와 tailwind.config.ts를 그대로 생성. index.html에 Pretendard CDN(jsdelivr) 추가. body 기본 폰트/색/tabular-nums 설정.
3. lib/supabase.ts (env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY), lib/format.ts(krw/phone/datetime, 전부 tabular), lib/auth.ts(useRole 스텁) 작성. .env.example 추가.
4. app/providers.tsx (QueryClientProvider + BrowserRouter), app/routes.tsx(빈 라우트 + 역할 가드 골격), app/AppShell.tsx 작성.
5. AppShell: 좌측 네이비 사이드바(CLAUDE.md §0 13개 메뉴를 운영/고객·세일즈/로또/시스템 4그룹으로, active 인디케이터·카운트 뱃지·접힘 토글) + 상단바(페이지 제목/설명 슬롯 + 계정) + 콘텐츠 Outlet. 스타일은 docs/pluslotto_admin_spec.html의 App Shell 프리뷰와 일치.
6. 임시 /dashboard 라우트에 "플러스로또 운영 콘솔" 플레이스홀더.

검수: npm run dev 정상, 사이드바/상단바 렌더, 토큰 적용 확인. docs/ASSUMPTIONS.md, docs/DECISIONS.md 빈 파일 생성.
```

---

## Phase 1 — 코어 컴포넌트 (화면의 80%)

```
CLAUDE.md §6을 따른다. design-system/components에 재사용 컴포넌트를 만들고, /dev/components 데모 라우트에서 전부 렌더해 확인한다.

1. <Button> (pri/acc/suc/dng/sec/gho, sm), <Badge grade=...>, <StatusChip status=...> — 토큰 자동 매핑, 도트+라벨.
2. <DataTable>: TanStack Table 기반. props=columns,data/query,rowSelection,bulkActions,density,onRowClick,isLoading,pagination.
   - sticky 헤더, 밀도 토글(44/36), 컬럼 토글 메뉴, 행 hover, 행 선택 시 하단 <BulkActionBar> 등장, 서버 페이지네이션 UI, 로딩 스켈레톤, <EmptyState>.
   - 숫자 컬럼 헬퍼(우측정렬+mono+tnum), 인라인 편집 셀 렌더러(select 형).
3. <FilterBar>: 접이식 패널 + 활성 필터 칩(개별 해제/전체 초기화) + 통합 검색 input. 상태를 URL query와 동기화하는 useUrlFilters 훅 포함.
4. <PageHeader>(제목+설명+우측 액션 슬롯), <KpiCard>, <Drawer>, <Modal>(확인 모달 포함), <Tabs>, <Pagination>, <DateRangeFilter>.

검수: /dev/components 에서 모든 컴포넌트의 주요 상태(기본/로딩/빈/선택/접힘)가 보이고 토큰을 따른다. DataTable은 더미 데이터로 정렬·선택·밀도·컬럼토글 동작.
```

---

## Phase 2 — 인증 · 역할 · RLS

```
CLAUDE.md §5를 따른다.

1. Supabase Auth로 로그인 페이지(/login). 로그인 시 staff 레코드와 매핑, staff.last_login_at 갱신, admin_log 기록.
2. lib/auth.ts: useSession/useRole(admin|manager|leader|rep). 세션 없으면 /login 리다이렉트.
3. app/routes.tsx: 라우트별 역할 가드. 권한 없는 메뉴는 사이드바에서 숨기고 직접 접근 시 차단.
4. lib/rls/policies.sql: members/payments 등에 대한 RLS 정책 초안 작성(rep=본인담당, leader=팀, manager/admin=전체). 주석으로 적용법 명시. 권한 경계 미확정 부분은 // TODO(live-verify) + ASSUMPTIONS 기록.

검수: 4개 역할 더미 계정으로 로그인 시 메뉴 노출/데이터 범위가 다르게 동작.
```

---

## Phase 3 — 이용자 모듈 (★ 수직 슬라이스 — 끝까지 완성)

```
CLAUDE.md §6,§7,§8을 따른다. 이용자 모듈을 "리스트→필터→일괄작업→상세 Drawer"까지 완전히 구현한다. 이 모듈이 전 모듈의 패턴 기준이 된다.

1. features/members/views.ts: CLAUDE.md §7의 26개 세그먼트 프리셋 완성. 의미 모호한 것(오늘다비/시도/중복유입 등)은 합리적으로 정의하고 ASSUMPTIONS 기록.
2. features/members/api.ts: useMembers(filter,page,sort), useMember(id), useUpdateMember, useBulkUpdate, useAssignStaff, useAutoAssign, useResetAssign — 전부 TanStack Query, RLS 적용.
3. features/members/columns.tsx: 컬럼 정의(No,상태,등급,담당,ID,이름/닉,핸드폰,성향,유입,메모,당첨,수정/활동/가입일시) + 역할별 기본 노출 프리셋. 등급/상태는 Badge/StatusChip, 숫자/일시는 mono.
4. MembersPage: PageHeader + 상단 탭(자주쓰는 6개 뷰)+더보기 드롭다운 + FilterBar + DataTable + BulkActionBar + Pagination. ?view= 와 필터를 URL 동기화.
5. BulkActionBar(이용자): 상태 일괄변경 / 유입분류 일괄변경 / 담당자 배정·자동할당·담당리셋 / 선택 회원 문자발송. 위험 작업은 확인 모달.
6. MemberDrawer(상세 허브): 탭 = 기본정보 / 결제내역 / 문자내역 / 배정이력 / 메모. 액션 = 등급변경·담당변경·정지·문자발송. 모든 액션은 CLAUDE.md §8 흐름 트리거(관련 쿼리 무효화 + 로그 생성).

검수: 26개 뷰 전환, 필터+검색+페이지네이션, 일괄작업 후 카운트 재계산, Drawer에서 등급/담당 변경 시 목록·이력 즉시 반영. 로딩/빈/에러/역할가드 모두 동작.
```

---

## Phase 4 — 결제 모듈

```
CLAUDE.md §8을 따른다. 06 결제를 구현한다.

1. /payments 리스트(상태 탭: 전체/대기/승인/실패/취소) + /payments/manual(수기결제 등록 폼).
2. 컬럼: No,상태,담당,결제수단,PG,금액,상품(Badge),기간,유입코드,유저,입금자명,결제일시.
3. 액션: 결제 승인 / PG취소(확인 모달). 승인 시 §8대로 member 등급↑·status=정상·매출 반영·payment_log·(옵션)SMS 트리거. 취소 시 롤백 검토·매출 차감.
4. 결제 상세는 Drawer 재사용. 회원 상세 Drawer의 '결제내역' 탭과 동일 데이터 소스 공유.

검수: 대기 결제 승인 → 해당 회원 등급/상태/매출/이력에 동시 반영. PG취소 동작 + 로그 기록.
```

---

## Phase 5 — 매출 모듈 (미확인 → 직접 구현)

```
CLAUDE.md §9 원칙으로 07 매출(실매출/전환매출/팀장매출)을 추정 구현한다. 원본 스샷 없음 → 표준 영업 정산 패턴 적용, 모든 가정은 ASSUMPTIONS 기록 + 코드에 TODO(live-verify).

1. 공통: DateRangeFilter + 요약 KPI(총매출·건수·평균·전환율) + recharts(기간별 추이) + 상세 표.
2. 실매출(/revenue/real): payments(status=승인) 기준 기간 합계. 담당자/팀/상품/PG별 그룹 토글.
3. 전환매출(/revenue/conversion): 무료→유료 전환에 귀속되는 매출. **귀속 공식은 가정**(예: 전환 시점 담당자에게 귀속)으로 상수화 → lib에 REVENUE_RULES 로 분리.
4. 팀장매출(/revenue/team): 팀 단위 집계(팀장 = team.leader). leader 역할은 본인 팀만.

검수: 기간 변경 시 KPI/차트/표 일관 갱신, 결제 데이터와 수치 일치. 귀속 규칙이 한 곳에서 교체 가능.
```

---

## Phase 6 — 로또기록 · 베팅

```
11 로또기록, 12 베팅을 구현(스샷 있음 — 원본 데이터 구조 재현).

1. /lotto/results: lotto_rounds 리스트. 컬럼: 회차,추첨일,당첨번호(6+보너스),합/홀짝/출현비율,1·2·3등 당첨금,총판매금액. 회차 등록/당첨 확정 액션 → §8대로 관련 bets.rank/prize 계산, 당첨자 세그먼트 갱신.
2. /bets: bets 리스트. 컬럼: 고유넘버,회차,발행,유저(ref),번호조합,등수,당첨금. 회차 필터.
3. 당첨번호 표시 컴포넌트(번호 볼 UI) 재사용 가능하게.

검수: 회차 선택 시 베팅 필터링, 당첨번호 시각화, 당첨금 집계 표시.
```

---

## Phase 7 — 나의고객 · 커뮤니티 · 고객센터 (일부 미확인 → 직접 구현)

```
CLAUDE.md §9. 04 나의고객(미확인), 02 커뮤니티, 03 고객센터를 구현.

1. 나의고객/담당현황(/my/customers): rep 역할의 메인 화면. 본인 담당 회원을 콜 관점으로(미아웃콜 우선, 전환 단계 표시). 이용자 컴포넌트 재사용 + roleScope=me.
2. 나의고객/문자발송(/my/sms): 대상 선택 + 템플릿(sms_templates, $변수 미리보기) + 발송 → sms_sends 생성, 회원 문자내역·문자로그 동시 반영(§8).
3. 커뮤니티: 공지사항·이벤트 게시판 CRUD(리스트형 경량 변형).
4. 고객센터: 1:1문의(답변 워크플로: 대기→답변완료, Drawer로 답변 작성)·FAQ·공지. 추정 구조는 ASSUMPTIONS 기록.

검수: 문자 발송 시 회원 상세 문자탭/문자로그에 즉시 반영. 문의 답변 상태 전이 동작.
```

---

## Phase 8 — 관리자 · 권한관리 · 로그 (미확인 → 직접 구현)

```
CLAUDE.md §5,§9. 08 관리자/권한, 09 로그(5종)를 추정 구현. admin 전용.

1. /admins: staff 목록(역할·팀·활성·최종로그인). 운영자 생성/수정/비활성. (계정 비번 직접설정 등 민감 동작은 신중히 — 실제 환경 규칙 확인 TODO)
2. /admins/roles 권한관리: **역할 × 기능(모듈) 체크박스 매트릭스** UI. 변경 시 메뉴 노출/RLS와 연동되는 권한 테이블 반영. 원본 미확인 → 매트릭스 구조로 구현 + ASSUMPTIONS 기록.
3. /logs/{admin|point|sms|payment|inflow}: 공통 리스트형(actor·action·target·일시·meta) + 필터. 각 로그는 §8의 액션들이 자동 생성한 레코드를 보여줌. 포인트 시스템 존재 여부는 TODO(live-verify).

검수: §8 액션 수행 후 해당 로그에 레코드 적재 확인. 권한 매트릭스 변경이 메뉴/접근에 반영.
```

---

## Phase 9 — 통계 · 운영 대시보드

```
10 통계(가입·결제 미확인, 유입로그 확인) + 01 메인 대시보드(신규)를 구현.

1. 대시보드(/dashboard): KPI 카드(오늘 신규유입·미아웃콜·결제대기·오늘매출) + 추이 차트 + '처리 대기' 리스트(미아웃콜·결제대기 바로가기). **전부 실시간 집계**(§8), 하드코딩 금지. 카드 클릭 시 해당 필터 적용된 화면으로 이동.
2. 통계/가입(추정): 기간별 가입 추이·유입경로별 차트 + 요약표.
3. 통계/결제(추정): 기간별 결제/매출·상품별·PG별 차트.
4. 통계/유입로그: 확인된 화면 기준 재현.
   추정 지표는 ASSUMPTIONS 기록.

검수: 대시보드 수치가 실제 데이터와 일치, KPI→화면 딥링크 동작. 통계 기간 필터/차트 정상.
```

---

## Phase 10 — 설정

```
13 설정(사이트·리포트·로또고정제외·이용약관)을 구현(스샷 있음). 폼형 패턴(섹션 카드 + 2열 label/input + SaveBar), react-hook-form+zod.

1. 사이트설정: 무통장 설정 / 유저 등급색 / **PG 설정(다중: 웰컴페이먼츠·페이허브·플러스페이·코밴·온미르 TID 다수·하이브플러스)** / 문자 설정(발신번호·SMTNT·발송 스케줄) / 기본 문자멘트 템플릿($변수) / 1~5등 당첨문자 / FAQ·공지 설정. site_settings·sms_templates에 저장. 시크릿(API키)은 마스킹 + 라이브 확인 TODO.
2. 리포트(/settings/report): 정기 리포트 설정.
3. 로또고정제외(/settings/lotto-exclude): 번호 고정/제외 설정 UI.
4. 이용약관(/settings/terms): 약관 편집.

검수: 폼 저장→재로드 유지, 등급색 변경이 전 화면 Badge에 반영(토큰 연동), 스케줄 설정 저장.
```

---

## Phase 11 — 연동 QA · 시드 데이터 · 마감

```
전체 점검 및 마감.

1. 시드 스크립트(supabase/seed.ts): staff 4역할·팀·상품·members 수백 건(등급/상태/유입 다양)·payments·lotto_rounds 몇 회차·bets·로그. 데모/개발용.
2. 교차 연동 E2E 체크리스트(CLAUDE.md §8 표 전부): 배정→나의고객/매출/로그, 결제승인→등급/매출/이력, 문자→히스토리/로그, 아웃콜→대시보드KPI, 당첨확정→당첨자세그먼트. 깨진 연동 수정.
3. 빈/로딩/에러 상태, 역할 가드, 위험 액션 확인 모달, 토큰 일관성 전수 점검.
4. docs/ASSUMPTIONS.md 정리(라이브 검증 항목 목록화), README(실행/배포/env) 작성. Vercel 배포 설정.

검수: 데모 데이터로 전체 운영 플로우가 끊김 없이 작동. 라이브 검증 대기 항목이 명확히 문서화됨.
```

---

## 진행 팁
- Phase가 크면 Claude Code에게 "이 Phase를 todo로 쪼개고 하나씩 진행" 요청.
- 각 Phase 후 `docs/DECISIONS.md`에 한 일/결정 1~2줄 기록 요청 → 다음 세션 컨텍스트 유지.
- 미확인 화면은 완성도보다 **연동·구조**를 먼저. 실제 모습은 라이브 캡처로 v0.2에서 보정.
- 막히면 `docs/pluslotto_admin_spec.html`의 해당 컴포넌트 프리뷰를 근거로 제시.
