/**
 * complexity.mjs —— 「按需复杂度」路由判定（先进编排迭代 4）
 *
 * 来源：_AI团队手册\先进自动化团队管理模式调研与迭代方案.md 迭代 4
 * （对齐 Anthropic《Building effective agents》元观点 B：从最简单方案开始，
 * 多智能体用延迟和成本换表现，交换要划算才用）。
 *
 * 三档路由：
 * L0 单干    单一产物、步骤可预判、无需独立验证 → 不开团，Lead 会话直接做
 * L1 流水线  产物 2-4 个、顺序依赖强、有明确验收 → 三人制团队（现行模式）
 * L2 扇出    多条独立路线可并行、或需多方案对比 → architect + N 个一次性 maker
 *
 * 判定入口「开团前四问」全部可判定（每问有默认值，不问就不猜）：
 * products    预计产物几个（1 / 2-4 / 5+）
 * predictable 步骤可预判吗（true=能列出步骤清单）
 * verify      需要独立验收吗（true=产物错了会流向下游，必须有第三方核对）
 * independent 各路线相互独立吗（true=可并行、互不依赖）
 *
 * 纯函数模块：不做 IO，op 层与流水线注入同一套判定，脚本可独立断言。
 */

/** 开团前四问的合法键与默认值 */
export const FOUR_QUESTIONS = [
  { key: 'products', label: '产物几个？', type: 'count', defaults: 1,
    hint: '这一轮要产出几件互相独立的东西（1 / 2-4 / 5+）' },
  { key: 'predictable', label: '步骤可预判吗？', type: 'boolean', defaults: true,
    hint: 'true = 现在就能列出完整步骤清单；false = 过程要根据发现随时转向' },
  { key: 'verify', label: '需要独立验收吗？', type: 'boolean', defaults: false,
    hint: 'true = 产物错了会流向下游/用户，必须有第三方核对' },
  { key: 'independent', label: '各路线独立吗？', type: 'boolean', defaults: false,
    hint: 'true = 各产物/路线可并行做、互不依赖（breadth-first）' },
]

/** 三档定义（口径与 00-协议 §2 修订一致：常设 3 人封顶，L2 可临时扩一次性 worker） */
export const LEVELS = {
  L0: {
    id: 'L0',
    label: '单干',
    form: 'Lead 会话直接做，不开团',
    rationale: '单一产物、步骤可预判、无需独立验证——三人制是浪费（Anthropic：多数应用优化单次调用+检索就够）',
  },
  L1: {
    id: 'L1',
    label: '流水线',
    form: '三人制团队（architect / maker / auditor，现行模式）',
    rationale: '产物 2-4 个、顺序依赖强、有明确验收——装配线能截断幻觉级联',
  },
  L2: {
    id: 'L2',
    label: '扇出',
    form: 'architect + N 个一次性 maker 并行（deps DAG + maxConcurrency），auditor 汇总投票',
    rationale: '多条独立路线可并行（breadth-first）、或单产物需多方案对比——压缩回传缓解 Lead 上下文压力',
  },
}

/**
 * 开团前四问 → 定档。判定规则（全部可判定，无「视情况而定」）：
 *
 * 1. independent=true 且（products>=3 或 verify=true）→ L2
 * （breadth-first 且需要汇总把关；多路线对比也走这里）
 * 2. verify=true 且 products>=2 → L1
 * （有独立验收 + 多产物顺序流转 = 装配线）
 * 3. verify=true 且 products==1 且 !predictable → L2
 * （单一产物但过程动态、要并行探索追线索——研究系统口径）
 * 4. 其余（products==1 或 predictable、无独立验收）→ L0
 *
 * @param {object} answers 四问答案：{ products?, predictable?, verify?, independent? }
 * 缺省的问按 defaults 兜底（defaults 即「最简单方案」方向的保守值）。
 * @returns {{level:'L0'|'L1'|'L2', levelDef:object, answers:object, trail:string[]}}
 * trail 是判定轨迹（面板与验收要能看「怎么判的」，不黑盒）。
 */
export function routeLevel(answers = {}) {
  const a = {}
  for (const q of FOUR_QUESTIONS) a[q.key] = q.defaults
  const src = answers && typeof answers === 'object' ? answers : {}
  for (const q of FOUR_QUESTIONS) {
    if (src[q.key] !== undefined && src[q.key] !== null) a[q.key] = src[q.key]
  }
  // products 归一：字符串/小数都收，非法回落默认 1
  let products = Number(a.products)
  if (!Number.isFinite(products) || products < 0) products = 1
  products = Math.round(products)
  a.products = products
  a.predictable = a.predictable === true || a.predictable === 'true'
  a.verify = a.verify === true || a.verify === 'true'
  a.independent = a.independent === true || a.independent === 'true'

  const trail = [
    '产物 ' + products + ' 个；步骤' + (a.predictable ? '可' : '不可') + '预判；' + (a.verify ? '需要' : '不需要') + '独立验收；路线' + (a.independent ? '相互独立' : '有依赖'),
  ]

  let level
  if (a.independent && (products >= 3 || a.verify)) {
    level = 'L2'
    trail.push('路线独立且（产物≥3 或需把关）→ 扇出：一次性 maker 并行，auditor 汇总')
  } else if (a.verify && products >= 2) {
    level = 'L1'
    trail.push('需独立验收 + 多产物顺序流转 → 三人制装配线')
  } else if (a.verify && products === 1 && !a.predictable) {
    level = 'L2'
    trail.push('单产物但过程动态不可预判 → 扇出并行探索（研究系统口径）')
  } else {
    level = 'L0'
    trail.push('单一产物或步骤可预判、无独立验收需求 → 单干，不开团')
  }
  return { level, levelDef: LEVELS[level], answers: a, trail }
}

/** 目录（op=complexity-route 无参数时的返回体） */
export function routeCatalog() {
  return {
    questions: FOUR_QUESTIONS,
    levels: Object.values(LEVELS),
  }
}