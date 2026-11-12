/**
 * closure.test.mjs — 判据层测试。
 *
 * 这里测的不是「代码跑不跑得动」，是**判据拦不拦得住**：
 * 一个只会在正确输入上返回 true 的校验器，等于没有校验器。
 * 所以要同时测「该拒的拒了」和「该过的过了」，并且测那条**故意选的方向**：
 * 带位置指针的空话仍然被拒（宁可误伤，不可放过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkControl, needsControl, describeVerdict, isCleanVerdict, VERDICTS } from '../lib/closure.js'

test('空 control 被拒，并给出「改用 checked / proof_gap」的下一步', () => {
  for (const v of [undefined, null, '', '   ']) {
    const r = checkControl(v)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'empty')
    assert.match(r.hint, /checked/)
    assert.match(r.hint, /proof_gap/)
  }
})

test('过短的 control 被拒', () => {
  const r = checkControl('没问题')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too_short')
})

test('空话黑名单：全部命中项都必须被拒', () => {
  const generic = [
    '框架会转义，所以这里是安全的',
    'ORM 处理了，不会有事',
    '一般不会出问题',
    '通常安全',
    '应该没问题吧',
    '默认安全的设计',
    '有内置防护',
    '会自动转义',
    '不用担心这里',
    '肯定安全',
    '理论上安全',
    '库会转义所以没事',
  ]
  for (const text of generic) {
    const r = checkControl(text)
    assert.equal(r.ok, false, '应被拒但通过了：' + text)
    assert.equal(r.reason, 'generic_trust', '拒收理由不对：' + text + ' → ' + r.reason)
    assert.ok(typeof r.hit === 'string' && r.hit !== '', '应回报命中的短语')
  }
})

test('★方向断言：带位置指针的空话仍然被拒（宁可误伤，不可放过）', () => {
  // 这是设计取舍的核心：空话 + 位置只是包装。
  // 误伤的代价 = 降级记 checked（诚实）；放过的代价 = 空话被当成清白证据留存。
  const r = checkControl('src/app.ts:42 这里是框架会转义，所以安全')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'generic_trust')
})

test('没有位置指针的合理表述也被拒（复核不了）', () => {
  const r = checkControl('因为做了权限校验，所以这个接口是安全的')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no_locator')
  assert.match(r.hint, /path:line|observed@|test:/)
})

test('三种合法位置写法都能通过', () => {
  const ok = [
    'src/plugins/loader.ts:88 用 realpath 解析后校验前缀，再交给 import()，路径逃逸被拦在加载之前',
    'observed@用 ../ 尝试逃逸三次都被拒，返回 EPERM，同时正常相对路径可读',
    'test:plugin-spec-check 的九项机械判据在 CI 里跑过，ESM/入口/依赖三项均绿',
  ]
  for (const text of ok) {
    const r = checkControl(text)
    assert.equal(r.ok, true, '应通过但被拒：' + text + ' → ' + r.reason + ' / ' + r.hint)
    assert.equal(r.reason, 'ok')
  }
})

test('needsControl：只有 cleared 要求清白理由', () => {
  assert.equal(needsControl('cleared'), true)
  for (const v of ['confirmed', 'proof_gap', 'checked', 'na']) {
    assert.equal(needsControl(v), false, v + ' 不应强制 control')
  }
})

test('★isCleanVerdict：checked 不算清白——整个插件存在的理由', () => {
  assert.equal(isCleanVerdict('cleared'), true)
  assert.equal(isCleanVerdict('checked'), false, 'checked 是「查过没结论」，不许算进清白')
  assert.equal(isCleanVerdict('proof_gap'), false)
  assert.equal(isCleanVerdict('confirmed'), false)
  assert.equal(isCleanVerdict('na'), false)
})

test('五态齐备且没有第六态', () => {
  assert.deepEqual([...VERDICTS], ['confirmed', 'cleared', 'proof_gap', 'checked', 'na'])
  for (const v of VERDICTS) {
    assert.ok(describeVerdict(v).length > 0, v + ' 缺少释义')
  }
})
