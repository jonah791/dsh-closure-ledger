/**
 * store.ts — 账本文件读写的**单一真源**。
 *
 * 纪律搬自 `dsh-longhorizon/src/store.ts`（同一教训链：2026-09-22 事故取证 / board.ts）：
 * **读路径可以退化，写路径绝不可以**——文件损坏时读到空账本，紧接着一次写入就会把
 * 整本覆盖成「只有刚写的那一条」= 静默数据销毁。
 * 所以本模块只给写路径提供**严格读**；只读面要宽松版就显式调 `readLenient`
 * ——让「降级」是一个选择，不是一个默认。
 *
 * 第二道护栏：整库畸形与单条畸形代价不对称——误丢单条是少一条读数，误丢整库不可逆。
 * 故 `items` 全数畸形且原始非空时**抛错**。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { normalizeLedger, EMPTY_LEDGER, type Ledger } from './ledger.ts'

export type ReadFile = (path: string) => string

export interface WriteDeps {
  writeFile: (path: string, data: string) => void
  rename: (from: string, to: string) => void
  mkdir: (path: string) => void
}

export const nodeWriteDeps: WriteDeps = {
  writeFile: (p, d) => { writeFileSync(p, d, 'utf8') },
  rename: (a, b) => { renameSync(a, b) },
  mkdir: (p) => { mkdirSync(p, { recursive: true }) },
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code !== undefined ? code + ': ' + e.message : e.message
  }
  return String(e)
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（与既有插件同约定） */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const raw = (env['DSH_HOME'] ?? '').trim()
  return raw !== '' ? raw : join(homedir(), '.dsh')
}

export function ledgerPath(home: string): string {
  return join(home, 'closure-ledger', 'ledger.json')
}

export function tracePath(home: string): string {
  return join(home, 'closure-ledger', 'trace.jsonl')
}

/** 严格读（**写路径专用**）：ENOENT ⇒ 空账本；其余一律抛错 */
export function readStrict(path: string, readFile: ReadFile): Ledger {
  let raw: string
  try {
    raw = readFile(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_LEDGER, items: [] }
    throw new Error('账本读取失败（' + path + '）：' + errText(e))
  }
  if (raw.trim() === '') return { ...EMPTY_LEDGER, items: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error('账本解析失败（' + path + '）——拒绝以空账本继续（否则下一次写入会覆盖整本）：' + errText(e))
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
    throw new Error('账本结构异常（' + path + '）：顶层缺少 items 数组——拒绝以空账本继续')
  }
  const rawCount = (parsed as { items: unknown[] }).items.length
  const { ledger, dropped } = normalizeLedger(parsed)
  if (dropped > 0 && ledger.items.length === 0 && rawCount > 0) {
    throw new Error('账本条目全部畸形（' + path + '）：' + String(dropped) + ' 条无一可用——拒绝以空账本继续')
  }
  return ledger
}

/** 宽松读（**只读面专用**）：任何失败退化为空账本。⚠ 绝不可用于写路径 */
export function readLenient(path: string, readFile: ReadFile): Ledger {
  try {
    return readStrict(path, readFile)
  } catch {
    return { ...EMPTY_LEDGER, items: [] }
  }
}

/** 原子写：先写 `.tmp` 再 rename（同目录 ⇒ 同卷 ⇒ rename 原子） */
export function writeAtomic(path: string, ledger: Ledger, deps: WriteDeps = nodeWriteDeps): void {
  deps.mkdir(dirname(path))
  const tmp = path + '.tmp'
  deps.writeFile(tmp, JSON.stringify(ledger, null, 2) + '\n')
  deps.rename(tmp, path)
}

/**
 * 追加一行留痕：关键机制不得只写 logger。
 * 留痕绝不反噬主流程：吞错并返回 bool。
 */
export function appendTrace(
  home: string,
  row: Record<string, unknown>,
  deps?: { append?: (path: string, data: string) => void },
): boolean {
  try {
    const append = deps?.append ?? ((p: string, d: string): void => { appendFileSync(p, d, 'utf8') })
    const path = tracePath(home)
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {
      /* 目录已存在或不可建——交给下面的 append 去决定成败 */
    }
    append(path, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')
    return true
  } catch {
    return false
  }
}
