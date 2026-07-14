// 조합생성 로직 구현현황 → Word(.docx) 생성. 실행: NODE_PATH=$(npm root -g) node scripts/build-logic-doc.cjs
const fs = require('fs')
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType, ShadingType, VerticalAlign,
} = require('docx')

const FONT = 'Malgun Gothic' // 한글 표준 폰트(미지원 환경은 자동 대체)
const CONTENT = 9026 // A4 - 좌우 1인치 여백
const border = { style: BorderStyle.SINGLE, size: 1, color: 'C7CDD6' }
const borders = { top: border, bottom: border, left: border, right: border }
const HEAD = 'E8EEF7'
const margins = { top: 60, bottom: 60, left: 120, right: 120 }

const t = (text, opts = {}) => new TextRun({ text, font: FONT, ...opts })
const para = (children, opts = {}) => new Paragraph({ children, ...opts })

function cell(content, { w, fill, bold = false, align = AlignmentType.LEFT } = {}) {
  const runs = Array.isArray(content) ? content : [t(String(content), { bold })]
  return new TableCell({
    borders, width: { size: w, type: WidthType.DXA }, margins, verticalAlign: VerticalAlign.CENTER,
    shading: fill ? { fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    children: [new Paragraph({ alignment: align, children: runs })],
  })
}
function row(cells) { return new TableRow({ children: cells }) }
function table(colWidths, rows) {
  return new Table({ width: { size: CONTENT, type: WidthType.DXA }, columnWidths: colWidths, rows })
}
const bullet = (runs) => new Paragraph({ numbering: { reference: 'b', level: 0 }, children: Array.isArray(runs) ? runs : [t(runs)] })
const num = (runs) => new Paragraph({ numbering: { reference: 'n', level: 0 }, children: Array.isArray(runs) ? runs : [t(runs)] })
const spacer = () => new Paragraph({ children: [t('')] })

const heading = (text, lvl = HeadingLevel.HEADING_2) =>
  new Paragraph({ heading: lvl, children: [t(text, { bold: true })] })

const children = []

// ── 제목 ──
children.push(new Paragraph({
  spacing: { after: 60 },
  children: [t('플러스로또 추천조합 생성 로직 — 전산 구현 현황', { bold: true, size: 32 })],
}))
children.push(new Paragraph({
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2756D6', space: 4 } },
  spacing: { after: 160 },
  children: [t('작성 2026-06-23  ·  제공해주신 「제외수 프로그램」 방식의 전산 적용 현황 1:1 정리', { size: 18, color: '6B7585' })],
}))
children.push(para([t('구현 원본(단일 출처): ', { size: 18, color: '6B7585' }), t('src/lib/lottoGenerator.ts', { font: 'Consolas', size: 18, color: '343C49' }), t('  ·  자동발급 크론 ', { size: 18, color: '6B7585' }), t('api/weekly-reco.ts', { font: 'Consolas', size: 18, color: '343C49' }), t(' (동일 로직)', { size: 18, color: '6B7585' })], { spacing: { after: 200 } }))

// ── 0. 한눈에 보기 ──
children.push(heading('0. 한눈에 보기 — 처리 흐름'))
children.push(num([t('대상회차 = 최신 회차 + 1, 추첨월 = 직전 회차의 추첨월로 기준 설정')]))
children.push(num([t('제외수 산정', { bold: true }), t(' — 5개 규칙으로 후보 수집 → 10/15/20개로 "압축" → 운영자 수동제외 병합')]))
children.push(num([t('풀 구성', { bold: true }), t(' — 남은 풀 = 45 − 제외수 (운영자 고정수는 항상 포함)')]))
children.push(num([t('조합 생성', { bold: true }), t(' — 풀에서 "품질 필터"를 통과하는 6개 조합을 N세트')]))
children.push(num([t('로직 : 랜덤 혼합', { bold: true }), t(' — 발급 시 N조합 = 로직조합(비율%) + 완전랜덤(나머지). 기본 100% 로직')]))
children.push(para([t('→ 제공하신 규칙(직전회차·보너스·월별 저출현·저빈도·40번대 과출현 + 압축 + 극단조합 회피)이 그대로 구현되어 있으며, 회원이 실제 받는 발급 조합은 ', {}), t('주간 자동발급·수동발급·일괄설정 모두 동일 엔진', { bold: true }), t('을 공유합니다.')], { spacing: { before: 120, after: 160 } }))

// ── 1. 제외수 5규칙 ──
children.push(heading('1. 제외수 5규칙 (코드: computeExclusions)'))
children.push(para([t('각 후보 번호에 우선순위를 부여해 모은 뒤, 번호별 최상위 사유만 남기고 우선순위 내림차순으로 상위 N개(=제외수 개수)만 채택("압축")합니다.')], { spacing: { after: 120 } }))
children.push(table([620, 1700, 5306, 1400], [
  row([cell('#', { w: 620, fill: HEAD, bold: true, align: AlignmentType.CENTER }), cell('규칙', { w: 1700, fill: HEAD, bold: true }), cell('구현 내용', { w: 5306, fill: HEAD, bold: true }), cell('우선순위', { w: 1400, fill: HEAD, bold: true, align: AlignmentType.CENTER })]),
  row([cell('①', { w: 620, align: AlignmentType.CENTER }), cell('직전회차 상·하위', { w: 1700 }), cell('직전 당첨 6개 중 최상위 2개 + 최하위 1개 = 3개', { w: 5306 }), cell('100', { w: 1400, align: AlignmentType.CENTER })]),
  row([cell('②', { w: 620, align: AlignmentType.CENTER }), cell('직전 보너스', { w: 1700 }), cell('직전회차 보너스 1개', { w: 5306 }), cell('95', { w: 1400, align: AlignmentType.CENTER })]),
  row([cell('③', { w: 620, align: AlignmentType.CENTER }), cell('월별 저출현', { w: 1700 }), cell('대상 추첨월에 역대 출현이 가장 적은 번호 (동률은 전체 저빈도순)', { w: 5306 }), cell('80', { w: 1400, align: AlignmentType.CENTER })]),
  row([cell('④', { w: 620, align: AlignmentType.CENTER }), cell('회차 저빈도', { w: 1700 }), cell('전체 역대 출현이 적은 번호. 대상 회차가 10의 배수면 우선순위 +5 가중', { w: 5306 }), cell('70(+5)', { w: 1400, align: AlignmentType.CENTER })]),
  row([cell('⑤', { w: 620, align: AlignmentType.CENTER }), cell('40번대 과출현', { w: 1700 }), cell('최근 20회차 기준 40~45 중 많이 나온 2개 (과편입 회피)', { w: 5306 }), cell('60', { w: 1400, align: AlignmentType.CENTER })]),
  row([cell('+', { w: 620, align: AlignmentType.CENTER }), cell('운영자 수동 제외', { w: 1700 }), cell('설정 > 로또 고정/제외의 제외수는 압축 한도와 무관하게 항상 포함', { w: 5306 }), cell('—', { w: 1400, align: AlignmentType.CENTER })]),
]))
children.push(para([t('압축 할당표', { bold: true }), t(' — ①직전3 + ②보너스1은 공통, 나머지를 ③월별·④빈도에 배분:')], { spacing: { before: 160, after: 120 } }))
children.push(table([2400, 2200, 2200, 2226], [
  row([cell('제외수 개수', { w: 2400, fill: HEAD, bold: true, align: AlignmentType.CENTER }), cell('③ 월별', { w: 2200, fill: HEAD, bold: true, align: AlignmentType.CENTER }), cell('④ 빈도', { w: 2200, fill: HEAD, bold: true, align: AlignmentType.CENTER }), cell('합계', { w: 2226, fill: HEAD, bold: true, align: AlignmentType.CENTER })]),
  row([cell('10개', { w: 2400, align: AlignmentType.CENTER }), cell('4', { w: 2200, align: AlignmentType.CENTER }), cell('4', { w: 2200, align: AlignmentType.CENTER }), cell('3+1+4+4 → 상위 10', { w: 2226, align: AlignmentType.CENTER })]),
  row([cell('15개', { w: 2400, align: AlignmentType.CENTER }), cell('5', { w: 2200, align: AlignmentType.CENTER }), cell('6', { w: 2200, align: AlignmentType.CENTER }), cell('3+1+5+6 → 상위 15', { w: 2226, align: AlignmentType.CENTER })]),
  row([cell('20개', { w: 2400, align: AlignmentType.CENTER }), cell('7', { w: 2200, align: AlignmentType.CENTER }), cell('7', { w: 2200, align: AlignmentType.CENTER }), cell('3+1+7+7 → 상위 20', { w: 2226, align: AlignmentType.CENTER })]),
]))
children.push(para([t('⚙️ 실제 발급은 항상 "제외수 20개" 기준', { bold: true }), t('으로 동작합니다(회원이 받는 조합). 10/15/20 선택은 운영자 탐색 화면에서만 조정합니다.')], { spacing: { before: 120, after: 160 } }))

// ── 2. 품질 필터 ──
children.push(heading('2. 조합 품질 필터 (코드: passesQuality) — 극단조합 회피'))
children.push(para([t('풀(45 − 제외수)에서 무작위로 6개를 뽑되, 아래를 모두 통과한 조합만 채택합니다.')], { spacing: { after: 120 } }))
;[
  ['역대 1등 동일 조합 회피', '과거 당첨번호와 똑같은 조합 제외'],
  ['구간 분산', '1–9 / 10–19 / 20–29 / 30–39 / 40–45 중 최소 3개 구간에 분포'],
  ['한 구간 몰림 금지', '한 구간에 4개 이상 몰리면 제외 (예: 40번대만 4개)'],
  ['전홀 / 전짝 금지', '6개가 모두 홀수 또는 모두 짝수면 제외'],
  ['연번 제한', '3연속 이상 금지, 연속쌍(2연속)은 최대 1쌍'],
  ['합계 밴드', '6개 합이 역대 당첨합의 10~90분위 범위 안 (데이터 부족 시 100~175)'],
].forEach(([h, d]) => children.push(num([t(h + ' — ', { bold: true }), t(d)])))
children.push(para([t('풀이 너무 좁아 6개를 못 만들면 자동으로 완화 모드(구간 5개 몰림·6연번만 차단)로 재시도합니다.', { color: '6B7585' })], { spacing: { before: 100, after: 160 } }))

// ── 3. 고정/제외 ──
children.push(heading('3. 고정수 / 제외수 입력 (운영자 · 등급별 · 효력일자)'))
children.push(para([t('코드: resolveExcludeForGrade ', { font: 'Consolas', size: 18 }), t('(설정 > 로또 고정/제외 화면과 연동)')], { spacing: { after: 100 } }))
children.push(bullet([t('고정수', { bold: true }), t(': 지정 번호는 모든 조합에 항상 포함(통계 규칙으로도 제외되지 않음).')]))
children.push(bullet([t('제외수', { bold: true }), t(': 지정 번호는 항상 제외.')]))
children.push(bullet([t('등급별 규칙 + 효력일자', { bold: true }), t(': 토요일 입력 → 익주 월요일부터 적용. 현재 등급별 규칙 운영 등급은 골드·VIP·로얄 3등급이며, 그 외 등급(골드플러스 포함)은 공통 규칙을 따릅니다.')]))
children.push(bullet([t('풀이 6개 미만이 되도록 제외가 과하면, 우선순위 낮은 통계 제외부터 자동 복원(수동 제외는 유지)해 항상 6개 조합이 가능하도록 방어합니다.')]))

// ── 4. 로직:랜덤 ──
children.push(heading('4. 로직 : 랜덤 비율 (코드: generateIssueSets)'))
children.push(bullet([t('발급 N조합 = 로직 조합 + 완전 랜덤 조합을 비율로 혼합. 비율은 설정에서 조정, 기본 100%(전부 로직).')]))
children.push(bullet([t('예) 10조합·비율 70% → 로직 7 + 랜덤 3. 랜덤분은 제외수·품질필터 미적용(완전 무작위)이며 로직 조합과의 중복만 회피.')]))
children.push(bullet([t('현재 운영 설정값: 비율 100%', { bold: true }), t(' → 지금 발급되는 조합은 전부 위 1~3의 로직 조합입니다.')]))

// ── 5. 발급 경로 ──
children.push(heading('5. 발급 경로 (모두 동일 엔진 공유)'))
children.push(table([2600, 6426], [
  row([cell('경로', { w: 2600, fill: HEAD, bold: true, align: AlignmentType.CENTER }), cell('동작', { w: 6426, fill: HEAD, bold: true })]),
  row([cell('주간 자동발급(크론)', { w: 2600 }), cell('매일 09:00, 회원별 발송요일이 오늘인 회원에게 조합발송갯수만큼 발급 → 회원 홈페이지에서 조회', { w: 6426 })]),
  row([cell('수동 발급', { w: 2600 }), cell('회원 상세에서 즉시 발급', { w: 6426 })]),
  row([cell('일괄 설정', { w: 2600 }), cell('이용자 일괄작업 → "자동조합"으로 다수 회원의 발송요일·조합수 일괄 지정', { w: 6426 })]),
]))
children.push(para([t('유료(골드~로얄) 회원은 발송요일을 지정해야 자동발급 대상이 됩니다. 조합 수는 회원별 설정값(없으면 전역 기본 30)을 따릅니다.', { color: '6B7585' })], { spacing: { before: 120, after: 160 } }))

// ── 6. 확률 정직성 ──
children.push(heading('6. 확률 정직성 (코드 주석에도 명시)'))
children.push(bullet([t('6/45에서 모든 6개 조합의 1등 확률은 1/8,145,060 로 동일합니다.')]))
children.push(bullet([t('본 엔진은 제외수·품질 기준으로 "제시할 조합을 선별·압축"할 뿐, 어떤 조합의 당첨 확률을 실제로 높이지 않습니다.')]))
children.push(bullet([t('따라서 전산은 "확률 N배 증가"를 사실로 단언하지 않습니다. 제공 로직의 선별 기준은 100% 반영하되, 확률 과장만 배제한 구현입니다.')]))

// ── 부록 ──
children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, pageBreakBefore: true, children: [t('부록. 제공 로직 ↔ 구현 대조표', { bold: true })] }))
children.push(table([4500, 3500, 1026], [
  row([cell('제공하신 로직', { w: 4500, fill: HEAD, bold: true }), cell('구현 위치', { w: 3500, fill: HEAD, bold: true }), cell('반영', { w: 1026, fill: HEAD, bold: true, align: AlignmentType.CENTER })]),
  ...[
    ['직전회차 상위2·하위1 제외', 'computeExclusions ①'],
    ['직전 보너스 제외', 'computeExclusions ②'],
    ['월별 저출현 제외', 'computeExclusions ③'],
    ['저빈도 제외 (+10배수 회차 가중)', 'computeExclusions ④'],
    ['40번대 과출현 2개 제외', 'computeExclusions ⑤'],
    ['10/15/20 압축', 'RULE_QUOTA_PRESET'],
    ['극단조합 회피(구간/홀짝/연번/합)', 'passesQuality'],
    ['고정수 항상 포함', 'generateRecommendation'],
    ['로직:랜덤 혼합 (기본 100% 로직)', 'generateIssueSets'],
  ].map(([a, b]) => row([
    cell(a, { w: 4500 }),
    cell([t(b, { font: 'Consolas', size: 18 })], { w: 3500 }),
    cell('✅', { w: 1026, align: AlignmentType.CENTER }),
  ])),
]))

const doc = new Document({
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } },
    paragraphStyles: [
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 25, bold: true, font: FONT, color: '1E3A5F' },
        paragraph: { spacing: { before: 260, after: 130 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'b', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 240 } } } }] },
      { reference: 'n', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 280 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    children,
  }],
})

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync('docs/조합생성_로직_구현현황.docx', buf)
  console.log('생성 완료: docs/조합생성_로직_구현현황.docx (' + buf.length + ' bytes)')
})
