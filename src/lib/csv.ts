// CSV 다운로드 유틸 — UTF-8 BOM(엑셀 한글 깨짐 방지). 셀 이스케이프 포함.
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const esc = (v: string | number | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [headers.map(esc).join(',')].concat(rows.map((r) => r.map(esc).join(',')))
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
