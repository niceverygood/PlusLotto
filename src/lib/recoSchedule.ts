// 조합 자동발급·발송 스케줄 상수 (현장 8/14 — "8/7, 8/14 자동발송 되었어야하나 자동발송 안됨").
//
// 크론(api/weekly-reco.ts)의 대상 판정 규칙:
//   · 무료회원  → weekly_reco_day 가 없으면 기본 금요일로 발급
//   · 유료등급  → weekly_reco_day 가 **설정된 회원만** 발급·문자발송
// 즉 결제로 유료가 돼도 발송요일을 넣어주지 않으면 조합문자가 영영 나가지 않는다. 그 누락을 막기
// 위해 결제 승인 경로와 일괄 복구 작업이 이 값을 공유한다.
//
// ⚠️ api/weekly-reco.ts 는 Vercel 함수 런타임 제약으로 src/ 를 import 하지 못하는 자급자족 파일이라
//    그쪽 PAID_GRADES/DEFAULT_DAY 와 **값을 맞춰서** 유지해야 한다(한쪽만 바꾸지 말 것).
import type { Grade } from '@/types/db'

/** 조합 자동발급·문자발송 대상 유료등급 (api/weekly-reco.ts PAID_GRADES 와 동일). */
export const PAID_RECO_GRADES = new Set<Grade>(['gold', 'goldp', 'vip', 'royal'])

/** 전역 기본 발송요일 — 금요일(0=일..6=토). api/weekly-reco.ts DEFAULT_DAY 와 동일. */
export const DEFAULT_RECO_DAY = 5
