#!/usr/bin/env python3
"""문자 발송 내역(pushSms) 요약 — 원본을 옮기지 않고 쓸 만한 것만 뽑는다 (현장 8/24).

왜: 815 의 `pushSms` 는 151만 건 / 해제 896MB 로 덤프 전체 용량의 대부분이다. 대화에 올릴
수도 없고, 올려도 과거 발송 이력 151만 건은 운영에 쓰이지 않는다(D164·D167 미이관 권고).
그래도 **회원별 요약**(발송 건수·최초·최근·유형별)은 쓸모가 있고, 그건 회원 수만큼이라
815 기준 13,237행 · 1MB 미만이다. 이 스크립트는 원본을 풀지 않고 스트리밍으로 그것만 만든다.

★ 개인정보: 문자 본문(`contents`)·수신번호(`to`)·발신번호(`from`)는 **뽑지 않는다.**
  `apiKey` 같은 연동 키도 마찬가지다. 결과 파일에는 회원 번호와 집계 숫자만 들어간다.

사용법:
  python3 scripts/summarize-pushsms.py lotto815_pushSms.sql.gz
  → lotto815_pushSms_요약.tsv (회원별) + 화면에 전체 집계

원본 .gz 를 그대로 넣으면 된다. 896MB 짜리로 푼 .sql 은 지워도 된다.
"""
import collections
import gzip
import io
import os
import sys

CHUNK = 1 << 20  # 1MB 씩 읽는다 — 896MB 를 통째로 메모리에 올리지 않기 위해서다.


def iter_rows(fh):
    """`-- 컬럼:` 헤더에서 컬럼명을 읽고, 최상위 튜플을 하나씩 흘려보낸다.

    문자 본문에 줄바꿈·괄호·쉼표가 들어 있어 줄 단위로는 못 자른다. 따옴표 상태를
    추적하며 스캔하되, 버퍼는 완성된 튜플까지만 잘라내 메모리를 일정하게 유지한다.
    """
    cols, buf, head_done = None, '', False
    while True:
        chunk = fh.read(CHUNK)
        if not chunk and not buf:
            break
        buf += chunk
        if not head_done:
            if '\n' not in buf:
                if not chunk:
                    break
                continue
            head, sep, rest = buf.rpartition('\n')
            for line in head.split('\n'):
                if line.startswith('-- 컬럼:'):
                    cols = line.split(':', 1)[1].strip().split(',')
                    head_done = True
            if not head_done:
                buf = rest if chunk else ''
                if not chunk:
                    break
                continue
            buf = head[head.index('-- 컬럼:'):] + sep + rest if cols else rest
        pos = 0
        while True:
            start = buf.find('\n(', pos)
            if start < 0:
                break
            i, depth, inq, esc, cur, out = start + 2, 1, False, False, [], []
            done = False
            while i < len(buf):
                ch = buf[i]
                if esc:
                    cur.append(ch); esc = False
                elif inq:
                    if ch == '\\': esc = True; cur.append(ch)
                    elif ch == "'": inq = False; cur.append(ch)
                    else: cur.append(ch)
                elif ch == "'": inq = True; cur.append(ch)
                elif ch == '(': depth += 1; cur.append(ch)
                elif ch == ')':
                    depth -= 1
                    if depth == 0:
                        out.append(''.join(cur)); done = True; break
                    cur.append(ch)
                elif ch == ',' and depth == 1:
                    out.append(''.join(cur)); cur = []
                else:
                    cur.append(ch)
                i += 1
            if not done:
                break  # 튜플이 아직 안 끝났다 — 다음 청크를 더 읽는다
            yield cols, [v.strip() for v in out]
            pos = i
        buf = buf[pos:]
        if not chunk:
            break


def unquote(v):
    return v[1:-1] if len(v) >= 2 and v[0] == "'" else v


def main(argv):
    if len(argv) != 2:
        raise SystemExit(__doc__)
    path = argv[1]
    opener = gzip.open if path.endswith('.gz') else open
    per = collections.defaultdict(lambda: {'n': 0, 'first': '', 'last': '', 'types': collections.Counter()})
    types = collections.Counter()
    results = collections.Counter()
    total = 0

    with opener(path, 'rt', encoding='utf-8', errors='replace') as fh:
        for cols, r in iter_rows(fh):
            if len(r) != len(cols):
                continue
            d = dict(zip(cols, r))
            uid = unquote(d.get('userIdx', '0'))
            dt = unquote(d.get('insertDateTime', ''))
            tc = unquote(d.get('contentsTypeCode', '')) or unquote(d.get('typeCode', ''))
            e = per[uid]
            e['n'] += 1
            if dt and (not e['first'] or dt < e['first']): e['first'] = dt
            if dt and dt > e['last']: e['last'] = dt
            e['types'][tc] += 1
            types[tc] += 1
            results[unquote(d.get('resultYN', ''))] += 1
            total += 1
            if total % 200_000 == 0:
                print(f'  … {total:,}건 처리', file=sys.stderr)

    base = os.path.basename(path).replace('.sql.gz', '').replace('.sql', '')
    out = f'{base}_요약.tsv'
    top = [t for t, _ in types.most_common(8)]
    with open(out, 'w', encoding='utf-8') as w:
        w.write('userIdx\t총건수\t최초발송\t최근발송\t' + '\t'.join(top) + '\n')
        for uid, e in sorted(per.items(), key=lambda kv: -kv[1]['n']):
            w.write(f"{uid}\t{e['n']}\t{e['first']}\t{e['last']}\t"
                    + '\t'.join(str(e['types'].get(t, 0)) for t in top) + '\n')

    print(f'\n총 {total:,}건 / 회원 {len(per):,}명')
    print(f'회원당 평균 {total / max(len(per), 1):.1f}건')
    print('\n[문자 유형]')
    for t, n in types.most_common(15):
        print(f'  {t or "(빈)":24} {n:>10,}')
    print('\n[발송 결과]')
    for t, n in results.most_common(8):
        print(f'  {t or "(빈)":24} {n:>10,}')
    print(f'\n→ {out} ({os.path.getsize(out) / 1024:.0f}KB) 생성. 이 파일만 보내주시면 됩니다.')
    print('  (회원 번호와 집계 숫자만 들어 있고, 문자 본문·전화번호는 없습니다.)')


if __name__ == '__main__':
    main(sys.argv)
