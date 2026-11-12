/**
 * ledger.ts — 闭合账本的**数据模型与纯逻辑**（无文件 IO）。
 *
 * 一条记录回答四个问题：
 *   ① 审的是什么面（surface）
 *   ② 得出什么裁决（verdict，五态）
 *   ③ 凭什么（control / evidence）——`cleared` 必须有可核的 control
 *   ④ 这次审覆盖到哪、没覆盖到哪（scope）——**读数必须自带范围**（母教训 #6e0e50c0）
 *
 * 与既有载体的分工（避免平行真源）：
 *   - `dsh-agent-taskboard`  = 要做的活（终态出板）
 *   - `dsh-longhorizon`      = 未完成项（还欠什么）
 *   - `dsh-evidence-router`  = 一次任务内的证据够不够（会话级，关闭即终结）
 *   - **本插件**             = 已终结的判断，且**要能被后来者反驳与修正**（长期，条目常驻）
 * 三者语义不重叠；本插件的 `proof_gap` 可人工转成 taskboard 项，这是接口不是重复。
 */
import { checkControl, describeVerdict, needsControl, VERDICTS, type Verdict } from './closure.ts'

export interface HistoryEntry {
  at: number
  from: Verdict
  to: Verdict
  why: string
  control: string
  evidence: string
  scope: string
}

export interface Item {
  id: string
  /** 被审的面。建议带前缀：`git:79仓` / `plugin:dsh-ops` / `service:3080` / `file:src/x.ts` */
  surface: string
  verdict: Verdict
  /** 清白理由：`cleared` 必填，且要过 checkControl */
  control: string
  /** 证据指针（可核的东西：命令输出、报告 id、行号） */
  evidence: string
  /** 本次审覆盖到哪 / 没覆盖到哪 —— 空串表示**没有声明范围**（读数会单独计数） */
  scope: string
  note: string
  createdAt: number
  updatedAt: number
  history: HistoryEntry[]
}

export interface Ledger {
  version: 1
  items: Item[]
}

export const EMPTY_LEDGER: Ledger = { version: 1, items: [] }

/** 畸形条目的宽容上限：单条坏了丢一条，整库坏了要炸（由 store 决定），不在这里吞。 */
export function normalizeLedger(input: unknown): { ledger: Ledger; dropped: number } {
  const raw = input as { items?: unknown } | null
  const arr = raw !== null && typeof raw === 'object' && Array.isArray(raw.items) ? raw.items : []
  const items: Item[] = []
  let dropped = 0

  for (const entry of arr) {
    const it = normalizeItem(entry)
    if (it === null) {
      dropped += 1
      continue
    }
    items.push(it)
  }
  return { ledger: { version: 1, items }, dropped }
}

function normalizeItem(input: unknown): Item | null {
  if (input === null || typeof input !== 'object') return null
  const o = input as Record<string, unknown>

  const id = str(o['id'])
  const surface = str(o['surface'])
  const verdict = str(o['verdict']) as Verdict
  if (id === '' || surface === '') return null
  if (!VERDICTS.includes(verdict)) return null

  const createdAt = num(o['createdAt'], 0)
  const updatedAt = num(o['updatedAt'], createdAt)

  return {
    id,
    surface,
    verdict,
    control: str(o['control']),
    evidence: str(o['evidence']),
    scope: str(o['scope']),
    note: str(o['note']),
    createdAt,
    updatedAt,
    history: normalizeHistory(o['history']),
  }
}

function normalizeHistory(input: unknown): HistoryEntry[] {
  if (!Array.isArray(input)) return []
  const out: HistoryEntry[] = []
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    const from = str(o['from']) as Verdict
    const to = str(o['to']) as Verdict
    if (!VERDICTS.includes(from) || !VERDICTS.includes(to)) continue
    out.push({
      at: num(o['at'], 0),
      from,
      to,
      why: str(o['why']),
      control: str(o['control']),
      evidence: str(o['evidence']),
      scope: str(o['scope']),
    })
  }
  return out
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 生成条目 id（8 位十六进制，前缀 cl- 便于肉眼区分其它台账） */
export function newId(rand: () => number = Math.random): string {
  const hex = (): string => Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')
  return 'cl-' + hex() + hex()
}

