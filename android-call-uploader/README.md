# 플러스로또 통화녹음 자동업로드 앱 (Android 동반앱)

상담원 안드로이드폰의 **기본 통화녹음 폴더**를 감시해서, 새 녹음 파일이 생기면 자동으로
플러스로또 전산에 올려주는 앱이다. 업로드된 녹음은 전화번호로 회원을 찾아 그 회원의
**회원정보창 > 통화녹음** 탭에 자동으로 붙는다.

> 형제 프로젝트 `../88lotto/android-call-uploader` 에서 포크. 소스는 동일하고 **접속 서버·앱 ID만
> 플러스로또 것으로 분리**했다(§ CLAUDE.md 인프라 완전 분리 원칙).

## 서버 연동 구성 (이미 배포 완료)

| 구성요소 | 값/위치 | 상태 |
|---|---|---|
| 업로드 수신 | `POST /api/ingest-call-recording` (`api/ingest-call-recording.ts`) | 배포됨 |
| 로그인 | 플러스로또 Supabase Auth (전산과 **같은 아이디/비번**) | 정상 |
| 회원 자동매칭 | 파일명에서 전화번호 추출 → `members.meta.call_recordings[]` 에 append | 정상 |
| 매칭 실패분 | `unmatched_call_recordings` 테이블 → 전산 `관리자 > 미매칭 통화녹음` 화면에서 수동 연결 | 테이블 생성됨 |

앱 빌드 설정(`app/build.gradle.kts`)이 가리키는 곳:

- `API_BASE_URL` = `https://lotto-plus.co.kr`
- `SUPABASE_URL` = `https://xmfdbmlpvvqqkhqemfay.supabase.co`
- `applicationId` = `kr.bottlecorp.lottoplus.recuploader` (88로또 앱과 별개 — 한 기기 공존 가능)

## 빌드

```bash
cd /Users/seungsoohan/Projects/PlusLotto/android-call-uploader
./gradlew :app:assembleDebug
# 결과: app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` 의 `sdk.dir` 는 로컬 Android SDK 경로(커밋 안 함).

## 상담원 폰 설치·설정 순서

1. APK 를 폰으로 전송해 설치(출처를 알 수 없는 앱 설치 허용 필요).
2. 앱 실행 → **전산과 동일한 로그인 ID / 비밀번호**로 로그인.
3. 권한 2개 허용 — 앱 화면에 버튼으로 안내된다:
   - **전체 파일 접근**(통화녹음 폴더를 읽기 위해 필수)
   - **배터리 최적화 제외**(백그라운드 업로드가 끊기지 않게)
4. 감시 폴더 확인. 기본 프리셋이 자동 등록된다:
   - `Call`, `Recordings/Call`, `Sounds/CallRecordings` (삼성 계열)
   - `MIUI/sound_recorder/call_rec` (샤오미)
   - `CallRecordings`
   - **기종마다 경로가 달라서 프리셋에 없으면** 앱 화면에서 폴더 경로를 직접 추가할 수 있다.
5. 전화를 한 통 걸어 녹음한 뒤, 앱 하단 스캔 로그에 잡히는지 → 전산 회원정보창에 붙는지 확인.

## 남은 확인 사항 (실기기)

- 기종별 **녹음 폴더 경로**와 **파일명 규칙**(전화번호가 파일명에 포함되는지)은 제조사·OS 버전마다
  달라서, 삼성·샤오미·LG 각 1대 이상에서 실사용 검증이 필요하다. 파일명에 번호가 없으면 회원
  자동매칭이 안 되고 `미매칭 통화녹음` 으로 빠진다(전산에서 수동 연결은 가능).
- 폴더 경로가 프리셋과 다르면 4번처럼 앱에서 직접 추가하면 되므로, 대부분은 앱 재빌드 없이 해결된다.
