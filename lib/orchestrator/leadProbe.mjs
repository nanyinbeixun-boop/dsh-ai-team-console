/**
 * Lead 句柄可用性探针 —— 回答「面板到底能不能替 Lead 投递」这一个问题
 *
 * 背景（-面板投递最后一公里.md）：
 * 让 S6 在 dispatch 之后必须调 subagents.sendMessage 把任务 brief 投进成员会话。
 * 但宿主 `dsh-subagent/lib/index.js:1538` 的 sendMessage 第一件事就是：
 *
 * if (this.ctx.agents.get(sender.id) !== sender) throw UNAUTHORIZED
 * ^^^^^^^^^^^^^^^^
 * 要求 sender 是注册表里那个**同一个实例**
 *
 * 面板（HTTP 桥）拿到的 ctx 是插件自己的上下文，从中取到的 agent 对象
 * 未必是注册表里那个实例。这一层能不能过，只能实测，不能推测。
 *
 * 本模块的探针设计要点 —— **零副作用**：
 * 不往任何真实成员会话投消息，不建会话，不改状态。
 * 做法是把 sendMessage 的目标设成一个**必然不存在的 sessionId**：
 * - 若 sender 实例校验不过 → 抛 "requires the exact live sender agent"
 * （说明：句柄是旧的/不是同一个对象 → 面板不能投递）
 * - 若 sender 校验通过   → 会继续走到目标解析，抛 lineage/target 相关错误
 * （说明：句柄**有效**，面板有能力投递，只是目标不存在）
 * 两种错误天然可区分，所以这条探针既能答问题又不动任何数据。
 */

/** 必然不存在的目标会话 id：撞上真会话的概率视为 0 */
const PROBE_TARGET = '__atc-probe-no-such-session__'

/** 宿主校验 sender 实例失败时的错误特征 */
const EXACT_SENDER_RE = /exact live sender agent/i

/** 安全取 Cordis 服务：未 inject 时点属性会抛，不能让它冒泡成 500 */
function safeGet(c, name) {
  try {
    if (!c) return undefined
    if (typeof c.get === 'function') return c.get(name)
    return c[name]
  } catch {
    return undefined
  }
}

/** agent 的可观测摘要（不 dump 整个对象，面板/文档要能读） */
function describeAgent(a) {
  const hdr = (a && a.session && a.session.header) || null
  return {
    id: a && a.id != null ? String(a.id) : null,
    hasFollowup: Boolean(a && typeof a.followup === 'function'),
    hasInject: Boolean(a && typeof a.inject === 'function'),
    origin: hdr ? hdr.origin || null : null,
    isSubagent: Boolean(hdr && hdr.origin === 'subagent'),
    parentSession: hdr && hdr.parentSession ? String(hdr.parentSession) : null,
    cwd: hdr && hdr.cwd ? String(hdr.cwd) : null,
    provider: (a && a.options && a.options.provider) || null,
    model: (a && a.options && a.options.model) || null,
  }
}

/**
 * 探测宿主给面板的能力面。
 * @param {object} ctx 宿主 Cordis context（index.js 的 apply ctx）
 * @returns {object} 纯数据报告，可直接 JSON 化进 HTTP 响应
 */
export function probeHostCapability(ctx) {
  const agents = safeGet(ctx, 'agents') || safeGet(ctx, 'agentRegistry')
  const subagents = safeGet(ctx, 'subagents')
  const sessions = safeGet(ctx, 'sessions')

  const report = {
    probedAt: new Date().toISOString(),
    services: {
      agents: Boolean(agents),
      agentsHasList: Boolean(agents && typeof agents.list === 'function'),
      agentsHasGet: Boolean(agents && typeof agents.get === 'function'),
      subagents: Boolean(subagents),
      subagentsHasSendMessage: Boolean(subagents && typeof subagents.sendMessage === 'function'),
      sessions: Boolean(sessions),
    },
    agentCount: 0,
    agents: [],
    leads: [],
    identityChecks: [],
    verdict: 'unknown',
    detail: [],
  }

  if (!agents || typeof agents.list !== 'function') {
    report.verdict = 'no-agents-service'
    report.detail.push('宿主未暴露 agents/agentRegistry 服务：面板无法枚举会话，投递不可能')
    return report
  }

  let list = []
  try {
    list = agents.list() || []
  } catch (err) {
    report.verdict = 'list-failed'
    report.detail.push(`agents.list() 抛错：${String(err && err.message ? err.message : err)}`)
    return report
  }

  report.agentCount = list.length
  report.agents = list.map(describeAgent)
  // Lead 候选 = 非 subagent 的会话（与 pickLeadAgent 同一口径）
  report.leads = report.agents.filter((x) => !x.isSubagent && x.origin !== 'subagent' && x.id)

  if (!report.leads.length) {
    report.verdict = 'no-lead-agent'
    report.detail.push(
      `注册表里有 ${list.length} 个 agent，但没有一个「非 subagent」的顶层会话可以当 Lead sender。`
      + '按宿主 authorizeLineage 的规则，成员只能由它的父会话投递；没有顶层 Lead 在跑时面板无法代投。')
    return report
  }

  // 逐个 Lead 候选做**实例同一性**检查：list() 里的对象与 get(id) 返回的是不是同一个
  for (const lead of report.leads) {
    let viaGet
    try {
      viaGet = agents.get(lead.id)
    } catch (err) {
      report.identityChecks.push({
        id: lead.id,
        sameInstance: false,
        error: `agents.get 抛错：${String(err && err.message ? err.message : err)}`,
      })
      continue
    }
    const same = viaGet === list.find((a) => a && String(a.id) === lead.id)
    report.identityChecks.push({
      id: lead.id,
      found: Boolean(viaGet),
      sameInstance: same,
      gotFollowup: Boolean(viaGet && typeof viaGet.followup === 'function'),
    })
  }

  if (!report.services.subagentsHasSendMessage) {
    report.verdict = 'no-subagents-sendmessage'
    report.detail.push('宿主没有 subagents.sendMessage：面板在结构上就无法投递，只能交 Lead 侧 dsh_team_task / dsh_team_send')
    return report
  }

  report.verdict = 'lead-found-pending-send-test'
  report.detail.push(
    `找到 ${report.leads.length} 个 Lead 候选；sendMessage 存在。`
    + '具体能否通过 sender 实例校验要跑 testSendWithProbeTarget（零副作用）。')
  return report
}

