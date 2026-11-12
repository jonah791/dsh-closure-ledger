/**
 * closure.ts — 闭合裁决的**判据层**（纯函数，无 IO）。
 *
 * 来源（2026-11-12 读源码后本土化）：Strix `strix/skills/analysis/counterevidence.md`
 * 的三态闭合。它把「我查过了、没问题」拆成两句可证伪的话：
 *   ① `ruled_out` 必须能填完「安全，因为〈某控制〉在〈某位置〉于〈危险点〉之前〈做了什么〉，
 *      在攻击者可达的每一条路径上」。**填不出这句，就不在 ruled_out。**
 *   ② 它列了九类「听起来像理由、实际不算」的形态，第一类就是「泛泛信任某个库/框架」。
 *
 * 本文件把 ① 做成**机械判据**（位置指针必须存在）、把 ② 做成**黑名单**。
 *
 * 设计取舍（重要）：判据**宁可误伤，不可放过**。
 *   - 误伤的代价 = 降级记 `checked`（「查了、指不出具体控制」）——这是**诚实**的，不造成谎报。
 *   - 放过的代价 = 一条空话被当成清白证据留存，将来被自己和别人引用。
 * 两者不对称，所以黑名单优先于位置指针（带位置的空话仍是空话，只是包装过）。
 */

/** 闭合裁决五态。**没有第六态**——「我继续往下走了」不是一态。 */
export type Verdict = 'confirmed' | 'cleared' | 'proof_gap' | 'checked' | 'na'

export const VERDICTS: readonly Verdict[] = ['confirmed', 'cleared', 'proof_gap', 'checked', 'na']

/** 需要「指名控制」的裁决（只有它要求说出凭什么清白） */
export const NEEDS_CONTROL: readonly Verdict[] = ['cleared']

/** 位置指针形态：至少命中一种，才允许记 `cleared`。 */
const LOCATOR_PATTERNS: readonly RegExp[] = [
  // path/to/file.ext 或 file.ext:12 或 file.ext#L12
  /\b[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|ya?ml|md|py|ps1|sh|bat|cmd|toml|ini)(?::\d+|#L\d+)?\b/i,
  // 实测观察到的行为（没有源码可指时的合法替代）
  /\bobserved@/i,
  // 有测试覆盖
  /\btest:/i,
  // 显式行号引用（如 :42 单独出现时不算，必须有前缀词）
  /\bline\s+\d+/i,
]

/**
 * 空话黑名单：Strix 九类里的「泛泛信任」一类的本土化。
 * 只收**短而精确、明显是甩锅**的表述；长句子里偶然包含不算（见下面的用法）。
 */
const GENERIC_PHRASES: readonly string[] = [
  '框架处理',
  '框架会处理',
  '框架会转义',
  '框架保证',
  '框架兜底',
  '库会转义',
  '库处理了',
  '库保证',
  'orm处理',
  'orm 处理',
  'orm会处理',
  '一般不会',
  '通常安全',
  '应该没问题',
  '应该是安全的',
  '应该安全',
  '默认安全',
  '内置防护',
  '自动转义',
  '不用担心',
  '不会有问题',
  '肯定安全',
  '理论上安全',
]

export interface CheckResult {
  ok: boolean
  /** 通过时为 'ok'；失败时为机器可读的失败码 */
  reason: 'ok' | 'empty' | 'too_short' | 'generic_trust' | 'no_locator'
  /** 失败时给调用方的**可执行**下一步（不是「请补充」这种废话） */
  hint: string
  /** 命中的空话短语（reason=generic_trust 时给出，便于调用方知道自己踩了哪条） */
  hit?: string
}

/** 校验一条「清白理由」是否成立。 */
export function checkControl(control: string | undefined | null): CheckResult {
  const text = (control ?? '').trim()

  if (text === '') {
    return {
      ok: false,
      reason: 'empty',
      hint:
        '记 cleared 必须给 control。填不出「因为〈某控制〉在〈某位置〉于〈危险点〉之前〈做了什么〉」，'
        + '就说明你并没有找到控制——那就记 `checked`（查过、指不出具体控制）或 `proof_gap`（既不能证实也不能排除）。'
        + '这两条都是合法结局，`cleared` 不是唯一的好结局。',
    }
  }

  // ⚠ 顺序有意义：空话检查**先于**长度检查。
  // 「一般不会」「通常安全」这类短句，问题的本质不是「太短」，是「它是甩锅」——
  // 报 generic_trust 才能把用户引向正确修法；报 too_short 会把真正的问题盖住。
  const lowered = text.toLowerCase()
  const hit = GENERIC_PHRASES.find((p) => lowered.includes(p))
  if (hit !== undefined) {
    return {
      ok: false,
      reason: 'generic_trust',
      hint:
        '「' + hit + '」不构成反证——这是「泛泛信任某个库或框架」，本质是没查。'
        + '要指名**那一次**调用、**那些**参数、**那个**上下文，并给出位置指针（path:line / observed@ / test:）。'
        + '查不到具体控制就老实记 `checked`。',
      hit,
    }
  }

  if (text.length < 12) {
    return {
      ok: false,
      reason: 'too_short',
      hint:
        'control 太短，不像一条可核的理由（下限 12 字）。写清三件事：控制是什么、在哪（文件:行 / observed@ / test:）、'
        + '它在危险动作之前做了什么。',
    }
  }

  const hasLocator = LOCATOR_PATTERNS.some((re) => re.test(text))
  if (!hasLocator) {
    return {
      ok: false,
      reason: 'no_locator',
      hint:
        'control 缺位置指针，别人照着复核不了。三种合法写法任选：'
        + '① `path/to/file.ts:42`（源码位置）② `observed@<你实测看到的行为>`（无源码时）③ `test:<测试名>`（有测试覆盖）。',
    }
  }

  return { ok: true, reason: 'ok', hint: '' }
}

/** 该裁决是否要求 control。 */
export function needsControl(verdict: Verdict): boolean {
  return NEEDS_CONTROL.includes(verdict)
}

/** 裁决的一句话释义（进工具出参与摘要，避免调用方自己解码枚举）。 */
export function describeVerdict(verdict: Verdict): string {
  switch (verdict) {
    case 'confirmed':
      return '已证实有问题（已上报或有可复现证据）'
    case 'cleared':
      return '已排除——必须指得出「哪个控制、在哪、拦住了什么」'
    case 'proof_gap':
      return '证据缺口——既不能证实也不能排除（合法结局，不许改写成 cleared 来收拾待办）'
    case 'checked':
      return '查过、没发现、但指不出具体控制（不等同清白）'
    case 'na':
      return '不适用（说清为什么不适用）'
  }
}

/** `checked` 与 `cleared` 的区别必须在读数里可见——这是整个插件存在的理由。 */
export function isCleanVerdict(verdict: Verdict): boolean {
  // ⚠ 只有 cleared 算「判过清白」。checked 是「查过、没结论」，不许算进清白。
  return verdict === 'cleared'
}
