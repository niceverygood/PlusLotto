# 815로또 → 플러스로또 이관 매핑표

> 근거: 이전 업체 제공 `815korean_유료회원_SQL덤프_코드대응표_20260819.xlsx` (원본 시트는 `docs/legacy/*.tsv`).
> 덤프 원본(압축 148MB / 해제 1,011MB)은 개인정보라 **저장소에 커밋하지 않는다.** 이 저장소는 공개다.

## 0. 덤프 규모 — 예상보다 훨씬 크다

| 테이블 | 행수 | 용량 | 내용 |
|---|---:|---:|---|
| `user` | 13,237 | 18MB | 회원(현재 이용중 유료회원만) |
| `payment` | 21,680 | 14MB | 결제(승인분만) |
| `userMemo` | 178,162 | 60MB | 상담 이력 |
| `pushSms` | 1,517,968 | 855MB | 문자 발송 내역 |
| `gameBettingNlotto` | 347,138 | 65MB | 추천 조합 + 당첨(당첨분만) |

**현장에서 말한 "3만 명"이 아니라 유료회원 13,237명**이다. 대신 부속 데이터가 크다 —
문자 내역만 151만 건(855MB)으로 전체 용량의 85%를 차지한다.

**1차 이관 범위 제안: `user` + `payment` 만.** 회원과 결제가 들어가야 운영이 시작되고, 그
둘만으로 32MB다. 상담메모·문자·조합은 2차로 미루거나 아예 넣지 않는 편이 낫다(§5).

## 1. user → members

| 815 컬럼 | 플러스로또 | 변환 | 확인필요 |
|---|---|---|---|
| `idx` | `meta.legacy_idx` | 그대로 — 결제 연결과 재실행 판정에 쓴다 | |
| `id` | `user_id` | ★ 충돌 주의 — §3 | ★ |
| `name` | `name` | 덤프는 복호화된 평문 | |
| `nick` | `nickname` | | |
| `phone` | `phone` | 숫자만 정규화 후 중복 검사 — §4 | |
| `levelNum`·`itemCode` | `grade` | §2 등급표 | ★ |
| `statCode` | `status` | `normal`→정상 / `block`→정지 / `remove`→삭제 / `leave`→탈퇴 / `standby`→정상(대기 개념 없음) | |
| `statTmCode` | `consult_status` | 라벨이 우리와 거의 일치 — §2 | |
| `inflowUniqCode` | `inflow_code` | | |
| `inflowFromCode` | `inflow_type` | 웹-일반/웹-간편/모바일-일반/모바일-간편 | |
| `salesIdx` | `assigned_staff_id` | ★ 상담원 계정 매핑 필요 — §3 | ★ |
| `adminMemo`, `memoLastContents` | `memo` | 둘 다 있으면 adminMemo 우선 | |
| `insertDateTimeOrg` ?? `insertDateTime` | `registered_at` | 원 가입일이 있으면 그것 | |
| `loginDateTime` | `last_active_at` | | |
| `itemEndDateTime` | `meta.end_date` | **그대로 쓴다** — 우리 만료 판정이 이 값을 본다(D155·D156) | |
| `schedulePickSmsWeek` | `meta.weekly_reco_day` | `sun`=0 … `sat`=6 | |
| `itemOptionSlot` | `meta.weekly_reco_count` | 주당 조합 수(패밀리 10 / 매니아·퍼스트 20) | |
| `adminScoreNum` | — | 관리자 평점(1~5). 우리 `tendency`(적극/보통/신중)와 다른 축이라 `meta` 보관만 | |
| `freeYN` | — | 추출 조건이라 전부 `N`. 저장 불필요 | |

## 2. 코드 매핑

### 2.1 등급 — ★ 운영 결정 필요

| 815 (levelNum) | 상품 | 판매가 | 이용 | 주당조합 | 회원수 | → 플러스로또(제안) |
|---|---|---:|---|---:|---:|---|
| 2 패밀리 | `family` | 488,000 | 18개월 | 10 | 13,993 | **실버**(`goldp`) |
| 3 매니아 | `mania` | 7,880,000 | 36개월 | 20 | 3,876 | **골드**(`vip`) |
| 4 퍼스트 | `first` | 11,880,000 | 36개월 | 20 | 583 | **다이아**(`royal`) |
| 6 언발란스 | `unbalance` | 999,000 | 36개월 | 20 | 0 | 대상 없음 |

가격대·이용기간·주당 조합 수가 실버/골드/다이아와 같은 순서로 대응한다. **다만 이건 추정이고
매출 귀속과 조합 발급 수에 직접 영향을 주므로 현장 확인이 필요하다.**

### 2.2 회원 상태 (`statCode` → `status`)

`normal`→`active` · `block`→`suspended` · `remove`→`deleted` · `leave`→`withdrawn` ·
`standby`→`active`(우리에 '대기' 상태가 없음) · `end`/`freeEnd`/`*BJ`→해당 없음(건수 0)

