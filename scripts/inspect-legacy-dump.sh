#!/usr/bin/env bash
# 이관용 레거시 SQL 덤프 구조 추출 (현장 8/19 — 815로또 유료회원 이관).
#
# 왜 필요한가: 덤프 원본은 압축 148MB / 해제 1GB+ 라 통째로 주고받거나 AI 대화에 올릴 수 없다.
# 매핑 작업에 실제로 필요한 것은 **데이터가 아니라 구조**(테이블·컬럼·코드값)이고, 그건 다 합쳐도
# 1MB 미만이다. 이 스크립트는 원본을 풀지 않고(스트리밍) 구조만 뽑아 작은 파일 몇 개로 만든다.
#
# ★ 개인정보 보호: 이름·전화번호 같은 실제 값은 뽑지 않는다. 원본은 이 컴퓨터 밖으로 나가지 않는다.
#
# 사용법:
#   bash scripts/inspect-legacy-dump.sh 815korean_유료회원_SQL덤프_20260818.tar.gz
# 결과: ./legacy-schema/ 폴더 (이 폴더째로 전달하면 된다)

set -euo pipefail

FILE="${1:-}"
if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "사용법: bash $0 <덤프파일.tar.gz | .sql.gz | .sql>" >&2
  exit 1
fi

OUT="legacy-schema"
mkdir -p "$OUT"

# 압축 형태에 따라 표준출력으로 흘려보내는 명령을 고른다(원본을 디스크에 풀지 않는다).
case "$FILE" in
  *.tar.gz|*.tgz) CAT=(tar -xzOf "$FILE") ;;
  *.sql.gz|*.gz)  CAT=(gzip -dc "$FILE") ;;
  *.sql)          CAT=(cat "$FILE") ;;
  *) echo "지원하지 않는 확장자: $FILE" >&2; exit 1 ;;
esac

echo "▶ 1/5 압축 내용물 목록"
if [[ "$FILE" == *.tar.gz || "$FILE" == *.tgz ]]; then
  tar -tzf "$FILE" > "$OUT/00_파일목록.txt"
else
  echo "(단일 파일: $FILE)" > "$OUT/00_파일목록.txt"
fi

echo "▶ 2/5 테이블 구조(CREATE TABLE)"
"${CAT[@]}" | sed -n '/^CREATE TABLE/,/^)/p' > "$OUT/01_테이블구조.sql"

echo "▶ 3/5 테이블별 INSERT 문 수"
"${CAT[@]}" | grep -o "^INSERT INTO [\`\"]\?[A-Za-z0-9_]*" \
  | sed 's/^INSERT INTO [`"]\?//' | sort | uniq -c | sort -rn \
  > "$OUT/02_테이블별_INSERT수.txt" || true

echo "▶ 4/5 컬럼 이름만 추출(값 제외)"
grep -E '^\s+[`"]?[A-Za-z0-9_]+[`"]?\s+' "$OUT/01_테이블구조.sql" \
  | sed 's/^[[:space:]]*//' | awk '{print $1, $2}' | tr -d '`"' \
  > "$OUT/03_컬럼목록.txt" || true

# 등급·상태처럼 종류가 적은 코드값은 매핑에 꼭 필요하다. ENUM 정의가 있으면 그것만 뽑는다.
echo "▶ 5/5 ENUM/코드값 정의"
grep -iE "enum\(|set\(" "$OUT/01_테이블구조.sql" > "$OUT/04_코드값정의.txt" || true

echo
echo "완료 — ./$OUT 폴더에 아래 파일이 생성됐습니다:"
ls -la "$OUT"
echo
echo "이 폴더의 파일에는 회원 이름·전화번호 같은 개인정보가 들어 있지 않습니다."
echo "이 폴더만 전달해 주세요. 원본 덤프는 이 컴퓨터에 두시면 됩니다."
