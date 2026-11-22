/**
 * 成员模型路由 —— 「每天默认优先免费、免费不可用按链降级」
 *
 * ── 层级概念（用户澄清）──────────────
 * 面板上看到的 14 个「provider 前缀」**不是 14 家独立厂商**，而是
 * `our-free-model` 这一个插件（chanGateway relay，127.0.0.1:18326）
 * 内部暴露的 14 条上游通道（lane）。每条通道背后接的是不同的上游服务
 * （DeepSeek 官方 API / 各聚合转发商 / 本地 Ollama 等），所以看起来像
 * 「很多家」，其实都从同一个插件入口出来。这是命名与界面层级的错误，
 * 与本模块的选路/门槛功能逻辑无关——字段名 `provider` 保持不变以兼容
 * 配置（route-config.json）与既有断言。
 *
 * 依据：dsh_team_models 当前 70 条 route 的 provider 去重后正好 14 个前缀，
 * 与 relay /v1/models 的 upstream 命名一致；deepseek-official 那条通道
 * 背后就是 DeepSeek 官方 API，按量消耗个人余额（见 route-config.json 的
 * disabledReason）。
 */
/** 这些前缀所属插件 */
export const PLUGIN_ID = 'our-free-model'
/** 插件的 chanGateway relay 入口（OpenAI 兼容） */
export const RELAY_ENDPOINT = 'http://127.0.0.1:18326/v1/chat/completions'
/**
 * 14 条上游通道（前缀 → 人读说明）；key 与 dsh_team_models 的 provider 严格一致。
 * 用途：面板/文档据此把「厂商」改称「通道」，并说明每条通道背后的上游服务。
 */
export const LANE_OF = {
  'our-free-model': '插件免费池主通道（EAC 系列，接多家免费上游）',
  'modlens-our-free-model': 'our-free-model 的视觉桥通道（modlens）',
  'deepseek-official': 'DeepSeek 官方 API 通道（按量消耗个人余额）',
  'deepseek-modlens': 'DeepSeek 官方 API 的视觉桥通道（modlens）',
  'workbuddy': 'WorkBuddy 积分通道',
  'modlens-workbuddy': 'WorkBuddy 的视觉桥通道（modlens）',
  'raccoon': 'Raccoon 转发通道',
  'qoder': 'Qoder 转发通道（主区）',
  'qodercn': 'Qoder 转发通道（国区）',
  'zcode': 'ZCode 通道',
  'modlens-zcode': 'ZCode 的视觉桥通道（modlens）',
  'loomy': 'Loomy 转发通道',
  'cline': 'Cline 通道',
  'ollama-local': '本地 Ollama 通道',
}
/** 通道条数（14，供面板顶部说明与断言用，不写死在文案里） */
export const LANE_COUNT = Object.keys(LANE_OF).length

/* 由来与硬事实（原文保留）：
 *
 * 由来：成员模型路由矩阵（auditor 产出）第 3、4 节。
 * 那份文档是用真实最小调用验证出来的（16 条 route 各发一句「只回OK」，见 103 §2），
 * 不是照抄路由列表——所以这里把结论直接落成常量，任何改动都该先有同等强度的实测。
 *
 * 三条硬事实（103 §2 时点快照，2026-11-21 10:58–11:04）：
 *   1. `our-free-model/*` 整族 26 条列表免费，实测 4/4 全报 `Free usage limit reached`
 * ——「列表里免费」不等于「今天能用」。所以免费池只放实测通过的那几个。
 *   2. `qoder/*` 主区未登录（报「未配置凭据，请先登录」）；`qodercn/*` 国区可用。
 * 同一个模型名在两个 provider 下可用性相反，provider 必须与 model 一起写死。
 *   3. `raccoon/*` 的 effort 只接受 `on`；拿 `high` 去 spawn 会被宿主
 * （dsh-team-control index.js:826）直接拒。所以 effort 必须带白名单校验。
 *
 * 本模块是纯函数模块：不读文件、不联网、不碰 sidecar，可被单测直接调用。
 * 真正的可用性复查交 scripts\check-free-routes.mjs（每日巡检），它的结果通过
 * `opts.freePool` 注入进来，本模块不自己发请求。
 */

/* ── 免费池：实测可用（103 §2 #5/#6/#7/#9 + 2026-11-21 our-free-model EAC 实测）──
 * 这七项都是「真发过一轮、拿到 OK」的，但稳定性分两档（2026-11-21 Lead 三组实测定稿）：
 * stability:'stable' —— 容量足、多次可复现，做主力；hy4flash-free 排第一。
 * stability:'flakey' —— our-free-model 3 条，容量小/会排队/会超时（有 5s 回 OK 也有 150s 超时），
 * 只做补位：默认不作为首选，仅在稳定项全被挡或用户显式点名时才选中。
 * 排序纪律：stable 在前、flakey 垫底；candidatePool 也按 stability 再排一次，
 * 免得 our-free-model 的 providerRank=0 把它顶到主力位。已 EOL 的两条不进池，见 DEFAULT_CONFIG.disabledRoutes。
 */
export const FREE_POOL = [
  {
    key: 'hy4flash-free',
    provider: 'workbuddy',
    model: 'hy4flash-free',
    reasoningEffort: 'high',
    modalities: ['text'],
    stability: 'stable',
    note: 'Hy4 flash · x0.00，实测 10.7s 回 OK；仅 text，视觉任务不可用',
  },
  {
    key: 'sensenova-flash',
    provider: 'raccoon',
    model: 'sn-sensenova-6-8-flash',
    reasoningEffort: 'on',
    modalities: ['text', 'image'],
    stability: 'stable',
    note: 'SenseNova-6.8-Flash · 免费，实测 8.6s 回 OK',
  },
  {
    key: 'sensenova-flash-lite',
    provider: 'raccoon',
    model: 'sn-sensenova-6-8-flash-lite',
    reasoningEffort: 'on',
    modalities: ['text', 'image'],
    stability: 'stable',
    note: 'SenseNova-6.8-Flash-Lite · 免费，实测 8.9s 回 OK',
  },
  {
    key: 'qodercn-qfmodel',
    provider: 'qodercn',
    model: 'qfmodel',
    reasoningEffort: 'medium',
    modalities: ['text', 'image'],
    stability: 'stable',
    note: 'Qwen3.8-Flash · 免费，国区可用，实测 4.5s 回 OK（qoder 主区未登录）',
  },
  // ── our-free-model EAC 3 条：容量小/会排队/会超时的补位通道（flakey）──
  // 名称按 relay 全名（与  / scripts\probe-eac-routes.mjs 一致）；
  // 与下面 EOL 的两条分开：EOL 走 DEFAULT_CONFIG.disabledRoutes 精确拉黑。
  {
    key: 'ofm-kimi-k3.1-pro',
    provider: 'our-free-model',
    model: 'moonshotai/kimi-k3.1-pro',
    reasoningEffort: undefined,
    modalities: ['text', 'image'],
    stability: 'flakey',
    note: 'Kimi K3.1 Pro（★1024K 多模态）· 免费但波动可用（14:51 89.6s / 15:00 99s 真产出）；窗口 1048576（1024K）',
  },
  {
    key: 'ofm-dsv41-flash-free',
    provider: 'our-free-model',
    model: 'opencode/deepseek-v4.1-flash-free',
    reasoningEffort: undefined,
    modalities: ['text', 'image'],
    stability: 'flakey',
    note: 'DeepSeek V4.1 Flash Free（★1024K 多模态）· 免费但波动可用（14:51 405ms / 15:00 150s 超时）；窗口 1048576（1024K）',
  },
  {
    key: 'ofm-step-5-preview',
    provider: 'our-free-model',
    model: 'stepfun-ai/step-5-preview',
    reasoningEffort: undefined,
    modalities: ['text', 'image'],
    stability: 'flakey',
    note: 'Step 5 Preview · 免费但波动可用（14:51 5.4s / 15:00 150s 超时）；窗口 131072（128K）',
  },
]

/* ── effort 白名单：来自 dsh_team_models 采样 ────────────────────
 * 宿主会拒掉不在 route efforts 里的值（dsh-team-control index.js:826），
 * 所以在选路阶段就夹住，别等 spawn 时才炸。
 * 表里没有的 route 视为「不限制」（返回 undefined 时不传该字段）。
 */
export const EFFORTS = {
  'raccoon/sn-sensenova-6-8-flash': ['on'],
  'raccoon/sn-sensenova-6-8-flash-lite': ['on'],
  'raccoon/sn-deepseek-v4-1-flash-1017': ['on'],
  'raccoon/sn-glm-5-3': ['on'],
  'raccoon/sn-glm-5-3-flash': ['on'],
  'raccoon/sn-kimi-k3-1-pro': ['on'],
  'raccoon/sn-qwen4-max': ['on'],
  'workbuddy/hy4flash-free': ['high'],
  'workbuddy/hy4flash': ['high'],
  'workbuddy/deepseek-v4-pro': ['high', 'xhigh'],
  'workbuddy/deepseek-v4.1-flash': ['low', 'high', 'max'],
  'workbuddy/glm-5.2': ['high', 'xhigh'],
  'workbuddy/glm-5.3': ['low', 'high', 'max'],
  'workbuddy/glm-5.3-flash': ['low', 'high', 'max'],
  'workbuddy/minimax-m3.1-flash': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek-official/deepseek-v4-pro': ['low', 'high', 'max'],
  'deepseek-official/deepseek-flash': ['low', 'high', 'max'],
  'qodercn/qfmodel': ['none', 'low', 'medium', 'xhigh'],
  'qodercn/dfmodel': ['none', 'low', 'high', 'max'],
  'qodercn/gmodel': ['low', 'high', 'max'],
  'ollama-local/qwen3-4b-abliterated:latest': [],
}

/** 每个 route 的默认 effort（白名单夹取时的回落值） */
const DEFAULT_EFFORT = {
  'raccoon/sn-sensenova-6-8-flash': 'on',
  'raccoon/sn-sensenova-6-8-flash-lite': 'on',
  'workbuddy/hy4flash-free': 'high',
  'workbuddy/deepseek-v4.1-flash': 'high',
  'workbuddy/deepseek-v4-pro': 'high',
  'workbuddy/glm-5.3-flash': 'high',
  'deepseek-official/deepseek-v4-pro': 'high',
  'deepseek-official/deepseek-flash': 'high',
  'qodercn/qfmodel': 'medium',
}

/* ── ROUTE 字典：按能力域的「免费首选 → 付费降级 → 备选」链 ───────
 * 域名单：code / audit / probe / vision / quick（ 的行，去掉 lead 行
 * ——Lead 不走本模块，它是主会话自己继承的 route）。
 *
 * **付费档定价纪律（2026-11-21 用户要求，覆盖  的原始排序）**：
 * `deepseek-v4-pro` 太贵（workbuddy x0.51 / deepseek-official 按量），
 * 所以任何域的**付费首选都必须是 `workbuddy/deepseek-v4.1-flash`（x0.11）**；
 * `deepseek-v4-pro` 一律降到**最后备选**——只在 V4.1 系全不可用（白名单排除、
 * 上下文窗口不足、当日不可用）时才启用。这条是钱的问题，不是口味问题，
 * 改链之前先看这里。
 *
 * 结构上刻意做成「有序档位数组」而不是写死三字段：selectRoute 遍历
 * TIER_ORDER + 链里出现的其它键，将来加第 4 档（如 `frugal`）不用改签名、
 * 不用改调用方。每条 route 可带 `contextWindow`（token），由 CONTEXT_WINDOW
 * 表统一提供，选路时参与过滤（见 selectRoute 的 opts.neededTokens）。
 */
