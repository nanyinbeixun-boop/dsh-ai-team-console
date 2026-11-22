/**
 * 任务类型识别与团队匹配
 *
 * 为什么需要：
 *   选中「团队模式」preset 后，用户直接输入任务，但系统不知道用哪个团队。
 *   此前只能手动 dsh_team_create 或指定 teamId，等于每次都要人工判断。
 *
 * 设计：
 *   1. 先按关键词判断任务类型（快、可解释、零 token）
 *   2. 再用 workspace 探测兜底（看目录里是代码还是文档）
 *   3. 最后在现有团队里找编制最匹配的；没有就推荐按模板新建
 *
 * 不做的事：
 *   - 不调模型判断任务类型（贵且不可复现）
 *   - 不替用户做最终决定（返回推荐 + 依据，由调用方决定）
 */

import * as Tpl from './teamTemplates.mjs'

/**
 * 任务类型关键词表。
 * 每条给「强信号」和「弱信号」——强信号命中一次即可，弱信号需要多个才作数。
 */
const TASK_SIGNALS = {
  software: {
    label: '软件开发',
    strong: /重构|接口|数据库|单元测试|前端|后端|部署|线上|bug|代码|函数|类名|依赖|编译|构建|报错|调试|性能优化|内存|并发|事务/i,
    weak: /功能|页面|模块|系统|逻辑|实现|开发|程序|脚本|服务|组件|样式|布局/i,
    need: 2,
  },
  docs: {
    label: '文档撰写',
    strong: /文档|手册|说明书|README|撰写|写作|稿件|排版|校对|引用|参考资料|章节|目录结构/i,
    weak: /说明|介绍|描述|整理|汇总|总结|格式|模板/i,
    need: 2,
  },
  research: {
    label: '研究分析',
    strong: /调研|研究|分析报告|对比分析|评估|取证|证据|数据来源|文献|样本|假设|结论|验证假设/i,
    weak: /调查|了解|看看|比较|判断|趋势|现状|问题在哪/i,
    need: 2,
  },
  ecom: {
    label: '电商运营',
    strong: /商品|订单|店铺|上架|详情页|主图|转化率|客单价|复购|库存|SKU|选品|促销|流量/i,
    weak: /卖|买|价格|客户|销售|运营|推广/i,
    need: 2,
  },
}

/** 从文本里数命中次数（用 match 的全局计数） */
function countHits(re, text) {
  const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))
  return m ? m.length : 0
}

/**
 * 按任务描述判断类型。
 * @param {string} text 任务描述（用户输入的一段话）
 * @param {object} [hint] 可选线索：{ workspaceKind } —— 来自目录探测
 * @returns {{kind:string, label:string, confidence:number, reason:string, scores:object}}
 */
export function classifyTask(text, hint = {}) {
  const s = String(text || '')
  const scores = {}
  const reasons = []

  for (const [kind, sig] of Object.entries(TASK_SIGNALS)) {
    const strong = countHits(sig.strong, s)
    const weak = countHits(sig.weak, s)
    // 强信号权重 3，弱信号权重 1
    scores[kind] = strong * 3 + weak
    if (strong) reasons.push(`${sig.label}：命中 ${strong} 个强特征词`)
    else if (weak >= sig.need) reasons.push(`${sig.label}：命中 ${weak} 个特征词`)
  }

  // 按总分排序
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [topKind, topScore] = ranked[0] || ['general', 0]
  const secondScore = ranked[1] ? ranked[1][1] : 0

  // workspace 提示优先于文本（目录里有什么比用户怎么说更准）
  if (hint.workspaceKind && TASK_SIGNALS[hint.workspaceKind]) {
    const wk = hint.workspaceKind
    return {
      kind: wk,
      label: TASK_SIGNALS[wk].label,
      confidence: 0.9,
      reason: `按工作目录类型判定（${wk}）`,
      scores,
    }
  }

  if (topScore === 0) {
    return {
      kind: 'general',
      label: '通用',
      confidence: 0.3,
      reason: '任务描述里没有明显类型特征，用通用团队兜底',
      scores,
    }
  }

  // 置信度：领先越多越确定
  const gap = topScore - secondScore
  const confidence = gap >= 3 ? 0.9 : gap >= 1 ? 0.7 : 0.5

  return {
    kind: topKind,
    label: TASK_SIGNALS[topKind].label,
    confidence,
    reason: reasons.filter((r) => r.includes(TASK_SIGNALS[topKind].label)).join('；')
      || `总分最高（${topScore}）`,
    scores,
  }
}

