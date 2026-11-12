/**
 * ledger.test.mjs — 数据模型与业务逻辑测试。
 *
 * 重点断言三件事：
 *   ① cleared 的强制校验发生在**写入路径**（不是靠调用方自觉）
 *   ② 修订保留历史（旧裁决不被抹掉），且 why 必填
 *   ③ 读数能把「清白」和「查过没结论」分开——这是插件存在的理由
 *
 * 注：id 一律从返回值取，不写字面量——测试之间共享一个 id 计数器，
 * 硬编码会让后面的用例排在别的 id 上（第一版就踩了）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_LEDGER,
  newId,
  recordItem,
  reviseItem,
  listItems,
  gapItems,
  summaryOf,
  normalizeLedger,
} from '../lib/ledger.js'

const NOW = 1_760_000_000_000
const DAY = 86_400_000
const GOOD_CONTROL = 'src/loader.ts:88 用 realpath 解析后校验前缀，再交给 import()，逃逸被拦在加载之前'

let seq = 0
const idGen = () => 'cl-test' + String(++seq).padStart(4, '0')

function rec(ledger, input) {
  return recordItem(ledger, input, NOW, idGen)
}

test('★cleared 无 control ⇒ 拒收，并指向 checked / proof_gap', () => {
  const r = rec(EMPTY_LEDGER, { surface: 'plugin:x', verdict: 'cleared' })
  assert.equal(r.ok, false)
  assert.match(r.error, /cleared/)
  assert.match(r.hint, /checked|proof_gap/)
})

test('★cleared + 空话 control ⇒ 拒收（空话过不了写入路径）', () => {
  const r = rec(EMPTY_LEDGER, { surface: 'plugin:x', verdict: 'cleared', control: '框架会转义，安全' })
  assert.equal(r.ok, false)
  assert.match(r.error, /generic_trust/)
})

test('cleared + 可核 control ⇒ 通过', () => {
  const r = rec(EMPTY_LEDGER, { surface: 'plugin:x', verdict: 'cleared', control: GOOD_CONTROL })
  assert.equal(r.ok, true)
  assert.match(r.id, /^cl-test\d{4}$/)
  assert.equal(r.ledger.items.length, 1)
})

test('★checked 不需要 control ⇒ 合法结局必须真的合法', () => {
  const r = rec(EMPTY_LEDGER, { surface: 'plugin:x', verdict: 'checked', evidence: 'grep 无命中' })
  assert.equal(r.ok, true, '指不出控制时应该能记 checked，否则人会去硬凑 control')
})

test('proof_gap 不需要 control ⇒ 也是合法结局', () => {
  const r = rec(EMPTY_LEDGER, { surface: 'service:3220', verdict: 'proof_gap', note: '缺：没有第二个账号比对令牌熵' })
  assert.equal(r.ok, true)
})

test('非法 verdict 被拒，并列出五态', () => {
  const r = rec(EMPTY_LEDGER, { surface: 'x', verdict: 'probably_fine' })
  assert.equal(r.ok, false)
  assert.match(r.hint, /confirmed.*cleared.*proof_gap.*checked.*na/s)
})

test('surface 不能为空', () => {
  const r = rec(EMPTY_LEDGER, { surface: '   ', verdict: 'checked' })
  assert.equal(r.ok, false)
  assert.match(r.error, /surface/)
})

test('★同一个面重复记录 ⇒ 拒收并指向 revise（防覆盖历史）', () => {
  const first = rec(EMPTY_LEDGER, { surface: 'plugin:dup', verdict: 'checked' })
  assert.equal(first.ok, true)
  const second = rec(first.ledger, { surface: 'plugin:dup', verdict: 'cleared', control: GOOD_CONTROL })
  assert.equal(second.ok, false)
  assert.ok(second.error.includes(first.id), '错误信息应指出已有条目的 id')
  assert.match(second.hint, /closure_revise/)
})

test('★revision：why 必填', () => {
  const r1 = rec(EMPTY_LEDGER, { surface: 'plugin:x', verdict: 'checked' })
  assert.equal(r1.ok, true)
  const r2 = reviseItem(r1.ledger, { id: r1.id, verdict: 'cleared', why: '', control: GOOD_CONTROL }, NOW + DAY)
  assert.equal(r2.ok, false)
  assert.match(r2.error, /why/)
})

test('★revision：改成 cleared 但仍无合格 control ⇒ 拒收', () => {
  const r1 = rec(EMPTY_LEDGER, { surface: 'plugin:x', verdict: 'proof_gap' })
  assert.equal(r1.ok, true)
  const r2 = reviseItem(r1.ledger, { id: r1.id, verdict: 'cleared', why: '补了证据' }, NOW + DAY)
  assert.equal(r2.ok, false)
  assert.match(r2.error, /清白理由/)
})

test('★revision 成功：旧裁决进 history，不被抹掉', () => {
  const r1 = rec(EMPTY_LEDGER, { surface: 'plugin:x', verdict: 'proof_gap', note: '缺证据' })
  assert.equal(r1.ok, true)
  const r2 = reviseItem(
    r1.ledger,
    { id: r1.id, verdict: 'cleared', why: '找到了控制：realpath 校验', control: GOOD_CONTROL },
    NOW + DAY,
  )
  assert.equal(r2.ok, true)
  const it = r2.ledger.items[0]
  assert.equal(it.verdict, 'cleared')
  assert.equal(it.updatedAt, NOW + DAY)
  assert.equal(it.history.length, 1)
  assert.equal(it.history[0].from, 'proof_gap')
  assert.equal(it.history[0].to, 'cleared')
  assert.equal(it.history[0].why, '找到了控制：realpath 校验')
})

test('revision 指向不存在的 id ⇒ 拒收并提示先 list', () => {
  const r = reviseItem(EMPTY_LEDGER, { id: 'cl-nope', verdict: 'checked', why: 'x' }, NOW)
  assert.equal(r.ok, false)
  assert.match(r.hint, /closure_list/)
})

test('revision 未给的字段沿用旧值', () => {
  const r1 = rec(EMPTY_LEDGER, { surface: 'p', verdict: 'checked', evidence: 'E1', scope: 'S1' })
  assert.equal(r1.ok, true)
  const r2 = reviseItem(r1.ledger, { id: r1.id, verdict: 'na', why: '不适用' }, NOW + DAY)
  assert.equal(r2.ok, true, JSON.stringify(r2))
  assert.equal(r2.ledger.items[0].evidence, 'E1')
  assert.equal(r2.ledger.items[0].scope, 'S1')
})

test('listItems：按面模糊过滤 + 按裁决过滤 + 按陈旧过滤', () => {
  const a = rec(EMPTY_LEDGER, { surface: 'git:alice', verdict: 'checked' })
  assert.equal(a.ok, true)
  const b = rec(a.ledger, { surface: 'plugin:dsh-ops', verdict: 'cleared', control: GOOD_CONTROL })
  assert.equal(b.ok, true)
  const l = b.ledger

  assert.equal(listItems(l, { surface: 'GIT' }, NOW).length, 1, '面过滤应大小写不敏感')
  assert.equal(listItems(l, { verdict: 'cleared' }, NOW).length, 1)
  assert.equal(listItems(l, { staleDays: 1 }, NOW).length, 0, '刚写的都不算陈旧')
  assert.equal(listItems(l, { staleDays: 1 }, NOW + 2 * DAY).length, 2)
})

test('★gapItems：proof_gap 一律列出；超期 cleared 也列出；新鲜 cleared 不列', () => {
  const a = rec(EMPTY_LEDGER, { surface: 'gap-a', verdict: 'proof_gap', note: '缺第二个账号' })
  assert.equal(a.ok, true)
  const b = rec(a.ledger, { surface: 'gap-b', verdict: 'cleared', control: GOOD_CONTROL })
  assert.equal(b.ok, true)
  const c = rec(b.ledger, { surface: 'gap-c', verdict: 'checked' })
  assert.equal(c.ok, true)
  const l = c.ledger

  const fresh = gapItems(l, 30, NOW)
  assert.equal(fresh.length, 1, '只有 proof_gap 该出现')
  assert.equal(fresh[0].kind, 'proof_gap')
  assert.equal(fresh[0].surface, 'gap-a')
  assert.match(fresh[0].detail, /缺第二个账号/)

  const stale = gapItems(l, 30, NOW + 31 * DAY)
  assert.equal(stale.length, 2, '超期的 cleared 也该进缺口清单')
  assert.deepEqual(stale.map((g) => g.kind).sort(), ['proof_gap', 'stale'])
})

test('★summaryOf：checked 不计入 cleared', () => {
  const a = rec(EMPTY_LEDGER, { surface: 's-a', verdict: 'cleared', control: GOOD_CONTROL, scope: 'S' })
  assert.equal(a.ok, true)
  const b = rec(a.ledger, { surface: 's-b', verdict: 'checked' })
  assert.equal(b.ok, true)
  const c = rec(b.ledger, { surface: 's-c', verdict: 'proof_gap' })
  assert.equal(c.ok, true)
  const d = rec(c.ledger, { surface: 's-d', verdict: 'confirmed' })
  assert.equal(d.ok, true)
  const e = rec(d.ledger, { surface: 's-e', verdict: 'na' })
  assert.equal(e.ok, true)

  const s = summaryOf(e.ledger)
  assert.equal(s.total, 5)
  assert.equal(s.cleared, 1)
  assert.equal(s.checked, 1, 'checked 单独计数，绝不能并进 cleared')
  assert.equal(s.proofGap, 1)
  assert.equal(s.confirmed, 1)
  assert.equal(s.na, 1)
  assert.equal(s.noScope, 4, '只有 s-a 声明了 scope')
})

test('summaryOf 报出「被修订过」的条数（账本在起作用的读数）', () => {
  const r1 = rec(EMPTY_LEDGER, { surface: 'rev-a', verdict: 'checked' })
  assert.equal(r1.ok, true)
  const r2 = reviseItem(r1.ledger, { id: r1.id, verdict: 'na', why: '不适用' }, NOW + DAY)
  assert.equal(r2.ok, true)
  assert.equal(summaryOf(r2.ledger).revised, 1)
})

test('normalizeLedger：丢畸形条目并计数', () => {
  const { ledger, dropped } = normalizeLedger({
    version: 1,
    items: [
      { id: 'cl-1', surface: 'a', verdict: 'checked', createdAt: 1, updatedAt: 1 },
      { id: '', surface: 'b', verdict: 'checked' },
      { id: 'cl-3', surface: 'c', verdict: 'bogus' },
      null,
      'string',
    ],
  })
  assert.equal(ledger.items.length, 1)
  assert.equal(dropped, 4)
})

test('newId 形如 cl-xxxxxxxx 且可注入随机源', () => {
  assert.match(newId(), /^cl-[0-9a-f]{8}$/)
  let i = 0
  const r = () => (i++ % 100) / 100
  assert.match(newId(r), /^cl-[0-9a-f]{8}$/)
})