export const ROUTE = {
  // 代码 / 干活（maker）
  code: {
    free: { provider: 'raccoon', model: 'sn-sensenova-6-8-flash', reasoningEffort: 'on' },
    paid: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    backup: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017', reasoningEffort: 'on' },
    last: { provider: 'workbuddy', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  },
  // 审计 / 复核（auditor）：四档全是 1M 窗；V4.1 两档打头，dsv4-pro 只在最后
  audit: {
    free: { provider: 'qodercn', model: 'qfmodel', reasoningEffort: 'xhigh' },
    paid: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    backup: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
    last: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
  },
  // 取证 / 验活（probe， 里叫 forensics）
  probe: {
    free: { provider: 'qodercn', model: 'qfmodel', reasoningEffort: 'medium' },
    paid: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    backup: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017', reasoningEffort: 'on' },
    last: { provider: 'workbuddy', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  },
  // 视觉 / 截图类：优先选 image 专精通道（modlens 视觉桥，2026-11-21 Lead ）；
  // 不再把 text+image 的主力 deepseek-v4.1-flash 当视觉首选（那是"复用主力"，不是专精）。
  // vision 域走生成意图：专精通道即使倍率超 cap 也放行（见 gateRoute 的 genIntent）。
  vision: {
    free: { provider: 'raccoon', model: 'sn-sensenova-6-8-flash-lite', reasoningEffort: 'on' },
    paid: { provider: 'modlens-workbuddy', model: 'mimo-v2.6-pro', reasoningEffort: 'high' },
    backup: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017', reasoningEffort: 'on' },
    last: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  },
  // 快速活（机械改写 / 分类）
  quick: {
    free: { provider: 'raccoon', model: 'sn-sensenova-6-8-flash-lite', reasoningEffort: 'on' },
    paid: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    backup: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017', reasoningEffort: 'on' },
    last: { provider: 'qodercn', model: 'qfmodel', reasoningEffort: 'medium' },
  },
}

/* ── 四级优先级（2026-11-21 用户明确定义，**取代旧「免费优先」设计**）──
 * 顺序：主力 → 免费 → 省钱备选 → 视觉兜底。selectRoute 按 TIER_ORDER 逐档试。
 *
 * 关键：档位「键名」沿用历史四档（paid/free/backup/last）以兼容面板与配置，
 * 但「语义」由本表重新定义——paid 不再是「付费降级」而是「主力」，last 不再是
 * 「dsv4-pro 保底」而是「视觉兜底」。读代码时以 TIER_PRIORITY 为准，别按旧注释理解。
 *
 * ④ 视觉档纪律（用户 15:20 修订）：视觉档 = 带 vision 模态的通道，**优先级最低**
 * （默认不参与 code/audit/probe/quick 四域，只在 vision 域或显式指定时被选中）；
 * 但**功能完整可用**——用户显式要求文生图/文生视频或显式指定视觉 route 时必须放行。
 * 这里只降优先级，不含任何 forbid/block 规则，也不因「消耗大」禁用视觉模型。
 */
export const TIER_PRIORITY = [
  { tier: 'paid',    name: '主力档',   rule: '模型名含 deepseek-v4.1-flash 的任意通道（不限 provider）' },
  { tier: 'free',    name: '免费档',   rule: '倍率 x0.00 的通道，每天先榨干净' },
  { tier: 'backup',  name: '省钱备选档', rule: '倍率 x0.03~0.13 的廉价通道，用于快速小活' },
  { tier: 'last',    name: '视觉兜底档', rule: '带 vision 模态的通道，优先级最低；仅 vision 域或显式指定时选中，功能完整可用' },
]

/** selectRoute 逐档尝试顺序（由 TIER_PRIORITY 派生，勿两处手写漂移） */
export const TIER_ORDER = TIER_PRIORITY.map((x) => x.tier) // ['paid','free','backup','last']

/** 主力档判定：模型名含 deepseek-v4.1-flash（任意 provider，点号/连字符两种写法都认）。
 * 兼容对象入参：传 route 对象时取 .model（或 provider/model key），传字符串时直接用。 */
export function isPrimaryModel(model) {
  let s = model
  if (model && typeof model === 'object') s = model.model || routeKey(model)
  return /deepseek[-.]v4\.1[-.]flash/i.test(String(s == null ? '' : s))
}

/**
 * 视觉模态判定：两类都算视觉——
 * ① ROUTE_MODALITIES 里带 image 的 route；
 * ② modlens-* / *-modlens 视觉桥通道（LANE_OF 已声明它们是视觉桥，
 * 即便 ROUTE_MODALITIES 未逐条收录，也要认——否则 modlens 专精通道会被判成非视觉）。
 * 其余未收录的按 text，不当视觉。
 */
export function isVisionRoute(routeOrKey) {
  const k = typeof routeOrKey === 'string' ? routeOrKey : routeKey(routeOrKey)
  if (!k) return false
  if (/^(modlens-|[a-z0-9-]+-modlens\/)/i.test(k)) return true
  const modes = ROUTE_MODALITIES[k]
  return Array.isArray(modes) && modes.includes('image')
}

/** image 专精通道（视觉兜底档优先选它，而非复用 text+image 的主力模型）：
 * modlens-* 视觉桥通道即专精；普通 text+image 多模态主力不算专精。 */
export function isVisionSpecialist(routeOrKey) {
  const k = typeof routeOrKey === 'string' ? routeOrKey : routeKey(routeOrKey)
  return !!k && /^(modlens-|[a-z0-9-]+-modlens\/)/i.test(k)
}

/**
 * 是否「生成/视觉意图」请求（2026-11-21 Lead  修复）：
 * - 请求来自 vision 域；
 * - 显式 allowVision=true；
 * - 显式指定的 route 是视觉通道（image 模态 / modlens 视觉桥）。
 * 命中时 gateRoute 跳过**成本类**门槛（倍率未知、cap），但不跳过 disabledProviders /
 * disabledRoutes 这类硬禁用——「倍率上限只用于自动选路省钱，不能用来封功能」。
 * 这是「非指定任务不做文生图/视频，但明确要做时必须放行」的落地：
 * 默认自动选路不带这些 opts，照旧省钱；显式做视觉的调用带 opts，功能完整可用。
 */
export function isGenerationIntent(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (normalizeDomain(o.domain) === 'vision' || String(o.domain || '').trim().toLowerCase() === 'vision') return true
  if (o.allowVision === true) return true
  if (o.explicit && isVisionRoute(o.explicit)) return true
  return false
}

/* ── 上下文窗口表（token）——  ──────────────────────────
 * 为什么必须有这张表：切模型时把 1M 上下文的会话切到 128K 的模型上，
 * 不是「变慢」，是**直接失败或静默截断**。所以窗口必须参与选路，而不是选完再炸。
 *
 * 取值纪律（ 末尾，违反这条比多花点压缩代价高得多）：
 * 只有「官方文档」或「description 原文」**明确写窗口**的才用大值；
 * 其余一律 DEFAULT_WINDOW（128K）保守处理。
 * 窗口估大 = 以为装得下 → 硬切 → 运行时截断/报错；估小只是多压一次。
 *
 * 所以这张表**只列有依据的大窗口**，未收录的由 windowOf 回落保守值——
 * 不再像上一版那样把未知显式写成 null（null 会让调用方以为「无法判定」而放行）。
 */
export const CONTEXT_WINDOW = {
  // ── V4.1 全系：官方 1M（）──
  'workbuddy/deepseek-v4.1-flash': 1000000, // 官方文档：DeepSeek 全线 1M 默认上下文
  'raccoon/sn-deepseek-v4-1-flash-1017': 1000000, // 官方 CONTEXT LENGTH=1M
  'deepseek-official/deepseek-flash': 1000000, // 官方：DeepSeek-V4.1-Flash
  // ── dsv4-pro 全系：官方 1M（）──
  'deepseek-official/deepseek-v4-pro': 1000000,
  'deepseek-modlens/deepseek-v4-pro': 1000000, // 底座官方 + modlens 视觉桥，窗口不因桥变
  'workbuddy/deepseek-v4-pro': 1000000,
  'modlens-workbuddy/deepseek-v4-pro': 1000000,
  // ── our-free-model/*：description 原文写了确切 K 数（ 允许的第二来源）──
  'our-free-model/big-pickle': 262144, // 256K
  'our-free-model/deepseek-v4.1-flash-free': 1048576, // 1024K
  'our-free-model/flint-40b-free': 262144, // 256K
  'our-free-model/hy4-flash-free': 131072, // 128K
  'our-free-model/iceman-free': 131072, // 128K
  'our-free-model/jev-1.13-free': 32768, // 32K
  'our-free-model/kilo-auto/free': 256000, // 250K
  'our-free-model/reflection/beam-free': 1048576, // 1024K
  'our-free-model/dots-studio/dots-3-note-preview:free': 512000, // 500K
  'our-free-model/baidu/ernie-5.5-flash-preview:free': 1024000, // 1000K
  'our-free-model/recursive/flint-v1.0:free': 262144, // 256K
  'our-free-model/stealth/glyph-cluster': 256000, // 250K
  'our-free-model/liquid/lfm-3-1.7b:free': 262144, // 256K
  'our-free-model/inclusionai/ling-3.2-flash:free': 1048576, // 1024K
  'our-free-model/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 256000, // 250K
  'our-free-model/nvidia/nemotron-3-ultra-550b-a55b:free': 1000448, // 977K
  'our-free-model/nvidia/nemotron-3.5-lightning:free': 1000448, // 977K
  'our-free-model/nvidia/nemotron-3.5-super-vl:free': 1000448, // 977K
  'our-free-model/openrouter/free': 199680, // 195K
  'our-free-model/particle-ai/particle-1:free': 1048576, // 1024K
  'our-free-model/longcat-2.5-free': 131072, // 128K
  'our-free-model/mimo-v2.6-flash-free': 1048576, // 1024K
  'our-free-model/nemotron-3.5-super-vl-free': 1048576, // 1024K
  'our-free-model/nemotron-3.5-lightning-free': 262144, // 256K
  'our-free-model/tidepool-alpha-free': 131072, // 128K
  'our-free-model/combo:recommended-free': 262144, // 256K
  // ── EAC 3 条（2026-11-21 实测接入，用户派发指定窗口）──
  'our-free-model/moonshotai/kimi-k3.1-pro': 1048576, // 1024K（★多模态）
  'our-free-model/opencode/deepseek-v4.1-flash-free': 1048576, // 1024K（★多模态）
  'our-free-model/stepfun-ai/step-5-preview': 131072, // 128K

  // ── 免费池 4 项：真实请求实测（；末行 + 两枚中段随机针全部回显才算「装得下」）──
  // 口径（109 §1）：实测最大成功 prompt_tokens − 300（指令开销）向下取整到 K = 「至少 ≥N K 可用」。
  // 所以这里写的是**下限**，不是上限；上限没测到就不猜（宁保守勿估大）。
  'qodercn/qfmodel': 971000, // 实测 972,047 成功；1056K 起 502 transport（非 window），上限未钉死
  'workbuddy/hy4flash-free': 935000, // 实测 935,888 成功；1088K 报 code 11115「prompt is too long」→ 硬上限 ≈990K
  'raccoon/sn-sensenova-6-8-flash': 469000, // 实测 469,899 成功，阶梯打满未失败，上限未测得
  // 注：'raccoon/sn-sensenova-6-8-flash-lite' **维持 128K 不动**——仅证实 29,987（48K 起账号级限流/风控），
  // 证据不足；不许因为兄弟模型 469K 就跟着上调（转发商账号风控独立， 末行）。
}

/**
 * 每个窗口值的来源标记（ 表格的「来源」列的代码化）。
 * 用途：面板/审计要能回答「这个数字哪来的」，以及「哪些是保守值而非实测」。
 * 未收录的 route 由 windowOf 回落 DEFAULT_WINDOW，来源即 'conservative'。
 */
export const CONTEXT_WINDOW_SOURCE = {
  'workbuddy/deepseek-v4.1-flash': 'official',
  'raccoon/sn-deepseek-v4-1-flash-1017': 'official',
  'deepseek-official/deepseek-flash': 'official',
  'deepseek-official/deepseek-v4-pro': 'official',
  'deepseek-modlens/deepseek-v4-pro': 'official',
  'workbuddy/deepseek-v4-pro': 'official',
  'modlens-workbuddy/deepseek-v4-pro': 'official',
  // ── 实测来源（）：真实请求打出来的下限，与 official（官档）/ conservative（保守默认）区分开 ──
  'qodercn/qfmodel': 'measured',
  'workbuddy/hy4flash-free': 'measured',
  'raccoon/sn-sensenova-6-8-flash': 'measured',
}

/**
 * 实测证据行（）：窗口值不是拍脑袋，每条都带「最大成功 token 数」与文档出处，
 * 面板/审计要能回答「这个 971000 哪来的」。
 * measuredPromptTokens —— 实测最大成功 prompt_tokens（服务端 usage 口径，不是本地估算）
 * derivedWindow        —— 表里写的下限（= measuredPromptTokens − 300 后向下取整到 K）
 */
export const CONTEXT_WINDOW_EVIDENCE = {
  'qodercn/qfmodel': {
    measuredPromptTokens: 972047,
    derivedWindow: 971000,
    doc: 'docs\\109 §2.1',
    note: '阶梯 1040K 档通过；1056K 起 502 transport（provider_error，无窗口字样）→ 不作窗口结论，上限未钉死',
  },
  'workbuddy/hy4flash-free': {
    measuredPromptTokens: 935888,
    derivedWindow: 935000,
    doc: 'docs\\109 §2.2',
    note: '1088K 报 400 code 11115「prompt is too long」= 唯一一条真实 window 证据 → 硬上限 ≈990K（≈1M）',
  },
  'raccoon/sn-sensenova-6-8-flash': {
    measuredPromptTokens: 469899,
    derivedWindow: 469000,
    doc: 'docs\\109 §2.3',
    note: '阶梯打满 512K 档未失败；上推时标定即 quota 失败（未打大档）→ 上限未测得，只认下限',
  },
  'raccoon/sn-sensenova-6-8-flash-lite': {
    measuredPromptTokens: 29987,
    derivedWindow: null,
    doc: 'docs\\109 §2.4',
    note: '仅证实 29,987；48K 起 quota + 账号级风控 → 证据不足，维持 128K，不上调',
  },
}

/** 未标注窗口的 route 一律按这个保守值处理（） */
export const DEFAULT_WINDOW = 128000

/**
 * 实测窗口的「贴边折扣」（ 验收③）。
 * 表里存的已经是实测**最小成功值**（−300 后向下取整）——不是最大值，所以判定基数直接用表值；
 * 但贴边仍有翻车风险，故另给一个更保守的预算窗口：measured 来源 × 0.95 再向下取整到 K。
 * 用途：面板/审计展示「建议留多少余量」，以及调用方需要额外保守时显式取用。
 * **不悄悄改 fitCheck**：判定用表值，折扣要显式 opt-in，免得同一份数据两个口径。
 */
export const MEASURED_DISCOUNT = 0.95

/** 贴边折扣后的窗口：只有 measured 来源打折，official / conservative 原样返回 */
export function conservativeWindow(route, override) {
  const win = windowOf(route, override)
  if (windowSourceOf(route, override) !== 'measured') return win
  return Math.floor((win * MEASURED_DISCOUNT) / 1000) * 1000
}

/**
 * 三态判定阈值（，写死为具体数字，不留给调用方猜）。
 * SAFETY_HEADROOM 1.1 —— 需求放大系数，给输出留余量
 * WINDOW_USAGE    0.8 —— 窗口可用上限，到 80% 就不再硬切
 * COMPRESS_THRESHOLD 0.6 —— 占用到 60% 即建议「先压缩再切」
 * 边界用法（ 末尾，刻意不重叠）：
 * needed*1.1 <= window*0.8            → safe
 * needed <= window*0.8 < needed*1.1   → compress-first
 * needed >  window*0.8                → reject
 */
export const FIT = { SAFETY_HEADROOM: 1.1, WINDOW_USAGE: 0.8, COMPRESS_THRESHOLD: 0.6 }

/** 兼容旧名：本文件早前叫 FIT_THRESHOLD（compress/reject 两个比例） */
export const FIT_THRESHOLD = { compress: FIT.WINDOW_USAGE, reject: FIT.WINDOW_USAGE }

/** 每个任务域的「预期工具输出」固定余量（） */
export const DOMAIN_OVERHEAD = { code: 8192, audit: 16384, probe: 16384, vision: 4096, quick: 2048 }

/**
 * 取某条 route 的上下文窗口（token）。
 * 语义：查不到 → DEFAULT_WINDOW（128K 保守），**不返回 null**。
 * 为什么不再返回 null：null 会让上层误以为「无法判定 → 放行」，
 * 而  的纪律是「没标注就当 128K」。宁可多压一次，不能硬切。
 *
 * @param {object|string} route route 对象或 'provider/model'
 * @param {object} [override] 窗口表覆盖（'provider/model' → token）
 */
export function windowOf(route, override) {
  const k = typeof route === 'string' ? route : routeKey(route)
  if (!k) return DEFAULT_WINDOW
  const ov = override && typeof override === 'object' ? override : null
  if (ov && Object.prototype.hasOwnProperty.call(ov, k)) {
    const v = ov[k]
    if (v === null) return DEFAULT_WINDOW // 显式置 null = 当未标注处理
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW
  }
  const v = CONTEXT_WINDOW[k]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW
}

/** 窗口来源：'official' / 'description' / 'conservative'（ 来源列） */
export function windowSourceOf(route, override) {
  const k = typeof route === 'string' ? route : routeKey(route)
  if (!k) return 'conservative'
  const ov = override && typeof override === 'object' ? override : null
  if (ov && Object.prototype.hasOwnProperty.call(ov, k)) return 'override'
  const marked = CONTEXT_WINDOW_SOURCE[k]
  if (marked) return marked
  return Object.prototype.hasOwnProperty.call(CONTEXT_WINDOW, k) ? 'description' : 'conservative'
}

/** 旧名兼容：contextWindowOf 现在等价于 windowOf（不再有 null 语义） */
export function contextWindowOf(route, override) {
  return windowOf(route, override)
}

/**
 * 按  判三态的核心（纯算术，无 IO）。
 * @returns {{ok:boolean, state:'safe'|'compress-first'|'reject',
 * level:'safe'|'compress'|'reject',
 * window:number, needed:number, usageRatio:number,
 * required:number, allowed:number, ratio:number,
 * windowSource:string, detail:string, reason:string}}
 * state 是  的官名（compress-first），level 是旧名（compress）——
 * 两个都给，避免上层为改名重新对表。
 */
function judge(neededTokens, window, fit, windowSource) {
  const f = { ...FIT, ...(fit || {}) }
  const need = typeof neededTokens === 'number' && Number.isFinite(neededTokens) && neededTokens >= 0
    ? neededTokens : 0
  const win = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : DEFAULT_WINDOW
  const required = need * f.SAFETY_HEADROOM
  const allowed = win * f.WINDOW_USAGE
  const usageRatio = need / win
  const base = {
    window: win, needed: need, usageRatio, required, allowed,
    ratio: usageRatio, windowSource: windowSource || 'conservative',
  }
  if (required <= allowed) {
    return {
      ...base, ok: true, state: 'safe', level: 'safe',
      detail: '窗口足够，可以直接切',
      reason: `需 ${Math.round(need)}×${f.SAFETY_HEADROOM}=${Math.round(required)} ≤ 可用上限 ${Math.round(allowed)}（窗口 ${win}），安全`,
    }
  }
  if (need <= allowed) {
    return {
      ...base, ok: false, state: 'compress-first', level: 'compress',
      detail: '窗口偏紧，先压缩/裁剪前文再切',
      reason: `需 ${Math.round(required)} 超可用上限 ${Math.round(allowed)} 但本体 ${Math.round(need)} 仍装得下（窗口 ${win}）：先压缩再切`,
    }
  }
  return {
    ...base, ok: false, state: 'reject', level: 'reject',
    detail: '目标模型装不下，禁止硬切',
    reason: `需 ${Math.round(need)} > 可用上限 ${Math.round(allowed)}（窗口 ${win} × ${f.WINDOW_USAGE}）：装不下，禁止硬切`,
  }
}

/**
 * 三态判定：这条 route 在当前上下文需求下能不能切（）。
 *
 * 签名同时接受两种入参，方便调用方：
 * fitCheck('workbuddy/deepseek-v4.1-flash', 500000)
 * fitCheck({ provider, model }, 500000)
 *
 * @param {object|string} route route 对象或 'provider/model'
 * @param {number} neededTokens 预计需要 token（当前占用 + 新增，见 ）
 * @param {{window?:number, override?:object, fit?:object}} [opt]
 * @returns {{ok:boolean, state:'safe'|'compress-first'|'reject', level:'safe'|'compress'|'reject',
 * required:number, window:number, ratio:number, usageRatio:number,
 * allowed:number, needed:number, windowSource:string, detail:string, reason:string}}
 */
export function fitCheck(route, neededTokens, opt = {}) {
  const key = typeof route === 'string' ? route : routeKey(route)
  const win = typeof opt.window === 'number' && Number.isFinite(opt.window) && opt.window > 0
    ? opt.window
    : windowOf(key, opt.override)
  return judge(neededTokens, win, opt.fit, windowSourceOf(key, opt.override))
}

/**
 * 旧签名兼容（needed, window, threshold) → 与 fitCheck 同一套算术。
 * 保留它是因为 verify 脚本与可能的外部调用已经在用；语义已对齐 ，
 * 不再有「ratio > 1 才 reject」那套更松的旧阈值。
 */
export function fitContext(neededTokens, window, fit) {
  const win = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null
  const out = judge(neededTokens, win == null ? DEFAULT_WINDOW : win, fit, win == null ? 'conservative' : 'explicit')
  // 没给需求 → 不评估（保留旧行为：ok=null / level=unknown），上层要知道自己没传
  if (neededTokens == null || !Number.isFinite(Number(neededTokens))) {
    return { ...out, ok: null, state: 'unknown', level: 'unknown', needed: 0, reason: '未提供 neededTokens，不评估上下文' }
  }
  return out
}

/**
 * 估算「预计需要 token」（）。
 * 口径：当前占用（totalTokens）+ 任务 brief 文本 + 该域的固定工具输出余量。
 * 中文按 1 字≈1 token、英文按 4 字符≈1 token 粗算——这是保守下限，不是精确值。
 */
export function estimateNeeded(domain, currentTokens, task) {
  const norm = normalizeDomain(domain) || DEFAULT_DOMAIN
  const textTokens = (s) => {
    const t = String(s == null ? '' : s)
    if (!t) return 0
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
    const rest = t.length - cjk
    return cjk + Math.ceil(rest / 4)
  }
  const plan = Array.isArray(task && task.plan) ? task.plan : []
  const planTokens = plan.reduce((a, p) => a + textTokens(p && (p.detail || p.action || p.target || p.note)), 0)
  const brief = textTokens(task && task.subject) + planTokens + textTokens(task && task.acceptance)
  const overhead = DOMAIN_OVERHEAD[norm] || 8192
  const current = typeof currentTokens === 'number' && Number.isFinite(currentTokens) && currentTokens > 0 ? currentTokens : 0
  return {
    neededTokens: current + brief + overhead,
    breakdown: { currentTokens: current, briefTokens: brief, overhead, domain: norm },
  }
}

/** 兼容  的旧域名：forensics→probe、fast→quick */
export const DOMAIN_ALIAS = {
  forensics: 'probe',
  fast: 'quick',
  coding: 'code',
  review: 'audit',
}

/** 未知能力域的回落域名。不猜最贵的，选 quick：机械活对模型最宽容，降级链也最便宜。 */
export const DEFAULT_DOMAIN = 'quick'

/**
 * 成员能力域（architect/maker/auditor…）→ 任务能力域（code/audit/…）。
 * 这是在「成员编制」和「任务类型」之间搭的桥：编制按 architect/maker/auditor 认，
 * 选模型按 code/audit/probe/vision/quick 走，两者不是一套词。
 */
export const MEMBER_DOMAIN_TO_TASK_DOMAIN = {
  architect: 'audit', // 造规则=强推理活，跟审计同一档
  maker: 'code',
  auditor: 'audit',
  probe: 'probe',
  vision: 'vision',
  quick: 'quick',
}

/* ── 静态能力基线（） ──────────────────────────────
 * 刻意不额外起 LLM：能力描述来自「模型模态（dsh_team_models 采样）+ 任务域定义」，
 * 是静态基线而非探查结论。动态探查（真能跑 shell 吗）由  的
 * dsh_team_memory_write 另行记录，不在这里假装知道。
 */
const DOMAIN_SKILLS = {
  code: ['改代码', '跑脚本', '读仓库结构', '按验收自测'],
  audit: ['找逻辑漏洞', '核对证据链', '跨文档对表', '判定真/假通过'],
  probe: ['跑命令取证', '核文件与时间戳', '复现问题', '写可复现判定口径'],
  vision: ['看图/截图', '核对视觉产物', '读图表与界面'],
  quick: ['机械改写', '分类归并', '批量校对', '格式对齐'],
}

/** 该 route 支持哪些输入模态（来自 dsh_team_models 采样，未收录的按 text） */
const ROUTE_MODALITIES = {
  'raccoon/sn-sensenova-6-8-flash': ['text', 'image'],
  'raccoon/sn-sensenova-6-8-flash-lite': ['text', 'image'],
  'workbuddy/hy4flash-free': ['text'],
  'workbuddy/deepseek-v4.1-flash': ['text', 'image'],
  'workbuddy/deepseek-v4-pro': ['text'],
  'workbuddy/glm-5.3-flash': ['text', 'image'],
  'deepseek-official/deepseek-v4-pro': ['text'],
  'deepseek-official/deepseek-flash': ['text', 'image'],
  'qodercn/qfmodel': ['text', 'image'],
}

/** route key 统一形态：`provider/model` */
export function routeKey(r) {
  return r && r.provider && r.model ? `${r.provider}/${r.model}` : ''
}

/**
 * 把 effort 夹进宿主允许的取值范围。
 * @returns {string|undefined} 合法 effort；route 无白名单时原样返回
 */
export function clampEffort(route) {
  if (!route || !route.model) return undefined
  const key = routeKey(route)
  const allow = EFFORTS[key]
  if (!Array.isArray(allow) || allow.length === 0) {
    // 无白名单：不强加 effort（宿主会继承 Lead 的 effort）。为 [] 时也一样。
    return allow && allow.length === 0 ? undefined : route.reasoningEffort
  }
  if (route.reasoningEffort && allow.includes(route.reasoningEffort)) return route.reasoningEffort
  return DEFAULT_EFFORT[key] || allow[0]
}

/**
 * 归一化能力域名（含别名、成员域映射、大小写、空白）。
 * 三层：① 直接是任务域 ②  的旧域名别名 ③ 成员域（architect/maker/auditor）
 * 第 ③ 层不能省：S2_5 拿到的就是成员域，不映射的话 audit/maker 会被当成未知域回落，
 * 白掉一次免费优先（真踩过：verify-routes [3] 三条成员域断言红）。
 */
export function normalizeDomain(domain) {
  const raw = String(domain == null ? '' : domain).trim().toLowerCase()
  if (!raw) return null
  if (ROUTE[raw]) return raw
  if (DOMAIN_ALIAS[raw]) return DOMAIN_ALIAS[raw]
  const mapped = MEMBER_DOMAIN_TO_TASK_DOMAIN[raw]
  if (mapped && ROUTE[mapped]) return mapped
  return null
}

/**
 * 选一条 route。纯函数：同样的输入永远同样的输出，不读网络/文件/环境。
 *
 * @param {string} domain 能力域：code / audit / probe（forensics）/ vision / quick（fast）；
 * 也接受成员域 architect / maker / auditor，内部映射
 * @param {object} [opts]  —— 参数表刻意做成「可选对象」，加新维度不改签名：
 * @param {boolean} [opts.freeDisabled=false]  true = 今天不用免费池（免费全灭/用户要求）
 * @param {string[]|object[]} [opts.freePool]  免费池覆盖：'provider/model' 字符串或 route 对象；
 * 传 [] 视为「免费池为空」→ 直接降级
 * @param {string[]} [opts.available]          可选白名单：只在这些 'provider/model' 里挑
 * @param {string} [opts.reasoningEffort]      偏好 effort（不合法时按白名单夹取）
 * @param {number} [opts.neededTokens]         **上下文占用 + 预计新增**（token）。
 * 给了就参与选路：窗口装不下的候选被**跳过**，
 * 而不是选完再失败（见 fitContext）
 * @param {object} [opts.contextWindows]       窗口表覆盖（ 定稿后注入，不必改本文件）
 * @param {{compress?:number,reject?:number}} [opts.fitThreshold] 阈值覆盖
 * @param {string[]} [opts.tiers]              只在这些档位里挑（如 ['paid','backup'] 强制跳免费）
 *
 * @returns {{provider:string, model:string, reasoningEffort:string|undefined,
 * domain:string, requestDomain:string, tier:string,
 * free:boolean, degraded:boolean, fellBackDomain:boolean,
 * contextWindow:number|null,
 * fit:{ok:boolean|null, level:'safe'|'compress'|'reject'|'unknown',
 * required:number|null, window:number|null, ratio:number|null, reason:string},
 * contextExhausted:boolean, contextRejected:string[],
 * reason:string, tried:string[]}}
 * fit.level 就是上层要区分的那三态：safe=安全切 / compress=需压缩 / reject=拒绝切
 * （另加 unknown=窗口未知，需人工确认）。contextExhausted=true 表示全链窗口都不够，
 * 此时返回的是「窗口最大的那条」并带 reject 结论，让上层明确拒绝而不是静默降级。
 */
export function selectRoute(domain, opts = {}) {
  const requestDomain = String(domain == null ? '' : domain).trim()
  const norm = normalizeDomain(requestDomain)
  const fellBackDomain = norm == null
  const useDomain = norm || DEFAULT_DOMAIN
  const chain = ROUTE[useDomain]

  const tried = []
  const contextRejected = []
  const wantedTiers = Array.isArray(opts.tiers) && opts.tiers.length
    ? opts.tiers.filter((t) => typeof t === 'string' && t).map((t) => t.trim().toLowerCase())
    : null

  const availableList = Array.isArray(opts.available) && opts.available.length
    ? opts.available.map((x) => (typeof x === 'string' ? x : routeKey(x))).filter(Boolean)
    : null
  const isAvailable = (r) => {
    const k = routeKey(r)
    if (!k) return false
    if (!availableList) return true
    return availableList.includes(k)
  }

  // 免费池是否可用：三重判定（用户禁用 / 池为空 / 白名单里挑不到）
  const poolOverride = Array.isArray(opts.freePool) ? opts.freePool : null
  const poolKeys = poolOverride
    ? poolOverride.map((x) => (typeof x === 'string' ? x : routeKey(x))).filter(Boolean)
    : FREE_POOL.map(routeKey)
  const freePoolEmpty = poolKeys.length === 0
  const freeForbidden = opts.freeDisabled === true || freePoolEmpty

  // 有序候选：TIER_ORDER 里的档位先试，链里出现的其它档位（未来第 4 档）按插入顺序补在后面。
  // 不写死 free/paid/backup 三行，是为了加档位时不用改这个函数、更不用改调用方。
  // 视觉兜底档「非指定任务不做」（2026-11-21 用户修订）：
  // code/audit/probe/quick 四域自动选路时，跳过 last 档里带 vision 模态的通道——
  // 这是"默认不主动挑视觉兜底"，**不是硬拦**：vision 域、显式点名档位(wantedTiers)、
  // opts.allowVision=true 时照常参与；显式指定某条视觉/生成 route 走 resolveChatRoute
  // 的 explicit 分支（直接 gateRoute，不经此过滤），功能完整可用。
  const skipVisionFallback = useDomain !== 'vision' && opts.allowVision !== true && !wantedTiers
  const candidates = orderTiers(chain)
    .filter(({ tier }) => !wantedTiers || wantedTiers.includes(tier))
    .filter(({ tier, route }) => !(skipVisionFallback && tier === 'last' && isVisionRoute(route)))

  const needed = typeof opts.neededTokens === 'number' && Number.isFinite(opts.neededTokens)
    ? opts.neededTokens : null
  const th = opts.fitThreshold
  const winOv = opts.contextWindows
  // 倍率/provider 门槛（用户 2026-11-21：养号优先，workbuddy cap=0）
  const cfg = resolveConfig(opts.config || {})
  // vision 域（或显式 allowVision）= 生成意图：视觉专精通道不受成本门槛限制（Lead ）
  const genOpts = useDomain === 'vision' || opts.allowVision === true
    ? { domain: useDomain, allowVision: opts.allowVision }
    : undefined
  const gate = (route) => gateRoute(route, cfg, genOpts)
  const evaluate = (route) => {
    const win = windowOf(route, winOv)
    // 没给 neededTokens 时不假装安全也不假装装不下：state='unknown'，交上层决定
    if (needed == null) {
      return { win, fit: { ...judge(0, win, th, windowSourceOf(route, winOv)), ok: null, state: 'unknown', level: 'unknown', needed: 0, reason: '未提供 neededTokens，不评估上下文' } }
    }
    return { win, fit: judge(needed, win, th, windowSourceOf(route, winOv)) }
  }

  /* ：**按档位顺序**逐档判，第一个通过的档就是答案。
   * - 倍率/provider 门槛不过（disabled / cap / 倍率未知）→ 记录 tried，继续
   * - 不可用（免费池/白名单/freeDisabled）→ 记录 tried，继续
   * - reject（装不下）→ 记录 tried，继续下一档；**绝不返回该档**（拒绝硬切）
   * - compress-first → 返回该档 + 态，不再往下（压缩与否交上层决定）
   * - safe → 返回该档
   * 刻意不做「先全局找 safe」：那会让「免费档需压缩」被「付费档安全」顶掉，
   * 与  的档位优先语义相反（省钱优先于省一次压缩）。
   */
  const evaluated = []
  const gatedOut = []
  for (const { tier, route } of candidates) {
    const key = routeKey(route)
    if (!key) { tried.push(`${tier}:（route 缺 provider/model）`); continue }
    // ① 倍率 / provider 门槛：最先判——被 cap 挡住的档位连"试"都不该试
    const g = gate(route)
    if (!g.allowed) {
      gatedOut.push({ tier, key, provider: g.provider, multiplier: g.multiplier, cap: g.cap, capSource: g.capSource, blockedBy: g.blockedBy, disabledReason: g.disabledReason || null, reason: g.reason })
      tried.push(`${key}（${g.blockedBy}：${g.reason}）`)
      continue
    }
    // ② 免费档额外准入：必须在今天的免费池里
    if (tier === 'free') {
      if (freeForbidden) {
        tried.push(freePoolEmpty ? '免费池为空' : '免费已禁用')
        continue
      }
      if (!poolKeys.includes(key)) { tried.push(`${key}（不在免费池）`); continue }
    }
    if (!isAvailable(route)) { tried.push(`${key}（不在白名单）`); continue }
    const { win, fit } = evaluate(route)
    evaluated.push({ tier, route, key, win, fit, gate: g })
  }

  const freeStage = !freeForbidden
  const makeReason = (tier, key) => (tier === 'free'
    ? `免费池命中 ${key}`
    : (freeStage
      ? `免费项不可用，按链降到 ${key}`
      : `${freePoolEmpty ? '免费池为空' : '免费已禁用'}，按链降到 ${key}`))
  const rejectedKeys = evaluated.filter((x) => x.fit.level === 'reject').map((x) => x.key)
  const rejectNote = (key, fit) => `${key}（窗口不足：需 ${Math.round(fit.needed)} > 可用 ${Math.round(fit.allowed)}，已跳过）`

  // 逐档挑第一个非 reject 的候选（顺带把被跳过的 reject 写进 tried，便于审计）
  for (const x of evaluated) {
    if (x.fit.level === 'reject') { tried.push(rejectNote(x.key, x.fit)); continue }
    return build(useDomain, requestDomain, x.tier, x.route, opts, {
      fellBackDomain,
      tried: [...tried, x.key],
      degraded: x.tier !== 'free',
      win: x.win, fit: x.fit, contextRejected: rejectedKeys, gatedOut,
      reason: makeReason(x.tier, x.key)
        + (x.fit.level === 'compress' ? '（上下文偏紧，需先压缩再切）' : '')
        + (rejectedKeys.length ? `；另有 ${rejectedKeys.length} 个候选窗口不足被跳过` : '')
        + (gatedOut.length ? `；${gatedOut.length} 个候选被倍率/provider 门槛挡住` : ''),
    })
  }

  /* 全链都 reject：**不返回任何档位的"假成功"**，但仍要把「最宽的那条」带回去，
   * 让上层能说清「最大只有 X，你要 Y」。返回体一律 state='reject' + exhausted=true，
   * 上层必须当成「拒绝切」处理（ 第 5 条）。 */
  if (evaluated.length) {
    const widest = [...evaluated].sort((a, b) => (b.win || 0) - (a.win || 0))[0]
    return build(useDomain, requestDomain, widest.tier, widest.route, opts, {
      fellBackDomain,
      tried: [...tried, `${widest.key}（全链窗口不足，取最宽者供参考）`],
      degraded: widest.tier !== 'free',
      win: widest.win,
      fit: { ...widest.fit, ok: false, state: 'reject', level: 'reject', detail: '目标模型装不下，禁止硬切' },
      contextRejected: rejectedKeys,
      exhausted: true,
      gatedOut,
      reason: `链上所有候选都装不下（需 ${needed} token，最宽可用 ${Math.round(widest.fit.allowed)}）：拒绝切换，先压缩上下文或换更大窗口的模型`,
    })
  }

  /* ⑥ 全被倍率/门槛挡住（用户在面板上把上限压得太低时的真实场景）：
   * 不硬选一个超标的，也不假装成功——返回 rejected 结论 + 建议放宽哪一项。 */
  if (gatedOut.length) {
    const cheapest = [...gatedOut].sort((a, b) => (a.multiplier ?? Infinity) - (b.multiplier ?? Infinity))[0]
    const fallbackRoute = candidates.find((c) => routeKey(c.route) === cheapest.key) || candidates[0]
    return build(useDomain, requestDomain, fallbackRoute.tier, fallbackRoute.route, opts, {
      fellBackDomain,
      tried: [...tried, `${cheapest.key}（全部候选被门槛挡住，最便宜的一条附上供参考）`],
      degraded: true,
      ...evaluate(fallbackRoute.route),
      contextRejected: rejectedKeys,
      gatedOut,
      exhausted: true,
      reason: `链上所有候选都被倍率/provider 门槛挡住（最便宜的是 ${cheapest.key} x${cheapest.multiplier}，`
        + `上限 ${cheapest.capSource === 'provider' ? `${cheapest.provider} 级` : '全局'} x${cheapest.cap}）：`
        + '到面板「模型配置」调高 providerMultiplierCap 或 maxMultiplier，否则只能用更便宜的池',
    })
  }

  // 走到这里只可能是链结构异常（全档位被白名单/免费池排空）。如实报，不糊。
  const fallback = candidates[candidates.length - 1] || { tier: 'backup', route: chain[Object.keys(chain)[0]] }
  return build(useDomain, requestDomain, fallback.tier, fallback.route, opts, {
    fellBackDomain,
    tried: [...tried, `${routeKey(fallback.route)}（无可用候选，退回链尾）`],
    degraded: true,
    ...evaluate(fallback.route),
    contextRejected: rejectedKeys,
    gatedOut,
    reason: '链上无满足条件的候选（白名单/免费池把档位排空），退回链尾并如实标注',
  })
}

/** 把一条链按 TIER_ORDER 排成有序候选数组（未列档位按原插入顺序追加） */
function orderTiers(chain) {
  const seen = new Set()
  const out = []
  for (const t of TIER_ORDER) {
    if (chain && chain[t]) { out.push({ tier: t, route: chain[t] }); seen.add(t) }
  }
  for (const [t, r] of Object.entries(chain || {})) {
    if (!seen.has(t) && r && typeof r === 'object') out.push({ tier: t, route: r })
  }
  return out
}

function build(useDomain, requestDomain, tier, route, opts, extra) {
  const prefEffort = opts.reasoningEffort || (route && route.reasoningEffort)
  const eff = clampEffort({ ...(route || {}), reasoningEffort: prefEffort })
  const winOv = opts.contextWindows
  const fit = extra.fit || fitCheck(route, typeof opts.neededTokens === 'number' ? opts.neededTokens : 0, { override: winOv, fit: opts.fitThreshold })
  const g = extra.gate || gateRoute(route, resolveConfig(opts.config || {}))
  return {
    provider: route.provider,
    model: route.model,
    reasoningEffort: eff,
    domain: useDomain,
    requestDomain,
    tier,
    free: tier === 'free',
    degraded: extra.degraded,
    fellBackDomain: extra.fellBackDomain,
    contextWindow: fit.window,
    windowSource: fit.windowSource,
    fit,
    // 便于上层直接读，不必钻 fit 里翻：三态与拒绝原因
    state: fit.state,
    // 倍率与门槛（面板/审计要显示「这条多少钱、被什么挡住」）
    multiplier: g.multiplier,
    cap: g.cap,
    capSource: g.capSource,
    providerRank: g.providerRank,
    contextExhausted: extra.exhausted === true,
    contextRejected: extra.contextRejected || [],
    gatedOut: extra.gatedOut || [],
    reason: extra.reason + (extra.fellBackDomain ? `（未知能力域「${requestDomain}」→ 回落 ${useDomain}）` : ''),
    tried: extra.tried,
  }
}

/** 整条链摊平成数组（面板要展示「免费→付费→备选→最后」+ 倍率 + 门槛） */
export function routeChain(domain, opts = {}) {
  const norm = normalizeDomain(domain) || DEFAULT_DOMAIN
  const chain = ROUTE[norm]
  const winOv = opts.contextWindows
  const needed = typeof opts.neededTokens === 'number' && Number.isFinite(opts.neededTokens) ? opts.neededTokens : null
  const cfg = resolveConfig(opts.config || {})
  return orderTiers(chain).map(({ tier, route }) => {
    const eff = clampEffort(route)
    const win = windowOf(route, winOv)
    const key = routeKey(route)
    const fit = needed == null
      ? { ...judge(0, win, opts.fitThreshold, windowSourceOf(key, winOv)), ok: null, state: 'unknown', level: 'unknown', needed: 0, reason: '未提供 neededTokens，不评估上下文' }
      : judge(needed, win, opts.fitThreshold, windowSourceOf(key, winOv))
    const g = gateRoute(route, cfg)
    return {
      tier,
      ...(route.provider ? { provider: route.provider } : {}),
      model: route.model,
      reasoningEffort: eff,
      key,
      contextWindow: win,
      windowSource: fit.windowSource,
      fit,
      state: fit.state,
      // 倍率与门槛：面板「模型配置」按这两个字段渲染「为什么这条不可选」
      multiplier: g.multiplier,
      cap: g.cap,
      capSource: g.capSource,
      providerRank: g.providerRank,
      allowed: g.allowed,
      blockedBy: g.blockedBy,
      disabledReason: g.disabledReason || null,
      gateReason: g.reason,
    }
  })
}

/**
 * 候选池：把「免费池里当天的可用项」+「各域的付费链」摊成一张按
 * (provider 优先级 → 倍率升序) 排好的候选表，供面板展示与「我们的免费模型优先」用。
 * 注意它**不做选择**——选择仍然由 selectRoute 按档位链做；
 * 这个函数只回答「全盘看，谁最便宜、谁被门槛挡住了」。
 */
export function candidatePool(opts = {}) {
  const cfg = resolveConfig(opts.config || {})
  const poolOverride = Array.isArray(opts.freePool) ? opts.freePool : null
  const poolKeys = poolOverride
    ? poolOverride.map((x) => (typeof x === 'string' ? x : routeKey(x))).filter(Boolean)
    : FREE_POOL.map(routeKey)
  const rows = []
  const seen = new Set()
  const push = (route, tier, fromPool) => {
    const key = routeKey(route)
    if (!key || seen.has(key)) return
    seen.add(key)
    const g = gateRoute(route, cfg)
    rows.push({
      key,
      provider: route.provider,
      model: route.model,
      tier,
      fromPool,
      stability: stabilityOf(key),
      multiplier: g.multiplier,
      cap: g.cap,
      capSource: g.capSource,
      providerRank: g.providerRank,
      allowed: g.allowed,
      blockedBy: g.blockedBy,
      disabledReason: g.disabledReason || null,
      gateReason: g.reason,
    })
  }
  // ① 免费池今天可用的
  for (const r of FREE_POOL) {
    if (!poolKeys.includes(routeKey(r))) continue
    push({ provider: r.provider, model: r.model, reasoningEffort: r.reasoningEffort }, 'free', true)
  }
  // ② 各域链上的所有档
  for (const domain of Object.keys(ROUTE)) {
    for (const { tier, route } of orderTiers(ROUTE[domain])) push(route, `${domain}.${tier}`, false)
  }
  rows.sort((a, b) => {
    // 先「能用的在前」（被门槛挡住的沉底，但仍要显示，用户才知道为什么没选它）
    if (a.allowed !== b.allowed) return a.allowed ? -1 : 1
    // 稳定项排在补位项前（2026-11-21：our-free-model 是 flakey 补位，不许靠 providerRank=0 顶主力）
    if (a.stability !== b.stability) return a.stability === 'stable' ? -1 : 1
    if (a.providerRank !== b.providerRank) return a.providerRank - b.providerRank
    const am = a.multiplier == null ? Infinity : a.multiplier
    const bm = b.multiplier == null ? Infinity : b.multiplier
    if (am !== bm) return am - bm
    return a.key.localeCompare(b.key)
  })
  return rows
}

/* ══ 倍率（cost multiplier）与 provider 分级上限 ═══════════════════
 *
 * 用户口径（2026-11-21）：**别烧 WorkBuddy 积分、要养号**，不是「一分钱不花」。
 * 所以停用粒度是 **route**，不是 provider ——
 * `workbuddy/hy4flash-free` 是 x0.00 的零成本源，一刀切停 WorkBuddy 会把它一起废掉。
 *
 * 两级上限，provider 级优先于全局：
 * providerMultiplierCap[provider]  —— 该 provider 的硬上限（workbuddy: 0 = 只留 x0.00）
 * maxMultiplier                    —— 全局兜底（默认 0.6，避免误伤其它 provider）
 * 生效规则：provider 有 cap 就用 cap，没有才用 maxMultiplier。
 * 为什么不取两者最小值：deepseek-official 不设 cap 时不该被全局 0.6 之外的规则管，
 * 而 workbuddy 的 cap=0 必须严格生效——分层表达比 min() 更贴用户意图。
 */

/** 倍率表（来自 dsh_team_models 的 name 字段「· x0.08」原文采样，2026-11-21）。
 * 0 = 厂商标注免费；null/缺省 = **未知倍率**（保守排除，见 multiplierOf）。 */
export const MULTIPLIER = {
  // ── workbuddy（养号重点：只留 x0.00）──
  'workbuddy/hy4flash-free': 0,
  'workbuddy/hy4flash': 0.03,
  'workbuddy/glm-5.3-flash': 0.08,
  'workbuddy/minimax-m3.1-flash': 0.08,
  'workbuddy/space-bunny': 0.08,
  'workbuddy/deepseek-v4.1-flash': 0.11,
  'workbuddy/mimo-v2.6-pro': 0.13,
  'workbuddy/hy4std': 0.29,
  'workbuddy/step-5-preview': 0.33,
  'workbuddy/deepseek-v4-pro': 0.51,
  'workbuddy/glm-5.3': 0.69,
  'workbuddy/kimi-k2.8-preview': 0.77,
  'workbuddy/glm-5.2': 0.79,
  'workbuddy/kimi-k3.1-pro': 0.97,
  'workbuddy/kimi-k3-1': 1.62,
  // ── modlens-workbuddy（同源转视觉桥，倍率照抄）──
  'modlens-workbuddy/deepseek-v4-pro': 0.51,
  'modlens-workbuddy/glm-5.3': 0.69,
  'modlens-workbuddy/glm-5.2': 0.79,
  'modlens-workbuddy/mimo-v2.6-pro': 0.13,
  // ── raccoon（转发价系数）──
  'raccoon/sn-sensenova-6-8-flash': 0,
  'raccoon/sn-sensenova-6-8-flash-lite': 0,
  'raccoon/sn-glm-5-3-flash': 0.2,
  'raccoon/sn-deepseek-v4-1-flash-1017': 0.25,
  'raccoon/sn-glm-5-3': 0.75,
  'raccoon/sn-qwen4-max': 0.75,
  'raccoon/sn-kimi-k3-1-pro': 1,
  // ── qoder / qodercn ──
  'qoder/qfmodel': 0,
  'qodercn/qfmodel': 0,
  'qoder/dfmodel': 0.1,
  'qodercn/dfmodel': 0.1,
  'qoder/qmodel': 0.1,
  'qoder/gfmodel': 0.1,
  'qoder/mmodel': 0.2,
  'qoder/efficient': 0.3,
  'qoder/auto': 0.5,
  'qoder/dmodel': 0.5,
  'qoder/qmodel_latest': 0.5,
  'qoder/qmodel_38max': 0.5,
  'qoder/gmodel': 0.8,
  'qodercn/gmodel': 0.8,
  'qoder/kmodel': 0.8,
  'qoder/performance': 1.1,
  'qoder/kmodel_latest': 1.4,
  'qoder/ultimate': 2,
  'qoder/cmodel': 4,
  'qoder/smodel': 8,
  // ── loomy ──
  'loomy/deepseek-v4-flash-1017': 2,
  'loomy/DeepSeek-V4.1-Flash': 2,
  'loomy/spark-x2.6': 2.5,
  // ── 官方直连 / 本地：无倍率系数（按量或免费），记 0 表示「无加价」──
  'deepseek-official/deepseek-v4-pro': 0,
  'deepseek-official/deepseek-flash': 0,
  'deepseek-modlens/deepseek-v4-pro': 0,
  'ollama-local/qwen3-4b-abliterated:latest': 0,
  // ── our-free-model/*：整族免费 ──
  'our-free-model/big-pickle': 0,
  'our-free-model/deepseek-v4.1-flash-free': 0,
  'our-free-model/flint-40b-free': 0,
  'our-free-model/hy4-flash-free': 0,
  'our-free-model/iceman-free': 0,
  'our-free-model/jev-1.13-free': 0,
  'our-free-model/kilo-auto/free': 0,
  'our-free-model/reflection/beam-free': 0,
  'our-free-model/dots-studio/dots-3-note-preview:free': 0,
  'our-free-model/baidu/ernie-5.5-flash-preview:free': 0,
  'our-free-model/recursive/flint-v1.0:free': 0,
  'our-free-model/stealth/glyph-cluster': 0,
  'our-free-model/liquid/lfm-3-1.7b:free': 0,
  'our-free-model/inclusionai/ling-3.2-flash:free': 0,
  'our-free-model/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 0,
  'our-free-model/nvidia/nemotron-3-ultra-550b-a55b:free': 0,
  'our-free-model/nvidia/nemotron-3.5-lightning:free': 0,
  'our-free-model/nvidia/nemotron-3.5-super-vl:free': 0,
  'our-free-model/openrouter/free': 0,
  'our-free-model/particle-ai/particle-1:free': 0,
  'our-free-model/longcat-2.5-free': 0,
  'our-free-model/mimo-v2.6-flash-free': 0,
  'our-free-model/nemotron-3.5-super-vl-free': 0,
  'our-free-model/nemotron-3.5-lightning-free': 0,
  'our-free-model/tidepool-alpha-free': 0,
  'our-free-model/combo:recommended-free': 0,
  // ── EAC 3 条实测可用（整族免费，2026-11-21 派发接入）──
  'our-free-model/moonshotai/kimi-k3.1-pro': 0,
  'our-free-model/opencode/deepseek-v4.1-flash-free': 0,
  'our-free-model/stepfun-ai/step-5-preview': 0,
}

/**
 * 从 dsh_team_models 的 name 里解析倍率（"GLM-5.3-Flash · x0.08" → 0.08）。
 * 返回 null 表示**解析不到**（未知倍率）——调用方必须按「保守排除」处理，
 * 不许当成 0（当 0 会把收费项当免费放进来，正好是最危险的方向）。
 */
export function parseMultiplier(name) {
  const s = String(name == null ? '' : name)
  const m = s.match(/[·•]?\s*x\s*(\d+(?:\.\d+)?)/i)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

/** 查某条 route 的倍率；null = 未知（保守排除） */
export function multiplierOf(route, override) {
  const k = typeof route === 'string' ? route : routeKey(route)
  if (!k) return null
  const ov = override && typeof override === 'object' ? override : null
  if (ov && Object.prototype.hasOwnProperty.call(ov, k)) {
    const v = ov[k]
    return v === null ? null : (typeof v === 'number' && Number.isFinite(v) ? v : null)
  }
  return Object.prototype.hasOwnProperty.call(MULTIPLIER, k) ? MULTIPLIER[k] : null
}

/**
 * 已知免费 provider 名单（2026-11-21 用户口径）：这些 provider 的「free 项」
 * 本质上不计费。当它们的某条 route 倍率查不到时，不再一律按「未知」排除，
 * 而是按 0 处理并标记来源为 inferred（推断）——因为对这几家，「查不到倍率」
 * 更可能是列表没登记，而不是突然开始收费。
 *
 * 名单只含「有免费档」的 provider：our-free-model 整族免费；raccoon / qodercn /
 * workbuddy 都有明确标注 x0.00 的免费项（hy4flash-free / qfmodel / sensenova-flash）。
 * 注意：这是 provider 级粗判，仅用于「倍率未知」的兜底；有明确倍率的项仍走 MULTIPLIER，
 * workbuddy 的付费项（x0.11 等）依旧被 cap=0 挡住——名单不等于「整厂放行」。
 */
export const KNOWN_FREE_PROVIDERS = [
  'our-free-model',
  'raccoon',
  'qodercn',
  'workbuddy',
]

/** provider 是否属于已知免费名单（大小写不敏感） */
export function isKnownFreeProvider(provider) {
  const p = String(provider == null ? '' : provider).trim().toLowerCase()
  return KNOWN_FREE_PROVIDERS.includes(p)
}

/**
 * 供 gateRoute 用的「有效倍率」：MULTIPLIER 有明确值就用它；
 * 查不到但 provider 在已知免费名单里 → 按 0 处理（inferred），否则 null。
 * @returns {{value:number|null, inferred:boolean}}
 */
export function effectiveMultiplier(route) {
  const explicit = multiplierOf(route, null)
  if (explicit != null) return { value: explicit, inferred: false }
  const provider = String((route && route.provider) || '').trim().toLowerCase()
  if (isKnownFreeProvider(provider)) return { value: 0, inferred: true }
  return { value: null, inferred: false }
}

/** provider 优先级：our-free-model 首位（当天可用才生效），未列出的排最后。
 * 这不是「偏爱某厂商」，而是「先花不掉的、再花便宜的」这条账的落地。 */
export const PROVIDER_PRIORITY = [
  'our-free-model',
  'deepseek-official',
  'qodercn',
  'raccoon',
  'workbuddy',
  'modlens-workbuddy',
  'deepseek-modlens',
  'ollama-local',
  'loomy',
  'qoder',
  'zcode',
  'modlens-zcode',
  'cline',
]

/** provider 优先级序号（越小越先）；未知 provider 排在已列之后 */
export function providerRank(provider) {
  const i = PROVIDER_PRIORITY.indexOf(String(provider || '').trim().toLowerCase())
  return i >= 0 ? i : PROVIDER_PRIORITY.length
}

/**
 * 默认配置。**workbuddy cap = 0**：只留 x0.00（hy4flash-free），其余全禁——养号。
 * 其余 provider 不设 cap（吃全局 maxMultiplier=0.6 兜底）。
 * disabledProviders 默认空：给将来手动停用整个 provider 用。
 * disabledRoutes 默认含 2 条已 EOL 的 our-free-model EAC 路由——以前它们靠
 * 「倍率未知被动排除」，现在改成显式拉黑并注明 EOL 日期（2026-11-21 用户要求）：
 * EOL 是事实层面的下线，不该伪装成「倍率查不到」这种成本层的猜测。
 */
export const DEFAULT_CONFIG = {
  maxMultiplier: 0.6,
  providerMultiplierCap: { workbuddy: 0 },
  disabledProviders: [],
  disabledRoutes: [
    'our-free-model/deepseek-ai/deepseek-v4.1-flash', // EOL 2026-11-16（ §逐条明细 #6）
    'our-free-model/openai/gpt-oss-20b',              // EOL 2026-11-18（ §逐条明细 #12）
  ],
  /**
   * provider → 停用原因（人读）。和 disabledProviders 一起落盘，
   * 面板要显示「被禁用：账号级限流，2026-11-21 12:47」而不是一片空白。
   * 默认空对象：不硬编码任何账号风控状态（那是运行期事实，写进兜底默认值会变成过期谎言）。
   */
  disabledReason: {},
  /** 指挥（Lead）推荐模型：主会话自己继承，这里只作为推荐值给面板显示 */
  leadRoute: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
}

/** 配置文件路径（落在插件目录内，符合「一切只进 DSH 数据目录」的约定） */
export const CONFIG_FILE = 'route-config.json'

/** 合并用户配置与默认值：数组取并集？不——取用户的（空就是空），cap 深合并 */
export function resolveConfig(partial) {
  const p = partial && typeof partial === 'object' ? partial : {}
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : null)
  /** 停用原因表：只要「非空字符串 → 非空字符串」的项，别把 null/数字写进配置 */
  const reasonMap = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (typeof k === 'string' && k.trim() && typeof val === 'string' && val.trim()) out[k.trim()] = val.trim()
    }
    return out
  }
  return {
    maxMultiplier: num(p.maxMultiplier, DEFAULT_CONFIG.maxMultiplier),
    providerMultiplierCap: {
      ...DEFAULT_CONFIG.providerMultiplierCap,
      ...(p.providerMultiplierCap && typeof p.providerMultiplierCap === 'object' ? p.providerMultiplierCap : {}),
    },
    disabledProviders: strArr(p.disabledProviders) ?? [...DEFAULT_CONFIG.disabledProviders],
    disabledRoutes: strArr(p.disabledRoutes) ?? [...DEFAULT_CONFIG.disabledRoutes],
    disabledReason: reasonMap(p.disabledReason) ?? { ...DEFAULT_CONFIG.disabledReason },
    leadRoute: (p.leadRoute && typeof p.leadRoute === 'object' && p.leadRoute.model)
      ? { ...p.leadRoute }
      : { ...DEFAULT_CONFIG.leadRoute },
  }
}

