import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
}

function calls(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const result: ts.CallExpression[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && member.name.getText() === name) return member.initializer
  }
  return undefined
}

// 실행 중 회원을 아는 모든 발송 경로가 번호 전체 보류로 되돌아가지 않도록 검사한다.
// 실제 서버의 인증·같은번호·출처·벤더 호출 여부는 send-sms-import-hold.test.ts에서 검증한다.
test('회원 화면·결제·당첨의 모든 OneShot 호출은 목적지와 같은 회원 ID를 전달한다', () => {
  const byFile = new Map<string, number>()
  for (const file of sourceFiles(join(root, 'src'))) {
    const source = parse(file)
    const sendCalls = calls(source, 'sendOneShot')
    if (!sendCalls.length) continue
    byFile.set(relative(root, file), sendCalls.length)
    for (const call of sendCalls) {
      const input = call.arguments[0]
      assert.ok(input && ts.isObjectLiteralExpression(input), `${file}: 발송 대상이 명시돼야 한다`)
      const dest = property(input, 'dest_phone')
      assert.ok(dest && ts.isPropertyAccessExpression(dest), `${file}: 회원 전화번호가 필요하다`)
      const memberKey = relative(root, file) === 'src/features/settings/smsResend.ts' ? 'member_id' : 'id'
      assert.equal(property(input, 'member_id')?.getText(source), `${dest.expression.getText(source)}.${memberKey}`, file)
    }
  }
  assert.deepEqual(Object.fromEntries([...byFile].sort()), {
    'src/features/lotto/supa.ts': 1,
    'src/features/members/api.ts': 3,
    'src/features/members/supa.ts': 3,
    'src/features/payments/api.ts': 1,
    'src/features/payments/supa.ts': 1,
    'src/features/settings/smsResend.ts': 1,
  })
})

test('자동발급·당첨·실패 재발송은 원래 회원 ID를 내부 발송 요청으로 전달한다', () => {
  const senders = [
    { file: 'api/weekly-reco.ts', name: 'sendComboSms', member: 'r.id' },
    { file: 'api/weekly-lotto-sync.ts', name: 'sendWinSms', member: 'm.id' },
    { file: 'api/resend-failed-sms.ts', name: 'sendOne', member: 'r.member_id' },
  ]
  for (const sender of senders) {
    const source = parse(join(root, sender.file))
    const sendCalls = calls(source, sender.name)
    assert.equal(sendCalls.length, 1, sender.file)
    assert.equal(sendCalls[0].arguments[1]?.getText(source), sender.member, sender.file)
    const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === sender.name)
    assert.ok(fn?.body, sender.file)
    let requestMember: string | undefined
    function visit(node: ts.Node) {
      if (ts.isObjectLiteralExpression(node) && property(node, 'dest_phone')) {
        requestMember = property(node, 'member_id')?.getText(source)
      }
      ts.forEachChild(node, visit)
    }
    visit(fn.body)
    assert.equal(requestMember, fn.parameters[1].name.getText(source), sender.file)
  }
})
