/**
 * store.test.mjs — 持久化纪律测试。
 *
 * 核心断言：**读路径可以退化，写路径绝不可以**。
 * 文件坏了，只读面返回空账本可以；但写路径必须以严格读为准，
 * 否则一次写入会把整本覆盖成「只有刚写的那一条」= 静默数据销毁。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  readStrict,
  readLenient,
  writeAtomic,
  ledgerPath,
  tracePath,
  resolveHome,
  appendTrace,
} from '../lib/store.js'

const readOf = (content) => () => content
const readThrows = (code) => () => {
  const e = new Error('boom')
  e.code = code
  throw e
}

test('ENOENT ⇒ 空账本（首次使用不是错误）', () => {
  const l = readStrict('/nah.json', readThrows('ENOENT'))
  assert.deepEqual(l.items, [])
})

test('非 ENOENT 的读错误 ⇒ 抛错（不假装空账本）', () => {
  assert.throws(() => readStrict('/x.json', readThrows('EACCES')), /账本读取失败/)
})

test('坏 JSON ⇒ 严格读抛错（拒绝以空账本继续）', () => {
  assert.throws(() => readStrict('/x.json', readOf('{ not json')), /拒绝以空账本继续/)
})

test('顶层缺 items ⇒ 抛错', () => {
  assert.throws(() => readStrict('/x.json', readOf('{"version":1}')), /缺少 items 数组/)
})

test('★全部条目畸形且原始非空 ⇒ 抛错（整库 vs 单条的代价不对称）', () => {
  const bad = JSON.stringify({ version: 1, items: [{ nope: 1 }, { nope: 2 }] })
  assert.throws(() => readStrict('/x.json', readOf(bad)), /无一可用/)
})

test('部分条目畸形 ⇒ 丢坏的留好的（宽松但有底线）', () => {
  const mixed = JSON.stringify({
    version: 1,
    items: [
      { id: 'cl-1', surface: 'a', verdict: 'checked', createdAt: 1, updatedAt: 1 },
      { nope: true },
      { id: 'cl-2', surface: 'b', verdict: 'not_a_verdict', createdAt: 1, updatedAt: 1 },
    ],
  })
  const l = readStrict('/x.json', readOf(mixed))
  assert.equal(l.items.length, 1)
  assert.equal(l.items[0].id, 'cl-1')
})

test('宽松读：任何失败都退化为空（只读面不许崩）', () => {
  assert.deepEqual(readLenient('/x.json', readOf('{bad')).items, [])
  assert.deepEqual(readLenient('/x.json', readThrows('EACCES')).items, [])
})

test('空文件视为空账本（touch 出来的不是损坏）', () => {
  assert.deepEqual(readStrict('/x.json', readOf('   \n')).items, [])
})

test('原子写：先写 .tmp 再 rename，且 JSON 可回读', () => {
  const calls = []
  const deps = {
    writeFile: (p, d) => calls.push(['write', p, d]),
    rename: (a, b) => calls.push(['rename', a, b]),
    mkdir: (p) => calls.push(['mkdir', p]),
  }
  writeAtomic('/dir/ledger.json', { version: 1, items: [] }, deps)

  assert.equal(calls[0][0], 'mkdir')
  assert.equal(calls[1][0], 'write')
  assert.ok(calls[1][1].endsWith('ledger.json.tmp'), '必须先写 tmp')
  assert.equal(calls[2][0], 'rename')
  assert.equal(calls[2][1], '/dir/ledger.json.tmp')
  assert.equal(calls[2][2], '/dir/ledger.json')
  assert.doesNotThrow(() => JSON.parse(calls[1][2]))
})

test('留痕失败不反噬主流程（返回 false，不抛）', () => {
  const r = appendTrace('/tmp/home-x', { stage: 'record' }, {
    append: () => {
      throw new Error('disk full')
    },
  })
  assert.equal(r, false)
})

test('留痕成功返回 true 且带时间戳', () => {
  let written = ''
  const r = appendTrace('/tmp/home-x', { stage: 'record', ok: true }, {
    append: (_p, d) => {
      written += d
    },
  })
  assert.equal(r, true)
  const row = JSON.parse(written.trim())
  assert.equal(row.stage, 'record')
  assert.ok(typeof row.at === 'string' && row.at.includes('T'))
})

test('路径约定：DSH_HOME 优先，缺省 ~/.dsh；账本与留痕同目录', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }), 'E:/alice/.dsh')
  const home = resolveHome({})
  assert.ok(home.length > 0)
  assert.match(ledgerPath(home), /closure-ledger[\\/]ledger\.json$/)
  assert.match(tracePath(home), /closure-ledger[\\/]trace\.jsonl$/)
})