/**
 * 某条 route 在当前配置下能不能选，以及被什么挡住。
 *
 * 判定顺序（任何一条命中即 blocked，reason 说清是哪一条）：
 * ① provider 在 disabledProviders 里
 * ② route 在 disabledRoutes 里（EOL 的两条在这里被显式挡住，早于倍率判定）
 * ③ 有效倍率未知 → 保守排除：
 * - MULTIPLIER 有明确值 → 用它；
 * - 查不到但 provider 在 KNOWN_FREE_PROVIDERS 里 → 按 0 处理并标 multiplierInferred=true
 * （2026-11-21 修「未知倍率误杀」：免费 provider 的免费项不该因没登记倍率被排除）；
 * - 查不到且 provider 不在名单里 → 仍按保守排除（不许当 0 放行）。
 * ④ 倍率 > 该 provider 的 cap（有 cap 用 cap，没有用全局 maxMultiplier）
 *
 * @returns {{allowed:boolean, multiplier:number|null, multiplierInferred:boolean,
 * cap:number|null, capSource:'provider'|'global'|null, provider:string,
 * providerRank:number, blockedBy:string|null, reason:string|null}}
 */
export function gateRoute(route, config, opts) {
  const cfg = config && typeof config === 'object' && 'providerMultiplierCap' in config
    ? config
    : resolveConfig(config)
  const genIntent = isGenerationIntent(opts)
  const key = routeKey(route)
  const provider = String((route && route.provider) || '').trim().toLowerCase()
  const eff = effectiveMultiplier(route)
  const mult = eff.value
  const hasCap = Object.prototype.hasOwnProperty.call(cfg.providerMultiplierCap, provider)
  const cap = hasCap ? cfg.providerMultiplierCap[provider] : cfg.maxMultiplier
  const base = {
    multiplier: mult,
    /** true = 倍率是「已知免费 provider」推断出来的 0，不是 MULTIPLIER 里登记的实测值 */
    multiplierInferred: eff.inferred,
    cap,
    capSource: hasCap ? 'provider' : 'global',
    provider,
    providerRank: providerRank(provider),
    blockedBy: null,
    reason: null,
    /** provider 被停用时的原因（人读）；其它 blockedBy 恒为 null，形状稳定 */
    disabledReason: null,
  }
  if (!key) return { ...base, allowed: false, blockedBy: 'bad-route', reason: 'route 缺 provider/model' }
  if (cfg.disabledProviders.map((x) => String(x).toLowerCase()).includes(provider)) {
    // 原因表大小写不敏感地查：配置里写 'Raccoon' 也能带出来，别让面板显示空白
    const reasons = cfg.disabledReason && typeof cfg.disabledReason === 'object' ? cfg.disabledReason : {}
    const whyKey = Object.keys(reasons).find((k) => String(k).toLowerCase() === provider) || null
    const why = whyKey ? String(reasons[whyKey]).trim() || null : null
    return {
      ...base,
      allowed: false,
      blockedBy: 'provider-disabled',
      disabledReason: why,
      reason: `provider「${provider}」已被停用（disabledProviders）${why ? `——${why}` : ''}`,
    }
  }
  if (cfg.disabledRoutes.includes(key)) {
    return { ...base, allowed: false, blockedBy: 'route-disabled', reason: `${key} 已被显式拉黑（disabledRoutes）` }
  }
  // ③④ 成本类门槛：仅「非生成意图」时生效。
  // 视觉/生成意图（vision 域 / allowVision / 显式指定视觉 route）跳过倍率未知与 cap 检查——
  // 倍率上限是「自动选路省钱」的工具，不是封功能的闸门（Lead maxMultiplier 0.13 曾把 x0.69 视觉通道全挡）。
  // 注意：①②硬禁用已在上面判过，生成意图**不能**绕过 disabledProviders/disabledRoutes。
  if (!genIntent && mult == null) {
    return { ...base, allowed: false, blockedBy: 'multiplier-unknown', reason: `${key} 倍率未知，按保守策略排除（不许当 0 放行）` }
  }
  if (!genIntent && cap != null && mult > cap) {
    return {
      ...base,
      allowed: false,
      blockedBy: hasCap ? 'provider-cap' : 'global-cap',
      reason: `${key} 倍率 x${mult} 超过${hasCap ? ` provider「${provider}」上限` : '全局上限'} x${cap}`,
    }
  }
  if (genIntent && (mult == null || (cap != null && mult > cap))) {
    // 放行但如实标注「按生成意图豁免了成本门槛」，面板/审计看得到为什么这条超预算还能用
    return { ...base, allowed: true, exemptedBy: 'generation-intent',
      reason: `生成/视觉意图：跳过成本门槛（倍率${mult == null ? '未知' : 'x' + mult}${cap != null && mult != null && mult > cap ? ` > 上限 x${cap}` : ''}）` }
  }
  return { ...base, allowed: true }
}

