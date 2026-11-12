/**
 * dsh-closure-ledger — 闭合账本：给「我判过什么、凭什么」一个归宿。
 *
 * 要解决的问题（实测缺口，2026-11-12）：我每天产出大量**判断**——
 * 「这 5 个 dirty 文件是主人的仓，不归我提交」「这条测试债是期望写错不是代码错」
 * 「这条路走不通」。这些判断**只存在于当轮汇报里**，会话一过就没了：
 * 下次要么重查，要么靠记忆碰运气。于是「干净区域」与「从未访问的区域」读起来一模一样。
 *
 * 来源：Strix `strix/skills/analysis/counterevidence.md` 的三态闭合（2026-11-12 读源码）。
 * 它那条最锋利的话是本插件的立项理由：
 *   「只记录发现的扫描，无法告诉读者什么被审过并澄清了，
 *     这让每个干净区域与未访问区域无法区分。」
 *
 * 与既有载体的分工（防平行真源）：
 *   taskboard（要做的活） / longhorizon（未完成项） / evidence-router（单次任务证据够不够）
 *   → **本插件管「已终结的判断」，且要能被后来者反驳与修正**。
 *
 * 本插件唯一的硬机制：**判 `cleared` 必须指名控制并给位置指针**（见 closure.ts）。
 * 指不出来不是失败——记 `checked` 或 `proof_gap` 都是合法结局。
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  describeVerdict,
  gapItems,
  listItems,
  recordItem,
  reviseItem,
  summaryOf,
  VERDICTS,
  type Item,
  type Ledger,
  type Verdict,
} from './ledger.ts'
import { appendTrace, ledgerPath, readLenient, readStrict, resolveHome, writeAtomic } from './store.ts'
import { installInject } from './inject.ts'

export const name = 'closure-ledger'
export const inject = ['tools', 'agents'] as const

export interface Config {
  enabled: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

/** 变更失败形态（工具出参统一用这个形状：可读的错误 + 可执行的下一步） */
type MutFail = { ok: false; error: string; hint: string }

/** 缺省陈旧阈值：清白结论超过这么多天没复核，就进缺口清单（代码会变，清白会过期） */
const DEFAULT_STALE_DAYS = 30

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

const VERDICT_HINT =
  '五态任选其一：confirmed（已证实有问题）· cleared（已排除，**必须给 control**）· '
  + 'proof_gap（既不能证实也不能排除，合法结局）· checked（查过、没发现、指不出具体控制，**不等同清白**）· na（不适用）'

function ageText(ms: number): string {
  const d = ms / 86_400_000
  if (d < 1) return (ms / 3_600_000).toFixed(1) + 'h'
  return d.toFixed(1) + 'd'
}

const VERDICT_MARK: Record<Verdict, string> = {
  confirmed: '⛔',
  cleared: '✅',
  proof_gap: '⚠',
  checked: '·',
  na: '—',
}

