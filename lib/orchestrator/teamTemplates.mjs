/**
 * 团队模板（按场景类型定义该用什么编制的团队）
 *
 * 为什么需要：
 *   此前场景绑哪个团队就永远用哪个，不会按场景类型挑合适编制。
 *   软件开发场景应该派「pm/ui/前端/后端/qa/devops」6 人，
 *   文档场景派「研究/撰写/审校」3 人——编制不同，工具和提示词也该不同。
 *
 * 设计原则：
 *   1. 模板只描述「需要哪些角色」，不描述「团队叫什么」
 *   2. domain 与 teamHealth.CORE_DOMAINS 同一个词汇表，可复用 domainOwned 判定
 *   3. 匹配失败时回落 general（保底能干活）
 */

/** 角色定义：name 用英文（与 CORE_DOMAINS / domainOwned 匹配），title 给人看 */
export const TEAM_TEMPLATES = {
  // ── 软件开发：6 人完整研发链 ──
  software: {
    label: '软件开发',
    describe: '需求 → 设计 → 前端/后端 → 测试 → 运维',
    roles: [
      {
        name: 'pm',
        title: '产品经理',
        duty: '收集需求 / 输出原型 / 规划功能 / 协调各方 / 把控范围与排期',
        reasoningEffort: 'high',
      },
      {
        name: 'ui-designer',
        title: 'UI 设计',
        duty: '界面 / 图标 / 配色 / 视觉稿，保证页面美观统一',
        reasoningEffort: 'high',
      },
      {
        name: 'frontend',
        title: '前端开发',
        duty: '页面与交互 / 多端适配 / 对接接口 / 兼容性',
        reasoningEffort: 'high',
      },
      {
        name: 'maker',
        title: '后端开发',
        duty: '业务逻辑 / 接口 / 数据库 / 后台稳定',
        reasoningEffort: 'high',
      },
      {
        name: 'qa',
        title: '测试',
        duty: '测试用例 / 功能验证 / bug 回归 / 保障交付质量',
        reasoningEffort: 'max',
      },
      {
        name: 'devops',
        title: '运维 DevOps',
        duty: '部署环境 / 上线发布 / 服务维护 / 监控 / 故障处理',
        reasoningEffort: 'high',
      },
    ],
  },

  // ── 文档：研究 → 撰写 → 审校 ──
  docs: {
    label: '文档撰写',
    describe: '研究取证 → 撰写成稿 → 审校定稿',
    roles: [
      {
        name: 'researcher',
        title: '研究员',
        duty: '收集资料 / 核实来源 / 提炼要点 / 标注不确定项',
        reasoningEffort: 'high',
      },
      {
        name: 'writer',
        title: '撰稿人',
        duty: '组织结构 / 撰写正文 / 控制语气一致 / 按格式交付',
        reasoningEffort: 'high',
      },
      {
        name: 'reviewer',
        title: '审校',
        duty: '事实核对 / 语病修正 / 格式统一 / 给出修改清单',
        reasoningEffort: 'max',
      },
    ],
  },

  // ── 电商：选品 → 上架 → 运营 ──
  ecom: {
    label: '电商运营',
    describe: '选品调研 → 内容上架 → 数据运营',
    roles: [
      {
        name: 'researcher',
        title: '选品调研',
        duty: '竞品分析 / 价格带 / 目标人群 / 卖点提炼',
        reasoningEffort: 'high',
      },
      {
        name: 'writer',
        title: '内容上架',
        duty: '标题 / 详情页 / 主图文案 / 关键词覆盖',
        reasoningEffort: 'high',
      },
      {
        name: 'operator',
        title: '数据运营',
        duty: '转化率 / 流量来源 / 活动排期 / 复盘',
        reasoningEffort: 'high',
      },
    ],
  },

  // ── 研究：分析 → 收集 → 复核 ──
  research: {
    label: '研究分析',
    describe: '问题拆解 → 证据收集 → 独立复核',
    roles: [
      {
        name: 'analyst',
        title: '分析师',
        duty: '拆解问题 / 提出假设 / 设计方案 / 归纳结论',
        reasoningEffort: 'high',
      },
      {
        name: 'collector',
        title: '资料收集',
        duty: '检索 / 抓取 / 整理原始材料 / 保留出处',
        reasoningEffort: 'high',
      },
      {
        name: 'auditor',
        title: '复核',
        duty: '交叉验证 / 找反例 / 标出证据薄弱处',
        reasoningEffort: 'max',
      },
    ],
  },

  // ── 通用：三人最小可用编制（保底） ──
  general: {
    label: '通用',
    describe: '造规则 → 干活 → 验活（最小可用）',
    roles: [
      {
        name: 'architect',
        title: '规划',
        duty: '定目标 / 拆步骤 / 定验收标准',
        reasoningEffort: 'high',
      },
      {
        name: 'maker',
        title: '执行',
        duty: '按计划做 / 产出可验收的东西',
        reasoningEffort: 'high',
      },
      {
        name: 'auditor',
        title: '验收',
        duty: '对照验收标准逐条核对 / 指出没做到的地方',
        reasoningEffort: 'max',
      },
    ],
  },
}

