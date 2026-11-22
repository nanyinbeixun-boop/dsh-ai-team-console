/**
 * 宿主适配层 —— 所有 DSH 内部 API 的唯一入口。
 *
 * 为什么需要这一层：
 *   DSH 的 `ctx.slots` / `ctx.agents` / `subagents` / `agent.followup` 都不是
 *   公开稳定 API。宿主升级时签名或行为可能变化，如果 30 多处调用点散在各个
 *   模块里，每次升级都要全库排查。
 *
 *   集中到这里之后：
 *     · 升级时只改本文件
 *     · 每个能力都带 `available` 探测，缺失时降级而不是崩
 *     · 调用方看到的是稳定的函数签名，不直接依赖宿主对象形状
 *
 * 设计原则：
 *   1. 每个能力先探测再调用（host.capability.available）
 *   2. 探测失败返回结构化结果，不抛裸异常
 *   3. 不做业务判断，只做形状适配
 */

/**
 * 安全取宿主能力。
 *
 * 注意：插件里存在两种上下文形态——
 *   · 真实 Cordis ctx：直接 ctx.get(name)
 *   · 测试夹具 / HTTP 桥包装：ctx.hostCtx.get(name)
 * 两者都要支持，否则测试注入的服务取不到。
 */
function safeGet(host, key) {
  if (!host) return null
  // 直接有 get
  try {
    if (typeof host.get === 'function') {
      const v = host.get(key)
      if (v !== undefined && v !== null) return v
    }
  } catch { /* 继续试 hostCtx */ }
  // 包装形态：ctx.hostCtx.get(name)
  try {
    const inner = host.hostCtx
    if (inner && typeof inner.get === 'function') {
      const v = inner.get(key)
      if (v !== undefined && v !== null) return v
    }
  } catch { /* ignore */ }
  return null
}

/** 安全读属性（宿主对象可能是 getter） */
function safeProp(obj, key) {
  try {
    return obj ? obj[key] : undefined
  } catch {
    return undefined
  }
}

// ══════════════════════════════════════════════════════════════
// 能力探测
// ══════════════════════════════════════════════════════════════

/**
 * 探测宿主提供了哪些能力。启动时调一次，结果可缓存。
 * 返回的每个字段都是布尔值，false 表示该能力不可用（调用方据此降级）。
 */
export function capabilities(ctx) {
  const agents = safeGet(ctx, 'agents')
  const subagents = safeGet(ctx, 'subagents')

  return {
    // UI 挂载
    slots: Boolean(safeProp(ctx, 'slots') && typeof safeProp(safeProp(ctx, 'slots'), 'register') === 'function'),
    effect: typeof safeProp(ctx, 'effect') === 'function',
    webServer: Boolean(safeGet(ctx, 'webServer')),

    // 会话 / 消息
    agentsList: Boolean(agents && typeof safeProp(agents, 'list') === 'function'),
    agentsGet: Boolean(agents && typeof safeProp(agents, 'get') === 'function'),
    agentsCreate: Boolean(agents && typeof safeProp(agents, 'create') === 'function'),

    // 团队投递
    subagentsSend: Boolean(subagents && typeof safeProp(subagents, 'sendMessage') === 'function'),

    // 自动开 Lead 会话
    modelSelection: Boolean(safeGet(ctx, 'modelSelection')),
  }
}

// ══════════════════════════════════════════════════════════════
// 会话（agents）
// ══════════════════════════════════════════════════════════════

/** 列出现存活 agent；宿主没提供或抛错时返回空数组 */
export function listAgents(ctx) {
  const agents = safeGet(ctx, 'agents')
  if (!agents || typeof safeProp(agents, 'list') !== 'function') return []
  try {
    const out = agents.list()
    return Array.isArray(out) ? out : []
  } catch {
    return []
  }
}

/** 按 id 取 agent；失败返回 null */
export function getAgent(ctx, id) {
  const agents = safeGet(ctx, 'agents')
  if (!agents || typeof safeProp(agents, 'get') !== 'function') return null
  try {
    return agents.get(id) || null
  } catch {
    return null
  }
}

