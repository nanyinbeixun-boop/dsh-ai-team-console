/**
 * 自建聊天框 —— 服务端
 *
 * 设计依据（已核实，不是猜）：
 * - dsh-better-sidebar 的 Side Chat 用的就是这条路：AgentRegistry.create 建子会话，
 * agent.followup 发消息，AgentRegistry.resume 冷恢复
 * - 它是「公开 seam」，不需要碰 DSH 源码
 *
 * 与 Side Chat 的区别：
 * - Side Chat 继承父会话历史；我们是**每个场景一个独立 Lead 会话**，跨场景不串
 * - Side Chat 挂在 better-sidebar 下；我们是独立插件自己的通道
 *
 * 降级策略：宿主没提供 registry / followup 时，本模块明确报 not-available，
 * 由面板提示用户，而不是假装能用。
 */

const TURN_TIMEOUT_MS = 180000

// route-config.json 落在包根目录，读盘要绝对路径；node:url 是内置模块，静态引入零风险
import { fileURLToPath } from 'node:url'
import * as Host from './host.mjs'

/** 内存态线程表：sceneId -> thread。不落库，重启即失（历史在 DSH session log 里） */
const threads = new Map()

function nowIso() {
  return new Date().toISOString()
}

/** 安全取 Cordis 服务：未 inject 时点属性会抛，不能让它冒泡成 500 */
function safeGet(ctx, name) {
  try {
    if (!ctx) return undefined
    if (typeof ctx.get === 'function') return ctx.get(name)
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * 探测宿主是否具备自建聊天框的能力。
 * 面板用它决定「聊天按钮是否可用」，而不是点了才报错。
 */
export function probeCapability(ctx) {
  const registry = safeGet(ctx, 'agents') || safeGet(ctx, 'agentRegistry')
  const sessions = safeGet(ctx, 'sessions')
  const out = {
    registry: Boolean(registry && typeof registry.create === 'function'),
    sessions: Boolean(sessions && (typeof sessions.get === 'function' || typeof sessions.create === 'function')),
    followup: false,
    resume: Boolean(registry && typeof registry.resume === 'function'),
    detail: [],
  }
  // followup 在 agent 实例上，得看有没有活着的 agent
  if (registry && typeof registry.get === 'function') {
    try {
      const any = registry.list ? registry.list()[0] : null
      out.followup = Boolean(any && typeof any.followup === 'function')
    } catch { /* 没有 agent 时不算错 */ }
  }
  if (!out.registry) out.detail.push('宿主未暴露 agents/agentRegistry 服务')
  if (!out.sessions) out.detail.push('宿主未暴露 sessions 服务')
  out.usable = out.registry && out.sessions
  return out
}

/**
 * 为一个场景开一个聊天线程（建子会话）。
 *
 * 参数形状是照 dsh-better-sidebar 的实际调用核对过的（它跑在三年前的宿主上仍然有效）。
 * 最容易错的四处：
 * 1. sessionId 必填 —— 要自己生成 UUID，宿主不会替你生成
 * 2. meta.parentSession 必填 —— 子会话必须挂在某个父会话下
 * 3. origin 在 meta 里，不在顶层
 * 4. seed / inheritedEventCount 要一起给（空数组也行，但字段要在）
 *
 * @param {object} ctx  Cordis context
 * @param {{sceneId:string, title?:string, preset?:string, cwd?:string,
 * provider?:string, model?:string, parentSession?:string}} opt
 */
export async function openThread(ctx, opt) {
  const sceneId = opt.sceneId
  if (!sceneId) return { ok: false, error: 'sceneId 必填' }

  const existing = threads.get(sceneId)
  if (existing && existing.sessionId) {
    return {
      ok: true, reused: true, thread: publicThread(existing),
      routeSource: existing.routeSource || null,
      ...(existing.routeWarning ? { routeWarning: existing.routeWarning } : {}),
    }
  }

  const cap = probeCapability(ctx)
  if (!cap.usable) {
    return {
      ok: false,
      reason: 'not-available',
      error: '宿主未提供创建会话的能力',
      detail: cap.detail,
      hint: '这种情况下面板的聊天框不可用；团队编排与面板只读部分不受影响。',
    }
  }

  const registry = safeGet(ctx, 'agents') || safeGet(ctx, 'agentRegistry')

  // 父会话：优先用调用方给的，其次从 lead 会话推，最后退回主会话
  const parentSession = opt.parentSession
    || findParentSession(ctx)
    || null
  if (!parentSession) {
    return {
      ok: false,
      reason: 'no-parent',
      error: '拿不到父会话 id',
      hint: '子会话必须挂在父会话下；请在主会话里调用，或显式传 parentSession。',
    }
  }

  const childId = newSessionId()
  // 根因修复：child agent 必须带 provider/model，否则每个回合死在
  // "has no provider/model"（实测 turn/end reason.error）。消息其实送到了
  // （agent/inbox/spliced 有 user 消息），是模型路由没配。
  // 回落优先级改为「显式传 > 配置链（route-config.json）> 宿主快照」，
  // 被 disabledProviders / cap 挡住的通道不会出现在回落结果里。
  const resolved = await resolveChatRouteOpt(ctx, opt, opt.routeConfig || null)
  const route = resolved.route
  // ：显式指定被禁/被 cap 挡住的通道 → **硬拦**，
  // 在建会话之前就返回，registry.create 绝不触发；hint 点明被什么挡 + 可用替代。
  if (resolved.explicitBlocked) {
    return {
      ok: false,
      reason: 'explicit-blocked',
      error: `显式指定的 ${resolved.blocked?.key || (opt.provider + '/' + opt.model)} 已被配置拦下，未创建会话`,
      routeSource: resolved.source,
      blocked: resolved.blocked || null,
      alternatives: resolved.alternatives || [],
      hint: resolved.hint || null,
      tried: resolved.tried || [],
    }
  }
  if (!route) {
    return {
      ok: false,
      reason: 'no-route',
      error: '拿不到可用的 provider/model：配置链候选全部被门槛挡住，宿主快照也不可用',
      routeSource: resolved.source,
      blocked: resolved.blocked || null,
      hostRoute: resolved.hostRoute || null,
      tried: resolved.tried || [],
      gatedOut: resolved.gatedOut || [],
      hint: resolved.blocked
        ? `宿主当时挂着的是 ${resolved.hostRoute ? resolved.hostRoute.provider + '/' + resolved.hostRoute.model : '（无）'}，被「${resolved.blocked.reason}」挡住。到面板「模型配置」放开一条，或调用时显式传 provider/model。`
        : 'openThread 传 provider/model，或在 route-config.json 里配一个可用的 leadRoute / 候选链。',
    }
  }
  try {
    const created = await registry.create({
      sessionId: childId,
      meta: {
        ...(opt.cwd ? { cwd: opt.cwd } : {}),
        parentSession,
        isSeeded: true,
        origin: 'subagent',
        delegationDepth: 1,
        ...(opt.preset ? { agentPreset: opt.preset } : {}),
        ...(opt.title ? { title: opt.title } : {}),
      },
      seed: [],
      inheritedEventCount: 0,
      agentOptions: {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        ...(opt.preset ? { agentPreset: opt.preset } : {}),
      },
      signal: AbortSignal.timeout(20000),
    })
    const agent = created && (created.agent || created)
    const sessionId = created && (created.sessionId || childId)
    if (!agent || typeof agent.followup !== 'function') {
      return {
        ok: false,
        error: '创建成功但拿不到可用的 agent 句柄',
        raw: created ? Object.keys(created) : null,
      }
    }
    // ──  修复：create 后四步（照 dsh-better-sidebar 的 sidechat.start）──
    // ① 清空 inbox 残留：runtime inbox 会折全会话日志，继承前缀里未认领的
    // 输入会被重放进子会话 live inbox，首条消息会被它抢占。刚建线程
    // 不可能有自己的待处理消息，clear 零代价。
    let inboxCleared = false
    try {
      inboxCleared = Host.clearInbox(agent)
    } catch { /* inbox 结构异常不致命 */ }
    // ② 装模型选择钩子：不装的话 child 可能不知道自己该用什么模型。
    // seed 从 agent.options 冻结值取（provider/model 齐才有 current）。
    let modelSelectionInstalled = false
    try {
      const installer = await getInstallModelSelection()
      if (installer && agent.ctx) {
        const opts = agent.options || {}
        installer(agent.ctx, {
          current: opts.provider && opts.model
            ? { provider: opts.provider, model: opts.model }
            : undefined,
          assembled: undefined,
        })
        modelSelectionInstalled = true
      }
    } catch { /* 失败不影响主流程 */ }
    const thread = {
      sceneId,
      sessionId,
      agent,
      createdAt: nowIso(),
      lastAt: nowIso(),
      turns: 0,
      // ：openThread 不再自带首发（面板先 chat-open 再 chat-send 的
      // 两段式流程不变），边界消息由 sendPrompt 首轮补发。
      boundaryInjected: false,
      // 这条路由是哪来的（显式传 / 配置链 / 宿主默认）——审计与面板都要能回答
      routeSource: resolved.source,
      routeFrom: resolved.from || null,
      routeWarning: resolved.warning || null,
      routeBlocked: resolved.blocked || null,
      routeTried: resolved.tried || [],
      routeConfigSource: resolved.configSource || null,
      setup: {
        inboxCleared,
        modelSelectionInstalled,
        route: route.provider + '/' + route.model,
        routeSource: resolved.source,
      },
    }
    threads.set(sceneId, thread)
    return {
      ok: true, reused: false, thread: publicThread(thread), setup: thread.setup,
      routeSource: thread.routeSource,
      routeFrom: thread.routeFrom,
      ...(thread.routeWarning ? { routeWarning: thread.routeWarning } : {}),
      ...(thread.routeBlocked ? { routeBlocked: thread.routeBlocked } : {}),
      routeConfigSource: thread.routeConfigSource,
      routeTried: thread.routeTried,
    }
  } catch (err) {
    return { ok: false, error: `create 失败：${err && err.message ? err.message : err}` }
  }
}

/** 从宿主找当前会话作为父：agents 注册表里挑一个非 subagent 的活 agent */
function findParentSession(ctx) {
  const registry = safeGet(ctx, 'agents') || safeGet(ctx, 'agentRegistry')
  try {
    const list = typeof registry?.list === 'function' ? registry.list() : []
    for (const a of list) {
      const hdr = a && a.session && a.session.header
      if (!hdr) continue
      // 只要不是子会话本体的，就是我们的父
      if (hdr.origin !== 'subagent') {
        return (a.session.id) || hdr.id || null
      }
    }
  } catch { /* 取不到就往下走 */ }
  return null
}

/**
 * 解析 chat 子会话的模型路由（ 根因：没有 provider/model 的 child
 * 每个回合都死在 "agent has no provider/model"）。
 *
 * 修复：修复前只有「显式传 > 宿主 Lead agent 的 options 快照」两档，
 * **从不读 route-config.json**，于是面板开聊天框会静默继承宿主主会话当时
 * 挂着的模型——实测落到过 raccoon/sn-deepseek-v4-1-flash-1017，
 * 而 raccoon 当时正在 disabledProviders 里（账号级限流）。
 * 现在回落交给 routes.resolveChatRoute：显式传 > 配置链（leadRoute + 五域四档）
 * > 宿主快照（且同样过 gate），被禁用/被 cap 挡住的不会出现在回落结果里；
 * 宿主快照只在配置链给不出可用项时才用，命中即带 warning。
 *
 * @param {object} ctx Cordis context
 * @param {object} opt 调用参数（provider/model/reasoningEffort 为显式档）
 * @param {object|null} [config] route-config 内容；缺省时自己读盘
 * @returns {Promise<{source:string|null, route:object|null, warning:string|null,
 * blocked:object|null, from:string|null, tried:string[],
 * configSource:string|null, gatedOut:object[]}>}
 */
export async function resolveChatRouteOpt(ctx, opt, config) {
  const explicit = opt && opt.provider && opt.model
    ? { provider: opt.provider, model: opt.model, reasoningEffort: opt.reasoningEffort }
    : null
  const hostRoute = readHostRoute(ctx)
  // 读盘只在这里发生（op 层/本函数），routes.mjs 保持纯函数
  let cfg = config
  let configSource = config ? 'injected' : null
  if (!cfg) {
    try {
      const { loadRouteConfig } = await import('./routes.mjs')
      const loaded = await loadRouteConfig(pkgRoot())
      cfg = loaded.config
      configSource = loaded.source
    } catch { cfg = null }
  }
  const gatedOut = []
  const M = await import('./routes.mjs')
  const out = M.resolveChatRoute({ explicit, hostRoute, config: cfg || {}, gatedOut })
  return { ...out, configSource: configSource || 'unknown', hostRoute, gatedOut }
}

/** 本包根目录（route-config.json 所在；chat.mjs 在 lib/orchestrator/ 下，故上跳两级） */
function pkgRoot() {
  try {
    return fileURLToPath(new URL('../..', import.meta.url))
  } catch {
    return process.cwd()
  }
}

/** 读宿主 Lead（非 subagent）agent 的 options 快照；拿不到返回 null */
function readHostRoute(ctx) {
  const registry = safeGet(ctx, 'agents') || safeGet(ctx, 'agentRegistry')
  try {
    const list = typeof registry?.list === 'function' ? registry.list() : []
    for (const a of list) {
      const hdr = a && a.session && a.session.header
      if (!hdr || hdr.origin === 'subagent') continue
      const o = a.options || {}
      if (o.provider && o.model) {
        return { provider: o.provider, model: o.model, reasoningEffort: o.reasoningEffort }
      }
    }
  } catch { /* 取不到就往下走 */ }
  return null
}

/** 生成会话 id：与宿主一致的 UUID 形状 */
function newSessionId() {
  try {
    // 宿主用 crypto.randomUUID
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch { /* ignore */ }
  const r = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return `${r()}-${r().slice(0,4)}-4${r().slice(1,4)}-8${r().slice(1,4)}-${r()}${r().slice(0,4)}`
}

/**
 * 组装一条用户消息。
 *
 * 这行的形状是照 dsh-better-sidebar 的实现核对过的：
 * createUserMessage({ content: [{type:'text', text}], source: {kind:'user'} })
 * followup 要的是**消息对象**，不是 { text }。传错形状会被静默丢弃或抛错。
 *
 * createUserMessage 来自 @deepseek-ai/dsh-llm。为了不让插件硬依赖它，
 * 这里做双路：能 import 到就用官方的；拿不到就退化成最小等价形状。
 */
let createUserMessageImpl = null
async function getCreateUserMessage() {
  if (createUserMessageImpl) return createUserMessageImpl
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (mod && typeof mod.createUserMessage === 'function') {
      createUserMessageImpl = mod.createUserMessage
      return createUserMessageImpl
    }
  } catch { /* 宿主没导出，用退化形状 */ }
  // 退化形状：与官方字段对齐（content + source），缺的字段由宿主侧补默认值
  createUserMessageImpl = (opt) => ({
    role: 'user',
    content: opt.content,
    source: opt.source || { kind: 'user' },
  })
  return createUserMessageImpl
}

async function buildUserMessage(text) {
  const make = await getCreateUserMessage()
  return make({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * installModelSelection 来自 @deepseek-ai/dsh-agent（ 修复）。
 * 动态 import + 失败降级：宿主没导出就返回 null，openThread 跳过该步，
 * 绝不让插件加载失败。
 */
let installModelSelectionImpl
async function getInstallModelSelection() {
  if (installModelSelectionImpl !== undefined) return installModelSelectionImpl
  installModelSelectionImpl = null
  try {
    const mod = await import('@deepseek-ai/dsh-agent')
    if (mod && typeof mod.installModelSelection === 'function') {
      installModelSelectionImpl = mod.installModelSelection
    }
  } catch { /* 宿主没导出就降级 */ }
  return installModelSelectionImpl
}

/** 发一条消息给某场景的线程 */
export async function sendPrompt(ctx, opt) {
  const sceneId = opt.sceneId
  const text = (opt.text || '').trim()
  if (!sceneId) return { ok: false, error: 'sceneId 必填' }
  if (!text) return { ok: false, error: '消息不能为空' }

  let thread = threads.get(sceneId)
  if (!thread) {
    const opened = await openThread(ctx, opt)
    if (!opened.ok) return opened
    thread = threads.get(sceneId)
  }

  const agent = thread.agent
  if (!agent || typeof agent.followup !== 'function') {
    return {
      ok: false,
      reason: 'no-followup',
      error: '该线程的 agent 没有 followup 方法',
      hint: '可能是宿主版本差异；可尝试关闭后重开线程。',
    }
  }

  try {
    const t0 = Date.now()
    const message = await buildUserMessage(text)
    // ：首条消息按 better-sidebar 的 admitFirstContact 两步走——
    // inject 边界（不唤醒 driver）+ followup 问题（唤醒）。线程没有边界时
    // sendPrompt 补发边界；已有（firstDelivered）则只发问题本身。
    if (!thread.boundaryInjected) {
      try {
        const make = await getCreateUserMessage()
        agent.inject(make({
          content: [{ type: 'text', text: '[ai-team 面板会话] 以下是用户消息。' }],
          source: { kind: 'plugin:dsh-ai-team-console' },
        }))
        thread.boundaryInjected = true
      } catch { /* 老宿主没有 inject：跳过，不影响消息本身 */ }
    }
    const fu = await Host.followup(agent, message, TURN_TIMEOUT_MS)
    if (!fu.ok) throw new Error(fu.error || 'followup 失败')
    const result = fu.result
    thread.turns += 1
    thread.lastAt = nowIso()
    return {
      ok: true,
      ms: Date.now() - t0,
      turns: thread.turns,
      result: summarizeResult(result),
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err)
    if (/timeout/i.test(msg)) {
      return { ok: false, reason: 'timeout', error: `回合超时（${TURN_TIMEOUT_MS / 1000}s）`, hint: '任务可能仍在跑，稍后再看会话。' }
    }
    return { ok: false, error: `followup 失败：${msg}` }
  }
}

/** 中断当前回合 */
export async function cancelThread(ctx, sceneId) {
  const thread = threads.get(sceneId)
  if (!thread) return { ok: false, error: '该场景没有打开的线程' }
  const agent = thread.agent
  try {
    if (agent && typeof agent.abort === 'function') { await agent.abort(); return { ok: true, via: 'abort' } }
    if (agent && typeof agent.interrupt === 'function') { await agent.interrupt(); return { ok: true, via: 'interrupt' } }
    return { ok: false, error: 'agent 没有 abort/interrupt 方法' }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

/** 列出当前打开的所有线程 */
export function listThreads() {
  return Array.from(threads.values()).map(publicThread)
}

/**
 * 取某个场景线程的子会话 id。
 * chat-read 用它把「面板里的工作项」翻译成「宿主 session log 的目录名」。
 * 线程表是内存态，重启即失——重启后面板要靠客户端记住的 sessionId 读历史。
 */
export function getThreadSessionId(sceneId) {
  const t = threads.get(sceneId)
  return t && t.sessionId ? t.sessionId : null
}

function publicThread(t) {
  return {
    sceneId: t.sceneId,
    sessionId: t.sessionId,
    createdAt: t.createdAt,
    lastAt: t.lastAt,
    turns: t.turns,
    setup: t.setup || null,
    // 列表里也要能看出这条线程的路由是显式传的还是回落来的
    routeSource: t.routeSource || null,
    ...(t.routeWarning ? { routeWarning: t.routeWarning } : {}),
  }
}

/** followup 的返回形状跨版本不一致，只挑能显示的部分 */
function summarizeResult(r) {
  if (!r) return null
  if (typeof r === 'string') return { text: r.slice(0, 4000) }
  const out = {}
  for (const k of ['text', 'content', 'message', 'reply', 'output', 'finishReason', 'status', 'usage']) {
    if (r[k] !== undefined) out[k] = r[k]
  }
  if (!Object.keys(out).length) out.keys = Object.keys(r)
  return out
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}
