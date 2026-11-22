/**
 * 本地 sidecar 兼容层 —— 用进程内实现顶替 127.0.0.1:4317。
 *
 * 为什么要有这一层：
 *   插件里有 55 处代码在写 `${SIDECAR}/api/teams` 这类 URL。
 *   如果直接改这些调用点，改动面太大且容易漏。
 *   所以保留 URL 形状，只把 `fetch` 换成「拦截器」：
 *     命中 127.0.0.1:4317/api/*  → 走 localStore
 *     其它 URL                    → 原样放行
 *
 * 兼容口径（对齐旧 sidecar）：
 *   GET  /api/teams                        → { items: [...] }
 *   GET  /api/teams/:id                    → { ...team }
 *   POST /api/teams                        → { team: {...} }
 *   PATCH /api/teams/:id                   → { ...team }
 *   DELETE /api/teams/:id                  → { ok: true }
 *   GET  /api/teams/:id/members            → { items: [...] }
 *   POST /api/teams/:id/members            → { member: {...} }
 *   PATCH /api/members/:id                 → { ...member }
 *   GET  /api/tasks?team=&limit=           → { items: [...] }
 *   GET  /api/tasks/:id                    → { ...task }
 *   POST /api/tasks                        → { task: {...} }
 *   PATCH /api/tasks/:id                   → { ...task }
 *   GET  /api/messages?team=&limit=        → { items: [...] }
 *   POST /api/messages                     → { id }
 *   GET  /api/memory?team=&limit=          → { items: [...] }
 *   GET  /api/memory/:id                   → { ...memory }
 *   POST /api/memory                       → { id }
 *   POST /api/agents/dispatch              → 落一条 task
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
 * 统一响应对象。
 *
 * 必须返回**真 Response**，不能是鸭子类型对象。
 * 踩过的坑：手搓一个带 ok/status/json/headers 的普通对象看起来能用，
 * 但宿主里有代码会对 Response 实例做 WeakMap 缓存
 * （WeakMap<Response, ...>），非 Response 对象当 key 直接抛
 * 「Invalid value used as weak map key」，而且异常会被上层的
 * fetchJson catch 吞成「sidecar 不可达」——表现为团队/成员全部消失，
 * 但数据其实一条没少。所以这里一律构造真 Response。
 */
function respond(data, status = 200) {
  const body = JSON.stringify(data)
  try {
    // 优先走全局真 Response（Node 18+ / Electron 都有）
    return new Response(body, {
      status,
      statusText: status === 200 ? 'OK' : String(status),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-atc-store': 'local',
      },
    })
  } catch {
    // 极老运行时没有全局 Response 时兜底：形状尽量对齐，并显式标记
    const headerPairs = [['content-type', 'application/json; charset=utf-8'], ['x-atc-store', 'local']]
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: {
        get: (n) => (headerPairs.find(([k]) => k === String(n).toLowerCase()) || [])[1] || null,
        has: (n) => headerPairs.some(([k]) => k === String(n).toLowerCase()),
        forEach: (cb) => headerPairs.forEach(([k, v]) => cb(v, k)),
        entries: () => headerPairs[Symbol.iterator](),
        keys: () => headerPairs.map(([k]) => k)[Symbol.iterator](),
        values: () => headerPairs.map(([, v]) => v)[Symbol.iterator](),
        [Symbol.iterator]: () => headerPairs[Symbol.iterator](),
      },
      url: '',
      redirected: false,
      type: 'basic',
      bodyUsed: false,
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
      if (method === 'GET') {
        const t = Store.getTeam(id)
        return t ? respond(t) : respond({ error: 'not found' }, 404)
      }
      if (method === 'PATCH') return respond(Store.updateTeam(id, body))
      if (method === 'DELETE') return respond(Store.deleteTeam(id))
    }
    const mTeamMembers = path.match(/^\/api\/teams\/([^/]+)\/members$/)
    if (mTeamMembers) {
      const teamId = decodeURIComponent(mTeamMembers[1])
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
      if (method === 'GET') {
        const m = Store.getMember(id)
        return m ? respond(m) : respond({ error: 'not found' }, 404)
      }
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

    // ── dispatch：把一个任务派给成员（旧 sidecar 的语义） ──
    if (path === '/api/agents/dispatch' && method === 'POST') {
      const t = Store.createTask({
        teamId: body.teamId || body.team,
        assignee: body.assignee || body.member,
        subject: body.subject || body.task,
        body: body.body || body.prompt,
        kind: body.kind,
        status: 'queued',
      })
      return respond({ task: t, dispatched: true }, 201)
    }

    // ── 健康检查 / 未实现 ──
    if (path === '/api/health' && method === 'GET') {
      return respond({ ok: true, local: true, stats: Store.stats() })
    }

    return respond({ error: `未实现的接口：${method} ${path}` }, 501)
  } catch (e) {
    return respond({ error: String(e && e.message ? e.message : e) }, 500)
  }
}

/**
 * 安装 fetch 拦截器。
 *
 * 做法：包一层 globalThis.fetch。
 * 命中 sidecar 的就本地处理，其它原样转发——这样插件里 55 处调用点一行不改。
 *
 * @returns {function} 卸载函数
 */
export function install() {
  if (typeof globalThis.fetch !== 'function') return () => {}
  if (globalThis.__atcStoreInstalled) return globalThis.__atcStoreUninstall || (() => {})

  const orig = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url)
    const res = await handle(url, init || {})
    if (res) return res
    return orig(input, init)
  }
  globalThis.__atcStoreInstalled = true
  const uninstall = () => {
    globalThis.fetch = orig
    globalThis.__atcStoreInstalled = false
    globalThis.__atcStoreUninstall = null
  }
  globalThis.__atcStoreUninstall = uninstall
  return uninstall
}

export { Store }
