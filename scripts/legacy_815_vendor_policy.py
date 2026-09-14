"""815 담당자 답변의 결제 근거 구분과 원본 보존을 검증하는 순수 함수.

DB/파일/네트워크 접근, 적재 대상 선택, 기존 행 변경, 발송 기능은 없다.
0원 승인 기록은 담당자가 설명한 보상 이력으로 구별하지만 과거 유상 결제를
만들지 않는다. 결제 기록이 전혀 없는 회원의 포함 근거까지 확대하지 않는다.
입력은 동일 원본 회원의 전체 결제 행이어야 한다. 부분 결제 목록으로 결제 없음의
증거를 만들면 안 된다. 반환값은 집계/분류만, 오류는 고정 코드만 포함한다.
이 검증 통과는 기존 계정/중복/배치/RLS/운영 검수 게이트를 대체하지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass
import copy
import datetime as dt
import re
from typing import Mapping, Sequence


GRADE_MAP = {'1': 'free', '2': 'goldp', '3': 'vip', '4': 'royal'}
STATUS_MAP = {'normal': 'active', 'standby': 'active', 'block': 'suspended',
              'remove': 'deleted', 'leave': 'withdrawn'}
PAYMENT_STATUS_MAP = {'success': 'approved', 'cancel': 'cancelled',
                      'fail': 'failed', 'standby': 'wait'}
PRODUCT_MAP = {code: 'legacy_lotto815_' + code for code in ('family', 'mania', 'first')}
KST = dt.timezone(dt.timedelta(hours=9))
MEMBER_CONTRACT_FIELDS = (
    ('itemStartDateTime', 'legacy_member_start_datetime'),
    ('itemEndDateTime', 'legacy_member_end_datetime'),
)


class PreservationError(ValueError):
    """실제 고객 값은 오류 메시지에 포함하지 않는다."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise PreservationError(code)


def source_integer(value: object, code: str, *, positive: bool = False) -> int:
    require(isinstance(value, str) and re.fullmatch(r'[0-9]+', value) is not None, code)
    parsed = int(value)
    require(not positive or parsed > 0, code)
    return parsed


def source_time(value: object) -> dt.datetime | None:
    if value in (None, '', '0000-00-00 00:00:00'):
        return None
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', value) is not None,
            'source_timestamp_invalid')
    try:
        return dt.datetime.strptime(value, '%Y-%m-%d %H:%M:%S').replace(tzinfo=KST)
    except ValueError:
        raise PreservationError('source_timestamp_invalid') from None


def target_time(value: object) -> dt.datetime | None:
    if value is None:
        return None
    require(isinstance(value, str), 'target_timestamp_invalid')
    try:
        normalized = value.replace('Z', '+00:00')
        normalized = re.sub(r'(\d{2}:\d{2}:\d{2}\.)(\d+)',
                            lambda m: m.group(1) + m.group(2).ljust(6, '0')[:6], normalized)
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError:
        raise PreservationError('target_timestamp_invalid') from None
    require(parsed.tzinfo is not None, 'target_timestamp_without_timezone')
    return parsed


@dataclass(frozen=True)
class PaymentEvidence:
    category: str
    approved_payments: int
    approved_amount: int
    zero_approved_payments: int
    scope_review_required: bool


def payment_evidence(source_user_idx: object,
                     source_payments: Sequence[Mapping[str, object]]) -> PaymentEvidence:
    """양수 승인, 0원 승인만, 승인 결제 없음은 서로 다른 근거다.

zero_approved_only의 scope_review_required=False는 담당자의 0원 보상 설명이
확보되었다는 뜻이다. 개별 과거 유상 결제의 금액/일시를 증명하지는 않는다.
"""
    user_idx = source_integer(source_user_idx, 'source_member_key_invalid', positive=True)
    keys: set[int] = set()
    approved: list[int] = []
    for row in source_payments:
        idx = source_integer(row.get('idx'), 'source_payment_key_invalid', positive=True)
        require(idx not in keys, 'source_payment_key_duplicate')
        keys.add(idx)
        require(source_integer(row.get('userIdx'), 'source_payment_member_invalid', positive=True) == user_idx,
                'source_payment_member_mismatch')
        amount = source_integer(row.get('itemWon'), 'source_payment_amount_invalid')
        require(row.get('statCode') in PAYMENT_STATUS_MAP, 'source_payment_status_unknown')
        if row['statCode'] == 'success':
            approved.append(amount)
    category = ('has_positive_approved' if any(amount > 0 for amount in approved)
                else 'zero_approved_only' if approved else 'no_approved_payment')
    return PaymentEvidence(category, len(approved), sum(approved), approved.count(0),
                           category == 'no_approved_payment')


