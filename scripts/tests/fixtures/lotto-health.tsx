// Dev-only visual fixture. Not an application route and not included in the production entry point.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { LottoHealthView } from '../../../src/features/lotto/LottoHealthPanel'
import type { LottoHealth } from '../../../src/features/lotto/health'
import '../../../src/design-system/tokens.css'
import '../../../src/index.css'

const fixture: LottoHealth = {
  checked_at: '2026-10-03T13:40:00+00:00', expected_round: 1244, max_round: 1244, max_confirmed_round: 1244,
  jobs: [{ round_no: 1244, status: 'complete', total: 120, done: 120, winners: 45, rank_counts: { '1': 0, '2': 0, '3': 1, '4': 4, '5': 70 }, last_error: null, updated_at: '2026-10-03T13:39:00+00:00', completed_at: '2026-10-03T13:39:00+00:00' }],
  sms: { pending: 0, claimed: 0, accepted: 45, failed: 0, unknown: 0, skipped: 0 },
  last_attempt_at: '2026-10-03T13:39:00+00:00', last_success_at: '2026-10-03T13:39:00+00:00', last_error: null,
}

function Fixture() {
  const [scenario, setScenario] = useState('healthy')
  const health = structuredClone(fixture)
  if (scenario === 'pending') { health.jobs[0].status = 'running'; health.jobs[0].done = 70; health.max_confirmed_round = 1243 }
  if (scenario === 'missing') { health.max_round = 1243; health.max_confirmed_round = 1243; health.jobs = [] }
  if (scenario === 'sms') health.sms.unknown = 2
  return <MemoryRouter><main className="min-h-screen bg-gray-50 p-6 font-sans">
    <h1 className="mb-4 text-xl font-bold text-ink-900">검수용 가상 데이터 · 운영 데이터 아님</h1>
    <label className="mb-4 block text-sm">확인할 상태 <select className="ml-2 rounded border border-gray-300 p-2" value={scenario} onChange={(event) => setScenario(event.target.value)}>
      <option value="healthy">정상 완료</option><option value="pending">집계 중</option><option value="missing">회차 누락</option><option value="sms">문자 응답 불명</option><option value="error">조회 실패</option><option value="loading">조회 중</option>
    </select></label>
    <LottoHealthView health={health} compact failed={scenario === 'error'} loading={scenario === 'loading'} onRefresh={() => undefined} />
    <LottoHealthView health={health} failed={scenario === 'error'} loading={scenario === 'loading'} onRefresh={() => undefined} />
  </main></MemoryRouter>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>)