/**
 * 在现有团队里找最适合承接这个任务的。
 *
 * 排序依据（从高到低）：
 *   1. 编制是否齐全（齐 > 缺）
 *   2. 场景类型是否一致（software 场景接 software 任务）
 *   3. 有没有空闲成员（idle > busy）
 *   4. 缺的人少
 *
 * @param {Array} teams [{ id, name, kind, maxMembers, maxConcurrency, members:[{name,status,agentSessionId}] }]
 * @param {string} taskKind classifyTask 返回的 kind
 * @returns {{best:object|null, ranked:Array, reason:string}}
 */
export function matchTeam(teams, taskKind) {
  const list = (teams || []).filter((t) => t && t.status !== 'archived')
  if (!list.length) {
    return { best: null, ranked: [], reason: '没有任何团队，建议按模板新建' }
  }

  const scored = list.map((t) => {
    const members = (t.members || []).filter((m) => m && m.status !== 'retired')
    const check = Tpl.checkTeamAgainstTemplate(members, taskKind)
    const idle = members.filter((m) => m.status === 'idle').length
    const bound = members.filter((m) => m.agentSessionId).length

    let score = 0
    const why = []
    // 编制齐全 +40
    if (check.ok) { score += 40; why.push('编制齐全') }
    else { score += Math.max(0, 20 - check.missing.length * 5); why.push(`缺 ${check.missing.length} 个角色`) }
    // 类型一致 +30
    if (t.kind === taskKind) { score += 30; why.push('类型一致') }
    // 有会话绑定 +15（能真派活）
    if (bound >= Math.min(3, members.length)) { score += 15; why.push(`${bound} 人可派` ) }
    // 空闲成员 +10
    score += Math.min(10, idle * 2)
    if (idle) why.push(`${idle} 人空闲`)
    // 名额还有余 +5
    if ((t.maxMembers || 0) > members.length) { score += 5; why.push('还有名额') }

    return {
      teamId: t.id,
      name: t.name,
      kind: t.kind,
      score,
      fit: check.ok ? 'complete' : 'incomplete',
      missing: check.missing.map((r) => ({ name: r.name, title: r.title })),
      present: check.present,
      roles: (Tpl.templateFor(taskKind).roles || []).map((r) => ({
        name: r.name, title: r.title, duty: r.duty,
      })),
      memberCount: members.length,
      idle,
      bound,
      why,
    }
  }).sort((a, b) => b.score - a.score)

  const best = scored[0] || null
  const reason = best
    ? `推荐「${best.name}」（${best.why.join('、')}）`
    : '没有可用团队'

  return { best, ranked: scored, reason }
}

/**
 * 一次调用完成「识别 + 匹配」，供 op=match-team 直接用。
 * @param {string} taskText 任务描述
 * @param {Array} teams 团队列表（含 members）
 * @param {object} [hint] { workspaceKind }
 */
export function matchTask(taskText, teams, hint = {}) {
  const cls = classifyTask(taskText, hint)
  const m = matchTeam(teams, cls.kind)
  const tpl = Tpl.templateFor(cls.kind)

  return {
    ok: true,
    taskKind: cls.kind,
    taskLabel: cls.label,
    confidence: cls.confidence,
    classifyReason: cls.reason,
    scores: cls.scores,
    recommend: m.best,
    alternatives: m.ranked.slice(1, 4),
    matchReason: m.reason,
    template: {
      kind: tpl.kind,
      label: tpl.label,
      describe: tpl.describe,
      roles: tpl.roles.map((r) => ({ name: r.name, title: r.title, duty: r.duty })),
      size: tpl.roles.length,
    },
    // 并行上限建议：按推荐团队规模自适应，不写死
    concurrencyHint: m.best
      ? Math.max(2, Math.min(m.best.idle || 2, 6))
      : Math.max(2, Math.min(tpl.roles.length, 6)),
  }
}


/** 取模板（供 index.js 的 team-overview 用） */
export function templateOf(kind) {
  return Tpl.templateFor(kind)
}

/** 单个成员是否承接某岗位（供 index.js 逐个判断） */
export function hasRoleOf(members, roleName) {
  return Tpl.hasRole(members, roleName)
}

/** 场景类型列表 */
export function templateKinds() {
  return Tpl.TEMPLATE_KINDS
}
