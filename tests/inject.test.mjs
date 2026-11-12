/**
 * inject.test.mjs — 注入面测试。
 *
 * 注入是本插件「会被想起来」的唯一依靠，所以它必须满足两条：
 *   ① 真有缺口时才出现（否则日常噪音会让人无视读数）
 *   ② 没缺口时返回空串（调用方据此跳过注入）
 * 另外测会话判据的样本集——它是跨插件副本，漂移必须在这里先红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isUserSession, dedupeKey, renderGapLine } from '../lib/inject.js'
import { EMPTY_LEDGER, recordItem } from '../lib/ledger.js'

const NOW = 1_760_000_000_000
const DAY = 86_400_000
const GOOD_CONTROL = 'src/loader.ts:88 用 realpath 解析后校验前缀，再交给 import()，逃逸被拦在加载之前'

let seq = 0
const idGen = () => 'cl-inj' + String(++seq).padStart(4, '0')

test('会话判据：人类会话样本通过，裸 uuid 与其它形状不通过', () => {
  assert.equal(isUserSession('session-3e786db2-a88d-4851-8ea6-6f2a1eeb2728'), true)
  assert.equal(isUserSession('3e786db2-a88d-4851-8ea6-6f2a1eeb2728'), false, '子代理是裸 uuid')
  assert.equal(isUserSession(''), false)
  assert.equal(isUserSession('session-xyz'), false)
})

test('去重键含会话 + 小时 + 内容，且内容变化即变键', () => {
  const d = new Date(NOW)
  const a = dedupeKey('session-x', 'line-a', d)
  const b = dedupeKey('session-x', 'line-b', d)
  const c = dedupeKey('session-y', 'line-a', d)
  assert.notEqual(a, b, '内容变了必须换键（否则闭环断）')
  assert.notEqual(a, c, '会话不同必须换键')
  assert.equal(a, dedupeKey('session-x', 'line-a', d))
})

test('★无缺口 ⇒ 空串（不注入、不噪音）', () => {
  assert.equal(renderGapLine(EMPTY_LEDGER, 30, NOW), '')
  const ok = recordItem(EMPTY_LEDGER, { surface: 'a', verdict: 'cleared', control: GOOD_CONTROL }, NOW, idGen)
  assert.equal(ok.ok, true)
  assert.equal(renderGapLine(ok.ledger, 30, NOW), '', '新鲜清白不该触发读数')
})

test('★有 proof_gap ⇒ 一行，且带面与缺口数', () => {
  const r = recordItem(EMPTY_LEDGER, { surface: 'service:3220', verdict: 'proof_gap' }, NOW, idGen)
  assert.equal(r.ok, true)
  const line = renderGapLine(r.ledger, 30, NOW)
  assert.ok(line.length > 0)
  assert.match(line, /闭合账本/)
  assert.match(line, /证据缺口 1/)
  assert.match(line, /service:3220/)
  assert.match(line, /closure_gaps/, '要指向下一步动作')
})

test('★超期清白也进读数（代码会变，清白会过期）', () => {
  const r = recordItem(EMPTY_LEDGER, { surface: 'plugin:old', verdict: 'cleared', control: GOOD_CONTROL }, NOW, idGen)
  assert.equal(r.ok, true)
  const line = renderGapLine(r.ledger, 30, NOW + 31 * DAY)
  assert.match(line, /超期清白 1/)
  assert.match(line, /plugin:old/)
})

test('两类缺口并存时分别计数', () => {
  const a = recordItem(EMPTY_LEDGER, { surface: 'x', verdict: 'proof_gap' }, NOW, idGen)
  assert.equal(a.ok, true)
  const b = recordItem(a.ledger, { surface: 'y', verdict: 'cleared', control: GOOD_CONTROL }, NOW, idGen)
  assert.equal(b.ok, true)
  const line = renderGapLine(b.ledger, 30, NOW + 31 * DAY)
  assert.match(line, /悬着 2 条/)
  assert.match(line, /证据缺口 1/)
  assert.match(line, /超期清白 1/)
})

test('读数是一行（多行会挤占执行路径）', () => {
  const r = recordItem(EMPTY_LEDGER, { surface: 'x', verdict: 'proof_gap' }, NOW, idGen)
  assert.equal(r.ok, true)
  const line = renderGapLine(r.ledger, 30, NOW)
  assert.equal(line.includes('\n'), false, '注入读数必须单行')
})
