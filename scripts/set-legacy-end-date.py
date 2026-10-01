#!/usr/bin/env python3
"""이관 사이트 회원의 이용 종료일을 '결제일 + N개월' 규칙으로 일괄 다시 정한다. (D199)

현장 요청(10/1, 정의현 차장): "815로또 실버회원의 경우 종료일을 결제일+27개월로 일괄 수정 가능한지"
  · 실버 = 신전산 등급 goldp (D95 명명: goldp→실버, vip→골드, royal→다이아). 815 '패밀리' 상품 회원이다.
  · 결제일 = 그 회원의 **가장 최근 승인 결제일**(한국 날짜). 기존 종료일 일괄 반영(D156,
    backfillMemberEndDates)과 같은 기준이다. --basis first 로 첫 결제일을 쓸 수 있다.

종료일(meta.end_date)은 만료 판정과 조합발송 자격을 함께 정한다. 틀리면 발송이 조기에 끊기거나
기간이 지나서까지 나간다 — 회원이 알려주기 전까지 드러나지 않는 종류의 오류다. 그래서

  1. --plan 은 읽기만 하고, 회원별 '현재 → 새 종료일' 변경안 CSV 를 만든다. 현장이 표본을 보고 승인한다.
  2. **종료일이 앞당겨지는(단축) 회원은 기본으로 건드리지 않는다.** 이미 낸 이용기간을 줄이는 일이라
     --allow-shorten 을 명시해야만 반영한다. 건수는 --plan 에서 따로 보여준다.
  3. --apply 는 바꾼 회원마다 이전 종료일과 적용 규칙을 meta 에 남기고, 실행 요약을 logs 에 1건 남긴다.

  python3 scripts/set-legacy-end-date.py --site lotto815 --grade goldp --months 27 --plan --out ~/Desktop/815실버_종료일변경안.csv
  python3 scripts/set-legacy-end-date.py --site lotto815 --grade goldp --months 27 --apply --out ~/Desktop/815실버_종료일반영.csv

URL/키는 VITE_SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 환경변수로만 받는다.
⚠️ 출력 CSV 에 성명이 들어간다. 저장소 폴더 밖에 저장하고 합의된 경로로만 전달한다.
"""

from __future__ import annotations

import argparse
import calendar
import csv
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
SITES = ('lotto815', 'cplotto', 'infolotto', 'best', 'lotto88')
GRADES = ('simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss')
GRADE_LABELS = {'goldp': '실버', 'vip': '골드', 'royal': '다이아', 'free': '무료', 'gold': '미정'}

NEW, EXTEND, SHORTEN, SAME, NO_PAYMENT = '신규설정', '연장', '단축', '동일', '승인결제없음'


class Supa:
    """PostgREST 최소 클라이언트. allow_writes=False 면 GET 외에는 예외를 던진다."""

    def __init__(self, url: str, key: str, allow_writes: bool):
        self.url, self.key, self.allow_writes = url.rstrip('/'), key, allow_writes

    def _req(self, method: str, path: str, body=None, prefer: str | None = None):
        if method != 'GET' and not self.allow_writes:
            raise RuntimeError('읽기 전용 모드에서는 Supabase 쓰기를 실행할 수 없습니다')
        request = urllib.request.Request(f'{self.url}/rest/v1/{path}', method=method)
        request.add_header('apikey', self.key)
        request.add_header('Authorization', f'Bearer {self.key}')
        request.add_header('Content-Type', 'application/json')
        if prefer:
            request.add_header('Prefer', prefer)
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, data, timeout=120) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else []
            except urllib.error.HTTPError as error:
                if error.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                db_code, message = 'unknown', '요청이 거부됐습니다'
                try:
                    payload = json.loads(error.read().decode('utf-8', 'replace'))
                    db_code = str(payload.get('code') or db_code)
                    message = str(payload.get('message') or message)
                except (json.JSONDecodeError, AttributeError):
                    pass
                message = re.sub(r'\b\d{6,}\b', '<redacted>', message)[:240]
                raise SystemExit(f'Supabase 요청 실패(HTTP {error.code}, DB {db_code}): {message}') from error
            except urllib.error.URLError as error:
                if attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                raise SystemExit('Supabase 네트워크 요청에 실패했습니다') from error
        return []

    def select_all(self, table: str, columns: str, filters: list[tuple[str, str]]) -> list[dict]:
        rows: list[dict] = []
        for offset in range(0, 10_000_000, 1000):
            params = [('select', columns), ('order', 'id.asc'), ('limit', '1000'),
                      ('offset', str(offset)), *filters]
            page = self._req('GET', f'{table}?{urllib.parse.urlencode(params, safe=",.*()")}')
            rows.extend(page)
            if len(page) < 1000:
                break
        return rows

    def patch(self, table: str, row_id: str, patch: dict):
        query = urllib.parse.urlencode([('id', f'eq.{row_id}')], safe=',.*')
        return self._req('PATCH', f'{table}?{query}', patch, prefer='return=minimal')

    def insert(self, table: str, rows: list[dict]):
        return self._req('POST', table, rows, prefer='return=minimal')


