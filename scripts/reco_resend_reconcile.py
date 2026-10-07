#!/usr/bin/env python3
"""조합문자 재발송 명단 만들기 — 운영자 PC에서만 실행 (개인정보 포함 파일을 외부로 보내지 않는다).

입력
  1) ledger.csv  : Supabase SQL Editor 결과 CSV (컬럼: 사이트, 수신번호, 문자내용, 상태, 사유)
                   reco_issue_ledger 의 status in ('unknown','rejected') 행.
  2) vendor.xls  : 문자업체(msgagent) 전송통계 엑셀 (컬럼: 타입, 발송시간, 발신번호, 수신번호, 결과, 메시지)
                   .xls 는 `pip install xlrd` 필요. 엑셀에서 CSV로 저장한 파일도 받는다.

규칙
  - 업체 기록에 같은 수신번호 + 같은 사이트(문자 첫 줄 '<브랜드> No. <회차>')가 이미 있으면 제외한다.
    (결과가 '성공'이 아니어도 업체 접수는 된 것이므로 중복 방지를 위해 제외하고 별도 파일로 남긴다.)
  - 남은 행을 사이트별 resend_<사이트>.csv 로 나눈다 (수신번호, 문자내용). 업체 엑셀 대량발송에 그대로 사용.

사용
  python3 reco_resend_reconcile.py ledger.csv vendor.xls [출력폴더]
"""
import csv
import os
import re
import sys

BRANDS = {
    'pluslotto': 'plus', 'lotto815': '815로또', 'infolotto': '인포로또',
    'cplotto': '일행로또', 'best': '프리미엄로또',
}


def digits(s: object) -> str:
    return re.sub(r'\D', '', str(s or ''))


def head(msg: object) -> str:
    m = re.match(r'^\s*(\S+) No\. (\d+)', str(msg or ''))
    return f'{m.group(1)} {m.group(2)}' if m else ''


def read_vendor(path: str) -> list[dict]:
    if path.lower().endswith(('.xls', '.xlsx')):
        import xlrd  # noqa: PLC0415
        sh = xlrd.open_workbook(path).sheet_by_index(0)
        cols = [str(c.value).strip() for c in sh.row(0)]
        return [dict(zip(cols, [c.value for c in sh.row(r)])) for r in range(1, sh.nrows)]
    with open(path, encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    ledger_path, vendor_path = sys.argv[1], sys.argv[2]
    out = sys.argv[3] if len(sys.argv) > 3 else 'resend_out'
    os.makedirs(out, exist_ok=True)

    vendor = {(digits(v.get('수신번호')), head(v.get('메시지'))) for v in read_vendor(vendor_path)}
    with open(ledger_path, encoding='utf-8-sig', newline='') as f:
        ledger = list(csv.DictReader(f))

    by_site: dict[str, list[tuple[str, str]]] = {}
    skipped: list[tuple[str, str, str]] = []
    bad = 0
    for row in ledger:
        site, phone, body = row.get('사이트', ''), digits(row.get('수신번호')), row.get('문자내용') or ''
        brand = BRANDS.get(site)
        if not brand or not phone or not body or not head(body).startswith(brand + ' '):
            bad += 1
            continue
        if (phone, head(body)) in vendor:
            skipped.append((site, phone, row.get('사유', '')))
            continue
        by_site.setdefault(site, []).append((phone, body))

    for site, items in sorted(by_site.items()):
        with open(os.path.join(out, f'resend_{site}.csv'), 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f)
            w.writerow(['수신번호', '문자내용'])
            w.writerows(items)
    with open(os.path.join(out, 'excluded_already_at_vendor.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['사이트', '수신번호', '사유'])
        w.writerows(skipped)

    print('명단 행:', len(ledger), '/ 형식 오류 제외:', bad, '/ 업체 접수 확인돼 제외:', len(skipped))
    for site, items in sorted(by_site.items()):
        print(f'  재발송 {site}: {len(items)}건 -> {out}/resend_{site}.csv')
    return 0


if __name__ == '__main__':
    sys.exit(main())