/**
 * 角色别名：同一个岗位在不同团队里可能写成不同名字。
 *
 * 为什么要这个：
 *   老团队里有人叫 `ui`、有人叫 `ui-designer`；有人叫 `frontend-dev`、
 *   有人叫 `frontend`。如果你按模板精确匹配，会把「已经配齐」误判成「缺角色」，
 *   然后再建一个同名不同姓的人，团队里出现两个 UI。
 *
 * 口径：别名只用于**判断这个岗位有没有人承接**，不用于建成员（建成员一律用模板的 name）。
 */
export const ROLE_ALIASES = {
  pm: ['pm', 'product', 'productmanager', '产品经理', '产品'],
  'ui-designer': ['ui-designer', 'uidesigner', 'ui', 'designer', '视觉', '设计'],
  frontend: ['frontend', 'frontend-dev', 'front-end', 'fe', '前端'],
  maker: ['maker', 'backend', 'back-end', 'be', 'dev', '后端', '开发'],
  qa: ['qa', 'test', 'tester', 'quality', '测试'],
  devops: ['devops', 'ops', 'sre', '运维', '部署'],
  researcher: ['researcher', 'research', 'ux-researcher', '调研', '研究'],
  writer: ['writer', 'author', 'copywriter', '撰稿', '文案'],
  reviewer: ['reviewer', 'review', 'editor', '审校', '校对'],
  analyst: ['analyst', 'data-analyst', 'analyzer', '分析'],
  collector: ['collector', 'collect', 'gatherer', '收集'],
  auditor: ['auditor', 'audit', 'verifier', '验收', '复核'],
  architect: ['architect', 'research-architect', 'planner', '规划', '架构'],
  operator: ['operator', 'operation', 'ops', '运营'],
}

/** 某岗位的别名列表（至少含 name 本身） */
export function aliasesOf(roleName) {
  const k = String(roleName || '').toLowerCase()
  return ROLE_ALIASES[k] || [k]
}

/**
 * 团队里有没有人承接这个岗位。
 *
 * 匹配顺序（从严到宽）：
 *   1. 成员 name 精确等于某个别名
 *   2. 成员 name 含某个别名（别名长度 ≥3，防 `ui` 误配 `build`）
 *   3. 成员 role 文本含某个别名 —— **仅在 name 完全对不上任何岗位时**才用
 *
 * 第 3 条的例外很重要：历史数据里有成员 role 被写成了别的岗位描述
 * （architect 的 role 写的是「产品经理（PM）：收集需求…」），
 * 如果无条件用 role 兜底，architect 就会被当成产品经理，
 * 明明缺 pm 却判「齐全」，永远补不上人。
 *
 * @param {Array} members 成员列表
 * @param {string} roleName 模板里的角色 name
 */
export function hasRole(members, roleName) {
  const list = (members || []).filter((m) => m && m.status !== 'retired')
  const als = aliasesOf(roleName)
  // 1. name 精确
  for (const m of list) {
    const n = String(m.name || '').toLowerCase()
    if (als.includes(n)) return true
  }
  // 2. name 包含（别名 ≥3 字）
  for (const m of list) {
    const n = String(m.name || '').toLowerCase()
    if (als.some((a) => a.length >= 3 && n.includes(a))) return true
  }
  // 3. role 文本兜底：仅当这个成员的 name 对不上任何已知岗位时才用
  //    （否则 role 写错岗位的历史数据会造成假阳性）
  for (const m of list) {
    const n = String(m.name || '').toLowerCase()
    const nameOwnsSomeRole = Object.values(ROLE_ALIASES)
      .some((group) => group.some((a) => n === a || (a.length >= 3 && n.includes(a))))
    if (nameOwnsSomeRole) continue // name 已经明确是别的岗位，别拿 role 文本猜
    const r = String(m.role || '').toLowerCase()
    if (als.some((a) => a.length >= 3 && r.includes(a))) return true
  }
  return false
}

/**
 * 按场景类型取团队模板。
 * @param {string} kind 场景类型
 * @returns {{kind:string, label:string, describe:string, roles:Array, fellBack:boolean}}
 */
export function templateFor(kind) {
  const k = String(kind || '').trim().toLowerCase()
  if (TEAM_TEMPLATES[k]) {
    return { kind: k, ...TEAM_TEMPLATES[k], fellBack: false }
  }
  return { kind: 'general', ...TEAM_TEMPLATES.general, fellBack: true }
}

