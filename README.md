# 플러스로또 ADMIN — 운영 콘솔

로또 번호 추천 서비스를 운영하는 **아웃바운드 텔레마케팅 CRM 백오피스**(내부 운영툴). 약 15만 명 규모 회원 DB를 다룬다. 13개 대분류 모듈로 구성되며, 모든 기능은 다음 운영 흐름을 중심으로 유기적으로 연동된다.

```
유입 → 담당 배정 → 아웃콜 → 전환(무료→유료) → 결제(다중 PG) → 번호발송(SMS) → 매출 귀속
```

> 설계의 단일 기준은 [`CLAUDE.md`](CLAUDE.md). 시각 스타일가이드 원본은 [`docs/pluslotto_admin_spec.html`](docs/pluslotto_admin_spec.html).
> 88lotto 코드베이스에서 포크된 브랜드 형제 프로젝트 — 자세한 배경은 CLAUDE.md 상단 참조.

---

## 기술 스택

Vite + React 18 + TypeScript(strict) · Tailwind(토큰 기반) · React Router v6 · TanStack Query v5 / Table v8 · Supabase(Auth+Postgres+RLS) · react-hook-form + zod · recharts · date-fns(ko) · lucide-react · zustand · Pretendard.

---

## 실행

요구: **Node 18+** (개발 환경은 v22).

```bash
npm install
npm run dev      # http://localhost:5173
```

| 스크립트 | 설명 |
|---|---|
| `npm run dev` | 개발 서버(HMR) |
| `npm run build` | `tsc --noEmit` 타입체크 후 프로덕션 빌드(`dist/`) |
| `npm run preview` | 빌드 결과 로컬 프리뷰 |
| `npm run typecheck` | 타입체크만 |

### 데모 로그인 (mock 모드)

env 의 Supabase 키가 비어 있으면 **로컬 seed 데이터**로 자동 동작한다. 비밀번호는 무시되며 로그인ID만 입력하면 된다.

| 로그인ID | 이름 | 역할 | 접근 범위 |
|---|---|---|---|
| `admin01` | 관리자 | admin | 전체 + 관리자/권한/로그/설정 |
| `two001` | 실장 김 | manager | 전체(설정 일부) |
| `leader01` | 팀장 이 | leader | 본인 팀 회원 |
| `rep01` | 담당 박 | rep | 본인 담당 회원만 |
| `rep02` | 담당 최 | rep | 본인 담당 회원만 |

---

## 데이터 소스 & 환경변수

[`.env.example`](.env.example) 를 `.env` 로 복사해 채운다.

```bash
VITE_SUPABASE_URL=        # Supabase 프로젝트 URL
VITE_SUPABASE_ANON_KEY=   # Supabase anon public key
VITE_DATA_SOURCE=         # (옵션) "mock" | "supabase" — 미지정 시 위 두 값 유무로 자동 판단
```

- **두 값이 비어 있으면** → `localStorage`(`pluslotto-db`) 기반 mock 데이터 계층으로 자동 폴백. 외부 의존성 없이 전체 운영 플로우가 동작한다(데모/개발용).
- **두 값을 채우면** → 실 Supabase 로 전환. (마이그레이션/RLS 는 라이브 검증 대기 — 아래 참조)
- `VITE_DATA_SOURCE` 로 강제 지정 가능.

> mock 데이터 초기화: 브라우저에서 `localStorage` 의 `pluslotto-db` 키를 삭제하면 다음 로드 시 재시드. (시드 구조를 바꾸면 `src/lib/db/store.ts` 의 `DB_VERSION` 을 올린다 → 기존 DB 자동 마이그레이션.)

---

## 배포 (Vercel)

SPA 라우팅을 위해 [`vercel.json`](vercel.json) 에 rewrite 가 설정되어 있다(모든 경로 → `index.html`).

1. Vercel 에 저장소 연결 (프레임워크 프리셋: **Vite** 자동 감지)
2. 환경변수 등록: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (mock 데모 배포라면 생략 가능)
3. Build Command `npm run build` · Output `dist` (기본값과 동일)

---

## 폴더 구조 (요약)

```
src/
├─ app/           # routes, providers, AppShell, 라우트 가드(RequireAuth/RequireNav)
├─ design-system/ # tokens.css + 공용 컴포넌트(DataTable·FilterBar·Badge·Drawer·ConfirmModal…)
├─ features/      # 모듈별 수직 슬라이스 (members·payments·revenue·lotto·bets·admins·logs·stats·settings·…)
│                 #   각 feature 의 api.ts(TanStack Query 훅)로만 데이터 접근
├─ lib/           # supabase, auth, format, db/(mock store·seed), queryKeys, permissions, revenueRules, lotto
└─ types/db.ts    # Supabase 생성 타입
docs/
├─ CLAUDE.md(루트)        # 설계 단일 기준
├─ DECISIONS.md           # 설계 결정 기록(D1~)
├─ ASSUMPTIONS.md         # 미확인 화면 추정 + 라이브 검증 체크리스트
└─ pluslotto_admin_spec.html
```

규칙: feature 간 직접 import 금지(공유는 `design-system/`·`lib/` 경유). 서버 상태는 전부 TanStack Query, 클라이언트 UI 상태만 zustand. 색·간격은 토큰/Tailwind 유틸만.

---

## 라이브 검증 대기

본 콘솔은 기존 백오피스를 역설계해 **기능 100% 보존 + UX/UI 재설계**한 것으로, 일부 화면/필드는 추정 구현이다. 운영진 확인이 필요한 항목은 [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) 상단의 **라이브 검증 체크리스트**에 우선순위(A: 동작영향 상수 / B: 세그먼트·스코프 / C: 명칭 / D: 정책·스키마)로 정리되어 있다. 동작에 영향을 주는 가정(매출 귀속·로또 상금·권한 기본값 등)은 한 파일의 상수로 분리되어 라이브 확정 시 한 줄 교체로 반영된다.