def add_months(base: date, months: int) -> date:
    """date-fns addMonths 와 같다 — 말일을 넘으면 그 달 말일로 맞춘다(1/31 + 1개월 = 2/28·29)."""
    total = base.month - 1 + months
    year, month = base.year + total // 12, total % 12 + 1
    return date(year, month, min(base.day, calendar.monthrange(year, month)[1]))


def kst_date(value: str | None) -> date | None:
    """결제 시각(UTC 저장) → 한국 날짜. 자정 전후 결제가 하루 어긋나지 않게 반드시 변환한다."""
    if not value:
        return None
    text = value.strip().replace('Z', '+00:00')
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(KST).date()


def basis_dates(payments: list[dict], basis: str) -> dict[str, date]:
    """회원별 기준 결제일. 승인 결제만 본다. paid_at 이 없으면 created_at."""
    chosen: dict[str, date] = {}
    for payment in payments:
        if payment.get('status') != 'approved':
            continue
        day = kst_date(payment.get('paid_at') or payment.get('created_at'))
        member_id = payment.get('member_id')
        if day is None or not member_id:
            continue
        current = chosen.get(member_id)
        if current is None or (day > current if basis == 'latest' else day < current):
            chosen[member_id] = day
    return chosen


def classify(current: str | None, new: date) -> str:
    if not current or not str(current).strip():
        return NEW
    try:
        old = date.fromisoformat(str(current).strip()[:10])
    except ValueError:
        return NEW  # 읽을 수 없는 값은 없는 것으로 본다 — 변경안 CSV 에 원래 값이 그대로 남는다
    if new > old:
        return EXTEND
    if new < old:
        return SHORTEN
    return SAME


def build_changes(members: list[dict], payments: list[dict], months: int, basis: str) -> list[dict]:
    bases = basis_dates(payments, basis)
    rows = []
    for member in members:
        meta = member.get('meta') if isinstance(member.get('meta'), dict) else {}
        current = meta.get('end_date')
        base = bases.get(member['id'])
        if base is None:
            rows.append({'member': member, 'base': None, 'current': current, 'new': None, 'kind': NO_PAYMENT})
            continue
        new = add_months(base, months)
        rows.append({'member': member, 'base': base, 'current': current, 'new': new,
                     'kind': classify(current, new)})
    return rows


def should_apply(row: dict, allow_shorten: bool) -> bool:
    return row['kind'] in (NEW, EXTEND) or (row['kind'] == SHORTEN and allow_shorten)


def patched_meta(member: dict, new: date, rule: str) -> dict:
    """meta 를 통째로 바꾸지 않고 병합한다 — 조합발송 보류·발송요일 등 다른 키를 지킨다."""
    meta = dict(member.get('meta') or {})
    # 두 번 돌려도 **최초** 종료일을 잃지 않는다 — 되돌릴 때 필요한 값은 이관 당시의 원래 값이다.
    if 'end_date_before' not in meta:
        meta['end_date_before'] = meta.get('end_date')
    meta['end_date'] = new.isoformat()
    meta['end_date_rule'] = rule
    return meta


def summarize(rows: list[dict], allow_shorten: bool) -> dict[str, int]:
    counts = {kind: 0 for kind in (NEW, EXTEND, SHORTEN, SAME, NO_PAYMENT)}
    for row in rows:
        counts[row['kind']] += 1
    counts['반영대상'] = sum(1 for row in rows if should_apply(row, allow_shorten))
    return counts


