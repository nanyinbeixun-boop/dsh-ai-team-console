/**
 * sessionUsage.mjs —— 「一个会话当前占多少上下文」的唯一取数入口（三路优先，绝不填 0）
 *
 * 为什么单独成模块：这条口径既要给 HTTP 的 op=route-fit 用（lib/index.js），
 * 又要能被离线脚本/自测**原样**调用（验收要求「实测 Lead 会话返回非空数值」）。
 * 写在 handler 闭包里就只能重启服务才验得了，等于没法自证 —— 所以抽出来。
 *
 * 三路优先（）：
 * ① token-meter 投影缓存 pressureTokens / projectedTokens（口径同 tools\lead-context.mjs）
 * —— **Lead（主会话）只有这一路**：它不发 usage 到 session 日志，但 token-meter 一直在投影。
 * ② 会话日志最近一次 assistant/message 的 usage.totalTokens（成员会话口径，）
 * ③ 都取不到 → ok:false + reason，让上层写 note。**不填 0**：0 会让所有候选都判 safe，正好是最危险的方向。
 *
 * 返回值里的 usedField / windowSource 是给面板与验收看的「我用的是哪个字段」，不许省。
 */

import * as Pressure from './pressure.mjs'
import * as Transcript from './transcript.mjs'
import * as Routes from './routes.mjs'

/**
 * @param {string|null} sessionId
 * @returns {Promise<{
 * ok: boolean, sessionId: string|null, source: 'projcache'|'session-log'|null,
 * usage: object|null, currentTokens: number|null,
 * usedField: string|null, windowSource: string|null, contextWindow: number|null,
 * routeKey: string|null, reason?: string, error?: string|null,
 * hint?: string|null, projcacheReason?: string|null, total?: number|null, file?: string|null,
 * }>}
 */
export async function resolveUsage(sessionId) {
  if (!sessionId) {
    return {
      ok: false, sessionId: null, source: null, usage: null, currentTokens: null,
      usedField: null, windowSource: null, contextWindow: null, routeKey: null,
      reason: 'no-session',
    }
  }

  // ① token-meter 投影（Lead 会话的唯一来源）
  const pr = Pressure.readPressure(sessionId)
  if (pr.ok) {
    const lu = pr.model || null
    return {
      ok: true,
      sessionId,
      source: 'projcache',
      usage: {
        // 兼容旧字段名：totalTokens 放 prompt 侧压力，contextTokens 放最终占用（projected 优先）
        totalTokens: pr.pressureTokens,
        contextTokens: pr.usedTokens,
        usedAs: pr.usedField,
        pressureTokens: pr.pressureTokens,
        projectedTokens: pr.projectedTokens,
        contextWindow: pr.contextWindow,
        note: `按 token-meter 口径记占用（${pr.usedField}${pr.projectedTokens !== pr.pressureTokens ? '，已含 surface 增量' : ''}）`,
      },
      currentTokens: pr.usedTokens,
      usedField: pr.usedField,
      windowSource: pr.windowSource,
      contextWindow: pr.contextWindow,
      routeKey: lu && lu.provider && lu.model ? Routes.routeKey({ provider: lu.provider, model: lu.model }) : null,
      total: pr.projectionSeq,
      file: pr.file,
      projcacheReason: null,
    }
  }

  // ② 会话日志（成员会话）
  const tr = await Transcript.readTranscript(sessionId, { limit: 400 })
  if (!tr.ok) {
    return {
      ok: false,
      sessionId,
      source: null,
      usage: null,
      currentTokens: null,
      usedField: null,
      windowSource: null,
      contextWindow: null,
      routeKey: null,
      // 投影缓存「没有」是常态（成员会话也可以没有投影），所以优先报会话日志那边的真实原因
      reason: pr.reason === 'no-projcache' ? (tr.reason || 'read-failed') : (pr.reason || tr.reason || 'read-failed'),
      error: tr.error || pr.error || null,
      projcacheReason: pr.reason || null,
      hint: tr.reason === 'no-log'
        ? '投影缓存与会话日志都没有：会话还没落盘/没被投影（op=chat-probe 查 sessions 根）'
        : null,
    }
  }

  const u = Transcript.latestUsage(tr.messages)
  if (!u) {
    // ③ 有日志但没有 usage：明说，不填 0
    return {
      ok: false,
      sessionId,
      source: null,
      usage: null,
      currentTokens: null,
      usedField: null,
      windowSource: null,
      contextWindow: null,
      routeKey: null,
      reason: 'no-usage',
      projcacheReason: pr.reason || null,
      total: tr.total,
      hint: '该会话还没有一轮完成的 assistant/message 事件（还没有 usage），也没有 token-meter 投影',
    }
  }

  return {
    ok: true,
    sessionId,
    source: 'session-log',
    usage: u,
    currentTokens: u.contextTokens,
    usedField: u.usedAs || 'totalTokens',
    // 会话日志只有 token 数，没有真实窗口 → 窗口来源标 session-log，窗口值交给路由表推
    windowSource: 'session-log',
    contextWindow: null,
    routeKey: null,
    total: tr.total,
    file: tr.file,
    projcacheReason: pr.reason || null,
  }
}
