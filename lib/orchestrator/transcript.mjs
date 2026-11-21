/**
 * 会话转录读取 —— 把「面板发出去的提问」对应的「AI 回答」读回来。
 *
 * 为什么需要这个模块：
 * agent.followup() 是「投递并启动回合」的异步语义，返回值通常不是回合结果
 * （实测 turns:1 / result:null）。所以面板只报「已提交」，用户看不到回答——
 * 对话页签等于半个残废。真正的对话内容在宿主 session log 里：
 * <sessionsRoot>/<cwdTag>/<sessionId>/session.v4.jsonl.zstd
 * 本模块把它读成结构化消息数组，面板拿去做气泡渲染。
 *
 * 三个坑（都踩过，别再踩）：
 * 1. 文件是 **zstd 多帧** 拼接。整文件 zstdDecompressSync 只解第一帧，
 * 看起来像「日志只有一行」。必须按帧魔数 28 B5 2F FD 切开逐帧解。
 * 2. 日志里混着宿主注入的 user 消息（运行时上下文 / memsearch 提示）和
 * 插件自己的边界消息，直接显示会给用户看一堆噪音 → 必须过滤。
 * 3. sessions 根目录位置随宿主安装方式变化（Desktop / web / DSH_HOME），
 * 不能写死 → 候选探测，命中才用，全部落空就如实报「找不到会话日志」。
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as zlib from 'node:zlib'

const LOG_NAME = 'session.v4.jsonl.zstd'
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 宿主/插件注入的噪音消息：不当作对话内容展示 */
const NOISE_PATTERNS = [
  /^\[ai-team 面板会话\]/,
  /^当前运行时上下文/,
  /^\[memsearch\]/,
  /^\[project-instructions\]/,
  /^\[system-reminder\]/,
]

/** 解析缓存：同一文件未变化就不重复解压（面板 2 秒轮询一次，不缓存会很浪费） */
const cache = new Map()

/** sessions 根目录候选：按「大概率 → 兜底」排列，命中即止 */
export function sessionsCandidates() {
  const out = []
  const push = (p) => {
    if (typeof p === 'string' && p && !out.includes(p)) out.push(p)
  }
  push(process.env.DSH_SESSIONS_DIR)
  push(process.env.DSH_SESSION_DIR)
  const stateRoot = process.env.DSH_HARNESS_DIR || process.env.DSH_STATE_DIR || process.env.DSH_APPDATA_HOME
  if (stateRoot) push(join(stateRoot, 'sessions'))
  const home = homedir()
  push(join(home, 'AppData', 'Roaming', 'dsh-desktop', 'sessions'))
  push(join(home, '.dsh', 'sessions'))
  push(join(process.env.DSH_USER_DATA_ROOT || 'D:\\软件\\DSH\\用户数据', '.dsh', 'sessions'))
  push('D:\\软件\\DSH\\appdata\\harness\\sessions')
  return out
}

/** 当前实际生效的 sessions 根（第一个存在且有子目录的候选） */
export async function resolveSessionsRoot() {
  for (const root of sessionsCandidates()) {
    if (!existsSync(root)) continue
    try {
      const ents = await readdir(root, { withFileTypes: true })
      if (ents.some((e) => e.isDirectory())) return root
    } catch { /* 读不到就试下一个 */ }
  }
  return null
}

/**
 * 定位某个子会话的日志文件。
 * 两种布局都要认：`<root>/<sid>/` 和 `<root>/<cwdTag>/<sid>/`。
 */
export async function findSessionFile(sessionId) {
  if (!sessionId) return null
  for (const root of sessionsCandidates()) {
    if (!existsSync(root)) continue
    const direct = join(root, sessionId, LOG_NAME)
    if (existsSync(direct)) return { root, file: direct }
    let subs
    try { subs = await readdir(root, { withFileTypes: true }) } catch { continue }
    for (const e of subs) {
      if (!e.isDirectory()) continue
      const f = join(root, e.name, sessionId, LOG_NAME)
      if (existsSync(f)) return { root, file: f }
    }
  }
  return null
}

