# 라이브 Supabase 전환 런북 (Phase 12)

> mock 데이터 계층(localStorage)을 실 Supabase(Postgres + Auth + RLS)로 전환하는 절차.
> **현재 기본값은 `mock`** 이다(`.env.local` 의 `VITE_DATA_SOURCE=mock`). 아래 단계를 모두 마치고
> 라이브 검증이 끝난 뒤에만 `supabase` 로 바꾼다. 그 전까지 앱은 데모 상태 그대로 동작한다.

전환은 **대시보드 전용 단계(사람만 가능)** 와 **코드 단계(이 저장소)** 로 나뉜다. 코드 단계는 대부분 준비되어 있고,
대시보드 단계는 보안상(서비스 키·인증 사용자 생성) 운영자가 직접 수행해야 한다.

---

## 0. 사전 준비 — 자격증명 확인

`.env.local` (이미 생성됨, `.gitignore` 로 커밋 제외):

```
VITE_SUPABASE_URL=https://rdltwmxuvoutrhkfougi.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...           # 공개키(RLS 보호) — 노출 안전
VITE_DATA_SOURCE=mock                               # 전환 완료 전까지 mock 유지
SUPABASE_SERVICE_ROLE_KEY=                          # ↓ 1줄: 시드용. 절대 커밋·브라우저 노출 금지
```

> ⚠️ **service_role 키는 RLS 를 우회**한다. 로컬 시드 스크립트에서만 쓰고 절대 커밋/배포하지 않는다.
> publishable(anon) 키는 RLS 로 보호되어 클라이언트 노출이 안전하다.

---

## 1. 스키마 적재 (대시보드 SQL Editor)

Supabase 대시보드 → **SQL Editor** → New query 에 아래 파일 내용을 **통째로** 붙여넣고 Run.

1. `supabase/migrations/0001_schema.sql` — 10개 enum + 17개 테이블 + 인덱스.
2. `supabase/migrations/0002_rls.sql` — RLS 정책 + security-definer 헬퍼 + `app_touch_login()` RPC.

> 순서 중요: 0001 → 0002. 재실행 안전(`create or replace` 함수). 테이블 `create table` 은 1회만.
> 다시 깔끔히 시작하려면 새 프로젝트를 쓰거나 `drop schema public cascade; create schema public;` 후 재실행.

검증: Table Editor 에 `members`, `staff`, `payments` … 17개 테이블이 보이면 성공. (아직 비어 있음)

---

## 2. 시드 데이터 적재 (로컬 스크립트)

mock 과 **동일한 데모 데이터**(회원 160 · 결제 67 · 베팅 208 · 배정 132 · 로그 68 …)를 실 DB 에 넣는다.

1. 대시보드 → Project Settings → **API** → `service_role` 키 복사 → `.env.local` 의
   `SUPABASE_SERVICE_ROLE_KEY=` 뒤에 붙여넣기.
2. 실행:
   ```bash
   npm run seed:supabase           # 실 적재
   npm run seed:supabase -- --dry  # (선택) 키 없이 빌드/카운트만 점검
   ```
3. 스크립트는 **전체 삭제 후 재적재**한다. 순환 FK(`teams.leader_id ↔ staff.team_id`)는 자동 처리.
   재실행해도 **이미 연결된 `staff.auth_user_id` 는 보존**된다(아래 4단계 이후 재시드해도 인증 유지).

검증: Table Editor 에서 `members` 약 160행 등 확인.

---

## 3. 인증 사용자 생성 (대시보드 Authentication)

운영자는 화면에서 **login_id**(예: `admin01`)로 로그인하지만, Supabase Auth 는 email 을 요구한다.
규약: **`<login_id>@pluslotto.local`** 합성 이메일을 쓴다(코드 `src/lib/auth.ts` 의 `AUTH_EMAIL_DOMAIN`).

대시보드 → **Authentication → Users → Add user** 로 5개 시드 운영자를 만든다.
각 사용자: *Auto Confirm User* 체크(이메일 인증 생략), 비밀번호 임의 지정(아래는 예시).

| 역할 | login_id | 생성할 이메일 | 비밀번호(예시) |
|---|---|---|---|
| admin | `admin01` | `admin01@pluslotto.local` | (지정) |
| manager(실장) | `two001` | `two001@pluslotto.local` | (지정) |
| leader(팀장) | `leader01` | `leader01@pluslotto.local` | (지정) |
| rep(담당) | `rep01` | `rep01@pluslotto.local` | (지정) |
| rep(담당) | `rep02` | `rep02@pluslotto.local` | (지정) |