/**
 * chat-open 的路由回落（同源的兄弟问题）。
 *
 * 为什么要单独一个函数：修复前 chat.mjs 的 resolveRoute 只有
 * 「显式传 > 宿主 Lead agent 的 options 快照」两档，**从不读 route-config**，
 * 于是面板开聊天框时会静默继承宿主主会话当时挂着的模型——实测（ §G2 复现）
 * 落到 raccoon/sn-deepseek-v4-1-flash-1017，而 raccoon 当时正在 disabledProviders 里
 * （账号级限流）。被禁用的通道不该出现在任何自动回落结果里。
 *
 * 优先级（成本优先 = 免费优先）：
 * ① explicit    —— 调用方显式传 provider/model。合法通道照旧放行；
 * **被禁 / 被 cap 挡住的显式指定一律硬拦**（ 用户拍板，
 * 见下方 ① 分支）：route=null + explicitBlocked + hint（含可用替代）。
 * ② config-chain —— 配置链：leadRoute 打头，然后「档位优先、域其次」遍历
 * 五域四档（free → paid → backup → last），取第一个过 gate 的。
 * 档位放外层循环是为了「免费优先」跨域成立，
 * 不让某个域的 paid 顶掉另一个域能用的 free。
 * ③ host-default —— 宿主 Lead agent 快照：只在 ①② 都给不出可用项时才试，
 * 且**同样过 gate**（禁用/cap 挡住就拒绝，宁可报 no-route，
 * 也不再偷偷用一条被停用的通道）。命中必带 warning。
 *
 * 纯函数：读盘只在 op 层，config 由调用方注入（与 selectRoute 的纪律一致）。
 *
 * @param {object} input
 * @param {{provider?:string, model?:string, reasoningEffort?:string}|null} [input.explicit]
 * @param {{provider?:string, model?:string, reasoningEffort?:string}|null} [input.hostRoute]
 * @param {object} [input.config] route-config 内容（resolveConfig 之后的形状）
 * @param {string[]} [input.domains] 参与回落的域，缺省 ROUTE 全部域
 * @param {Array<{provider:string,model:string,multiplier:number|null,cap:number|null,capSource:string|null,blockedBy:string|null,reason:string|null}>} [input.gatedOut] 出参：被挡掉的候选
 * @returns {{source:'explicit'|'config-chain'|'host-default'|null, route:object|null,
 * warning:string|null, blocked:object|null, tried:string[],
 * explicitBlocked?:boolean, hint?:string,
 * alternatives?:Array<{key:string,from:string,multiplier:number|null}>}}
 */