/** 逐帧解压 zstd；运行时没有 zstd 能力就如实返回原因 */
function decompressFrames(buf) {
  const zstd = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null
  if (!zstd) {
    return { ok: false, reason: 'no-zstd', error: '当前 Node 运行时没有 zstd 解压能力（需要 Node >= 22.15 / 23.8）' }
  }
  const cuts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) cuts.push(i)
  }
  if (!cuts.length) return { ok: false, reason: 'no-frame', error: '文件里没有找到 zstd 帧魔数' }
  const parts = []
  let badFrames = 0
  for (let k = 0; k < cuts.length; k++) {
    const slice = buf.subarray(cuts[k], k + 1 < cuts.length ? cuts[k + 1] : buf.length)
    try { parts.push(zstd(slice)) } catch { badFrames += 1 }
  }
  if (!parts.length) return { ok: false, reason: 'decode-failed', error: `全部 ${cuts.length} 帧解压失败` }
  return { ok: true, text: Buffer.concat(parts).toString('utf8'), frames: cuts.length, badFrames }
}

/** 从消息对象里取纯文本（tool-call / thinking 等非 text block 一律跳过） */
function pickText(message) {
  if (!message) return ''
  const c = message.content
  if (typeof c === 'string') return c.trim()
  if (!Array.isArray(c)) return ''
  return c
    .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
    .map((x) => x.text)
    .join('\n')
    .trim()
}

function isNoise(text) {
  return NOISE_PATTERNS.some((re) => re.test(text))
}

/** 把 jsonl 文本解析成 {role, text, at, seq, usage} 列表 */
function parseEvents(text) {
  const out = []
  const lines = String(text || '').split('\n')
  for (const ln of lines) {
    const s = ln.trim()
    if (!s) continue
    let ev
    try { ev = JSON.parse(s) } catch { continue }
    const type = ev.type || ''
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const data = ev.data || {}
    // 两种事件形状都见过：assistant/message 把消息包在 data.message 里，
    // user/message 直接是 data.{role,content}。少认一种就会丢一半对话。
    const msg = data.message || data
    const role = msg.role || (type === 'user/message' ? 'user' : 'assistant')
    const body = pickText(msg)
    if (!body) continue
    if (role === 'user' && isNoise(body)) continue
    out.push({
      seq: ev.seq,
      role: role === 'user' ? 'user' : 'assistant',
      text: body,
      at: typeof ev.time === 'number' ? new Date(ev.time).toISOString() : null,
      usage: data.usage || null,
      provider: msg.source && msg.source.provider ? msg.source.provider : null,
      model: msg.source && msg.source.model ? msg.source.model : null,
    })
  }
  return out
}

/**
 * 读某个会话的对话转录。
 * @param {string} sessionId 子会话 id
 * @param {{limit?:number}} opt  limit 默认 60（只回最后 N 条）
 */
export async function readTranscript(sessionId, opt = {}) {
  const hit = await findSessionFile(sessionId)
  if (!hit) {
    return {
      ok: false,
      reason: 'no-log',
      sessionId: sessionId || null,
      error: '没找到该会话的日志文件',
      hint: '会话可能还没落盘，或 sessions 根目录不在候选列表里。',
      candidates: sessionsCandidates(),
    }
  }
  let st
  try {
    const { statSync } = await import('node:fs')
    st = statSync(hit.file)
  } catch (err) {
    return { ok: false, reason: 'stat-failed', sessionId, error: String(err && err.message ? err.message : err) }
  }

  const key = hit.file
  const prev = cache.get(key)
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
    return tail(prev.payload, opt.limit, { ...hit, sessionId, cached: true })
  }

  let buf
  try { buf = await readFile(hit.file) } catch (err) {
    return { ok: false, reason: 'read-failed', sessionId, error: String(err && err.message ? err.message : err) }
  }
  const dec = decompressFrames(buf)
  if (!dec.ok) {
    return { ok: false, reason: dec.reason, sessionId, file: hit.file, error: dec.error }
  }
  const messages = parseEvents(dec.text)
  const payload = { messages, frames: dec.frames, badFrames: dec.badFrames }
  cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, payload })
  return tail(payload, opt.limit, { ...hit, sessionId, cached: false })
}