export function apply(ctx: Context, config: Config): void {
  const home = resolveHome()
  const path = ledgerPath(home)
  const read = (p: string): string => readFileSync(p, 'utf8')
  const now = (): number => Date.now()

  const loadLenient = (): Ledger => readLenient(path, read)

  /** 写面：严格读 ⇒ 变更 ⇒ 原子写 ⇒ 留痕。严格读失败即拒写。 */
  function mutate<T>(
    stage: string,
    fn: (l: Ledger) => (T & { ok: true; ledger: Ledger }) | MutFail,
  ): (T & { ok: true; ledger: Ledger }) | MutFail {
    let ledger: Ledger
    try {
      ledger = readStrict(path, read)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      appendTrace(home, { stage, ok: false, error: msg })
      return { ok: false, error: msg, hint: '账本文件损坏，写操作已拒绝（否则会把整本覆盖成一条）。先手工检查 ledger.json。' }
    }
    const out = fn(ledger)
    if (!out.ok) {
      appendTrace(home, { stage, ok: false, error: out.error })
      return out
    }
    try {
      writeAtomic(path, out.ledger)
    } catch (e: unknown) {
      const msg = '写盘失败：' + (e instanceof Error ? e.message : String(e))
      appendTrace(home, { stage, ok: false, error: msg })
      return { ok: false as const, error: msg, hint: '检查目录权限与磁盘空间。' }
    }
    return out
  }

  // ── 1. closure_record ────────────────────────────────────────────────
  const recordTool: ToolDefinition = defineTool({
    name: 'closure_record',
    description:
      '往闭合账本记一条**判断**：审的是什么面、裁决是什么、凭什么。'
      + '用途：把「查过了、没问题」从口头叙述变成可对账的条目——否则干净区域和未访问区域读起来一模一样。'
      + '硬机制：判 cleared **必须**给 control，且要含位置指针（path:line / observed@… / test:…），'
      + '命中「框架处理」「一般不会」这类空话会被拒收。指不出控制不是失败：记 checked 或 proof_gap 都是合法结局。'
      + '同一个面已有条目时拒收，请改用 closure_revise（保留历史）。',
    parameters: {
      surface: {
        type: 'string',
        required: true,
        description: '被审的面。建议带前缀：git:<仓> / plugin:<名> / service:<端口> / file:<路径> / task:<id>',
      },
      verdict: { type: 'string', required: true, description: VERDICT_HINT },
      control: {
        type: 'string',
        description: '清白理由（cleared 必填）：「因为〈某控制〉在〈某位置〉于〈危险点〉之前〈做了什么〉」。'
          + '位置指针三种写法任选：path/to/file.ts:42 · observed@<实测到的行为> · test:<测试名>',
      },
      evidence: { type: 'string', description: '证据指针：命令输出摘要 / 报告 id / 行号 / 日志片段（别人照着能复核）' },
      scope: {
        type: 'string',
        description: '本次审**覆盖到哪、没覆盖到哪**。强烈建议填——不填的条目会在 summary 里被单独计数（读数不带范围＝不知道它管到哪）',
      },
      note: { type: 'string', description: '补充说明（如：为什么这条是 proof_gap、缺的是哪一块证据）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_a, v) => {
        const o = v as { ok: boolean; id: string; note: string }
        return [{ type: 'text', text: o.note }]
      },
    },
    async execute(args) {
      const a = args as Record<string, unknown>
      const surface = str(a['surface']).trim()
      const verdict = str(a['verdict']).trim()
      const out = mutate('record', (l) =>
        recordItem(l, {
          surface,
          verdict,
          control: str(a['control']),
          evidence: str(a['evidence']),
          scope: str(a['scope']),
          note: str(a['note']),
        }, now()),
      )
      if (!out.ok) {
        return { ok: false, id: '', note: '✖ 拒收：' + out.error + '\n  → ' + out.hint }
      }
      const v = verdict as Verdict
      appendTrace(home, { stage: 'record', ok: true, id: out.id, surface, verdict: v })
      const extra = v === 'cleared' ? '' : '\n  （' + describeVerdict(v) + '——这不是「清白」）'
      return {
        ok: true,
        id: out.id,
        note: '✅ 记下 ' + out.id + ' — ' + v + '（' + describeVerdict(v) + '）\n  面：' + surface + extra,
      }
    },
  })

  // ── 2. closure_list ─────────────────────────────────────────────────
  const listTool: ToolDefinition = defineTool({
    name: 'closure_list',
    description:
      '列闭合账本的条目（按最近更新倒序）。可按面 / 裁决 / 陈旧天数过滤。'
      + '用途：动手前查「这个面我以前判过吗、判的是什么」——避免重查，也避免沿用一条已过期的清白结论。',
    parameters: {
      surface: { type: 'string', description: '按面模糊过滤（子串匹配，大小写不敏感）' },
      verdict: { type: 'string', description: '按裁决过滤：' + VERDICTS.join(' | ') },
      stale_days: { type: 'number', description: '只看超过 N 天没更新的（缺省 0 = 不过滤）' },
      limit: { type: 'number', description: '最多返回几条（缺省 30）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          shown: { type: 'number', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: (v as { note: string }).note }],
    },
    async execute(args) {
      const a = args as Record<string, unknown>
      const ledger = loadLenient()
      const nowMs = now()
      const limit = Math.max(1, Math.min(200, num(a['limit'], 30)))
      const rows = listItems(
        ledger,
        {
          surface: str(a['surface']),
          verdict: str(a['verdict']),
          staleDays: num(a['stale_days'], 0),
        },
        nowMs,
      )
      if (rows.length === 0) {
        return {
          total: ledger.items.length,
          shown: 0,
          note: ledger.items.length === 0
            ? '【闭合账本】空——还没有任何判断被记下来。这本身是个读数：说明「查过什么」暂时只存在于对话里。'
            : '【闭合账本】共 ' + String(ledger.items.length) + ' 条，但当前过滤条件下 0 条。',
        }
      }
      const shown = rows.slice(0, limit)
      const lines = ['【闭合账本】共 ' + String(ledger.items.length) + ' 条 · 显示 ' + String(shown.length) + ' 条']
      for (const it of shown) {
        const age = ageText(nowMs - it.updatedAt)
        const rev = it.history.length > 0 ? '（修订过 ' + String(it.history.length) + ' 次）' : ''
        lines.push('  ' + VERDICT_MARK[it.verdict] + ' ' + it.verdict.padEnd(9) + ' ' + it.id + '  ' + age + '  ' + it.surface + rev)
        if (it.control !== '') lines.push('      凭什么：' + it.control)
        if (it.evidence !== '') lines.push('      证据：' + it.evidence)
        if (it.scope !== '') lines.push('      范围：' + it.scope)
        if (it.note !== '') lines.push('      备注：' + it.note)
      }
      if (rows.length > shown.length) lines.push('  …还有 ' + String(rows.length - shown.length) + ' 条（调大 limit）')
      return { total: ledger.items.length, shown: shown.length, note: lines.join('\n') }
    },
  })

  // ── 3. closure_revise ───────────────────────────────────────────────
  const reviseTool: ToolDefinition = defineTool({
    name: 'closure_revise',
    description:
      '修订一条已有判断。**why 必填**——「改了什么」账本自己记得，「为什么改」只有你知道，而那才是留给将来的那一条。'
      + '典型用法：新证据推翻了旧的 cleared（改回 proof_gap 或 confirmed）· 补上了原先缺的证据（proof_gap → cleared，此时必须给 control）。'
      + '⚠ 旧裁决不会被抹掉，会进 history——包括 who/why/何时。',
    parameters: {
      id: { type: 'string', required: true, description: '条目 id（如 cl-1a2b3c4d）' },
      verdict: { type: 'string', required: true, description: VERDICT_HINT },
      why: { type: 'string', required: true, description: '为什么改：什么新信息推翻了旧裁决 / 补上了什么缺口' },
      control: { type: 'string', description: '新的清白理由（改成 cleared 时必填且要过校验；缺省沿用旧值）' },
      evidence: { type: 'string', description: '新的证据指针（缺省沿用旧值）' },
      scope: { type: 'string', description: '新的范围声明（缺省沿用旧值）' },
      note: { type: 'string', description: '新的备注（缺省沿用旧值）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: (v as { note: string }).note }],
    },
    async execute(args) {
      const a = args as Record<string, unknown>
      const out = mutate('revise', (l) =>
        reviseItem(l, {
          id: str(a['id']),
          verdict: str(a['verdict']),
          why: str(a['why']),
          control: a['control'] === undefined ? undefined : str(a['control']),
          evidence: a['evidence'] === undefined ? undefined : str(a['evidence']),
          scope: a['scope'] === undefined ? undefined : str(a['scope']),
          note: a['note'] === undefined ? undefined : str(a['note']),
        }, now()),
      )
      if (!out.ok) {
        return { ok: false, note: '✖ 拒收：' + out.error + '\n  → ' + out.hint }
      }
      const r = out as { ok: true; ledger: Ledger; id: string; from: Verdict; to: Verdict }
      appendTrace(home, { stage: 'revise', ok: true, id: r.id, from: r.from, to: r.to, why: str(a['why']) })
      return {
        ok: true,
        note: '✅ 已修订 ' + r.id + '：' + r.from + ' → ' + r.to + '\n  理由已入 history（旧裁决没被抹掉）',
      }
    },
  })

  // ── 4. closure_gaps ─────────────────────────────────────────────────
  const gapsTool: ToolDefinition = defineTool({
    name: 'closure_gaps',
    description:
      '缺口清单：所有 proof_gap（既不能证实也不能排除＝欠的活）+ 所有超期未复核的 cleared（代码会变，清白会过期）。'
      + '用途：收工时对账「我以为查干净的地方，还有哪些其实没结论」。这是本账本最该被定期调用的一条。',
    parameters: {
      stale_days: { type: 'number', description: '清白结论多少天未复核算过期（缺省 ' + String(DEFAULT_STALE_DAYS) + '）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          gaps: { type: 'number', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: (v as { note: string }).note }],
    },
    async execute(args) {
      const a = args as Record<string, unknown>
      const ledger = loadLenient()
      const nowMs = now()
      const staleDays = num(a['stale_days'], DEFAULT_STALE_DAYS)
      const gaps = gapItems(ledger, staleDays, nowMs)
      if (gaps.length === 0) {
        return {
          gaps: 0,
          note: '【缺口】0 条（账本 ' + String(ledger.items.length) + ' 条，无 proof_gap、无超期清白）——这是好消息，但只覆盖**被记录过的面**。',
        }
      }
      const pg = gaps.filter((g) => g.kind === 'proof_gap').length
      const st = gaps.length - pg
      const lines = ['【缺口】' + String(gaps.length) + ' 条（证据缺口 ' + String(pg) + ' · 超期清白 ' + String(st) + '）']
      for (const g of gaps) {
        lines.push('  ' + (g.kind === 'proof_gap' ? '⚠' : '🕐') + ' ' + g.kind.padEnd(10) + ' ' + g.id + '  ' + String(g.ageDays) + 'd  ' + g.surface)
        lines.push('      ' + g.detail)
      }
      lines.push('  下一步：proof_gap 要么补证据改判，要么转成 taskboard 项；超期清白要么复核后 revise 续期，要么降级成 proof_gap。')
      return { gaps: gaps.length, note: lines.join('\n') }
    },
  })

  // ── 5. closure_summary ──────────────────────────────────────────────
  const summaryTool: ToolDefinition = defineTool({
    name: 'closure_summary',
    description:
      '闭合账本总览：各裁决计数 + 未声明范围的条数 + 被修订过的条数。'
      + '⚠ 读数自带范围：这个数**只覆盖被记录过的面**，未记录的面无法枚举——不要把它读成「全部清白」。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: (v as { note: string }).note }],
    },
    async execute() {
      const ledger = loadLenient()
      const s = summaryOf(ledger)
      if (s.total === 0) {
        return {
          total: 0,
          note: '【闭合账本】空。没有任何判断被记下来——所有「我看过了」都只活在对话里。',
        }
      }
      const lines = [
        '【闭合账本】共 ' + String(s.total) + ' 条'
        + '｜已证实 ' + String(s.confirmed)
        + ' · 已排除 ' + String(s.cleared)
        + ' · 证据缺口 ' + String(s.proofGap)
        + ' · 查过无控制 ' + String(s.checked)
        + ' · 不适用 ' + String(s.na),
      ]
      if (s.noScope > 0) {
        lines.push('  未声明范围：' + String(s.noScope) + ' 条——不知道它覆盖到哪，等于读数没有分母')
      }
      if (s.revised > 0) {
        lines.push('  被修订过：' + String(s.revised) + ' 条——说明账本在起作用（旧结论能被推翻）')
      }
      lines.push('  ⚠ 范围诚实：本数只覆盖「被记录过的面」。未记录的面无法枚举——不要把 0 缺口读成「全部清白」。')
      return { total: s.total, note: lines.join('\n') }
    },
  })

  if (!config.enabled) return
  ctx.tools.register(recordTool)
  ctx.tools.register(listTool)
  ctx.tools.register(reviseTool)
  ctx.tools.register(gapsTool)
  ctx.tools.register(summaryTool)

  // 缺口读数注入：只在**真的有缺口**时出现（没缺口不噪音）。
  // 不注入的话，这 5 个工具的结果就是「造完当天用三次，之后再也不会想起」——
  // 中性提醒不改变行为，读数必须出现在执行路径上（arXiv:2610.14966v1）。
  installInject(ctx, { loadLedger: loadLenient, staleDays: DEFAULT_STALE_DAYS })
}