/**
 * 团队是否已符合模板编制（缺哪些角色）。
 * @param {Array} members sidecar 成员列表
 * @param {string} kind 场景类型
 * @returns {{ok:boolean, kind:string|null, missing:Array<{name,title,duty}>, present:string[]}}
 */
export function checkTeamAgainstTemplate(members, kind) {
  const tpl = templateFor(kind)
  const list = (members || []).filter((m) => m && m.status !== 'retired')
  // 用别名匹配（hasRole），不按模板 name 精确匹配——
  // 老团队里 ui / ui-designer、data-analyst / analyst 是同一个人，
  // 精确匹配会把「已配齐」误判成「缺角色」，再建一个重复的人。
  const missing = tpl.roles.filter((r) => !hasRole(list, r.name))
  const present = tpl.roles.filter((r) => hasRole(list, r.name)).map((r) => r.name)
  return { ok: missing.length === 0, kind: tpl.fellBack ? null : tpl.kind, missing, present }
}

/**
 * 生成建成员用的角色描述（拼进 prompt / role 字段）。
 * @param {object} role 模板里的角色
 * @param {string} teamName 团队名（让 prompt 有归属感）
 */
export function rolePrompt(role, teamName) {
  return `你是「${teamName || '团队'}」的${role.title}（${role.name}）。\n`
    + `职责：${role.duty}\n`
    + '工作方式：收到任务先看验收标准，按步骤做完再回报；不确定的事先问，不猜。'
}

/**
 * 成员 name → 中文显示名。
 *
 * 为什么要这层：成员在 sidecar 里的 name 是英文（maker / research-architect），
 * 那是内部标识，改了会断历史任务归属。但界面上摆一串英文，
 * 用户看不出「research-architect」和「method-upgrader」有什么区别。
 *
 * 所以：显示用中文，内部仍用英文。UI 调 displayName(name) 拿中文。
 */
export const MEMBER_LABELS = {
  // 开发组
  pm: '产品经理',
  'ui-designer': 'UI 设计',
  ui: 'UI 设计',
  designer: 'UI 设计',
  frontend: '前端开发',
  'frontend-dev': '前端开发',
  'front-end': '前端开发',
  maker: '后端开发',
  backend: '后端开发',
  qa: '测试',
  test: '测试',
  tester: '测试',
  devops: '运维',
  ops: '运维',
  sre: '运维',

  // 规划 / 验收
  architect: '架构规划',
  'research-architect': '研究架构',
  planner: '规划',
  auditor: '验收',
  reviewer: '审校',
  review: '审校',

  // 文档 / 研究
  researcher: '研究员',
  'ux-researcher': '体验研究',
  writer: '撰稿',
  author: '撰稿',
  copywriter: '文案',
  analyst: '分析师',
  'data-analyst': '数据分析',
  collector: '资料收集',
  operator: '运营',
  'method-upgrader': '方法迭代',
  'code-iter': '代码迭代',

  // 通用兜底词
  member: '成员',
  probe: '探测',
}

/**
 * 取成员的中文显示名。查不到就原样返回（不猜、不编）。
 * @param {string} name 成员 name
 * @returns {string} 中文名，或原名
 */
export function displayName(name) {
  const n = String(name == null ? '' : name).trim().toLowerCase()
  if (!n) return ''
  if (MEMBER_LABELS[n]) return MEMBER_LABELS[n]
  // 探针类成员（__probe__ / __cap_probe__）不显示原始下划线名
  if (/^_+\w+_+$/.test(n)) return '探针'
  return String(name)
}

/**
 * 清理团队名：去掉版本号、括号备注、英文标识。
 *
 * 实测要处理的名字：
 *   「AI 团队管理升级版会话（7 条方法论落地）」→ 「AI 团队管理」
 *   「ai-team-console 迭代组（第2轮）」→ 「控制台迭代组」
 *   「team-iter-v2」→ 「迭代组」
 *
 * 规则（机械可判，不猜业务含义）：
 *   1. 去括号内容（（）/()）
 *   2. 去「升级版 / 最终版 / 加强版 / 正式版 / v2 / 第N轮 / 第N版」
 *   3. 纯英文/连字符名 → 按关键词映射到中文
 *   4. 剩下空就用 kind 的中文名
 */
const TEAM_NAME_RULES = [
  [/[（(][^）)]*[）)]/g, ''],                        // 括号内容
  [/\s*(升级版|最终版|加强版|正式版|完整版)\s*/g, ''],   // 版本词
  [/\s*v\d+(\.\d+)*\s*/gi, ''],                    // v2 / v2.1
  [/\s*第\s*\d+\s*(轮|版|期)\s*/g, ''],            // 第2轮
  [/\s*[-_]\s*v\d+\s*$/i, ''],                      // -v2 结尾
]

