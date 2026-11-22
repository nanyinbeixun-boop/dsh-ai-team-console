/**
 * 本地数据适配层 —— 不再劫持 globalThis.fetch。
 *
 * ## 为什么推翻重做
 *
 * 第一版做法是包一层 globalThis.fetch：命中 127.0.0.1:4317/api/* 就用本地库应答。
 * 这在独立脚本里跑得好好的，但装进 DSH 之后把整个应用搞崩了——
 * 因为**宿主自己也用 globalThis.fetch**（调 LLM API、拉远程模型列表、
 * 拿插件市场数据都在用）。我换掉全局 fetch 后，宿主拿到的都是
 * 假 Response 对象（连 instanceof Response 都不成立），
 * 内部 WeakMap 一 key 就抛 "Invalid value used as weak map key"，
 * 严重到用户打不开界面。
 *
 * 结论：**全局副作用必须为零**。正确做法是把本地实现作为
 * 「一个明确的函数」暴露给插件自己的调用点，谁要用谁显式调，
 * 绝不篡改宿主环境。
 *
 * ## 现在的形态
 *
 *   sidecarFetch(url, init)  —— 只处理 127.0.0.1:4317/api/*，其它一律返回 null
 *   install()                —— 保留为兼容入口，但**什么都不做**（不再改全局）
 *
 * 调用方（pipeline / index / evolve）改成：
 *   const local = sidecarFetch(url, init)
 *   const res = local || await fetch(url, init)
 */

import * as Store from './localStore.mjs'

/** sidecar 的默认端口（与旧配置一致，便于沿用） */
export const SIDECAR_ORIGIN = 'http://127.0.0.1:4317'

/** 该 URL 是否归本地层处理 */
export function handles(url) {
  try {
    const u = new URL(String(url))
    return (u.origin === SIDECAR_ORIGIN) && u.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

function jsonBody(init) {
  if (!init || !init.body) return {}
  try {
    return typeof init.body === 'string' ? JSON.parse(init.body) : init.body
  } catch {
    return {}
  }
}

/**
 * 构造真 Response。
 * 必须是真 Response 实例——宿主里有代码对 Response 做 WeakMap 缓存，
 * 鸭子类型对象当 key 会抛 "Invalid value used as weak map key"。
 */
function respond(data, status = 200) {
  const body = JSON.stringify(data)
  try {
    return new Response(body, {
      status,
      statusText: status === 200 ? 'OK' : String(status),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-atc-store': 'local',
      },
    })
  } catch {
    // 极老运行时没有全局 Response 时兜底（形状尽量对齐）
    const pairs = [['content-type', 'application/json; charset=utf-8'], ['x-atc-store', 'local']]
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: {
        get: (n) => (pairs.find(([k]) => k === String(n).toLowerCase()) || [])[1] || null,
        has: (n) => pairs.some(([k]) => k === String(n).toLowerCase()),
        forEach: (cb) => pairs.forEach(([k, v]) => cb(v, k)),
        entries: () => pairs[Symbol.iterator](),
        keys: () => pairs.map(([k]) => k)[Symbol.iterator](),
        values: () => pairs.map(([, v]) => v)[Symbol.iterator](),
        [Symbol.iterator]: () => pairs[Symbol.iterator](),
      },
      url: '', redirected: false, type: 'basic', bodyUsed: false,
      json: async () => JSON.parse(body),
      text: async () => body,
      clone() { return respond(data, status) },
    }
  }
}

/**
 * 处理一个 sidecar 请求。返回 null 表示「不归我管」。
 * @param {string} url 完整 URL
 * @param {object} init fetch init
 * @returns {Promise<Response|null>}
 */
