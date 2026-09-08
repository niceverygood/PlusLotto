#!/usr/bin/env bash
# 레거시 적재 사전 점검 — 데이터를 건드리기 전에 환경이 준비됐는지 확인한다.
#
# 8/31 사고(D177) 이후 만든 안전장치다. 그날은 준비 상태를 확인하지 않고 바로 적재를 시작했고,
# 사이트 구분 기능이 없다는 사실을 데이터가 들어간 뒤에야 알았다.
#
# 사용법:
#   bash scripts/preflight-legacy-load.sh lotto815 ~/Downloads/815korean_paid_all_20260831.zip
#
# 이 스크립트는 아무것도 쓰지 않는다. 읽기만 한다.

set -uo pipefail

SITE="${1:-}"
ARCHIVE="${2:-}"
FAIL=0
WARN=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARN=$((WARN+1)); }
head2(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ -z "$SITE" ] || [ -z "$ARCHIVE" ]; then
  echo "사용법: bash scripts/preflight-legacy-load.sh <사이트키> <zip경로>"
  echo "  예:   bash scripts/preflight-legacy-load.sh lotto815 ~/Downloads/815korean_paid_all_20260831.zip"
  echo
  echo "사이트키: lotto815 · cplotto(일행) · infolotto"
  exit 2
fi

ARCHIVE="${ARCHIVE/#\~/$HOME}"

echo "======================================================"
echo " 레거시 적재 사전 점검 — $SITE"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================================"

# ── 1. 실행 환경 ────────────────────────────────────────────
head2 "1. 실행 환경"

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 -c 'import sys;print(".".join(map(str,sys.version_info[:3])))')"
else
  bad "python3 없음 — 적재 도구를 실행할 수 없다"
fi

if [ -f scripts/load-legacy-site.py ]; then
  ok "적재 도구 확인"
else
  bad "scripts/load-legacy-site.py 없음 — 리포 루트에서 실행해야 한다"
fi

if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  SHA=$(git rev-parse --short HEAD)
  ok "리포 $BRANCH @ $SHA"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    warn "커밋되지 않은 변경이 있다 — 적재 중 문제가 생기면 어느 코드로 돌렸는지 추적하기 어렵다"
  fi
else
  warn "git 저장소가 아니다 — 실행 시점의 코드 버전을 기록할 수 없다"
fi

# ── 2. 원본 파일 ────────────────────────────────────────────
head2 "2. 원본 파일"

if [ -f "$ARCHIVE" ]; then
  SIZE=$(du -h "$ARCHIVE" | cut -f1)
  ok "파일 확인 ($SIZE)"

  if python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).testzip()" "$ARCHIVE" 2>/dev/null; then
    ok "ZIP 무결성 정상"
  else
    bad "ZIP 이 손상됐거나 열 수 없다 — 다시 받아야 한다"
  fi

  echo "  들어 있는 파일:"
  python3 - "$ARCHIVE" <<'PY' 2>/dev/null || bad "ZIP 내용을 읽을 수 없다"
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    if i.is_dir():
        continue
    mb = i.file_size / 1024 / 1024
    print(f'    {i.filename}  ({mb:,.1f}MB)')
PY

  # 로더가 찾는 이름 규칙(user/payment)이 실제로 들어 있는지
  python3 - "$ARCHIVE" "$SITE" <<'PY'
import sys, zipfile
from pathlib import PurePosixPath
PREFIX = {'lotto815': ('lotto815', '815korean'), 'cplotto': ('cplotto',), 'infolotto': ('infolotto',)}
site = sys.argv[2]
if site not in PREFIX:
    print(f'  \033[31m✗\033[0m 알 수 없는 사이트키 "{site}" — lotto815 / cplotto / infolotto 중 하나여야 한다')
    sys.exit(1)
names = [PurePosixPath(n).name for n in zipfile.ZipFile(sys.argv[1]).namelist()]
missing = []
for table in ('user', 'payment'):
    hit = [n for n in names if any(n.startswith(f'{p}_{table}.sql') for p in PREFIX[site])]
    if hit:
        print(f'  \033[32m✓\033[0m {table} 덤프: {hit[0]}')
    else:
        missing.append(table)