export const ROUTE_SOURCE = {
  EXPLICIT: 'explicit',
  CONFIG_CHAIN: 'config-chain',
  HOST_DEFAULT: 'host-default',
}

export function resolveChatRoute(input = {}) {
  const cfg = resolveConfig(input.config || {})
  const tried = []
  const gated = input.gatedOut || []
  const gateOf = (route, tag) => {
    // 生成意图：显式指定的视觉/生成 route，或请求带 vision 域/allowVision —— 跳过成本门槛。
    // 只在 explicit（或视觉域全局）时给豁免；config-chain 里的视觉项仍走省钱口径。
    const genOpts = (tag === 'explicit' && isVisionRoute(route))
      || normalizeDomain(input.domain) === 'vision' || String(input.domain || '').trim().toLowerCase() === 'vision'
      || input.allowVision === true
      ? { domain: input.domain, allowVision: input.allowVision, explicit: route }
      : undefined
    const g = gateRoute(route, cfg, genOpts)
    if (!g.allowed) {
      const row = {
        provider: g.provider,
        model: route && route.model ? route.model : null,
        tag,
        multiplier: g.multiplier,
        cap: g.cap,
        capSource: g.capSource,
        blockedBy: g.blockedBy,
        disabledReason: g.disabledReason || null,
        reason: g.reason,
      }
      gated.push(row)
      tried.push(`${routeKey(route)}（${tag}，被 ${g.blockedBy} 挡住）`)
    }
    return g
  }
  const norm = (r, extra) => (r ? {
    provider: r.provider,
    model: r.model,
    reasoningEffort: r.reasoningEffort ?? extra?.reasoningEffort ?? undefined,
  } : null)
  /** 已判定过的 route key（防链遍历与 alternativesFor 重复评估同一档） */
  const seen = new Set()
  /** 档位优先遍历配置链，收集过 gate 的候选（limit 控制条数；不中途中断 seen 语义） */
  const collectChain = (limit) => {
    const domains = Array.isArray(input.domains) && input.domains.length
      ? input.domains.filter((d) => ROUTE[normalizeDomain(d) || d])
      : Object.keys(ROUTE)
    const byTier = new Map()
    for (const d of domains) {
      for (const row of routeChain(d, { config: cfg })) {
        if (!row.provider || !row.model) continue
        if (!byTier.has(row.tier)) byTier.set(row.tier, [])
        byTier.get(row.tier).push(row)
      }
    }
    const tierOrder = [...TIER_ORDER.filter((t) => byTier.has(t)), ...[...byTier.keys()].filter((t) => !TIER_ORDER.includes(t))]
    const picked = []
    for (const tier of tierOrder) {
      const rows = byTier.get(tier)
      if (!rows) continue
      for (const row of rows) {
        const key = row.key
        if (!key || seen.has(key)) continue
        seen.add(key)
        if (!row.allowed) {
          gated.push({
            provider: row.provider, model: row.model, tag: `chain:${row.tier}`,
            multiplier: row.multiplier, cap: row.cap, capSource: row.capSource,
            blockedBy: row.blockedBy, disabledReason: row.disabledReason || null, reason: row.gateReason,
          })
          tried.push(`${key}（chain:${row.tier}，被 ${row.blockedBy} 挡住）`)
          continue
        }
        picked.push(row)
        if (limit && picked.length >= limit) return picked
      }
    }
    return picked
  }
  /** 拦下显式通道时，hint 要点名「可用替代」，不能只说「不行」 */
  const alternativesFor = (excludeKey) => {
    const out = []
    const lead = cfg.leadRoute
    if (lead && lead.provider && lead.model && routeKey(lead) !== excludeKey
      && gateRoute(lead, cfg).allowed) {
      out.push({ key: routeKey(lead), from: 'leadRoute', multiplier: multiplierOf(lead, null) })
    }
    for (const row of collectChain(4)) {
      if (out.length >= 3) break
      if (row.key === excludeKey || out.some((x) => x.key === row.key)) continue
      out.push({ key: row.key, from: `chain:${row.tier}`, multiplier: row.multiplier, reasoningEffort: row.reasoningEffort })
    }
    return out
  }
  const BLOCK_LABEL = {
    'provider-disabled': 'route-config 的 disabledProviders 停用清单',
    'route-disabled': 'route-config 的 disabledRoutes 精确拉黑',
    'provider-cap': '该 provider 的 providerMultiplierCap',
    'global-cap': '全局 maxMultiplier',
    'multiplier-unknown': '倍率未知（保守排除，不许当 0 放行）',
    'bad-route': 'provider/model 不完整',
  }

  // ① 显式传（用户拍板：**改成硬拦**）。
  // 语义变更：上一版按「用户主权」采纳 + warning，实测连 disabledProviders
  // （deepseek-official＝用户进安全模式的兜底通道，已 Insufficient Balance）
  // 和 providerMultiplierCap 都能被显式指定绕过并真的建了会话（ §G2）。
  // 现在：**被禁 / 被 cap 挡住的显式指定一律拒绝建会话**，返回 blocked + 具体 hint
  // （点明被哪一项挡住 + 可用替代）。合法通道的显式指定**照旧放行**，不误伤。
  const ex = input.explicit
  if (ex && ex.provider && ex.model) {
    const g = gateOf(ex, 'explicit')
    if (g.allowed) {
      return {
        source: ROUTE_SOURCE.EXPLICIT,
        route: norm(ex),
        blocked: null,
        warning: null,
        tried,
      }
    }
    const alt = alternativesFor(routeKey(ex))
    return {
      source: ROUTE_SOURCE.EXPLICIT,
      route: null,
      explicitBlocked: true,
      blocked: {
        key: routeKey(ex),
        blockedBy: g.blockedBy,
        blockedLabel: BLOCK_LABEL[g.blockedBy] || g.blockedBy,
        reason: g.reason,
        disabledReason: g.disabledReason || null,
        multiplier: g.multiplier,
        cap: g.cap,
        capSource: g.capSource,
      },
      alternatives: alt,
      hint: `显式指定的 ${routeKey(ex)} 被${BLOCK_LABEL[g.blockedBy] || g.blockedBy}挡住（${g.blockedBy}）——`
        + `${g.reason}。`
        + (alt.length
          ? `可用替代：${alt.map((a) => `${a.key}（x${a.multiplier}，来自 ${a.from}）`).join('、')}；`
            + '或到面板「模型配置」把这条通道解禁/调高 cap 后重试。'
          : '当前配置链上没有任何可用替代通道——先到面板「模型配置」放开一条 leadRoute / 候选，或调高 cap。'),
      tried,
    }
  }

  // ② 配置链：leadRoute 打头
  const lead = cfg.leadRoute
  if (lead && lead.provider && lead.model) {
    const g = gateOf(lead, 'leadRoute')
    if (g.allowed) {
      seen.add(routeKey(lead))
      return {
        source: ROUTE_SOURCE.CONFIG_CHAIN,
        route: norm(lead, { reasoningEffort: lead.reasoningEffort }),
        warning: `未显式传 provider/model，已按配置链回落（leadRoute）到 ${routeKey(lead)}；要固定模型请显式传。`,
        blocked: null,
        from: 'leadRoute',
        tried,
      }
    }
  }

  // ②' 配置链：档位优先、域其次，取第一个过 gate 的
  {
    const first = collectChain(1)[0]
    if (first) {
      return {
        source: ROUTE_SOURCE.CONFIG_CHAIN,
        route: { provider: first.provider, model: first.model, reasoningEffort: first.reasoningEffort },
        warning: `未显式传 provider/model，已按配置链回落（${first.tier} 档 · ${first.provider}/${first.model}，倍率 x${first.multiplier}）；要固定模型请显式传。`,
        blocked: null,
        from: `chain:${first.tier}`,
        tried,
      }
    }
  }

  // ③ 宿主默认：最后才试，且必须过 gate
  const host = input.hostRoute
  if (host && host.provider && host.model) {
    const g = gateOf(host, 'host-default')
    if (g.allowed) {
      return {
        source: ROUTE_SOURCE.HOST_DEFAULT,
        route: norm(host),
        warning: `配置链没有可用候选，回落到宿主 Lead 快照 ${routeKey(host)}（倍率 x${g.multiplier}）——这条来自宿主当时挂着的模型，不是面板配置，建议显式配置或显式传。`,
        blocked: null,
        tried,
      }
    }
    return {
      source: null,
      route: null,
      warning: null,
      blocked: { blockedBy: g.blockedBy, reason: g.reason, disabledReason: g.disabledReason || null, key: routeKey(host) },
      tried,
    }
  }

  return { source: null, route: null, warning: null, blocked: null, tried }
}

