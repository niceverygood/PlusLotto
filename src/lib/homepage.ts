// 고객 홈페이지 로그인 자격증명(현장 피드백). 기본값: ID=전화번호, PW=전화번호 뒷4자리.
// 실제 인증/계정 저장은 고객 홈페이지(별도 프론트) 담당. 여기서는 운영자 확인·안내용으로 파생만 한다.
const digits = (phone: string | null | undefined): string => (phone ?? '').replace(/\D/g, '')

/** 홈페이지 로그인 ID = 전화번호(숫자만). */
export function homepageId(phone: string | null | undefined): string {
  return digits(phone)
}

/** 홈페이지 기본 비밀번호 = 전화번호 뒷 4자리. */
export function homepagePw(phone: string | null | undefined): string {
  return digits(phone).slice(-4)
}