def validate_preserved_payload(
    source_user: Mapping[str, object],
    source_payments: Sequence[Mapping[str, object]],
    member: Mapping[str, object],
    mapped_payments: Sequence[Mapping[str, object]],
    *,
    require_payment_details: bool = True,
) -> PaymentEvidence:
    """현재 회원 상태와 모든 원본 결제를 보존했는지 검사한다. 입력을 바꾸지 않는다.

신규 적재/기존 보완 비교 시 사용할 검증 함수다. 현재 회원 종료일은 운영 모델의
date인 meta.end_date로 비교한다. 결제 period_start/end는 원본 시각까지 대조한다.
현재 로더는 결제 세부 필드 3개를 별도 보완하므로 전체 확장용 검증 기본값은
이 필드까지 요구한다. False는 기존 기본 로더의 제한된 계약을 테스트할 때만 쓴다.
"""
    evidence = payment_evidence(source_user.get('idx'), source_payments)
    require(isinstance(member.get('id'), str) and bool(member['id']), 'member_target_id_missing')
    meta = member.get('meta')
    require(isinstance(meta, Mapping), 'member_metadata_missing')
    require(meta.get('source_site') == 'lotto815', 'member_source_site_mismatch')
    require(type(meta.get('legacy_idx')) is int and meta['legacy_idx'] == int(source_user['idx']),
            'member_source_key_mismatch')
    require(source_user.get('levelNum') in GRADE_MAP, 'source_member_grade_unknown')
    require(member.get('grade') == GRADE_MAP[source_user['levelNum']], 'member_current_grade_changed')
    require(source_user.get('statCode') in STATUS_MAP, 'source_member_status_unknown')
    expected_status = STATUS_MAP[source_user['statCode']]
    require(member.get('status') == expected_status, 'member_current_status_changed')
    for field, status in (('is_deleted', 'deleted'), ('is_withdrawn', 'withdrawn'), ('is_suspended', 'suspended')):
        require(member.get(field) is (expected_status == status), 'member_status_flag_changed')
    end = source_time(source_user.get('itemEndDateTime'))
    require(meta.get('end_date') == (end.date().isoformat() if end else None), 'member_current_end_date_changed')
    if any(target in meta for _, target in MEMBER_CONTRACT_FIELDS):
        require(all(isinstance(source_user.get(source), str) and target in meta
                    and meta[target] == source_user[source] for source, target in MEMBER_CONTRACT_FIELDS),
                'member_original_contract_datetime_changed')
    count = source_integer(source_user.get('itemOptionSlot'), 'source_member_reco_count_invalid')
    require(type(meta.get('weekly_reco_count')) is int and meta['weekly_reco_count'] == count,
            'member_reco_count_changed')
    require(source_user.get('agreeSmsYN') in ('Y', 'N'), 'source_sms_consent_unknown')
    require(meta.get('legacy_agree_sms_yn') == source_user['agreeSmsYN'], 'original_sms_consent_changed')
    require(meta.get('reco_paused') is True and meta.get('reco_pause_reason') == 'legacy_import_review'
            and meta.get('legacy_consent_review_required') is True, 'member_import_hold_changed')
    raw_consent = source_user.get('agreeSmsDateTime')
    if raw_consent in (None, '', '0000-00-00 00:00:00'):
        consent_state = 'legacy_zero_date' if raw_consent == '0000-00-00 00:00:00' else 'missing'
        consent_time = None
    else:
        try:
            consent_time = source_time(raw_consent)
            consent_state = 'valid'
        except PreservationError:
            consent_time, consent_state = None, 'invalid'
    require(meta.get('legacy_consent_timestamp_state') == consent_state
            and target_time(meta.get('legacy_agree_sms_at')) == consent_time, 'original_consent_timestamp_changed')

    require(len(mapped_payments) == len(source_payments), 'payment_rows_added_or_removed')
    actual_by_idx: dict[int, Mapping[str, object]] = {}
    for row in mapped_payments:
        payment_meta = row.get('meta')
        require(isinstance(payment_meta, Mapping), 'payment_metadata_missing')
        idx = payment_meta.get('legacy_idx')
        require(type(idx) is int and idx > 0 and idx not in actual_by_idx, 'target_payment_key_invalid_or_duplicate')
        actual_by_idx[idx] = row
    for raw in source_payments:
        actual = actual_by_idx.get(int(raw['idx']))
        require(actual is not None, 'payment_source_key_missing')
        payment_meta = actual['meta']
        require(payment_meta.get('source_site') == 'lotto815', 'payment_source_site_mismatch')
        require(actual.get('member_id') == member.get('id'), 'payment_member_changed')
        require(type(actual.get('amount')) is int and actual['amount'] == int(raw['itemWon']), 'payment_amount_changed')
        require(actual.get('status') == PAYMENT_STATUS_MAP[raw['statCode']], 'payment_status_changed')
        require(raw.get('itemCode') in PRODUCT_MAP and actual.get('product_id') == PRODUCT_MAP[raw['itemCode']],
                'payment_product_changed')
        for source_field, target_field in (('itemStartDateTime', 'period_start'),
                                          ('itemEndDateTime', 'period_end'), ('insertDateTime', 'paid_at')):
            require(target_time(actual.get(target_field)) == source_time(raw.get(source_field)), 'payment_timestamp_changed')
        if require_payment_details:
            require(isinstance(raw.get('itemStatCode'), str) and isinstance(raw.get('payInstallmentCode'), str),
                    'source_payment_details_missing')
            reco_count = source_integer(raw.get('itemOptionSlot'), 'source_payment_reco_count_invalid')
            require(payment_meta.get('legacy_item_status') == raw['itemStatCode']
                    and type(payment_meta.get('legacy_payment_reco_count')) is int
                    and payment_meta['legacy_payment_reco_count'] == reco_count
                    and payment_meta.get('legacy_installment_code') == raw['payInstallmentCode'],
                    'payment_details_missing_or_changed')
    return evidence