/**
 * 读配置文件（不存在 / 坏 JSON → 返回默认值并标注来源，不抛）。
 * 注意：selectRoute **不调这个函数**——纯函数靠 opts.config 注入，
 * 读盘只发生在 op 层，避免单测碰到文件系统。
 */
export async function loadRouteConfig(dir) {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const file = dir ? join(dir, CONFIG_FILE) : CONFIG_FILE
  try {
    const raw = await readFile(file, 'utf8')
    // 顺手挡掉 BOM：带 BOM 的 JSON 会 JSON.parse 失败（本项目已踩过一次）
    const txt = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(txt)
    return { ok: true, file, config: resolveConfig(parsed), source: 'file', raw: parsed }
  } catch (err) {
    const code = err && err.code
    return {
      ok: true,
      file,
      config: resolveConfig({}),
      source: code === 'ENOENT' ? 'default' : 'default-after-error',
      error: code === 'ENOENT' ? null : String(err && err.message ? err.message : err),
    }
  }
}

/** 写配置文件。UTF-8 **无 BOM**、两空格缩进，写完回读校验可解析。 */
export async function saveRouteConfig(config, dir) {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const file = dir ? join(dir, CONFIG_FILE) : CONFIG_FILE
  const cfg = resolveConfig(config)
  const text = JSON.stringify(cfg, null, 2) + '\n'
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
  } catch (err) {
    return { ok: false, file, error: String(err && err.message ? err.message : err) }
  }
  // 回读校验：写成功不等于写对了（编码/BOM 都可能坏掉）
  const back = await loadRouteConfig(dir)
  const same = JSON.stringify(back.config) === JSON.stringify(cfg)
  return {
    ok: same,
    file,
    config: back.config,
    bytes: Buffer.byteLength(text, 'utf8'),
    verified: same,
    error: same ? null : '写入后回读不一致',
  }
}


