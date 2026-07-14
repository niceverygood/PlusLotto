// 회원 일괄 임포트 파서 (§V2-3 DB 입력 ②). .csv/.xlsx 첫 시트 → 헤더 + 행(문자열).
// SheetJS(xlsx)로 두 형식을 한 경로로 처리한다.
// TODO(security): xlsx 0.18.5 는 알려진 취약점(prototype pollution 등)이 있음. 본 도구는
//   내부 운영자(신뢰)가 자사 리드 파일을 올리는 용도라 위험이 낮음. 프로덕션 강화 시
//   패치된 SheetJS 빌드(CDN)로 교체할 것. (docs/ASSUMPTIONS.md 기록)
// xlsx 는 무거우므로(~400KB) 정적 import 하지 않고 parseLeadFile 에서 동적 로드 → 메인 번들 분리.

export interface ParsedSheet {
  headers: string[]
  rows: Record<string, string>[]
}

// CSV 텍스트 디코딩: UTF-8 우선, 깨지면(한국 엑셀 CSV=CP949/EUC-KR) 폴백 디코드.
function decodeCsv(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!utf8.includes('�')) return utf8 // 정상 UTF-8(BOM 자동 제거)
  try {
    return new TextDecoder('euc-kr').decode(bytes) // 한국 엑셀 CSV 폴백
  } catch {
    return utf8
  }
}

/** 파일 첫 시트를 헤더+행으로 파싱. 모든 값은 trim 된 문자열.
 *  CSV 는 텍스트로 디코드(UTF-8/EUC-KR)해 한글 깨짐 방지, 엑셀은 바이너리로 읽는다. */
export async function parseLeadFile(file: File): Promise<ParsedSheet> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv' || file.type === 'text/plain'
  const wb = isCsv ? XLSX.read(decodeCsv(buf), { type: 'string' }) : XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) return { headers: [], rows: [] }
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false })
  const rows = json.map((r) => {
    const o: Record<string, string> = {}
    for (const k of Object.keys(r)) o[k.trim()] = String(r[k] ?? '').trim()
    return o
  })
  const headers = rows.length ? Object.keys(rows[0]) : []
  return { headers, rows }
}

// 매핑 대상 회원 필드 + 헤더 자동매핑 힌트
export const IMPORT_FIELDS = [
  { key: 'name', label: '이름', required: true, hints: ['이름', '성명', '고객명', '회원명', 'name'] },
  {
    key: 'phone',
    label: '휴대폰',
    required: true,
    hints: ['휴대폰', '핸드폰', '전화', '연락처', '번호', 'phone', 'mobile', 'hp'],
  },
  { key: 'inflow_code', label: '유입코드', required: false, hints: ['유입코드', '코드', 'code'] },
  { key: 'inflow_type', label: '유입구분', required: false, hints: ['유입구분', '유입분류', '유입', '경로', '채널', '분류', 'type'] },
  { key: 'consult_status', label: '상담상태', required: false, hints: ['상담상태', '상담', '상태', 'consult'] },
  { key: 'tendency', label: '성향', required: false, hints: ['성향', 'tendency'] },
  { key: 'nickname', label: '닉네임', required: false, hints: ['닉네임', '별명', 'nick'] },
  { key: 'memo', label: '메모', required: false, hints: ['메모', '비고', 'memo', 'note'] },
] as const

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key']

/** 헤더명을 회원 필드에 자동 매핑(키워드 포함 매칭, 1:1). */
export function autoMapHeaders(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  const used = new Set<string>()
  for (const f of IMPORT_FIELDS) {
    const h = headers.find(
      (hd) => !used.has(hd) && f.hints.some((x) => hd.toLowerCase().includes(x.toLowerCase())),
    )
    if (h) {
      map[f.key] = h
      used.add(h)
    }
  }
  return map
}
