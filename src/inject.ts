/**
 * inject.ts — 每轮一行缺口读数注入（`agent/pre-step` 瀑布）。
 *
 * 为什么要注入而不是「我记得去查」（同 dsh-longhorizon 的教训，arXiv:2610.14966v1）：
 * 中性提醒**不改变行为**——读数必须出现在**执行路径**上才有效。
 * 本插件如果只提供 5 个工具而不注入，结果就是：造完当天用三次，之后再也不会想起它。
 *
 * 与 longhorizon 注入的分工（不重复）：
 *   - longhorizon ：「还剩几件没做完」（未完成项）
 *   - 本插件     ：「有几个判断还悬着 / 过期了」（已终结的裁决，但证据缺口或清白过期）
 *
 * ⚠ 只在**真的有缺口**时注入。没缺口就不出现——日常噪音会让读数被无视。
 *
 * 去重（防刷屏）：`agent/pre-step` 每 step 触发，一个长 turn 里有几十个 step。
 * 键 = 会话 + 小时 + 读数内容 ⇒ 内容变了立刻带新读数、跨小时重注入、其余不重复。
 *
 * 尾部追加（缓存友好）：动态注入统一放批次末尾，避免插在历史中部破坏前缀缓存。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { gapItems, type Ledger } from './ledger.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-closure-ledger': { kind: 'dsh-closure-ledger' }
  }
}

/**
 * 人类会话判据：DSH 人类会话形如 `session-<uuid>`；子代理是裸 uuid。
 *
 * ⚠ 这是 `dsh-longhorizon/src/inject.ts` 与 `dsh-life-core/src/target.ts` 同判据的**第三份副本**
 * （不 import 别的插件内部）。已知漂移风险 ⇒ 本文件带样本集测试，改判据必须多处同时改，测试会红。
 */
export function isUserSession(sessionId: string): boolean {
  return /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
}

/** 去重键：会话 + 小时 + 读数内容 */
export function dedupeKey(sessionId: string, line: string, now: Date): string {
  const hour = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0')
  return sessionId + '|' + hour + '|' + line
}

/** 把缺口渲染成一行（无缺口返回空串 ⇒ 不注入） */
export function renderGapLine(ledger: Ledger, staleDays: number, now: number): string {
  const gaps = gapItems(ledger, staleDays, now)
  if (gaps.length === 0) return ''

  const pg = gaps.filter((g) => g.kind === 'proof_gap').length
  const st = gaps.length - pg
  const oldest = gaps[0]
  const parts: string[] = []
  if (pg > 0) parts.push('证据缺口 ' + String(pg))
  if (st > 0) parts.push('超期清白 ' + String(st))

  const head = '【闭合账本】悬着 ' + String(gaps.length) + ' 条（' + parts.join(' · ') + '）'
  const one = oldest === undefined
    ? ''
    : '· 最老 ' + String(oldest.ageDays) + 'd（' + oldest.surface + '，' + oldest.kind + '）'
  return head + one + ' —— closure_gaps 对账；别让「我查过了」只活在当轮汇报里。'
}

export interface InjectDeps {
  /** 读账本（接线层给：宽松读——注入面绝不可因账本坏而崩） */
  loadLedger: () => Ledger
  /** 陈旧阈值 */
  staleDays: number
  /** 当前时刻（测试注入固定时刻） */
  now?: () => number
}

/** 去重集合上限（护栏：长期运行不得无限增长；清空只导致一次重复注入） */
const SEEN_CAP = 500

/** 安装注入：每个 pre-step 检查一次，命中即把一行读数追加进本 step 的消息批次末尾。 */
export function installInject(ctx: Context, deps: InjectDeps): void {
  const seen = new Set<string>()
  // DSH 类型漂移（同 longhorizon 的处理）：pre-step 事件重载后 TS 无法匹配监听器签名，
  // 运行时契约未变——用宽松类型绕开重载匹配。
  ctx.on('agent/pre-step', (async (payload: any, next: any) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const sid = String(payload.agent?.session?.id ?? '')
    if (!isUserSession(sid)) return decision
    const nowMs = deps.now !== undefined ? deps.now() : Date.now()
    const line = renderGapLine(deps.loadLedger(), deps.staleDays, nowMs)
    if (line === '') return decision
    const key = dedupeKey(sid, line, new Date(nowMs))
    if (seen.has(key)) return decision
    if (seen.size >= SEEN_CAP) seen.clear()
    seen.add(key)
    const msg = createUserMessage({
      content: [{ type: 'text', text: line }],
      source: { kind: 'dsh-closure-ledger' },
    })
    return { ...decision, messages: [...decision.messages, msg] }
  }) as any, { prepend: true })
}
