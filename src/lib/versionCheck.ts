// 새 버전 배포 감지(현장 피드백 7/31) — "자동발송은 새 포맷인데 수동발송은 옛 포맷으로 나간다"는
// 제보의 실제 원인은 코드 버그가 아니라, 배포 전에 열어둔 브라우저 탭이 그대로 옛 JS 번들을 쓰고
// 있었기 때문이었다(크론은 항상 최신 서버 코드). SPA 는 새 배포가 떠도 저절로 알아채지 못하므로,
// 주기적으로 index.html 을 다시 받아 현재 로드된 진입 스크립트와 다르면 새로고침을 안내한다.
import { useEffect, useState } from 'react'

const CHECK_INTERVAL_MS = 5 * 60_000 // 5분

function currentEntryScriptSrc(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]')
  return script?.getAttribute('src') ?? null
}

function extractEntryScriptSrc(html: string): string | null {
  const m = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)
  return m ? m[1] : null
}

export function useNewVersionAvailable(): boolean {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    const current = currentEntryScriptSrc()
    if (!current) return // 개발 서버 등 진입 스크립트를 못 찾으면 검사하지 않는다.

    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/', { cache: 'no-store' })
        const html = await res.text()
        const latest = extractEntryScriptSrc(html)
        if (!cancelled && latest && latest !== current) setStale(true)
      } catch {
        // 네트워크 오류는 무시(다음 주기에 재시도) — 새로고침 안내는 필수 기능이 아니다.
      }
    }

    const id = setInterval(check, CHECK_INTERVAL_MS)
    const onFocus = () => check()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return stale
}