def enrich_new_review_payload(
    source_user: Mapping[str, object],
    source_payments: Sequence[Mapping[str, object]],
    member: Mapping[str, object],
    mapped_payments: Sequence[Mapping[str, object]],
) -> tuple[dict, list[dict]]:
    """새 배치 계획 전용: 복사한 회원/결제에 원본 보존 필드만 추가하고 검증한다.

이미 적재된 행, 001/002의 frozen payload, 기존 strict-meta 실행기에 적용하지
않는다. 신규 계획 작성자가 기존 계정·전화 충돌·배치 게이트를 통과한 뒤 호출한다.
반환값 (회원 복사본, 결제 복사본)에는 고객정보가 있으므로 콘솔/공개 저장소에
출력하지 않는다. 기존 같은 메타 값은 허용하지만 다른 값은 덮어쓰지 않는다.
회원 계약 일시는 zero date/빈 문자열도 원문 그대로 보존한다. 이 메타 보강은
현재 서비스 종료일·등급을 계산하거나 과거 유상 결제를 생성하지 않는다.
"""
    payment_evidence(source_user.get('idx'), source_payments)
    require(all(isinstance(source_user.get(source), str) for source, _ in MEMBER_CONTRACT_FIELDS),
            'source_member_contract_datetime_missing')
    member_copy = copy.deepcopy(dict(member))
    payment_copies = [copy.deepcopy(dict(row)) for row in mapped_payments]

    def add_meta(row: dict, additions: dict) -> None:
        require(isinstance(row.get('meta'), Mapping), 'source_metadata_missing')
        meta = copy.deepcopy(dict(row['meta']))
        for key, value in additions.items():
            if key in meta:
                require(type(meta[key]) is type(value) and meta[key] == value, 'source_metadata_conflict')
            else:
                meta[key] = value
        row['meta'] = meta

    add_meta(member_copy, {target: source_user[source] for source, target in MEMBER_CONTRACT_FIELDS})
    by_idx = {int(raw['idx']): raw for raw in source_payments}
    for row in payment_copies:
        require(isinstance(row.get('meta'), Mapping), 'payment_metadata_missing')
        idx = row['meta'].get('legacy_idx')
        require(type(idx) is int and idx in by_idx, 'payment_source_key_missing')
        raw = by_idx[idx]
        require(isinstance(raw.get('itemStatCode'), str) and isinstance(raw.get('payInstallmentCode'), str),
                'source_payment_details_missing')
        add_meta(row, {
            'legacy_item_status': raw['itemStatCode'],
            'legacy_payment_reco_count': source_integer(raw.get('itemOptionSlot'), 'source_payment_reco_count_invalid'),
            'legacy_installment_code': raw['payInstallmentCode'],
        })
    validate_preserved_payload(source_user, source_payments, member_copy, payment_copies)
    return member_copy, payment_copies
