"""815 후속 후보 전용 순수 계획 함수. 네트워크/DB 쓰기/문자 기능은 없다.

운영 권한 또는 팀·테스트 플래그는 고객이 아니라고 단정하지 않고 검토 대상으로
제외한다. 기존 100명의 승인 계획을 재해석하거나 이미 적재된 행을 수정하지 않는다.
"""
from __future__ import annotations

from collections import Counter
import datetime as dt
import hashlib
import json
import re


ACCOUNT_REVIEW_FIELDS = (
    'groupSystemYN', 'groupAdminYN', 'groupPartnerYN', 'groupSalesYN',
    'groupSecondSalesYN', 'groupStaffYN', 'groupDummyYN',
    'groupTeamAdmYN', 'groupTeamYN',
)


def account_review_reasons(user):
    reasons = []
    if any(user.get(field) == 'Y' for field in ACCOUNT_REVIEW_FIELDS):
        reasons.append('account_flags_require_review')
    if any(user.get(field) not in ('Y', 'N') for field in ACCOUNT_REVIEW_FIELDS):
        reasons.append('account_flags_missing_or_unknown')
    return reasons


def enrich_review_metadata(member, user):
    """원본의 제한된 Y/N만 보존한다. 보류 해제나 수신동의 정책 판단은 하지 않는다."""
    raw_date = user.get('agreeSmsDateTime') or ''
    consent_at, date_state = None, 'missing'
    if raw_date == '0000-00-00 00:00:00':
        date_state = 'legacy_zero_date'
    elif raw_date:
        date_state = 'invalid'
        if re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', raw_date):
            try:
                parsed = dt.datetime.strptime(raw_date, '%Y-%m-%d %H:%M:%S')
                consent_at = parsed.replace(tzinfo=dt.timezone(dt.timedelta(hours=9))).isoformat()
                date_state = 'valid'
            except ValueError:
                pass
    member['meta'].update({
        'legacy_account_flags': {field: user.get(field) for field in ACCOUNT_REVIEW_FIELDS},
        'legacy_agree_sms_yn': user.get('agreeSmsYN'),
        'legacy_agree_sms_at': consent_at,
        'legacy_consent_timestamp_state': date_state,
        # 전용 의미를 확정하기 전까지 원문 값만 저장한다. 현대 시스템의 동의와 자동 등치하지 않는다.
        'legacy_consent_review_required': True,
        'reco_paused': True,
        'reco_pause_reason': 'legacy_import_review',
    })


def build_review_plan(loader, users, payments, existing, batch_id, limit=100):
    """새 고객만 후보로 만들고, 내부 중복의 양쪽과 기존 고객의 결제 보충도 제외한다.

반환 객체에는 계획 행이 있으므로 저장소/로그에 출력하면 안 된다. 요약·지문만 공개한다.
전체 원본을 입력해야 원본 후반의 중복 번호도 앞부분 후보에서 제외할 수 있다.
"""
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise ValueError('검토 후보 수는 양의 정수여야 합니다.')
    if not loader.BATCH_ID_RE.fullmatch(batch_id):
        raise ValueError('검토 배치 형식 오류')
    idx_counts = Counter(loader.num(user.get('idx')) for user in users)
    phone_counts = Counter(loader.digits(user.get('phone')) for user in users)
    exclusions = Counter()
    eligible = []
    for user in users:
        idx = loader.num(user.get('idx'))
        phone = loader.digits(user.get('phone'))
        # 사유는 독립 집계이므로 사유별 건수를 합하면 행 수와 같지 않을 수 있다.
        reasons = account_review_reasons(user)
        if idx is None or idx <= 0 or idx_counts[idx] != 1:
            reasons.append('source_member_key_invalid_or_duplicate')
        if not re.fullmatch(r'01\d{8,9}', phone):
            reasons.append('source_phone_invalid')
        elif phone_counts[phone] > 1:
            reasons.append('source_phone_duplicate_all_rows')
        if ('lotto815', idx) in existing.legacy_member_ids:
            reasons.append('already_imported_source_member')
        if idx is not None and loader.stable_id('member', 'lotto815', idx) in existing.member_ids:
            reasons.append('existing_deterministic_member_id')
        if phone in existing.phones:
            reasons.append('existing_phone_match')
        if user.get('agreeSmsYN') not in ('Y', 'N'):
            reasons.append('source_sms_consent_missing_or_unknown')
        if reasons:
            exclusions.update(reasons)
            continue
        member, error = loader.build_member(user, 'lotto815', loader.GRADE_BY_SITE['lotto815'], batch_id)
        if error or member is None:
            exclusions['member_mapping_requires_review'] += 1
            continue
        eligible.append(user)

    selected = eligible[:limit]
    selected_by_idx = {loader.num(user['idx']): user for user in selected}
    selected_payments = [row for row in payments if loader.num(row.get('userIdx')) in selected_by_idx]
    # 선택된 결제 중 PK가 중복이면 임의의 한 건을 고르지 않고 계획 자체를 중단한다.
    payment_key_counts = Counter(loader.num(row.get('idx')) for row in payments)
    if any(key is None or key <= 0 or payment_key_counts[key] != 1
           for key in (loader.num(row.get('idx')) for row in selected_payments)):
        raise ValueError('검토 범위 결제 원본키 중복 또는 오류')
    plan = loader.build_import_plan(selected, selected_payments, 'lotto815', existing, batch_id=batch_id)
    if len(plan.members) != len(selected) or len(plan.payments) != len(selected_payments):
        raise ValueError('검토 후보의 회원 또는 결제 변환 누락')
    for member in plan.members:
        enrich_review_metadata(member, selected_by_idx[member['meta']['legacy_idx']])
    full_payload = json.dumps({
        'members': plan.members, 'payments': plan.payments, 'products': plan.products,
    }, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    summary = {
        'review_only': True, 'db_writes': 0, 'sms_requests': 0,
        'eligible_source_members': len(eligible),
        'excluded_source_members': len(users) - len(eligible),
        'overlapping_exclusion_reasons': dict(sorted(exclusions.items())),
        'candidate_members': len(plan.members), 'candidate_payments': len(plan.payments),
        'candidate_payment_amount': sum(row['amount'] for row in plan.payments),
        'candidate_original_sms_consent': dict(sorted(Counter(user['agreeSmsYN'] for user in selected).items())),
        'candidate_consent_timestamp_states': dict(sorted(Counter(row['meta']['legacy_consent_timestamp_state'] for row in plan.members).items())),
        'all_candidates_held': all(row['meta']['reco_paused'] is True for row in plan.members),
        'all_consent_requires_review': all(row['meta']['legacy_consent_review_required'] is True for row in plan.members),
        'full_payload_sha256': hashlib.sha256(full_payload.encode()).hexdigest(),
        'requires_fresh_db_comparison_before_apply': True,
        'approval_status': 'not_approved',
    }
    return plan, summary
