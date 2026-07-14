// 멀티테넌트 브랜드 — 배포별 VITE_BRAND 로 주입(미설정 시 플러스로또). 같은 코드 1벌로 88로또·플러스로또 등
// 여러 전산을 각각 별도 Vercel+Supabase+도메인에 배포한다(88lotto 저장소에서 포크, 현장 7/14).
//   VITE_BRAND       = 전체 표기명(예: '88로또'). 미설정 시 '플러스로또'.
//   VITE_BRAND_SHORT = 로고/네비 접두(예: '88'). 미설정 시 이름에서 '로또' 를 뗀 값.
// name = 문자·푸터·타이틀 전체명 / short = 로고·네비 접두 / rest = 나머지(로고 강조부, 보통 '로또').
const NAME = (import.meta.env.VITE_BRAND as string | undefined)?.trim() || '플러스로또'
const SHORT_ENV = (import.meta.env.VITE_BRAND_SHORT as string | undefined)?.trim()
const REST = NAME.endsWith('로또') ? '로또' : ''
const SHORT = SHORT_ENV || (REST ? NAME.slice(0, NAME.length - REST.length) : NAME) || NAME

export const BRAND = {
  /** 전체 표기명 — '플러스로또' / '88로또' */
  name: NAME,
  /** 로고·네비 접두 — '플러스' / '88' */
  short: SHORT,
  /** 로고 강조부(short 뒤) — '로또' */
  rest: REST || NAME,
} as const

// 브라우저 탭 제목도 브랜드로(index.html 은 로드 전 폴백만 표시).
if (typeof document !== 'undefined') document.title = `${NAME} 운영 콘솔`