/** 中英混合时，把英文标识词替换掉（这些是产品/仓库名，不是岗位） */
const MIXED_EN_MAP = [
  [/ai[-_ ]?team[-_ ]?console/gi, '控制台'],
  [/ai[-_ ]?team/gi, 'AI 团队'],
  [/team[-_ ]?iter[-_ ]?v?\d*/gi, '迭代组'],
]

/** 纯英文团队名 → 中文（按关键词，按顺序匹配） */
const EN_TEAM_MAP = [
  [/iter|iterate/i, '迭代组'],
  [/ai[-_ ]?team|agent[-_ ]?team/i, 'AI 团队'],
  [/console|panel|ui/i, '控制台组'],
  [/research|study/i, '研究组'],
  [/dev|develop/i, '开发组'],
  [/test|qa/i, '测试组'],
  [/ops|devops/i, '运维组'],
]

/**
 * 清理团队名。
 * @param {string} raw 原始名
 * @param {string} [kind] 场景类型（兜底用）
 * @returns {string} 清理后的名字
 */
export function cleanTeamName(raw, kind) {
  let n = String(raw == null ? '' : raw).trim()
  if (!n) return kindLabelOf(kind) + '组'

  // ── 顺序很重要 ──
  // 1. 先看原串是不是「纯英文标识」（team-iter-v2 / ai-team-tpl-test-software）
  //    这类要先按关键词判定它是什么组，再清版本号。
  //    否则 v2 被清掉后变成 team-iter，反而匹配不上 iter。
  const isPureEn = /^[a-z][a-z0-9\-_\s]*$/i.test(n) && !/[\u4e00-\u9fff]/.test(n)
  if (isPureEn) {
    for (const [re, rep] of EN_TEAM_MAP) {
      if (re.test(n)) return rep
    }
  }

  // 2. 去括号内容
  n = n.replace(/[（(][^）)]*[）)]/g, '')
  // 3. 去版本词
  n = n.replace(/\s*(升级版|最终版|加强版|正式版|完整版)\s*/g, '')
  n = n.replace(/\s*v\d+(\.\d+)*\s*/gi, '')
  n = n.replace(/\s*第\s*\d+\s*(轮|版|期)\s*/g, '')
  n = n.replace(/\s*[-_]\s*v\d+\s*$/i, '')
  // 4. 去冗余后缀「会话」（它不是团队属性）
  n = n.replace(/\s*会话\s*$/g, '')
  n = n.trim()

  // 5. 中英混合：用占位符保护替换结果，避免后续规则二次匹配。
  // 直接替换成中文的话，「ai-team-console」→「控制台」之后，
  // 下一条 /ai[-_ ]?team/ 会把替换结果里的字符当匹配目标，导致「控制台」被吃成「控制」。
  const HOLD = []
  for (const [re, rep] of MIXED_EN_MAP) {
    n = n.replace(re, function () {
      HOLD.push(rep)
      return '\u0001' + (HOLD.length - 1) + '\u0001'
    })
  }
  // 6. 剩下的英文标识（含连字符/下划线的长词）→ 去掉。
  // 注意不能用 \b：中英文交界处 \b 也成立，会把中文当边界，
  // 导致「控制台 迭代组」里的「台」被吞掉。改用「前后不是字母数字」的显式断言。
  n = n.replace(/(^|[^A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+($|[^A-Za-z0-9])/g,
    function (_, pre, post) { return pre + post })
  // 6b. 还原占位符
  n = n.replace(/\u0001(\d+)\u0001/g, function (_, idx) { return HOLD[Number(idx)] || '' })

  // 7. 收尾：去首尾分隔符、压空格、中英之间补一个空格
  n = n.replace(/^[\s\-_]+/, '').replace(/[\s\-_]+$/, '')
  n = n.replace(/\s{2,}/g, ' ')
  // 中文之间不留空格（「控制台 迭代组」→「控制台迭代组」），
  // 但「AI 团队」这类中英/brand 与中文之间保留一个空格。
  n = n.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, function (_, c) { return c })
  n = n.trim()

  // 8. 仍然没有中文（说明英文标识被删光了）→ 按 kind 兜底
  if (!/[\u4e00-\u9fff]/.test(n)) {
    for (const [re, rep] of EN_TEAM_MAP) {
      if (re.test(String(raw))) return rep
    }
    return (kindLabelOf(kind) || '通用') + '组'
  }

  return n.trim()
}

/** kind → 中文标签（内部用，避免循环依赖） */
function kindLabelOf(kind) {
  const m = { software: '开发', docs: '文档', research: '研究', ecom: '电商', general: '通用' }
  return m[String(kind || '').toLowerCase()] || '通用'
}
