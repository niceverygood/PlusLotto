// Storage 오브젝트 키 안전화 (현장 8/14 — 통화녹음 자동업로드가 매번 HTTP 500).
//
// 배경: 업로드 경로를 `.../{timestamp}_{원본파일명}` 으로 만들었는데, 삼성 통화녹음 파일명이
// "통화 녹음 01074971957_260814_163223.m4a" 처럼 **한글과 공백**을 포함한다. Supabase Storage 는
// 오브젝트 키 문자셋을 제한해서 이런 키를 거절하고, 그 실패가 500 으로 현장에 나타났다.
//
// 키는 내부 저장 경로일 뿐이고 화면에 보여줄 이름은 따로 `file_name` 에 원본 그대로 보관하므로,
// 키에서는 ASCII 로 눌러도 잃는 정보가 없다.

/**
 * 파일명을 Storage 키에 쓸 수 있는 형태로 바꾼다.
 * - `A-Za-z0-9._-` 외 문자(한글·공백·괄호 등)는 `_` 로 치환
 * - `_` 연속은 하나로, 앞뒤 `_`·`.` 은 제거
 * - 확장자는 보존(플레이어가 확장자로 형식을 판단하는 경우가 있다)
 * - 지나치게 긴 이름은 잘라낸다(경로 길이 한계 회피)
 */
export function safeStorageName(filename: string, maxBase = 60): string {
  const raw = (filename || 'recording').trim()
  const dot = raw.lastIndexOf('.')
  const hasExt = dot > 0 && dot < raw.length - 1
  const base = hasExt ? raw.slice(0, dot) : raw
  const ext = hasExt ? raw.slice(dot + 1) : ''

  const clean = (s: string): string =>
    s
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._]+|[._]+$/g, '')

  const safeBase = clean(base).slice(0, maxBase) || 'recording'
  const safeExt = clean(ext).slice(0, 10)
  return safeExt ? `${safeBase}.${safeExt}` : safeBase
}