export async function handle(url, init = {}) {
  if (!handles(url)) return null
  const u = new URL(String(url))
  const path = u.pathname
  const q = u.searchParams
  const method = String(init.method || 'GET').toUpperCase()
  const body = jsonBody(init)

  try {
    // ── teams ──
    if (path === '/api/teams' && method === 'GET') {
      return respond({ items: Store.listTeams() })
    }
    if (path === '/api/teams' && method === 'POST') {
      const t = Store.createTeam({
        id: body.id,
        name: body.name,
        workspace: body.workspace,
        maxMembers: body.maxMembers,
        maxConcurrency: body.maxConcurrency,
        permissionPreset: body.permissionPreset,
        agentPreset: body.agentPreset,
      })
      return respond({ team: t }, 201)
    }
    const mTeam = path.match(/^\/api\/teams\/([^/]+)$/)
    if (mTeam) {
      const id = decodeURIComponent(mTeam[1])
      // 团队不在本地库 → 交回调用方，不抢答
      const exists = Store.getTeam(id)
      if (!exists) return null
      if (method === 'GET') return respond(exists)
      if (method === 'PATCH') return respond(Store.updateTeam(id, body))
      if (method === 'DELETE') return respond(Store.deleteTeam(id))
    }
    const mTeamMembers = path.match(/^\/api\/teams\/([^/]+)\/members$/)
    if (mTeamMembers) {
      const teamId = decodeURIComponent(mTeamMembers[1])
      // 团队不在本地库 → 交回调用方。
      // 测试与外部系统会 mock fetch 造团队，本地层不该抢答：
      // 抢答了会因外键约束失败，把一个 mock 场景变成 500。
      if (!Store.getTeam(teamId)) return null
      if (method === 'GET') return respond({ items: Store.listMembers(teamId) })
      if (method === 'POST') {
        const exists = Store.findMember(teamId, body.name)
        if (exists) return respond({ member: exists, existed: true }, 200)
        const m = Store.createMember(teamId, body)
        return respond({ member: m }, 201)
      }
    }

    // ── members ──
    const mMember = path.match(/^\/api\/members\/([^/]+)$/)
    if (mMember) {
      const id = decodeURIComponent(mMember[1])
      // 成员不在本地库 → 交回调用方（外部/mock 场景）
      if (!Store.getMember(id)) return null
      if (method === 'GET') return respond(Store.getMember(id))
      if (method === 'PATCH') return respond(Store.updateMember(id, body))
      if (method === 'DELETE') return respond(Store.retireMember(id))
    }

    // ── tasks ──
    if (path === '/api/tasks' && method === 'GET') {
      return respond({
        items: Store.listTasks({
          teamId: q.get('team') || undefined,
          status: q.get('status') || undefined,
          limit: Number(q.get('limit') || 200),
        }),
      })
    }
    if (path === '/api/tasks' && method === 'POST') {
      // 团队不在本地库 → 交回调用方
      const tid = body.teamId || body.team
      if (tid && !Store.getTeam(tid)) return null
      return respond({ task: Store.createTask(body) }, 201)
    }
    const mTask = path.match(/^\/api\/tasks\/([^/]+)$/)
    if (mTask) {
      const id = decodeURIComponent(mTask[1])
      if (method === 'GET') {
        const t = Store.getTask(id)
        return t ? respond(t) : respond({ error: 'not found' }, 404)
      }
      if (method === 'PATCH') return respond(Store.updateTask(id, body))
    }

    // ── messages ──
    if (path === '/api/messages' && method === 'GET') {
      return respond({
        items: Store.listMessages({
          teamId: q.get('team') || undefined,
          limit: Number(q.get('limit') || 80),
        }),
      })
    }
    if (path === '/api/messages' && method === 'POST') {
      return respond({ id: Store.addMessage(body) }, 201)
    }

    // ── memory ──
    if (path === '/api/memory' && method === 'GET') {
      return respond({
        items: Store.listMemory({
          teamId: q.get('team') || undefined,
          limit: Number(q.get('limit') || 200),
        }),
      })
    }
    if (path === '/api/memory' && method === 'POST') {
      return respond({ id: Store.addMemory(body) }, 201)
    }
    const mMem = path.match(/^\/api\/memory\/([^/]+)$/)
    if (mMem) {
      const id = decodeURIComponent(mMem[1])
      const r = Store.getMemory(id)
      return r ? respond(r) : respond({ error: 'not found' }, 404)
    }

    // ── artifacts ──
    if (path === '/api/artifacts' && method === 'GET') {
      return respond({
        items: Store.listArtifacts({
          teamId: q.get('team') || undefined,
          limit: Number(q.get('limit') || 100),
        }),
      })
    }
    if (path === '/api/artifacts' && method === 'POST') {
      return respond({ id: Store.addArtifact(body) }, 201)
    }

    // ── dispatch ──
    if (path === '/api/agents/dispatch' && method === 'POST') {
      // 团队不在本地库 → 交回调用方（mock / 外部场景不该被本地层抢答）
      const tid = body.teamId || body.team
      if (tid && !Store.getTeam(tid)) return null
      const t = Store.createTask({
        teamId: tid,
        assignee: body.assignee || body.member,
        subject: body.subject || body.task,
        body: body.body || body.prompt,
        kind: body.kind,
        status: 'queued',
      })
      return respond({ task: t, dispatched: true }, 201)
    }

    // ── health ──
    if (path === '/api/health' && method === 'GET') {
      return respond({ ok: true, local: true, stats: Store.stats() })
    }

    return respond({ error: `未实现的接口：${method} ${path}` }, 501)
  } catch (e) {
    return respond({ error: String(e && e.message ? e.message : e) }, 500)
  }
}

/**
 * 兼容入口：**不做任何全局副作用**。
 *
 * 第一版这里会替换 globalThis.fetch，把宿主搞崩了。
 * 现在只是空操作——调用方应改用 sidecarFetch()。
 *
 * @returns {function} 空清理函数（保持调用方签名不变）
 */
export function install() {
  // 明确不做全局篡改，只留一句提示，便于排查旧调用点
  if (typeof globalThis.fetch === 'function' && !globalThis.__atcStoreNoteShown) {
    globalThis.__atcStoreNoteShown = true
    // 不打印，避免噪音；需要时手动查看
  }
  return () => {}
}

/**
 * 本地优先的 fetch：命中 sidecar 就用本地库，否则返回 null 交给调用方走真 fetch。
 *
 * 用法：
 *   const local = await sidecarFetch(url, init)
 *   const res = local || await fetch(url, init)
 *
 * @param {string} url
 * @param {object} [init]
 * @returns {Promise<Response|null>}
 */
export async function sidecarFetch(url, init) {
  return handle(url, init || {})
}

export { Store }
