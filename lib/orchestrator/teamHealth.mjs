/**
 * 团队成员健康 —— 「有记录」与「能干活」是两件事
 *
 * 由来（-团队模式根因规格.md 断点②/⑤ + -单会话取证.md）：
 * 面板建出来的成员只是 sidecar 的成员**记录**；真正的 sub-agent 会话由宿主
 * `dsh_team_spawn` / `subagents.startActivation` 拉起（面板不做这件事）。
 * 而成员会话一旦建立，就被 `header.parentSession` 钉死在 spawn 那一刻的 Lead 会话下，
 * 宿主 `dsh-subagent` 的 `authorizeLineage` 会拒绝来自新 Lead 的投递：
 *
 * subagent "<id>" belongs to another parent session
 *
 * 结果就是用户看到的「成员显示 idle，但任务派不动」——面板如果只照抄 status，
 * 就会把「派不动」显示成「待命」，这和无验收是一个毛病。
 *
 * 本模块的职责只有一件：把成员按**会话可用性**分三态，让上层如实报，不替它圆。
 * ok            有会话，且没有归属失效的阻塞项
 * unbound       有成员记录，但 agentSessionId 为空（宿主没 spawn）
 * stale-lineage 有会话，但阻塞项里带 belongs to another parent session（需重建）
 *
 * 插件侧不能重建宿主会话（那要动 dsh-subagent / dsh-team-control），所以这里
 * 只做判定与措辞，不做修复动作——修复方案见 -宿主cwd修复方案-待批准.md。
 */

/** 核心能力域：缺一个 = 缺一个员工 */
export const CORE_DOMAINS = [
  { domain: 'architect', name: 'architect', role: '造规则', reasoningEffort: 'high' },
  { domain: 'maker', name: 'maker', role: '干活', reasoningEffort: 'high' },
  { domain: 'auditor', name: 'auditor', role: '验活', reasoningEffort: 'max' },
]

/** 宿主 authorizeLineage 的报错特征：命中即「成员会话归属已失效」 */
export const LINEAGE_ERROR_RE = /belongs to another parent session/i

/** 成员阻塞项的文本化（blockers 可能是字符串数组，也可能是对象数组） */
function blockerText(b) {
  if (typeof b === 'string') return b
  if (b && typeof b === 'object') {
    const bits = [b.detail, b.reason, b.error, b.message, b.kind].filter((x) => typeof x === 'string' && x)
    return bits.length ? bits.join(' ') : JSON.stringify(b)
  }
  return ''
}

/**
 * 单个成员的会话健康。
 * @param {object} m sidecar 成员记录
 * @returns {{state:'ok'|'unbound'|'stale-lineage', bound:boolean, lineageHit:string|null, label:string, advice:string|null}}
 */
export function memberSessionHealth(m) {
  const blockers = Array.isArray(m && m.blockers) ? m.blockers : []
  const lineageHit = blockers.map(blockerText).find((t) => LINEAGE_ERROR_RE.test(t)) || null
  const bound = Boolean(m && m.agentSessionId)
  if (!bound) {
    return {
      state: 'unbound',
      bound,
      lineageHit: null,
      label: '无会话',
      advice: '该成员只有记录、没有宿主会话：让 Lead 用 dsh_team_spawn 拉起，否则任务派不进去。',
    }
  }
  if (lineageHit) {
    return {
      state: 'stale-lineage',
      bound,
      lineageHit,
      label: '会话已失效',
      advice: '会话绑在旧父会话上（belongs to another parent session）：retire 该成员后由当前 Lead 重新 dsh_team_spawn，或等宿主侧重建逻辑落地。',
    }
  }
  return { state: 'ok', bound, lineageHit: null, label: '可用', advice: null }
}

/** 某能力域是否已有成员承接（按 name / role 匹配，与流水线 S3 同一口径） */
export function domainOwned(members, domain) {
  const re = new RegExp(domain, 'i')
  return (members || []).some((m) => re.test(String(m.name || '')) || re.test(String(m.role || '')))
}

/** 活成员（retired 不计）。传入原始数组，返回过滤后的数组。 */
export function activeMembers(rows) {
  return (Array.isArray(rows) ? rows : []).filter((m) => m && m.status !== 'retired')
}

/**
 * 给整组成员打健康标记，并汇总成一句能贴到面板上的话。
 * retired 成员自动剔除（不参与「可用 N/M」的分母），调用点漏过滤也不会算错。
 * @param {object[]} members sidecar 成员记录
 */
export function annotateMembers(members) {
  const rows = activeMembers(members).map((m) => {
    const h = memberSessionHealth(m)
    return {
      id: m.id || null,
      name: m.name || null,
      role: m.role || null,
      status: m.status || null,
      agentSessionId: m.agentSessionId || null,
      currentTaskId: m.currentTaskId || null,
      sessionState: h.state,
      sessionLabel: h.label,
      sessionAdvice: h.advice,
      lineageHit: h.lineageHit,
    }
  })
  const unbound = rows.filter((r) => r.sessionState === 'unbound')
  const stale = rows.filter((r) => r.sessionState === 'stale-lineage')
  const usable = rows.filter((r) => r.sessionState === 'ok')
  return {
    rows,
    counts: { total: rows.length, usable: usable.length, unbound: unbound.length, stale: stale.length },
    unboundNames: unbound.map((r) => r.name).filter(Boolean),
    staleNames: stale.map((r) => r.name).filter(Boolean),
    /** 一句话结论：面板/snapshot 直接显示，避免把「派不动」看成「待命」 */
    summary: rows.length === 0
      ? '团队里没有活成员'
      : `可用 ${usable.length}/${rows.length}`
        + (unbound.length ? ` · 无会话：${unbound.map((r) => r.name).join('、')}` : '')
        + (stale.length ? ` · 会话失效：${stale.map((r) => r.name).join('、')}（需重建成员）` : ''),
    needsRebuild: stale.map((r) => ({ name: r.name, id: r.id, advice: r.sessionAdvice })),
  }
}
