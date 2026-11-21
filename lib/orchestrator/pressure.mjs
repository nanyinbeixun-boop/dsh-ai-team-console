/**
 * pressure.mjs —— 「当前上下文占用」的第三路取数：token-meter 投影缓存
 *
 * 为什么要有它：成员会话日志里有 usage.totalTokens，但 **Lead（主会话）没有**——
 * Lead 的占用只落在宿主持久化的 session 投影缓存里：
 * <harness>/storages/session_projcache/sessions/<sessionId>.json → record.rows.contextPressure.val
 * 以前 route-fit 只读会话日志，于是 Lead 会话一律「拿不到占用」，面板上整条链没有窗口结论。
 *
 * 口径**逐行照搬** tools\lead-context.mjs（不另造第二套，见该文件 36-60 行与 7-11 行的源码依据）：
 *   pressureTokens  = inputTokens + cacheReadTokens + cacheWriteTokens            // 最近一次请求的 prompt 侧压力
 *   projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) // 面向「下一次请求」的占用
 *   usedTokens      = projectedTokens ?? pressureTokens                          // 与 GUI 上下文圆环同源
 * 源码依据 @deepseek-ai/dsh-token-meter/lib/index.js:366/491；
 * GUI 显示规则 @deepseek-ai/dsh-client-ui-conversation/lib/client.js:18510。
 *
 * 只读：本模块只 stat/readFile 投影缓存，不写任何东西、不发网络请求、不碰进程。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** harness 根候选（同名缓存可能出现在多处；按「显式指定 → 环境变量 → 本机既定目录」排） */
function harnessRoots(explicit) {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(explicit)
  push(process.env.DSH_HARNESS_HOME)
  push(process.env.DSH_HARNESS)
  push('D:\\软件\\DSH\\appdata\\harness')
  try {
    push(join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness'))
    push(join(homedir(), '.dsh'))
  } catch { /* homedir 拿不到就只试固定路径 */ }
  return out
}

/** 该会话的投影缓存文件路径（找不到返回 null） */
export function projCacheFile(sessionId, harnessRoot) {
  if (!sessionId) return null
  for (const root of harnessRoots(harnessRoot)) {
    const f = join(root, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    if (existsSync(f)) return { file: f, root }
  }
  return null
}

/**
 * 读一个会话的 token-meter 占用。
 * @returns {{
 * ok: boolean, sessionId: string, file: string|null, root: string|null,
 * reason?: string, error?: string,
 * projectionSeq: number|null, contextWindow: number|null,
 * pressureTokens: number|null, projectedTokens: number|null, usedTokens: number|null,
 * usedField: 'projectedTokens'|'pressureTokens'|null,
 * windowSource: 'session-projcache'|null,
 * model: {provider:string, model:string, reasoningEffort?:string}|null,
 * surfaceTokens: number|null, sampledSurfaceTokens: number|null,
 * breakdown: object|null, lastTurnUsage: object|null,
 * }}
 */
export function readPressure(sessionId, opts = {}) {
  const base = {
    ok: false, sessionId: sessionId || null, file: null, root: null,
    projectionSeq: null, contextWindow: null,
    pressureTokens: null, projectedTokens: null, usedTokens: null,
    usedField: null, windowSource: null,
    model: null, surfaceTokens: null, sampledSurfaceTokens: null,
    breakdown: null, lastTurnUsage: null,
  }
  if (!sessionId) return { ...base, reason: 'no-session' }

  const hit = projCacheFile(sessionId, opts.harnessRoot)
  if (!hit) {
    // 宿主从没投影过这个会话（新会话未跑完一轮），或 harness 路径不是默认值
    return { ...base, reason: 'no-projcache', error: `找不到投影缓存：${sessionId}.json` }
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(hit.file, 'utf8'))
  } catch (e) {
    return { ...base, file: hit.file, root: hit.root, reason: 'bad-projcache', error: String(e && e.message ? e.message : e) }
  }

  // 两种布局都认（与 tools\lead-context.mjs:44 一致）
  const rows = (raw.record && raw.record.rows) || (raw.projections && raw.projections.values) || {}
  const pick = (k) => (rows[k] && rows[k].val) || null

  const p = pick('contextPressure') || {}
  const tokenUsage = pick('tokenUsage') || {}
  const selection = pick('modelSelection') || {}
  const breakdown = pick('contextBreakdown') || {}

  const contextWindow = typeof p.contextWindow === 'number' && p.contextWindow > 0 ? p.contextWindow : null
  const pressureTokens = typeof p.pressureTokens === 'number' && Number.isFinite(p.pressureTokens) ? p.pressureTokens : null
  const surfaceTokens = typeof p.surfaceTokens === 'number' && Number.isFinite(p.surfaceTokens) ? p.surfaceTokens : null
  const sampled = typeof p.sampledSurfaceTokens === 'number' && Number.isFinite(p.sampledSurfaceTokens) ? p.sampledSurfaceTokens : null

  const projectedTokens = pressureTokens != null && surfaceTokens != null && sampled != null
    ? Math.max(0, pressureTokens + surfaceTokens - sampled)
    : pressureTokens

  const usedTokens = projectedTokens ?? pressureTokens
  const usedField = usedTokens == null ? null : (projectedTokens != null && usedTokens === projectedTokens ? 'projectedTokens' : 'pressureTokens')

  if (usedTokens == null) {
    // 有缓存文件但没有 contextPressure 行：明说「无数据」，不填 0
    return {
      ...base, file: hit.file, root: hit.root, reason: 'no-pressure',
      contextWindow, error: '投影缓存里没有 contextPressure.val（该会话还没被 token-meter 采样）',
    }
  }

  const lu = selection.lastUsed || null
  return {
    ok: true,
    sessionId,
    file: hit.file,
    root: hit.root,
    projectionSeq: (rows.contextPressure && rows.contextPressure.seq != null) ? rows.contextPressure.seq : null,
    contextWindow,
    pressureTokens,
    projectedTokens,
    usedTokens,
    usedField,
    windowSource: 'session-projcache',
    model: lu && (lu.provider || lu.model)
      ? { provider: lu.provider || null, model: lu.model || null, reasoningEffort: lu.reasoningEffort || null }
      : null,
    surfaceTokens,
    sampledSurfaceTokens: sampled,
    breakdown: breakdown.breakdown || null,
    lastTurnUsage: tokenUsage.last || null,
  }
}