export type RecordOut =
  | { ok: true; ledger: Ledger; id: string }
  | { ok: false; error: string; hint: string }

export interface RecordInput {
  surface: string
  verdict: string
  control?: string | undefined
  evidence?: string | undefined
  scope?: string | undefined
  note?: string | undefined
}

/** 记一条闭合。**校验在这里发生**——不是靠调用方自觉。 */
export function recordItem(ledger: Ledger, input: RecordInput, now: number, idGen: () => string = newId): RecordOut {
  const surface = (input.surface ?? '').trim()
  if (surface === '') {
    return { ok: false, error: 'surface 不能为空', hint: '写清被审的是什么面，建议带前缀：`git:<仓>` / `plugin:<名>` / `service:<端口>` / `file:<路径>`' }
  }

  const verdictRaw = (input.verdict ?? '').trim()
  if (!VERDICTS.includes(verdictRaw as Verdict)) {
    return {
      ok: false,
      error: 'verdict 非法：「' + verdictRaw + '」',
      hint: '只能是 ' + VERDICTS.join(' | ') + '。释义见 closure_record 的说明。',
    }
  }
  const verdict = verdictRaw as Verdict

  const control = (input.control ?? '').trim()
  const evidence = (input.evidence ?? '').trim()
  const scope = (input.scope ?? '').trim()
  const note = (input.note ?? '').trim()

  if (needsControl(verdict)) {
    const check = checkControl(control)
    if (!check.ok) {
      return { ok: false, error: 'cleared 的清白理由不成立（' + check.reason + '）', hint: check.hint }
    }
  }

  // 同一个面已有条目时，不静默覆盖——提示改用 revise（保留历史）
  const existing = ledger.items.find((it) => it.surface === surface)
  if (existing !== undefined) {
    return {
      ok: false,
      error: '这个面已有条目：' + existing.id + '（当前 ' + existing.verdict + '）',
      hint: '改用 closure_revise 修订它——修订必须写 why，历史会保留；不要用新条目覆盖旧的（那会让「谁改过、为什么改」消失）。',
    }
  }

  const id = idGen()
  const item: Item = {
    id,
    surface,
    verdict,
    control,
    evidence,
    scope,
    note,
    createdAt: now,
    updatedAt: now,
    history: [],
  }
  return { ok: true, ledger: { version: 1, items: [...ledger.items, item] }, id }
}

export type ReviseOut =
  | { ok: true; ledger: Ledger; id: string; from: Verdict; to: Verdict }
  | { ok: false; error: string; hint: string }

export interface ReviseInput {
  id: string
  verdict: string
  why: string
  control?: string | undefined
  evidence?: string | undefined
  scope?: string | undefined
  note?: string | undefined
}

/** 修订一条。**why 必填**——「改了什么」便宜，「为什么改」才是留给将来的那一条。 */
export function reviseItem(ledger: Ledger, input: ReviseInput, now: number): ReviseOut {
  const id = (input.id ?? '').trim()
  const idx = ledger.items.findIndex((it) => it.id === id)
  if (idx < 0) {
    return { ok: false, error: '没有这个条目：' + id, hint: '先用 closure_list 找 id。' }
  }
  const target = ledger.items[idx]
  if (target === undefined) {
    return { ok: false, error: '条目读取失败：' + id, hint: '台账可能损坏，用 closure_list 复核。' }
  }

  const why = (input.why ?? '').trim()
  if (why === '') {
    return {
      ok: false,
      error: 'why 不能为空',
      hint: '修订必须说明**为什么改**（什么新信息推翻了旧裁决）。「改了什么」工具自己有记录，「为什么」只有你知道。',
    }
  }

  const verdictRaw = (input.verdict ?? '').trim()
  if (!VERDICTS.includes(verdictRaw as Verdict)) {
    return { ok: false, error: 'verdict 非法：「' + verdictRaw + '」', hint: '只能是 ' + VERDICTS.join(' | ') }
  }
  const verdict = verdictRaw as Verdict

  const control = (input.control ?? target.control).trim()
  if (needsControl(verdict)) {
    const check = checkControl(control)
    if (!check.ok) {
      return { ok: false, error: '修订后仍要求可核的清白理由（' + check.reason + '）', hint: check.hint }
    }
  }

  const entry: HistoryEntry = {
    at: now,
    from: target.verdict,
    to: verdict,
    why,
    control,
    evidence: (input.evidence ?? target.evidence).trim(),
    scope: (input.scope ?? target.scope).trim(),
  }

  const updated: Item = {
    ...target,
    verdict,
    control,
    evidence: entry.evidence,
    scope: entry.scope,
    note: (input.note ?? target.note).trim(),
    updatedAt: now,
    history: [...target.history, entry],
  }

  const items = ledger.items.map((it, i) => (i === idx ? updated : it))
  return { ok: true, ledger: { version: 1, items }, id, from: entry.from, to: verdict }
}