if missing:
    exp = ' 또는 '.join(f'{p}_{t}.sql(.gz)' for p in PREFIX[site] for t in missing)
    print(f'  \033[31m✗\033[0m {"·".join(missing)} 덤프를 못 찾았다 — 기대 이름: {exp}')
    sys.exit(1)
PY
  [ $? -ne 0 ] && FAIL=$((FAIL+1))
else
  bad "파일이 없다: $ARCHIVE"
fi

# ── 3. 등급 대응표 ──────────────────────────────────────────
head2 "3. 등급 대응표"

python3 - "$SITE" <<'PY'
import re, sys, pathlib
site = sys.argv[1]
src = pathlib.Path('scripts/load-legacy-site.py').read_text(encoding='utf-8')
m = re.search(r'GRADE_BY_SITE\s*=\s*\{(.*?)\n\}', src, re.S)
if not m:
    print('  \033[31m✗\033[0m GRADE_BY_SITE 를 찾을 수 없다'); sys.exit(1)
line = re.search(rf"'{re.escape(site)}':\s*\{{([^}}]*)\}}", m.group(1))
if not line:
    print(f'  \033[31m✗\033[0m "{site}" 등급 대응표가 없다 — 현장 승인 없이 임의로 채우면 안 된다'); sys.exit(1)
pairs = re.findall(r"'(\w+)':\s*'(\w+)'", line.group(1))
LABEL = {'free':'무료','goldp':'실버','vip':'골드','royal':'다이아'}
print(f'  \033[32m✓\033[0m {site} 등급 대응 {len(pairs)}종')
for code, grade in pairs:
    print(f'      levelNum {code} → {LABEL.get(grade, grade)} ({grade})')
if site == 'cplotto':
    print('  \033[33m!\033[0m 일행로또는 등급 이름이 우리와 겹치는데 뜻이 다르다.')
    print('      일행 「골드」·「골드플러스」 → 우리 실버 / 일행 「VIP」 → 우리 골드')
    print('      현장 상담원 공지가 필요하다.')
PY
[ $? -ne 0 ] && FAIL=$((FAIL+1))

# ── 4. DB 접속 (plan·apply 단계에서만 필요) ─────────────────
head2 "4. DB 접속 정보 (dry-run 에는 불필요)"

if [ -n "${VITE_SUPABASE_URL:-}" ]; then
  ok "VITE_SUPABASE_URL 설정됨 (${VITE_SUPABASE_URL:0:28}…)"
else
  warn "VITE_SUPABASE_URL 미설정 — dry-run 은 가능하지만 plan·apply 는 불가"
fi

if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  ok "SUPABASE_SERVICE_ROLE_KEY 설정됨 (${#SUPABASE_SERVICE_ROLE_KEY}자)"
else
  warn "SUPABASE_SERVICE_ROLE_KEY 미설정 — dry-run 은 가능하지만 plan·apply 는 불가"
fi

# ── 5. 적재 도구 자체 검증 ──────────────────────────────────
head2 "5. 적재 도구 단위 테스트"

if [ -f scripts/test_load_legacy_site.py ]; then
  if OUT=$(python3 scripts/test_load_legacy_site.py 2>&1); then
    N=$(printf '%s' "$OUT" | grep -oE 'Ran [0-9]+ test' | grep -oE '[0-9]+' | head -1)
    ok "테스트 통과 (${N:-?}개)"
  else
    bad "테스트 실패 — 도구가 정상 동작하지 않는다. 아래 출력을 확인할 것"
    printf '%s\n' "$OUT" | tail -20 | sed 's/^/      /'
  fi
else
  warn "테스트 파일이 없다"
fi

# ── 결과 ────────────────────────────────────────────────────
head2 "결과"
if [ "$FAIL" -gt 0 ]; then
  printf '  \033[31m실패 %d건\033[0m · 경고 %d건 — 문제를 해결한 뒤 다시 실행할 것\n\n' "$FAIL" "$WARN"
  exit 1
fi
printf '  \033[32m점검 통과\033[0m · 경고 %d건\n\n' "$WARN"
echo "다음 단계 — 쓰기 없이 무엇이 들어갈지만 확인한다:"
echo
echo "  python3 scripts/load-legacy-site.py \\"
echo "    --site $SITE \\"
echo "    --archive \"$ARCHIVE\" \\"
echo "    --dry-run"
echo
echo "출력에는 개인정보가 포함되지 않는다. 그대로 복사해서 공유하면 된다."
echo
