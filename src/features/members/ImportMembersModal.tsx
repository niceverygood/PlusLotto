// 회원 일괄 임포트 모달 (§V2-3). 업로드 → 컬럼 매핑 → 미리보기 → 일괄 등록.
// 엑셀/CSV 첫 행을 헤더로 보고 회원 필드에 매핑. 전화 중복은 건너뛰고 기존 DB를 '중복 DB'로 표시.
import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react'
import { Button, Modal } from '@/design-system/components'
import { GRADE_LABEL } from '@/design-system/labels'
import { useStaff } from '@/lib/staff'
import type { Grade } from '@/types/db'
import { useBulkImportMembers, type MemberCreateInput } from './api'
import { autoMapHeaders, IMPORT_FIELDS, parseLeadFile, type ParsedSheet } from './import'
import { INFLOW_TYPES } from './views'

const GRADES: Grade[] = ['simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss']
const selectCls =
  'h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-700 outline-none focus:border-primary-500'
const inputCls =
  'h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-700 outline-none focus:border-primary-500'
const onlyDigits = (s: string) => s.replace(/\D/g, '')

type Step = 'upload' | 'map' | 'preview'

export function ImportMembersModal({ onClose }: { onClose: () => void }) {
  const importMut = useBulkImportMembers()
  const { data: staff = [] } = useStaff()

  const [step, setStep] = useState<Step>('upload')
  const [sheet, setSheet] = useState<ParsedSheet | null>(null)
  const [fileName, setFileName] = useState('')
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [defGrade, setDefGrade] = useState<Grade>('free')
  const [defInflowCode, setDefInflowCode] = useState('')
  const [defInflowType, setDefInflowType] = useState('')
  const [defStaff, setDefStaff] = useState('')
  const [parseErr, setParseErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ created: number; dup: number } | null>(null)

  async function onFile(file?: File | null) {
    if (!file) return
    setParseErr(null)
    try {
      const s = await parseLeadFile(file)
      if (s.rows.length === 0) {
        setParseErr('데이터 행이 없습니다. 첫 행은 헤더(이름·휴대폰 등)여야 합니다.')
        return
      }
      setSheet(s)
      setFileName(file.name)
      setMapping(autoMapHeaders(s.headers))
      setStep('map')
    } catch {
      setParseErr('파일을 읽지 못했습니다. .csv 또는 .xlsx 형식인지 확인하세요.')
    }
  }

  const rows = sheet?.rows ?? []
  const cell = (row: Record<string, string>, key: string) =>
    mapping[key] ? String(row[mapping[key]] ?? '').trim() : ''

  const inputs: MemberCreateInput[] = useMemo(
    () =>
      rows.map((row) => ({
        name: cell(row, 'name'),
        phone: cell(row, 'phone'),
        inflow_code: cell(row, 'inflow_code') || defInflowCode || null,
        inflow_type: cell(row, 'inflow_type') || defInflowType || null,
        consult_status: cell(row, 'consult_status') || null,
        tendency: cell(row, 'tendency') || null,
        nickname: cell(row, 'nickname') || null,
        memo: cell(row, 'memo') || null,
        grade: defGrade,
        assigned_staff_id: defStaff || null,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, mapping, defInflowCode, defInflowType, defGrade, defStaff],
  )

  const valid = inputs.filter((i) => i.name && i.phone)
  const invalidCount = inputs.length - valid.length
  const fileDup = useMemo(() => {
    const seen = new Set<string>()
    let d = 0
    for (const i of valid) {
      const p = onlyDigits(i.phone)
      if (!p) continue
      if (seen.has(p)) d++
      else seen.add(p)
    }
    return d
  }, [valid])

  const canPreview = !!mapping.name && !!mapping.phone

  function doImport() {
    importMut.mutate(valid, { onSuccess: (r) => setResult(r) })
  }

  // ── 결과 ──────────────────────────────────────────
  if (result) {
    return (
      <Modal
        open
        onClose={onClose}
        title="일괄 등록 완료"
        size="sm"
        footer={
          <Button variant="pri" size="sm" onClick={onClose}>
            확인
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <CheckCircle2 className="h-10 w-10 text-success" />
          <p className="text-[15px] font-bold text-ink-800">
            {result.created.toLocaleString('ko-KR')}건 등록 완료
          </p>
          {result.dup > 0 && (
            <p className="text-[12.5px] text-warning">
              중복 {result.dup}건은 등록하지 않고 기존 DB를 ‘중복 DB’로 표시했습니다.
            </p>
          )}
          <p className="text-[12px] text-gray-500">목록·세그먼트 카운트에 즉시 반영됩니다.</p>
        </div>
      </Modal>
    )
  }

  const footer =
    step === 'upload' ? (
      <Button variant="sec" size="sm" onClick={onClose}>
        취소
      </Button>
    ) : step === 'map' ? (
      <>
        <Button variant="sec" size="sm" onClick={() => setStep('upload')}>
          뒤로
        </Button>
        <Button variant="pri" size="sm" disabled={!canPreview} onClick={() => setStep('preview')}>
          미리보기
        </Button>
      </>
    ) : (
      <>
        <Button variant="sec" size="sm" onClick={() => setStep('map')}>
          뒤로
        </Button>
        <Button
          variant="pri"
          size="sm"
          disabled={valid.length === 0 || importMut.isPending}
          onClick={doImport}
        >
          {valid.length.toLocaleString('ko-KR')}건 등록
        </Button>
      </>
    )

  return (
    <Modal open onClose={onClose} title="회원 일괄 임포트" size="lg" footer={footer}>
      {/* 단계 표시 */}
      <div className="mb-3 flex items-center gap-1.5 text-[11.5px] font-semibold">
        {(['upload', 'map', 'preview'] as Step[]).map((s, i) => (
          <span
            key={s}
            className={
              'rounded-full px-2 py-0.5 ' +
              (step === s ? 'bg-primary-100 text-primary-700' : 'bg-gray-100 text-gray-400')
            }
          >
            {i + 1}. {s === 'upload' ? '업로드' : s === 'map' ? '컬럼 매핑' : '미리보기'}
          </span>
        ))}
      </div>

      {/* ── 1. 업로드 ── */}
      {step === 'upload' && (
        <div>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 px-4 py-10 text-center transition-colors hover:border-primary-400 hover:bg-primary-50">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <Upload className="h-7 w-7 text-gray-400" />
            <span className="text-[13px] font-semibold text-gray-700">엑셀(.xlsx) 또는 CSV 파일 선택</span>
            <span className="text-[11.5px] text-gray-400">첫 행은 헤더(이름·휴대폰·유입 …)여야 합니다</span>
          </label>
          {parseErr && (
            <p className="mt-2 flex items-center gap-1 text-[12px] text-danger">
              <AlertTriangle className="h-3.5 w-3.5" /> {parseErr}
            </p>
          )}
          <p className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-[11.5px] leading-relaxed text-gray-500">
            업로드한 파일은 화면에서 미리보기·등록에만 사용되며 별도로 저장되지 않습니다. 개인정보(이름·전화)가
            포함되니 신뢰된 파일만 올리세요.
          </p>
        </div>
      )}

      {/* ── 2. 매핑 ── */}
      {step === 'map' && sheet && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-[12.5px] text-gray-600">
            <FileSpreadsheet className="h-4 w-4 text-primary-600" />
            <span className="font-semibold text-ink-800">{fileName}</span>
            <span className="text-gray-400">· {rows.length.toLocaleString('ko-KR')}행</span>
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-bold text-gray-700">컬럼 매핑</div>
            <div className="grid grid-cols-2 gap-2.5">
              {IMPORT_FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">
                    {f.label}
                    {f.required && <span className="text-danger"> *</span>}
                  </span>
                  <select
                    className={selectCls}
                    value={mapping[f.key] ?? ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                  >
                    <option value="">(없음)</option>
                    {sheet.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {!canPreview && (
              <p className="mt-1.5 flex items-center gap-1 text-[11.5px] text-warning">
                <AlertTriangle className="h-3.5 w-3.5" /> 이름·휴대폰은 반드시 매핑해야 합니다.
              </p>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-bold text-gray-700">
              공통값 <span className="font-normal text-gray-400">(해당 컬럼이 비었을 때 적용)</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">유입코드</span>
                <input
                  className={inputCls}
                  placeholder="예: KAKAO"
                  value={defInflowCode}
                  onChange={(e) => setDefInflowCode(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">유입구분</span>
                <select
                  className={selectCls}
                  value={defInflowType}
                  onChange={(e) => setDefInflowType(e.target.value)}
                >
                  <option value="">미지정</option>
                  {INFLOW_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">등급</span>
                <select
                  className={selectCls}
                  value={defGrade}
                  onChange={(e) => setDefGrade(e.target.value as Grade)}
                >
                  {GRADES.map((g) => (
                    <option key={g} value={g}>
                      {GRADE_LABEL[g]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">담당자(일괄 배정)</span>
                <select
                  className={selectCls}
                  value={defStaff}
                  onChange={(e) => setDefStaff(e.target.value)}
                >
                  <option value="">미지정</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* ── 3. 미리보기 ── */}
      {step === 'preview' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-[12px]">
            <span className="rounded-md bg-success-bg px-2 py-1 font-semibold text-success">
              등록 대상 {valid.length.toLocaleString('ko-KR')}건
            </span>
            {invalidCount > 0 && (
              <span className="rounded-md bg-gray-100 px-2 py-1 font-semibold text-gray-500">
                제외(이름·전화 누락) {invalidCount}건
              </span>
            )}
            {fileDup > 0 && (
              <span className="rounded-md bg-warning-bg px-2 py-1 font-semibold text-warning">
                파일 내 중복 {fileDup}건
              </span>
            )}
          </div>

          <div className="max-h-[340px] overflow-auto rounded-md border border-gray-200">
            <table className="w-full text-left text-[12px]">
              <thead className="sticky top-0 bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-2.5 py-2">이름</th>
                  <th className="px-2.5 py-2">휴대폰</th>
                  <th className="px-2.5 py-2">유입</th>
                  <th className="px-2.5 py-2">성향</th>
                  <th className="px-2.5 py-2">메모</th>
                </tr>
              </thead>
              <tbody>
                {valid.slice(0, 50).map((i, idx) => (
                  <tr key={idx} className="border-t border-gray-100">
                    <td className="px-2.5 py-1.5 font-semibold text-ink-800">{i.name}</td>
                    <td className="px-2.5 py-1.5 font-mono tnum text-gray-600">{i.phone}</td>
                    <td className="px-2.5 py-1.5 text-gray-600">{i.inflow_type || i.inflow_code || '—'}</td>
                    <td className="px-2.5 py-1.5 text-gray-600">{i.tendency || '—'}</td>
                    <td className="max-w-[180px] truncate px-2.5 py-1.5 text-gray-500">{i.memo || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {valid.length > 50 && (
            <p className="text-[11.5px] text-gray-400">…상위 50건만 표시. 등록은 전체 {valid.length}건.</p>
          )}
          <p className="rounded-md bg-gray-50 px-3 py-2 text-[11.5px] leading-relaxed text-gray-500">
            기존 회원과 전화번호가 겹치거나 파일 안에서 같은 번호가 반복되면 신규 등록하지 않고, 먼저 등록된 기존
            DB를 ‘중복 DB’로 표시합니다.
          </p>
        </div>
      )}
    </Modal>
  )
}