/**
 * 用「必然不存在的目标」实测 sendMessage 的 sender 校验是否通过（**零副作用**）。
 *
 * 判读规则（这是本探针的全部价值所在）：
 * - 错误命中 EXACT_SENDER_RE  → sender 不是注册表里那个精确实例 → 面板**不能**代投
 * - 错误是 lineage / target / not-found 之类 → sender 校验**通过** → 面板**能**代投
 * - 没有抛错 → 更怪，如实记下
 *
 * @param {object} ctx 宿主 Cordis context
 * @param {string} [leadId] 指定要测的 Lead sessionId；省略则取第一个非 subagent agent
 * @returns {Promise<object>}
 */
export async function testSendWithProbeTarget(ctx, leadId) {
  const agents = safeGet(ctx, 'agents') || safeGet(ctx, 'agentRegistry')
  const subagents = safeGet(ctx, 'subagents')
  const out = {
    testedAt: new Date().toISOString(),
    target: PROBE_TARGET,
    leadId: leadId || null,
    canResolveLead: false,
    senderExactCheckPassed: null,
    thrown: false,
    errorName: null,
    errorCode: null,
    errorMessage: null,
    verdict: 'unknown',
    note: null,
  }

  if (!agents || typeof agents.list !== 'function') {
    out.verdict = 'no-agents-service'
    out.note = '宿主未暴露 agents 服务'
    return out
  }
  if (!subagents || typeof subagents.sendMessage !== 'function') {
    out.verdict = 'no-subagents-sendmessage'
    out.note = '宿主未暴露 subagents.sendMessage'
    return out
  }

  let lead = null
  try {
    const list = agents.list() || []
    if (leadId) {
      lead = list.find((a) => a && String(a.id) === String(leadId)) || agents.get(String(leadId))
    } else {
      lead = list.find((a) => {
        const hdr = a && a.session && a.session.header
        return hdr && hdr.origin !== 'subagent'
      })
    }
  } catch (err) {
    out.verdict = 'list-failed'
    out.note = String(err && err.message ? err.message : err)
    return out
  }

  if (!lead) {
    out.verdict = 'no-lead-agent'
    out.note = leadId ? `找不到 id=${leadId} 的 agent` : '注册表里没有非 subagent 的 agent'
    return out
  }
  out.canResolveLead = true
  out.leadId = String(lead.id)

  try {
    // 目标必然不存在：不会真的往任何成员会话里塞消息。
    // 这一步要验证的只是「sender 实例校验过不过」。
    const r = await subagents.sendMessage(
      lead,
      PROBE_TARGET,
      [{ type: 'text', text: '[atc probe] 忽略：这是一次能力探测，不应送达任何会话' }],
      { signal: AbortSignal.timeout(8000) },
    )
    out.thrown = false
    out.verdict = 'unexpected-success'
    out.note = `sendMessage 没有抛错（返回 ${String(r)}）——目标本应不存在，需人工复核`
    return out
  } catch (err) {
    out.thrown = true
    out.errorName = err && err.name ? String(err.name) : null
    out.errorCode = err && err.code ? String(err.code) : null
    out.errorMessage = String(err && err.message ? err.message : err)
    if (EXACT_SENDER_RE.test(out.errorMessage)) {
      out.senderExactCheckPassed = false
      out.verdict = 'sender-not-exact-live'
      out.note = 'sender 不是注册表里的精确实例：面板从 HTTP 上下文拿到的 agent 句柄无法代 Lead 投递'
    } else {
      out.senderExactCheckPassed = true
      out.verdict = 'sender-ok-target-missing'
      out.note = 'sender 实例校验已通过（错在目标会话不存在，属预期）：面板有能力代 Lead 投递'
    }
    return out
  }
}

/** 一步到位的组合探针：能力面 + 实测投递校验 */
export async function probeLeadDelivery(ctx, leadId) {
  const cap = probeHostCapability(ctx)
  const send = await testSendWithProbeTarget(ctx, leadId)
  return {
    ...cap,
    sendTest: send,
    /** 最终结论：面板能否在 op=run 里完成投递 */
    finalVerdict: send.verdict === 'sender-ok-target-missing'
      ? 'panel-can-deliver'
      : (send.verdict === 'sender-not-exact-live'
        ? 'panel-cannot-deliver-handle-not-live'
        : `panel-cannot-deliver:${send.verdict}`),
  }
}