/* ── 能力基线 → 成员 role 文本（/§3.2） ─────────────
 * S2_5 建成员记录时写进 role。格式固定两段（能力域|任务域|擅长|模型），
 * 便于机器读（domainOwned 靠名字与 role 里的域名匹配）也便于人读。
 */
export function capabilityRole(memberDomain, role, route) {
  const domain = String(memberDomain || '').trim().toLowerCase()
  const mapped = MEMBER_DOMAIN_TO_TASK_DOMAIN[domain] || domain
  // 落进 role 的必须是**实际用到的任务域**（归一化后），不是原词——
  // 否则「mystery」这类未知成员域会写进 role，机器读回来对不上任何链。
  const norm = normalizeDomain(mapped) || DEFAULT_DOMAIN
  const skills = DOMAIN_SKILLS[norm] || []
  const mods = ROUTE_MODALITIES[routeKey(route)] || ['text']
  const base = String(role || '').trim() || norm
  // 第二段显式带域名（architect/maker/auditor 要能被 domainOwned 认出）
  return `${base}|${domain}|${norm}|擅长：${skills.join('/')}|模态：${mods.join('+')}|模型：${routeKey(route)}`
}

/** 解析 capabilityRole 产出的 role 文本（面板/单测共用，反向可读） */
export function parseCapabilityRole(text) {
  const raw = String(text == null ? '' : text)
  const parts = raw.split('|').map((s) => s.trim())
  const grab = (prefix) => {
    const hit = parts.find((p) => p.startsWith(prefix))
    return hit ? hit.slice(prefix.length).trim() : null
  }
  return {
    role: parts[0] || null,
    memberDomain: parts[1] || null,
    taskDomain: parts[2] || null,
    skills: (grab('擅长：') || '').split('/').filter(Boolean),
    modalities: (grab('模态：') || '').split('+').filter(Boolean),
    model: grab('模型：'),
  }
}

