"""Pure conversion of reviewed 815/ilhang history; no I/O, network, or SQL execution.

The private preparation manifest and source archive must be verified by the caller.
This module validates one prepared record and returns (table, insert_payload).
It does not authorize a target, import a row, send a message, or render HTML.
Unknown/direct SMS bodies remain withheld. The credential pattern is defense in
depth, not a guarantee that arbitrary memo/SMS text contains no sensitive content.
"""
from __future__ import annotations
import hashlib
import json
import re
import uuid


class InvalidHistory(ValueError):
    """Only fixed error codes; never includes source text or customer identifiers."""


def require(ok, code):
    if not ok:
        raise InvalidHistory(code)


ESCAPES = {'\\': '\\', "'": "'", '"': '"', 'n': '\n', 'r': '\r',
           't': '\t', 'b': '\b', 'Z': '\x1a'}
BIGINT_MAX = 9223372036854775807
SAFE_TYPES = frozenset(('autoPick', 'adminPickSend', 'autoPickReSend', 'autoPickRecovery'))
CREDENTIAL = re.compile(r'비밀번호|비번|인증번호|인증코드|임시\s*번호|password|passwd|\botp\b|(?:api[_-]?key|access[_-]?token)\s*[:=]|[?&](?:token|key|auth)=', re.I)
POLICIES = frozenset(('body_preserved', 'credential_type_omitted',
                      'credential_pattern_omitted', 'unreviewed_type_omitted'))
TABLES = {'userMemo': 'legacy_member_memos', 'pushSms': 'legacy_member_sms',
          'gameBettingNlotto': 'legacy_member_wins'}
SOURCE_SITES = frozenset(('lotto815', 'cplotto'))
COMMON = {'idx', 'userIdx', 'insertDateTime', 'updateDateTime'}
ALLOWED = {
    'userMemo': COMMON | set('salesIdx statCode statTmCode groupTeamOpenYN typeCode contents insertUserIdx updateUserIdx reservYN reservCheckYN reservDateTime'.split()),
    'pushSms': COMMON | set('salesIdx statCode typeCode contentsTypeCode contentsCode resultCode resultYN resultCountdown insertUserIdx updateUserIdx reserveDateTime from to subject contents'.split()),
    'gameBettingNlotto': COMMON | set('num statCode checkYN pickTypeCode pickFromCode pickStr grade prize'.split()),
}


def decode_mysql_token(token):
    """Decode one dump literal with a strict allowlist; never interpret SQL.

NUL cannot be represented in PostgreSQL text. Unknown escapes are rejected rather
than silently losing a backslash. Quoted 'NULL' and SQL NULL remain distinct.
"""
    require(isinstance(token, str), 'token_type')
    if token == 'NULL':
        return None
    if re.fullmatch(r'-?(?:0|[1-9][0-9]*)', token):
        return token
    require(len(token) >= 2 and token[0] == token[-1] == "'", 'unsupported_literal')
    output = []
    index = 1
    while index < len(token) - 1:
        value = token[index]
        if value == '\\':
            index += 1
            require(index < len(token) - 1 and token[index] in ESCAPES, 'unsupported_escape')
            value = ESCAPES[token[index]]
        elif value == "'":
            require(index + 1 < len(token) - 1 and token[index + 1] == "'", 'unescaped_quote')
            index += 1
        output.append(value)
        index += 1
    result = ''.join(output)
    require('\0' not in result, 'nul_text')
    try:
        result.encode('utf-8', errors='strict')
    except UnicodeError:
        raise InvalidHistory('invalid_unicode') from None
    return result


def source_integer(value, *, nullable=False, minimum=0, maximum=BIGINT_MAX):
    if value is None and nullable:
        return None
    require(isinstance(value, str) and re.fullmatch(r'(?:0|[1-9][0-9]*)', value) is not None,
            'source_integer')
    number = int(value)
    require(minimum <= number <= maximum, 'source_integer_range')
    # A string survives JSON / JS transport without 53-bit rounding.
    return str(number)


def source_yn(value):
    require(value in (None, '', 'Y', 'N'), 'source_yn')
    return value or None


def stable_member_id(idx, site='lotto815'):
    require(isinstance(site, str) and site in SOURCE_SITES, 'source_site')
    return 'mem_' + str(uuid.uuid5(uuid.NAMESPACE_URL,
        f'https://lotto-plus.co.kr/legacy/member/{site}/{idx}'))