> 실제 운영 계정은 추후 별도 생성하고 동일 규약으로 `staff` 행과 잇는다.

---

## 4. staff ↔ auth.users 연결 (대시보드 SQL Editor)

3단계에서 만든 인증 사용자를 `staff.auth_user_id` 에 잇는다. SQL Editor 에서 1회 실행:

```sql
update staff s
set    auth_user_id = u.id
from   auth.users u
where  u.email = lower(s.login_id) || '@pluslotto.local'
  and  s.auth_user_id is null;

-- 검증: 5행이 연결됐는지 확인
select s.login_id, s.role, (s.auth_user_id is not null) as linked
from staff s order by s.role;
```

> 이후 `npm run seed:supabase` 를 다시 돌려도 이 연결은 보존된다(2단계 참고).

---

## 5. 타입 생성 (선택, 권장)

현재 `src/types/db.ts` 는 수기 도메인 모델이다. 라이브 스키마와 정합을 맞추려면 생성 타입을 받는다:

```bash
# 액세스 토큰 필요: https://supabase.com/dashboard/account/tokens
npx supabase login                 # 또는 SUPABASE_ACCESS_TOKEN 환경변수
npx supabase gen types typescript --project-id rdltwmxuvoutrhkfougi > src/types/db.generated.ts
```

생성물은 `Database` 제네릭 타입을 제공한다. 이후 `src/lib/supabase.ts` 의
`createClient(...)` 를 `createClient<Database>(...)` 로 바꾸면 쿼리가 완전 타입드가 된다.
(수기 `db.ts` 의 도메인 인터페이스는 앱 로직이 계속 참조하므로 당장 삭제하지 않는다 — 점진 정합.)

---

## 6. 전환 (flip) 과 라이브 검증

1. `.env.local` → `VITE_DATA_SOURCE=supabase` 로 변경 후 dev 재시작(`npm run dev`).
2. 로그인: `admin01` + 3단계 비밀번호. (이메일 `@pluslotto.local` 자동 합성)
3. **RLS 스코프 검증** — 역할별로 로그인해 데이터 경계 확인:
   - rep(`rep01`) → 본인 담당 회원만 보임.
   - leader(`leader01`) → 본인 팀(team-1) 회원만.
   - manager(`two001`)/admin(`admin01`) → 전체.
4. **§8 연동 검증** — 배정/결제승인/문자발송/아웃콜/당첨확정이 관련 화면·로그에 반영되는지.
5. 문제 시 즉시 `VITE_DATA_SOURCE=mock` 으로 되돌리면 데모 상태로 복귀(데이터 안전).

---

## 진행 현황 (코드 단계)

| 단계 | 상태 | 산출물 |
|---|---|---|
| M0 env + 클라이언트 | ✅ | `.env.local`, `src/lib/supabase.ts` |
| M1 스키마 | ✅ | `0001_schema.sql` |
| M2 RLS + RPC | ✅ | `0002_rls.sql` (`app_touch_login`) |
| M3 시드 스크립트 | ✅ | `scripts/seedSupabase.ts`, `npm run seed:supabase` |
| M4 라이브 인증 | ✅(코드) | `src/lib/auth.ts` 합성 이메일 + staff 해석 + 세션 복원 |
| M5 repo 계층 | ✅ | mock/supabase 분기 기반 (`fetchTables`/`sb()`/`insertLog`) |
| M6 이용자 슬라이스 전환 | ✅ | `features/members/{api,supa}.ts` |
| M7 나머지 전 모듈 전환 | ✅(코드) | 13개 모듈 `features/*/{api,supa}.ts` + lib 헬퍼 mock/supabase 분기 (typecheck·build green) |
| M8 flip + 라이브 QA | ⛔ 대시보드 선행 필요 | 본 런북 1~4단계 완료 후 |

> 코드 단계(M0~M7)는 완료됐다. **라이브 검증(M8)** 만 위 **1~4단계(운영자 전용)** 가 끝나야 실제 응답으로 확인 가능하다.
> 그 전까지 앱은 mock 동작을 보존한 채(데모 정상) `VITE_DATA_SOURCE=mock` 로 유지한다.