function tail(payload, limit, meta) {
  const all = payload.messages || []
  const n = Math.max(1, Math.min(400, Number(limit) || 60))
  const messages = all.slice(-n)
  return {
    ok: true,
    sessionId: meta.sessionId || null,
    file: meta.file,
    root: meta.root,
    cached: Boolean(meta.cached),
    frames: payload.frames,
    badFrames: payload.badFrames || 0,
    total: all.length,
    messages,
  }
}

/**
 * 从 messages 数组取最近一次非空 usage（）。
 *
 * 为什么需要它：宿主每个 assistant/message 事件都带 data.usage，
 * 但 tail() 只回最后 N 条消息，且 usage 未做「最近一次非空」聚合。
 * 选路要知道「当前上下文占了多大」，就得从最近一轮真实 usage 里读。
 *
 * 关键口径（ 实测）：**当前上下文占用要看 totalTokens，不是 inputTokens**。
 * inputTokens 是单轮新增输入，会随缓存命中大幅缩水（实测同会话 8171 → 3339，
 * 而 totalTokens 从 150298 涨到 165468）。拿 inputTokens 当占用会严重低估，
 * 导致本该拒绝的硬切被放过去。
 *
 * @param {Array} messages parseEvents / readTranscript 返回的消息数组（按 seq 升序）
 * @returns {{inputTokens:number|null, outputTokens:number|null, totalTokens:number|null,
 * cacheReadTokens:number|null, seq:number|null, at:string|null,
 * usedAs:string, note:string}|null}
 * usedAs 说明这次占用是按哪个字段取的（totalTokens 优先，缺失才退回 input+cacheRead）
 */
export function latestUsage(messages) {
  const rows = Array.isArray(messages) ? messages : []
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]
    const u = m && m.usage
    if (!u || typeof u !== 'object') continue
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const input = num(u.inputTokens)
    const output = num(u.outputTokens)
    const total = num(u.totalTokens)
    const cache = num(u.cacheReadTokens)
    // 三者全空 = 这条事件的 usage 是空壳，继续往前找
    if (input == null && output == null && total == null && cache == null) continue
    let usedAs = 'totalTokens'
    let contextTokens = total
    if (contextTokens == null) {
      // totalTokens 缺失：用 input + cacheRead 近似当前窗口占用（不含输出）
      const approx = (input || 0) + (cache || 0)
      if (approx > 0) { usedAs = 'inputTokens+cacheReadTokens'; contextTokens = approx }
      else { usedAs = 'unknown'; contextTokens = null }
    }
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      cacheReadTokens: cache,
      contextTokens,
      usedAs,
      seq: typeof m.seq === 'number' ? m.seq : null,
      at: m.at || null,
      note: usedAs === 'totalTokens'
        ? '按 totalTokens 记当前上下文占用（docs\\108 §2.1）'
        : (usedAs === 'unknown' ? '该事件没有可用占用字段' : 'totalTokens 缺失，用 input+cacheRead 近似'),
    }
  }
  // 没有 usage 记录：会话太新，尚无一轮完成
  return null
}

/** 供排查用：当前探测到哪些 sessions 根、哪些真的存在 */
export async function probeSessions() {
  const rows = []
  for (const root of sessionsCandidates()) {
    let exists = existsSync(root)
    let subdirs = 0
    if (exists) {
      try {
        const ents = await readdir(root, { withFileTypes: true })
        subdirs = ents.filter((e) => e.isDirectory()).length
      } catch { subdirs = -1 }
    }
    rows.push({ root, exists, subdirs })
  }
  return rows
}