### 2.3 상담 상태 (`statTmCode` → `consult_status`) — 우리 라벨과 거의 1:1

`new`→신규 · `none`→결번 · `absence`→부재 · `chance`→가망 · `success`→승인 ·
`reserv`→통화예약 · `refuseStubborn`→도입거절 · `refuse`→일반거절 · `etc`→기타 ·
`manageFree`→무료번호관리(우리에 없음 → 기타)

### 2.4 결제수단 (`payMethodCode` → `method`)

`officeCredit`(수기-단말기)→`manual` · `siteBank`(무통장)→`bank` · `siteCredit`(신용카드)→`pg`

> 815는 `officeCredit`(수기)이 결제의 대부분이다. `payResMethod`는 4사 모두 빈값이라 쓰면 안 된다.

### 2.5 결제 상태 (`statCode` → `status`)

`success`→`approved` · `cancel`→`cancelled` · `fail`→`failed` · `standby`→`wait`
(덤프는 `success`만 담고 있어 실제로는 전부 승인)

## 3. payment → payments

| 815 | 플러스로또 | 비고 |
|---|---|---|
| `idx` | `meta`/키 | 재실행 시 중복 방지용 원본 id |
| `userIdx` | `member_id` | `members.meta.legacy_idx` 로 역참조 |
| `itemWon` | `amount` | |
| `payMethodCode` | `method` | §2.4 |
| `statCode` | `status` | §2.5 |
| `itemCode`·`itemName` | `product_id` | 우리 `products` 에 대응 상품이 없으면 신규 생성 필요 ★ |
| `itemStartDateTime` | `period_start` | |
| `itemStartDateTime` + `itemExpMonth` | `period_end` | `itemEndDateTime` 이 있으면 그것 우선 |
| `userBankName` | `depositor_name` | |
| `salesIdx` (또는 `salesRealIdx`) | `staff_id` | 매출 귀속 — §4 |
| `insertDateTime` | `paid_at`·`created_at` | |
| `payInstallmentCode` | — | 할부. 우리에 없음 → `meta` |

## 4. 먼저 정해야 할 것 (막히는 지점)

1. **★ 등급 대응** — §2.1 제안대로 갈지. 잘못되면 조합 발급 수와 매출 분류가 전부 틀어진다.
2. **★ 담당 상담원(`salesIdx`)** — 815 상담원 계정 ↔ 플러스로또 `staff` 대응표가 없다.
   상담원 명단(이름·연락처)을 받아야 한다. 대응 못 하면 **전원 미배정**으로 넣고 나중에 배분한다.
3. **★ 로그인 아이디** — 815 `id` 를 그대로 쓰면 기존 플러스로또 회원과 충돌할 수 있다.
   충돌 시 `pl####` 새 채번으로 넘기고, 원본 id 는 `meta.legacy_id` 에 보관하는 방식을 제안한다.
4. **전화번호 중복** — 우리 DB에 이미 있는 번호는 트리거가 INSERT 를 막고 기존 회원을 '중복 DB'로
   표시한다(D-중복가드). 이관분은 **덮어쓰지 않고 건너뛴 뒤 목록으로 보고**하는 것이 안전하다.
5. **상품(`products`)** — 815 상품 4종을 우리 `products` 에 만들지, 기존 상품에 붙일지.

## 5. 부속 데이터 — 넣을지 말지

| 대상 | 권고 | 이유 |
|---|---|---|
| `userMemo` 178k | **선택 이관** — `typeCode='normal'` 만, 회원당 최근 N건 | 전부 넣으면 회원 상세가 무거워진다. 우리 메모는 `members.meta.memos` 배열이라 회원당 수백 건은 부적합 |
| `pushSms` 152만 | **미이관 권고** | 855MB. 과거 발송 이력은 운영에 거의 쓰이지 않는다. 필요하면 원본 보관으로 충분 |
| `gameBettingNlotto` 34.7만 | **당첨분만 요약 이관** | 회원별 최고 당첨 등수/회차만 뽑아 `win_history`·`meta.win_records` 에 넣으면 당첨자 세그먼트가 살아난다 |

## 6. 진행 순서

1. §4의 ★ 4가지를 현장·대표님과 확정
2. 변환·적재 스크립트 작성 (로컬 덤프 → Supabase 직접, 청크 + 실패 격리 + 재실행 안전)
3. **100건 시범 적재** → 화면에서 눈으로 확인
4. 전체 적재 → 건수 대조(13,237 / 21,680)
5. 원본·드라이브 공유 정리

---

TODO(live-verify): 이 매핑은 **코드대응표만 보고 만든 것**이고 실제 덤프의 값은 아직 확인하지 않았다.
`scripts/inspect-legacy-dump.sh` 로 뽑은 실제 스키마와 대조한 뒤 확정할 것.