/** 创建子会话 agent；失败返回 { ok:false, error } */
export function createAgent(ctx, opts) {
  const agents = safeGet(ctx, 'agents')
  if (!agents || typeof safeProp(agents, 'create') !== 'function') {
    return { ok: false, error: '宿主未暴露 agents.create' }
  }
  try {
    return { ok: true, agent: agents.create(opts) }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

/** 该 agent 实例能否接收 followup */
export function canFollowup(agent) {
  return Boolean(agent && typeof safeProp(agent, 'followup') === 'function')
}

/** 投递一条消息给 agent；返回 { ok, result?, error? } */
export async function followup(agent, message, timeoutMs = 0) {
  if (!canFollowup(agent)) return { ok: false, error: 'agent 没有 followup 方法' }
  try {
    const p = Promise.resolve(agent.followup(message))
    const result = timeoutMs > 0
      ? await Promise.race([
        p,
        new Promise((_, rej) => {
          const t = setTimeout(() => rej(new Error(`followup 超时 ${timeoutMs}ms`)), timeoutMs)
          if (t.unref) t.unref()
        }),
      ])
      : await p
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

/** 清空 agent 的 inbox（新会话开团前用，避免读到上一轮残留） */
export function clearInbox(agent) {
  const inbox = safeProp(agent, 'inbox')
  if (!inbox || typeof safeProp(inbox, 'clear') !== 'function') return false
  try {
    inbox.clear()
    return true
  } catch {
    return false
  }
}

// ══════════════════════════════════════════════════════════════
// 团队投递（subagents）
// ══════════════════════════════════════════════════════════════

/** 宿主是否支持面板侧投递 */
export function canSendToMember(ctx) {
  const subagents = safeGet(ctx, 'subagents')
  return Boolean(subagents && typeof safeProp(subagents, 'sendMessage') === 'function')
}

/**
 * 把消息投进成员会话。这是 S6 真投递的落点。
 *
 * 宿主签名：subagents.sendMessage(senderAgent, toSessionId, content[], opts?)
 * 这里原样透传，不做参数改造——调用方需要精确控制 content 形状与超时。
 *
 * 返回 { ok, via?, result?, error?, reason? }：
 *   · reason='no-api'  宿主没有这个能力（结构性缺失，不是偶发失败）
 *   · reason='threw'   调用抛错（可能是 lineage 不匹配等业务原因）
 */
export async function sendToMember(ctx, senderAgent, toSessionId, content, opts) {
  const subagents = safeGet(ctx, 'subagents')
  if (!subagents || typeof safeProp(subagents, 'sendMessage') !== 'function') {
    return { ok: false, reason: 'no-api', error: '宿主未暴露 subagents.sendMessage' }
  }
  try {
    const result = await subagents.sendMessage(senderAgent, toSessionId, content, opts)
    return { ok: true, via: 'subagents.sendMessage', result }
  } catch (e) {
    return { ok: false, reason: 'threw', error: String(e && e.message ? e.message : e) }
  }
}

// ══════════════════════════════════════════════════════════════
// UI 挂载（slots）
// ══════════════════════════════════════════════════════════════

/**
 * 安全注册一个 slot 条目。
 * 宿主 slots API 缺失时返回 false，调用方跳过 UI 挂载而不是崩掉整个插件。
 */
export function registerSlot(ctx, name, options, component) {
  const slots = safeProp(ctx, 'slots')
  if (!slots || typeof safeProp(slots, 'inject') !== 'function' || typeof safeProp(slots, 'register') !== 'function') {
    return false
  }
  try {
    slots.inject(name, function () {
      return slots.register(Object.assign({ name }, options), component)
    })
    return true
  } catch {
    return false
  }
}

// ══════════════════════════════════════════════════════════════
// 其他
// ══════════════════════════════════════════════════════════════

/**
 * 注册 effect（清理钩子）。
 *
 * 语义要分清两件事，此前混在一起导致注册被静默跳过：
 *   · fn 是「要做的事」（比如注册一条 HTTP 路由）
 *   · effect 是「宿主提供的生命周期钩子」，用来在卸载时执行清理
 *
 * 原来 effect 缺失时直接执行一次 fn 并返回 false——调用方把 false 理解成
 * 「没注册成功」，于是打日志说「HTTP 桥未注册」，但路由其实已经加上了。
 * 反过来若 effect 可用，fn 又只被当成清理函数存在闭包里、从没被执行。
 *
 * 现在：**先执行 fn**（这件事必须做成），再尽量把清理钩子挂到 effect 上。
 * 返回值只表达「fn 有没有抛错」，不再兼任「effect 是否可用」。
 */
export function registerEffect(ctx, fn, label) {
  let ok = true
  let cleanup = null
  try {
    const result = fn()
    // fn 可能返回一个清理函数（例如路由注册返回的 disposer）
    if (typeof result === 'function') cleanup = result
  } catch (e) {
    ok = false
    console.warn(`[host] ${label || 'effect'} 执行失败：${e && e.message ? e.message : e}`)
  }

  const effect = safeProp(ctx, 'effect')
  if (typeof effect === 'function' && ok) {
    try {
      effect(() => {
        try { if (typeof cleanup === 'function') cleanup() } catch { /* 清理失败不影响卸载 */ }
      }, label)
    } catch { /* 挂不上清理钩子不影响主流程 */ }
  }
  return ok
}

/** 注册 HTTP 路由；缺失时返回 false（插件降级为纯 UI 不可用） */
/**
 * 注册 HTTP 路由。
 * @returns {function|null} 成功返回 disposer（可撤销本条路由），失败返回 null
 */
export function registerWebRoute(ctx, handler) {
  const ws = safeGet(ctx, 'webServer')
  if (!ws || typeof safeProp(ws, 'register') !== 'function') return null
  try {
    const disposer = ws.register(handler)
    // 宿主返回的可能是函数（撤销用），也可能什么都不返回
    return typeof disposer === 'function' ? disposer : () => {}
  } catch (e) {
    console.warn(`[host] 注册路由失败：${e && e.message ? e.message : e}`)
    return null
  }
}

/** 模型选择能力（自动开 Lead 会话时用）；缺失返回 null */
export function modelSelection(ctx) {
  return safeGet(ctx, 'modelSelection') || null
}

/**
 * 一次性自检：把能力状态整理成人能读的报告。
 * 启动时调一次打到日志，宿主升级后能立刻看出哪里没了。
 */
export function healthReport(ctx) {
  const caps = capabilities(ctx)
  const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k)
  return {
    ok: missing.length === 0,
    capabilities: caps,
    missing,
    summary: missing.length === 0
      ? '宿主能力齐全'
      : `宿主缺少 ${missing.length} 项能力：${missing.join('、')}`,
  }
}
