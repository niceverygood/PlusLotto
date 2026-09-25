#!/usr/bin/env python3
"""이관 사이트 검수 대조표 생성 — 읽기 전용.

왜 만들었나 (현장 9/23, 정의현 차장 "대조표 전달주시면 해당날짜에 검수하도록 하겠습니다"):
10/5 구전산 발송 중지 → 신전산 발송 전환 전에, 현장이 **신전산에 들어간 회원이 맞는지**와
**10/5 주간에 누구에게 문자가 나가는지**를 눈으로 확인해야 한다. 검수 착수일이 이 표의
전달일에 묶여 있다(D194).

이 표의 핵심은 "지금 상태"가 아니라 **"검수 보류를 풀면 벌어질 일"** 이다.
이관 회원은 전원 `meta.reco_paused=True / reco_pause_reason='legacy_import_review'` 로 묶여
있어(load-legacy-site.py), 현재 상태로 판정하면 전원 "일시정지"로 나와 표가 무의미해진다.
그래서 **그 보류만 해제됐다고 가정**하고 판정한다. 운영자가 건 일반 일시정지는 그대로 제외한다.

⚠️ 판정 규칙은 `src/lib/recoEligibility.ts` 와 `api/weekly-reco.ts` 의 대상 규칙을 옮긴 것이다.
   Python 이라 import 할 수 없어 규칙이 세 곳에 있다. **크론 조건을 바꾸면 여기도 같이 바꿔야
   한다.** 규칙이 갈라지면 "검수에서는 나간다고 했는데 실제로는 안 나갔다"가 되고, 그 순간
   현장은 이 표를 믿지 않게 된다 — D192(조합발송 누락 대조)에서 얻은 교훈과 같다.

출력 (사이트별 폴더, UTF-8 BOM CSV — 엑셀에서 바로 열린다):
  요약.csv          전 사이트 한 장. 회원수·등급·상태·발송요일·결제·담당배정. 구전산 숫자와 맞춰본다.
  <사이트>/발송예정.csv   보류 해제 시 조합문자가 나갈 회원 전체. 이름·연락처·요일·종료일·담당자.
  <사이트>/발송제외.csv   나가지 않는 회원과 그 사유. "나가야 하는데 왜 빠졌지"를 여기서 찾는다.
  <사이트>/점검필요.csv   전환 전에 손봐야 할 것만 추린 것(연락처 없음·종료일 문제·요일 미지정 등).

사용법:
  export VITE_SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...
  python3 scripts/make-review-sheet.py --out ./검수대조표_20260928
  python3 scripts/make-review-sheet.py --site lotto815 --limit 200 --out ./표본

키는 환경변수로만 받는다(명령행·로그에 남기지 않는다). 쓰기는 구조적으로 불가능하다 —
Supa(allow_writes=False) 라 GET 이외 메서드는 예외로 막힌다.

⚠️ 생성 파일에는 회원 성명·연락처가 들어간다. 전달은 암호 압축 등 합의된 경로로만 한다.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import importlib.util
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    'load_legacy_site', ROOT / 'scripts/load-legacy-site.py'
)
_loader = importlib.util.module_from_spec(_SPEC)
assert _SPEC and _SPEC.loader
sys.modules[_SPEC.name] = _loader
_SPEC.loader.exec_module(_loader)
Supa = _loader.Supa

# src/lib/legacySites.ts 의 LEGACY_SITES 와 같은 키·라벨을 쓴다.
SITE_LABELS = {
    'lotto815': '815로또',
    'cplotto': '일행로또',
    'infolotto': '인포로또',
}
# src/lib/recoSchedule.ts PAID_RECO_GRADES / DEFAULT_RECO_DAY 와 값을 맞춘다.
PAID_GRADES = {'gold', 'goldp', 'vip', 'royal'}
DEFAULT_RECO_DAY = 5  # 금요일(0=일..6=토)
GRADE_LABELS = {
    'simple': '간편가입', 'free': '무료', 'gold': '골드', 'goldp': '골드플러스',
    'vip': 'VIP', 'royal': '로얄', 'ovr': '인반언스', 'toss': '토스DB',
}
WEEKDAY = ['일', '월', '화', '수', '목', '금', '토']
# load-legacy-site.py 가 이관 직후 거는 보류. 검수 후 해제될 값이라 판정에서 해제된 것으로 본다.
IMPORT_HOLD = 'legacy_import_review'


def seoul_today() -> str:
    """한국 날짜 'YYYY-MM-DD'. memberExpiry.ts 와 같은 기준."""
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d')


def end_date_past(end: str | None, today: str) -> bool:
    """종료일 경과 여부. 종료일 당일까지는 이용 가능(memberExpiry.ts isEndDatePast 와 동일)."""
    if not end or not end.strip():
        return False
    return end.strip()[:10] < today


def send_plan(member: dict, today: str) -> tuple[str, str, str | None]:
    """보류 해제 후 이 회원에게 벌어질 일. → (구분, 사유, 요일라벨)

    구분은 '발송' / '발급만' / '제외' 세 가지다. '발급만'은 조합은 만들어지지만 문자는
    나가지 않는 무료 등급으로, 누락이 아니라 정상이다.

    전역 스위치(설정 > 유료회원 조합문자·실발송·발신번호)는 여기서 보지 않는다. 회원별
    대조가 목적이고, 전역 스위치는 요약표에 따로 싣는다 — 꺼져 있으면 전원이 같이 막히므로
    회원 명단에 같은 사유를 수만 줄 반복해 봐야 읽히지 않는다.
    """
    meta = member.get('meta') or {}
    grade = member.get('grade') or ''

    # ① 크론의 회원 조회 필터
    if member.get('is_suspended') or member.get('is_deleted') or member.get('is_withdrawn'):
        return '제외', '정지·삭제·탈퇴 회원', None
    # ② 이용 종료일 경과
    if end_date_past(meta.get('end_date'), today):
        return '제외', f"이용 종료일 경과({meta.get('end_date')})", None
    # ③ 발송요일 — 무료는 미설정 시 기본 금요일, 유료는 설정된 회원만
    day = meta.get('weekly_reco_day')
    if not isinstance(day, int):
        day = DEFAULT_RECO_DAY if grade == 'free' else None
    if day is None:
        return '제외', '발송요일 미지정(유료회원은 요일을 지정해야 자동발송)', None
    day_label = f'{WEEKDAY[day]}요일' if 0 <= day < 7 else '?요일'
    # ④ 일시정지 — 이관 검수 보류는 해제 예정이므로 제외 사유로 세지 않는다.
    if meta.get('reco_paused') is True and meta.get('reco_pause_reason') != IMPORT_HOLD:
        return '제외', '조합발송 일시정지(운영자 설정)', day_label
    # ⑤ 발송갯수 0
    if meta.get('weekly_reco_count') == 0:
        return '제외', '조합발송갯수 0', day_label
    # ⑥ 등급·연락처
    if grade not in PAID_GRADES:
        return '발급만', '무료 등급 — 조합은 발급되고 문자는 나가지 않음', day_label
    if not (member.get('phone') or '').strip():
        return '제외', '휴대폰 번호 없음 — 유료회원인데 문자를 보낼 수 없음', day_label
    return '발송', f'매주 {day_label} 조합문자 발송', day_label


def issues(member: dict, verdict: str, today: str) -> list[str]:
    """전환 전에 손봐야 할 것. 정상 제외는 넣지 않는다 — 허위가 섞이면 표 자체를 안 본다."""
    meta = member.get('meta') or {}
    grade = member.get('grade') or ''
    found = []
    paid = grade in PAID_GRADES
    if paid and not (member.get('phone') or '').strip():
        found.append('유료회원인데 휴대폰 번호가 없음')
    if paid and not meta.get('end_date'):
        found.append('유료회원인데 이용 종료일이 없음 — 언제까지 보낼지 알 수 없음')
    if paid and end_date_past(meta.get('end_date'), today):
        found.append(f"이용 종료일이 이미 지남({meta.get('end_date')})")
    if paid and not isinstance(meta.get('weekly_reco_day'), int):
        found.append('유료회원인데 조합발송요일이 없음 — 이대로면 문자가 영영 안 나감')
    if not member.get('assigned_staff_id'):
        found.append('담당자 미배정')
    if meta.get('reco_paused') is True and meta.get('reco_pause_reason') != IMPORT_HOLD:
        found.append('운영자가 건 조합발송 일시정지가 남아 있음')
    return found


def member_row(member: dict, verdict: str, reason: str, day_label: str | None,
               staff_names: dict[str, str]) -> dict:
    meta = member.get('meta') or {}
    return {
        '이름': member.get('name') or '',
        '연락처': member.get('phone') or '',
        '아이디': member.get('user_id') or '',
        '등급': GRADE_LABELS.get(member.get('grade') or '', member.get('grade') or ''),
        '발송요일': day_label or '',
        '이용종료일': meta.get('end_date') or '',
        '주당조합수': meta.get('weekly_reco_count', ''),
        '담당자': staff_names.get(member.get('assigned_staff_id') or '', ''),
        '구전산번호': meta.get('legacy_idx', ''),
        '사유': reason,
    }


def summarize(site: str, members: list[dict], pay_count: int, pay_amount: int,
              today: str) -> list[dict]:
    """사이트 한 곳의 요약 행들. 현장이 구전산 숫자와 한 줄씩 맞춰보는 용도."""
    label = SITE_LABELS.get(site, site)
    grade = Counter(GRADE_LABELS.get(m.get('grade') or '', '기타') for m in members)
    verdicts = Counter()
    days = Counter()
    for member in members:
        verdict, _, day_label = send_plan(member, today)
        verdicts[verdict] += 1
        if verdict == '발송':
            days[day_label or '?'] += 1

    rows = [
        {'사이트': label, '항목': '전체 회원 수', '값': len(members), '설명': '신전산에 들어간 이 사이트 회원'},
        {'사이트': label, '항목': '조합문자 발송 대상', '값': verdicts['발송'],
         '설명': '검수 보류를 풀면 매주 문자가 나갈 회원'},
        {'사이트': label, '항목': '조합 발급만(무료)', '값': verdicts['발급만'],
         '설명': '조합은 만들어지고 문자는 나가지 않음 — 정상'},
        {'사이트': label, '항목': '발송 제외', '값': verdicts['제외'],
         '설명': '사유는 발송제외.csv 참고'},
    ]
    for name, count in sorted(grade.items(), key=lambda kv: -kv[1]):
        rows.append({'사이트': label, '항목': f'등급 · {name}', '값': count, '설명': ''})
    for day in WEEKDAY:
        key = f'{day}요일'
        if days.get(key):
            rows.append({'사이트': label, '항목': f'발송요일 · {key}', '값': days[key],
                         '설명': '이 요일에 문자가 나갈 인원'})
    rows.append({'사이트': label, '항목': '결제 건수', '값': pay_count, '설명': '이관된 결제 이력'})
    rows.append({'사이트': label, '항목': '결제 금액 합계', '값': pay_amount, '설명': '원'})
    rows.append({'사이트': label, '항목': '담당자 미배정', '값':
                 sum(1 for m in members if not m.get('assigned_staff_id')), '설명': ''})
    return rows


def write_csv(path: Path, rows: list[dict], columns: list[str]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    # 엑셀이 UTF-8 을 알아보게 BOM 을 붙인다. 없으면 한글이 깨져서 현장이 표를 못 연다.
    with path.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description='이관 사이트 검수 대조표 생성(읽기 전용)')
    parser.add_argument('--site', action='append', choices=sorted(SITE_LABELS),
                        help='대상 사이트. 생략하면 815·일행·인포 전부')
    parser.add_argument('--out', default='검수대조표', help='출력 폴더')
    parser.add_argument('--limit', type=int, help='사이트당 최대 회원 수(표본 확인용)')
    args = parser.parse_args()

    url = os.environ.get('VITE_SUPABASE_URL') or os.environ.get('SUPABASE_URL')
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not url or not key:
        print('VITE_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.',
              file=sys.stderr)
        return 2

    client = Supa(url, key, allow_writes=False)  # 쓰기는 구조적으로 막는다
    today = seoul_today()
    out = Path(args.out)
    sites = args.site or sorted(SITE_LABELS)

    staff_names = {
        row['id']: row.get('name') or ''
        for row in client.select_all('staff', 'id,name')
    }

    summary_rows: list[dict] = []
    for site in sites:
        label = SITE_LABELS[site]
        print(f'■ {label} 조회 중…')
        members = client.select_all(
            'members',
            'id,user_id,name,phone,grade,status,assigned_staff_id,'
            'is_suspended,is_deleted,is_withdrawn,meta',
            [('meta->>source_site', f'eq.{site}')],
        )
        if args.limit:
            members = members[:args.limit]
        member_ids = {m['id'] for m in members}
        payments = [
            p for p in client.select_all('payments', 'id,member_id,amount,status',
                                         [('meta->>source_site', f'eq.{site}')])
            if p.get('member_id') in member_ids
        ]
        approved = [p for p in payments if p.get('status') == '승인']
        pay_amount = sum(int(p.get('amount') or 0) for p in approved)

        sending, excluded, needs_fix = [], [], []
        for member in members:
            verdict, reason, day_label = send_plan(member, today)
            row = member_row(member, verdict, reason, day_label, staff_names)
            if verdict == '발송':
                sending.append(row)
            else:
                excluded.append({**row, '구분': verdict})
            for issue in issues(member, verdict, today):
                needs_fix.append({**row, '점검항목': issue})

        member_cols = ['이름', '연락처', '아이디', '등급', '발송요일', '이용종료일',
                       '주당조합수', '담당자', '구전산번호', '사유']
        site_dir = out / label
        write_csv(site_dir / '발송예정.csv', sending, member_cols)
        write_csv(site_dir / '발송제외.csv', excluded, ['구분'] + member_cols)
        write_csv(site_dir / '점검필요.csv', needs_fix, ['점검항목'] + member_cols)
        summary_rows += summarize(site, members, len(approved), pay_amount, today)
        print(f'   회원 {len(members):,} · 발송예정 {len(sending):,} · '
              f'제외 {len(excluded):,} · 점검필요 {len(needs_fix):,}')

    # 전역 스위치는 회원별 사유로 반복하지 않고 요약 맨 끝에 한 번만 싣는다(send_plan 주석 참고).
    settings = client.select_all('site_settings', 'weekly_free_reco,sms')
    cfg = (settings[0] if settings else {}) or {}
    reco, sms = cfg.get('weekly_free_reco') or {}, cfg.get('sms') or {}
    for name, on, note in (
        ('유료회원 조합문자 자동발송', reco.get('paid_sms'), '꺼져 있으면 유료회원 전원 문자 안 나감'),
        ('문자 실발송(OneShot 연동)', sms.get('oneshot_enabled'), '꺼져 있으면 실제 문자 안 나감'),
        ('발신번호 설정', bool(sms.get('sender_no')), '통신사에 등록된 번호여야 발송됨'),
    ):
        summary_rows.append({'사이트': '전체 설정', '항목': name,
                             '값': '켜짐' if on else '꺼짐', '설명': note})

    write_csv(out / '요약.csv', summary_rows, ['사이트', '항목', '값', '설명'])
    print(f'\n완료 — {out}/ 에 생성했습니다. (기준일 {today}, 한국 시간)')
    print('※ 성명·연락처가 들어 있습니다. 암호 압축 등 합의된 경로로만 전달하십시오.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