export interface ListFilter {
  surface?: string | undefined
  verdict?: string | undefined
  /** 只看 N 天以上没动过的（0 = 不过滤） */
  staleDays?: number | undefined
}

export function listItems(ledger: Ledger, filter: ListFilter, now: number): Item[] {
  const surface = (filter.surface ?? '').trim().toLowerCase()
  const verdict = (filter.verdict ?? '').trim()
  const staleDays = filter.staleDays ?? 0

  return ledger.items
    .filter((it) => (surface === '' ? true : it.surface.toLowerCase().includes(surface)))
    .filter((it) => (verdict === '' ? true : it.verdict === verdict))
    .filter((it) => (staleDays <= 0 ? true : now - it.updatedAt >= staleDays * 86_400_000))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface Gap {
  id: string
  surface: string
  verdict: Verdict
  /** `proof_gap` = 明确的证据缺口；`stale` = 清白结论已过期需复核 */
  kind: 'proof_gap' | 'stale'
  ageDays: number
  detail: string
}

/**
 * 缺口清单：收工时该看的那一张。
 * - `proof_gap` 一律列出（既不能证实也不能排除，是欠的活）
 * - `cleared` 超过 staleDays 天没复核也列出（**代码会变，清白会过期**）
 */
export function gapItems(ledger: Ledger, staleDays: number, now: number): Gap[] {
  const out: Gap[] = []
  for (const it of ledger.items) {
    const ageDays = Number(((now - it.updatedAt) / 86_400_000).toFixed(1))
    if (it.verdict === 'proof_gap') {
      out.push({
        id: it.id,
        surface: it.surface,
        verdict: it.verdict,
        kind: 'proof_gap',
        ageDays,
        detail: it.note !== '' ? it.note : '缺的是：' + (it.evidence !== '' ? '' : '连证据指针都没有'),
      })
      continue
    }
    if (it.verdict === 'cleared' && staleDays > 0 && now - it.updatedAt >= staleDays * 86_400_000) {
      out.push({
        id: it.id,
        surface: it.surface,
        verdict: it.verdict,
        kind: 'stale',
        ageDays,
        detail: '清白结论已 ' + String(ageDays) + ' 天未复核——代码/依赖/部署变过就可能失效',
      })
    }
  }
  return out.sort((a, b) => b.ageDays - a.ageDays)
}

export interface Summary {
  total: number
  confirmed: number
  cleared: number
  proofGap: number
  checked: number
  na: number
  /** 没声明 scope 的条数（读数带范围：0 才是好） */
  noScope: number
  /** 有 history 的条数（被修订过） */
  revised: number
}

export function summaryOf(ledger: Ledger): Summary {
  const s: Summary = {
    total: ledger.items.length,
    confirmed: 0,
    cleared: 0,
    proofGap: 0,
    checked: 0,
    na: 0,
    noScope: 0,
    revised: 0,
  }
  for (const it of ledger.items) {
    switch (it.verdict) {
      case 'confirmed':
        s.confirmed += 1
        break
      case 'cleared':
        s.cleared += 1
        break
      case 'proof_gap':
        s.proofGap += 1
        break
      case 'checked':
        s.checked += 1
        break
      case 'na':
        s.na += 1
        break
    }
    if (it.scope === '') s.noScope += 1
    if (it.history.length > 0) s.revised += 1
  }
  return s
}

export { VERDICTS, describeVerdict, checkControl }
export type { Verdict }