def history_insert_payload(record, *, archive_sha256, import_batch, expected_members):
    """Return (table_name, new_payload) for an explicitly verified source-key map.

expected_members must map integer source user IDs to their exact stable target IDs.
All required prepared literals are decoded anew. SMS body gating runs after
decoding as well. No existing member, payment, or prepared record is modified.
"""
    require(isinstance(record, dict) and isinstance(record.get('source_site'), str)
            and record['source_site'] in SOURCE_SITES
            and record.get('historical_only') is True
            and record.get('source_values_encoding') == 'mysql_dump_tokens_not_decoded', 'record_envelope')
    table = record.get('source_table')
    site = record['source_site']
    require(table in TABLES, 'source_table')
    require(isinstance(archive_sha256, str) and re.fullmatch('[0-9a-f]{64}', archive_sha256), 'archive_hash')
    require(isinstance(import_batch, str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,63}', import_batch), 'import_batch')
    tokens = record.get('source_sql_values')
    require(isinstance(tokens, dict) and COMMON <= tokens.keys()
            and tokens.keys() <= ALLOWED[table], 'source_field_allowlist')
    # Decode restricted records too: malformed text should not silently become trusted provenance.
    values = {name: decode_mysql_token(token) for name, token in tokens.items()}
    idx = source_integer(values['idx'], minimum=1)
    user_idx = source_integer(values['userIdx'], minimum=1)
    target = stable_member_id(user_idx, site)
    require(type(record.get('source_user_idx')) is int and record['source_user_idx'] == int(user_idx)
            and record.get('target_member_id') == target
            and expected_members.get(int(user_idx)) == target, 'target_identity')
    key = [int(idx)]
    if table == 'gameBettingNlotto':
        require('num' in values, 'missing_win_round')
        key.append(int(source_integer(values['num'], minimum=1, maximum=2147483647)))
    require(record.get('legacy_key') == key
            and all(type(part) is int for part in record['legacy_key']), 'source_key')
    payload = dict(source_site=site, legacy_idx=idx, source_user_idx=user_idx,
        member_id=target, source_insert_datetime=values['insertDateTime'],
        source_update_datetime=values['updateDateTime'], archive_sha256=archive_sha256,
        prepared_record_sha256=hashlib.sha256(json.dumps(record, sort_keys=True, ensure_ascii=False,
            separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest(), import_batch=import_batch)
    optional = lambda name: values.get(name)
    if table == 'userMemo':
        require({'contents', 'groupTeamOpenYN'} <= values.keys(), 'missing_memo_fields')
        payload.update(body=values['contents'], source_status=optional('statCode'),
            source_consult_status=optional('statTmCode'), source_type=optional('typeCode'),
            source_team_open_yn=source_yn(values['groupTeamOpenYN']),
            source_author_idx=source_integer(optional('insertUserIdx'), nullable=True),
            source_updater_idx=source_integer(optional('updateUserIdx'), nullable=True),
            source_reserved_yn=source_yn(optional('reservYN')),
            source_reservation_checked_yn=source_yn(optional('reservCheckYN')),
            source_reserve_datetime=optional('reservDateTime'))
    elif table == 'pushSms':
        contents_type = optional('contentsTypeCode')
        policy = record.get('body_policy')
        require(isinstance(contents_type, str) and policy in POLICIES, 'sms_policy')
        if policy == 'body_preserved':
            require({'contents', 'subject', 'from', 'to'} <= values.keys(), 'missing_sms_body')
            if contents_type.lower() in ('userpwmofiy', 'userpwmodify'):
                policy = 'credential_type_omitted'
            elif contents_type not in SAFE_TYPES and not re.fullmatch(r'nlottoWin[0-9]+', contents_type):
                policy = 'unreviewed_type_omitted'
            elif CREDENTIAL.search((optional('subject') or '') + '\n' + (optional('contents') or '')):
                policy = 'credential_pattern_omitted'
        payload.update(contents_type=contents_type, source_type=optional('typeCode'), body_policy=policy,
            source_reserve_datetime=optional('reserveDateTime'))
        if policy == 'body_preserved':
            require(values['contents'] is not None, 'missing_sms_body')
            payload.update(body=values['contents'], subject=optional('subject'),
                from_phone=optional('from'), to_phone=optional('to'), source_status=optional('statCode'),
                source_result_yn=optional('resultYN'), source_result_code=optional('resultCode'),
                source_author_idx=source_integer(optional('insertUserIdx'), nullable=True),
                source_updater_idx=source_integer(optional('updateUserIdx'), nullable=True))
        # All omitted policies return only type/source key/times/provenance, even if input had bodies.
    else:
        pick = optional('pickStr')
        require(isinstance(pick, str) and re.fullmatch(r'\|*[0-9]{1,2}(\|[0-9]{1,2}){5}\|*', pick), 'win_numbers')
        numbers = [int(part) for part in pick.strip('|').split('|')]
        require(len(set(numbers)) == 6 and all(1 <= part <= 45 for part in numbers), 'win_numbers')
        payload.update(round_no=key[1], source_status=optional('statCode'),
            source_checked_yn=source_yn(optional('checkYN')), source_pick_type=optional('pickTypeCode'),
            source_pick_from=optional('pickFromCode'), source_pick_string=pick, numbers=numbers,
            rank=int(source_integer(optional('grade'), minimum=1, maximum=5)),
            prize=source_integer(optional('prize')))
    return TABLES[table], payload