def write_csv(path: Path, rows: list[dict], allow_shorten: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['회원ID', '구전산번호', '이름', '등급', '기준결제일', '현재종료일', '새종료일', '구분', '반영'])
        for row in rows:
            member = row['member']
            meta = member.get('meta') if isinstance(member.get('meta'), dict) else {}
            writer.writerow([
                member['id'], meta.get('legacy_idx', ''), member.get('name') or '',
                GRADE_LABELS.get(member.get('grade') or '', member.get('grade') or ''),
                row['base'].isoformat() if row['base'] else '', row['current'] or '',
                row['new'].isoformat() if row['new'] else '', row['kind'],
                'O' if should_apply(row, allow_shorten) else '',
            ])


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--site', required=True, choices=SITES)
    parser.add_argument('--grade', required=True, choices=GRADES)
    parser.add_argument('--months', required=True, type=int)
    parser.add_argument('--basis', choices=('latest', 'first'), default='latest',
                        help='기준 결제일: latest=가장 최근 승인 결제(기본, D156 과 동일) / first=첫 승인 결제')
    parser.add_argument('--allow-shorten', action='store_true',
                        help='종료일이 앞당겨지는 회원도 반영한다(기본은 건드리지 않음)')
    parser.add_argument('--out', required=True, help='변경안 CSV 경로 — 저장소 폴더 밖 권장(성명 포함)')
    parser.add_argument('--url', default=os.getenv('VITE_SUPABASE_URL'))
    parser.add_argument('--key', default=os.getenv('SUPABASE_SERVICE_ROLE_KEY'), help=argparse.SUPPRESS)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', action='store_true', help='읽기 전용 — 변경안 CSV 만 만든다')
    mode.add_argument('--apply', action='store_true', help='명시적으로 실제 반영')
    args = parser.parse_args(argv)
    if not 1 <= args.months <= 120:
        parser.error('--months 는 1~120 사이여야 합니다')
    if not (args.url and args.key):
        parser.error('VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다')
    return args


def main(argv=None):
    args = parse_args(argv)
    rule = f'{args.site}:{args.grade}:{args.basis}_approved_payment+{args.months}m'
    label = GRADE_LABELS.get(args.grade, args.grade)
    print(f"=== {args.site} {label} 종료일 = 결제일 + {args.months}개월 ({'실제 반영' if args.apply else '변경안/읽기 전용'}) ===")
    client = Supa(args.url, args.key, allow_writes=args.apply)

    members = client.select_all('members', 'id,name,grade,meta', [
        ('meta->>source_site', f'eq.{args.site}'), ('grade', f'eq.{args.grade}')])
    payments: list[dict] = []
    ids = [member['id'] for member in members]
    for offset in range(0, len(ids), 100):  # URL 길이 한계 때문에 나눠 읽는다
        chunk = ','.join(ids[offset:offset + 100])
        payments.extend(client.select_all('payments', 'id,member_id,status,paid_at,created_at', [
            ('member_id', f'in.({chunk})'), ('status', 'eq.approved')]))
    print(f'대상 회원 {len(members):,}명 · 승인 결제 {len(payments):,}건 (기준: '
          f"{'가장 최근' if args.basis == 'latest' else '첫'} 승인 결제일, 한국 날짜)\n")

    rows = build_changes(members, payments, args.months, args.basis)
    counts = summarize(rows, args.allow_shorten)
    for kind in (NEW, EXTEND, SHORTEN, SAME, NO_PAYMENT):
        note = ''
        if kind == SHORTEN:
            note = '  ← 반영함(--allow-shorten)' if args.allow_shorten else '  ← 건드리지 않음. 현장 판단 필요'
        print(f'  {kind:<8} {counts[kind]:>7,}명{note}')
    print(f"  {'반영 대상':<7} {counts['반영대상']:>7,}명")

    out = Path(os.path.expanduser(args.out))
    write_csv(out, rows, args.allow_shorten)
    print(f'\n변경안: {out} (성명 포함 — 저장소 밖 보관)')

    if not args.apply:
        print('※ 쓰기 없이 종료했습니다.')
        return

    applied = 0
    for row in rows:
        if should_apply(row, args.allow_shorten):
            client.patch('members', row['member']['id'], {'meta': patched_meta(row['member'], row['new'], rule)})
            applied += 1
            if applied % 200 == 0:
                print(f'  {applied:,}/{counts["반영대상"]:,}')
    client.insert('logs', [{
        'id': f'log_{uuid.uuid4().hex}', 'kind': 'admin', 'actor': None,
        'action': 'member.end_date_bulk_rule', 'target_type': 'member', 'target_id': None,
        'meta': {'site': args.site, 'grade': args.grade, 'months': args.months, 'basis': args.basis,
                 'allow_shorten': args.allow_shorten, 'rule': rule, 'applied': applied,
                 **{kind: counts[kind] for kind in (NEW, EXTEND, SHORTEN, SAME, NO_PAYMENT)}},
    }])
    print(f'완료 — {applied:,}명 반영. 회원별 이전 종료일은 meta.end_date_before 에 남겼습니다.')


if __name__ == '__main__':
    main()