/** 当前免费池的 key 列表（给巡检脚本 / 面板展示） */
export function freePoolKeys() {
  return FREE_POOL.map(routeKey)
}

/**
 * 稳定性档位（2026-11-21 Lead 三组实测定稿）：
 * 'stable' —— 容量足、多次可复现，可做默认主力；
 * 'flakey' —— 容量小、会排队、会超时，只做补位（显式点名或稳定项全挡才用）。
 * 缺省（FREE_POOL 里没写 stability 的旧项）按 'stable' 处理——不凭空把老路由降成补位。
 */
export function stabilityOf(routeOrKey) {
  const k = typeof routeOrKey === 'string' ? routeOrKey : routeKey(routeOrKey)
  const row = FREE_POOL.find((r) => routeKey(r) === k)
  return row && row.stability === 'flakey' ? 'flakey' : 'stable'
}

/** 是否补位（波动可用）通道 */
export function isFlakey(routeOrKey) {
  return stabilityOf(routeOrKey) === 'flakey'
}

/** 目录：所有域名 + 每条链的摊平结果（给单测和面板）。
 * opts 透传给 routeChain（neededTokens/contextWindows/fitThreshold），
 * 让面板一次拿到「每条链每一档在当前上下文下装不装得下」。 */
export function routeCatalog(opts = {}) {
  return Object.keys(ROUTE).map((domain) => ({ domain, chain: routeChain(domain, opts) }))
}
