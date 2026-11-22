/**
 * dsh-ai-team-console —— 服务端半侧
 *
 * 职责：注册一条 Package 私有 HTTP 桥 `POST/GET /ai-team/api`，把真实数据喂给浏览器侧面板：
 * - 团队花名册（读 dsh-team sidecar HTTP API）
 * - 成员编制与能力域缺口（按预设的能力域模板与本队成员比对）
 * - handbook 文件清单与验收状态（读文件系统）
 *   - preset 真身（读 ~/.dsh/team/presets/*.json）
 * - 任务/消息/记忆（sidecar API）
 *
 * 为什么走 webServer 而不是别的东西：本包零外部依赖，只依赖宿主已提供的 ctx.webServer。
 * 跨源请求由 Origin/Host 校验挡住（同源才放行）。
 */

import { readFile, readdir, stat, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Reg from './orchestrator/registry.mjs'
import * as Pipeline from './orchestrator/pipeline.mjs'
import * as Evolve from './orchestrator/evolve.mjs'
import * as Detect from './orchestrator/detect.mjs'
import * as Chat from './orchestrator/chat.mjs'
import * as Transcript from './orchestrator/transcript.mjs'
import * as Pressure from './orchestrator/pressure.mjs'
import * as SessionUsage from './orchestrator/sessionUsage.mjs'
import * as TeamHealth from './orchestrator/teamHealth.mjs'
import * as LeadProbe from './orchestrator/leadProbe.mjs'
import * as Routes from './orchestrator/routes.mjs'
import * as PresetMgr from './orchestrator/presetManager.mjs'
import * as Artifacts from './orchestrator/artifacts.mjs'
import * as Complexity from './orchestrator/complexity.mjs'
import * as Paths from './orchestrator/paths.mjs'
import * as Host from './orchestrator/host.mjs'
import * as TaskMatch from './orchestrator/taskMatch.mjs'
import * as LocalSidecar from './orchestrator/localSidecar.mjs'

export const name = 'dsh-ai-team-console'
export const inject = ['webServer']

/** 本包根目录（route-config.json 落在这里，遵循「插件数据只进 DSH 数据目录」的约定） */
const PKG_ROOT = (() => {
  try { return dirname(dirname(fileURLToPath(import.meta.url))) } catch { return process.cwd() }
})()

/** 读一次 route-config.json；读盘只在 op 层发生，routes.mjs 保持纯函数 */
async function routeConfig() {
  const r = await Routes.loadRouteConfig(PKG_ROOT)
  return r
}

/* ── 能力域模板：6 个真实岗位（对齐团队编制）───────────────────────
 * 「成员/缺口」页按真实岗位切，不按抽象职能切。缺一个域 = 缺一个岗位。
 * matchRole 同时匹配成员 name 与 role（中文职能），六域互不误判：
 * 所有活跃成员 agentPreset 都是 standard，故 matchPreset 一律为 null ——
 * 否则一个 /^standard$/ 会把全队认领成同一个域（旧版 architect 域踩过这个坑）。
 */
const CAPABILITY_DOMAINS = [
  {
    id: 'pm',
    label: '产品经理',
    covers: '收集需求 / 输出原型 / 规划功能 / 协调各方 / 把控范围与排期',
    matchRole: /architect|产品经理|输出原型|需求范围|版本排期/i,
    matchPreset: null,
    hireWhen: '没人收集需求、排优先级和把控范围，做出来的东西容易跑偏、反复返工，范围还会无限膨胀',
    suggest: { name: 'pm', agentPreset: 'standard', provider: 'workbuddy', model: 'hy4flash-free', effort: 'high' },
  },
  {
    id: 'ui',
    label: 'UI设计',
    covers: '界面 / 图标 / 配色 / 视觉稿',
    matchRole: /ui-designer|UI\s*设计师|图标|配色|视觉稿/i,
    matchPreset: null,
    hireWhen: '没人管界面和视觉，产物能跑但难看、风格不统一，用户一看就不专业',
    suggest: { name: 'ui', agentPreset: 'standard', provider: 'workbuddy', model: 'hy4flash-free', effort: 'high' },
  },
  {
    id: 'frontend',
    label: '前端开发',
    covers: '页面与交互 / 多端适配 / 对接接口 / 兼容性',
    matchRole: /frontend|前端|交互效果|多端|页面兼容/i,
    matchPreset: null,
    hireWhen: '没人把界面做成能操作的页面、适配多端，后端能力做得再好用户也用不上',
    suggest: { name: 'frontend', agentPreset: 'standard', provider: 'workbuddy', model: 'hy4flash-free', effort: 'high' },
  },
  {
    id: 'backend',
    label: '后端开发',
    covers: '业务逻辑 / 接口 / 数据库 / 后台稳定',
    matchRole: /maker|后端开发|数据库|数据服务|后台功能/i,
    matchPreset: null,
    hireWhen: '没人写业务逻辑、接口和管理数据，前端没有数据来源，功能落不了地',
    suggest: { name: 'backend', agentPreset: 'standard', provider: 'workbuddy', model: 'hy4flash-free', effort: 'high' },
  },
  {
    id: 'qa',
    label: '测试',
    covers: '测试用例 / 功能验证 / bug / 回归',
    matchRole: /auditor|测试|回归|QA/i,
    matchPreset: null,
    hireWhen: '没人独立验证和回归，改一处坏一片没人发现，bug 直接送到用户面前',
    suggest: { name: 'qa', agentPreset: 'standard', provider: 'workbuddy', model: 'hy4flash-free', effort: 'high' },
  },
  {
    id: 'devops',
    label: '运维DevOps',
    covers: '部署环境 / 上线发布 / 服务器维护 / 监控 / 故障处理',
    matchRole: /devops|运维|部署|上线|服务器|监控/i,
    matchPreset: null,
    hireWhen: '没人搭环境、上线和监控，东西做完部署不上去，线上出问题也没人及时发现和处理',
    suggest: { name: 'devops', agentPreset: 'standard', provider: 'workbuddy', model: 'hy4flash-free', effort: 'high' },
  },
]

export { CAPABILITY_DOMAINS, analyseGaps, buildChecks }

const SIDECAR_DEFAULT = 'http://127.0.0.1:4317'

function sidecarBase() {
  const env = process.env.DSH_TEAM_SIDECAR_URL || process.env.DSH_TEAM_SIDECAR
  if (env && /^https?:\/\//.test(env)) return env.replace(/\/+$/, '')
  const port = process.env.DSH_TEAM_SIDECAR_PORT
  if (port) return `http://127.0.0.1:${port}`
  return SIDECAR_DEFAULT
}

/**
 * 读 sidecar 风格接口。
 *
 * 本地优先：先问 LocalSidecar.sidecarFetch 能不能处理这个 URL
 * （127.0.0.1:4317/api/*），能就直接用本地库的结果；
 * 不能就走真 fetch。
 *
 * 不再劫持 globalThis.fetch —— 宿主自己也用 fetch（调 LLM、拉模型列表），
 * 上一版换掉全局 fetch 直接把整个应用搞崩了。
 */
async function fetchJson(url, timeoutMs = 4000) {
  const init = { headers: { accept: 'application/json' } }
  try {
    const local = await LocalSidecar.sidecarFetch(url, init)
    if (local) {
      if (!local.ok) return { ok: false, status: local.status, error: `HTTP ${local.status}` }
      return { ok: true, data: await local.json() }
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
  // 非 sidecar 地址：走真网络
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  } finally {
    clearTimeout(timer)
  }
}

/* ── 路径解析：一切落 D 盘（存储铁律），~/.dsh 是 junction ─────────────── */

function userDataRoot() {
  return Paths.userDataRoot()
}

/** 会话预设的两个来源：profile 层（可编辑）+ DSH 安装目录内置（只读） */
function presetProfileFile() {
  return process.env.DSH_PRESET_PROFILE_FILE ||
    Paths.profileFile()
}
function presetBuiltinDir() {
      return process.env.DSH_PRESET_BUILTIN_DIR ||
        join(process.env.DSH_APP_DIR || process.cwd(), 'resources', 'app',
          'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets')
}

function dshHome() {
  const env = process.env.DSH_HOME
  if (env) return env
  const home = homedir()
  // ~/.dsh 在本机是指向 D 盘的 junction；两种写法的最终目标相同，
  // 但 readdir 对 junction 的解析行为不一致，挨个探，取第一个真存在的。
  const candidates = [
    join(home, '.dsh'),
    join(userDataRoot(), '.dsh'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

function handbookRoot() {
  return join(userDataRoot(), '_AI团队手册')
}

function presetDir() {
  const env = process.env.DSH_TEAM_PRESET_DIR
  if (env) return env
  // 显式优先取 D 盘那侧（junction 目标），避免 homedir 侧读不到
  const dSide = join(userDataRoot(), '.dsh', 'team', 'presets')
  if (existsSync(dSide)) return dSide
  return join(dshHome(), 'team', 'presets')
}

async function safeDir(dir) {
  try {
    const names = await readdir(dir)
    const out = []
    for (const nm of names) {
      const full = join(dir, nm)
      try {
        const st = await stat(full)
        out.push({ name: nm, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs })
      } catch { /* 单个条目读不到就跳过 */ }
    }
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    return out
  } catch {
    return null
  }
}

async function readJsonFile(path) {
  try {
    const raw = await readFile(path, 'utf8')
    return { ok: true, data: JSON.parse(raw) }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

/**
 * 简单短哈希（T15）：给「存为工作项」生成 ASCII 短 id。
 * 不依赖 crypto（避免在受限环境报错），用 FNV-1a 32 位取 8 位小写 hex。
 * 输入含中文也稳定（按 UTF-16 code unit 算），保证 id 不含中文。
 */
function simpleHash(input) {
  let h = 0x811c9dc5
  const s = String(input || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8)
}

/* ── 能力域缺口分析 ───────────────────────────────────────────────── */

function analyseGaps(members) {
  // 只有能真干活的成员才算岗位承接人：retired（已退休）与 failed（派发失败、
  // 拉不起来）都不算。否则唯一承接人退休/失败时，缺口页仍显示该岗位齐备，
  // capability-covered 也跟着假通过（已修的假齐备）。
  // 不过滤 idle/running：idle 只是此刻没在跑，仍是有效承接人。
  const active = (Array.isArray(members) ? members : []).filter(
    (m) => m && m.status !== 'retired' && m.status !== 'failed')
  const rows = CAPABILITY_DOMAINS.map((dom) => {
    const owners = active.filter((m) => {
      const roleHit = dom.matchRole.test(String(m.role || '')) || dom.matchRole.test(String(m.name || ''))
      const presetHit = dom.matchPreset && dom.matchPreset.test(String(m.agentPreset || ''))
      return roleHit || presetHit
    })
    return {
      id: dom.id,
      label: dom.label,
      covers: dom.covers,
      status: owners.length > 0 ? 'covered' : 'missing',
      owners: owners.map((m) => ({ id: m.id, name: m.name, model: m.model, agentPreset: m.agentPreset, status: m.status })),
      hireWhen: dom.hireWhen,
      suggest: owners.length > 0 ? null : dom.suggest,
    }
  })
  const missing = rows.filter((r) => r.status === 'missing')
  return { rows, missing, coveredCount: rows.length - missing.length, total: rows.length }
}

/* ── handbook 巡检 ────────────────────────────────────────────────── */

const REQUIRED_HANDBOOK = [
  { file: '00-协议.md', label: '工作项协议' },
  { file: '01-成员卡.md', label: '成员卡（六段式 prompt 全文）' },
  { file: '02-preset.md', label: 'preset 说明（plugins + persona）' },
  { file: '03-验收清单.md', label: '验收清单（A/B/C/D）' },
  { file: '04-启动指令.md', label: '工作项化启动指令' },
  { file: '99-本轮变更.md', label: '本轮变更清单' },
]

async function scanHandbook(scenario) {
  const dir = join(handbookRoot(), scenario)
  const entries = await safeDir(dir)
  if (!entries) {
    return { dir, exists: false, files: [], missing: REQUIRED_HANDBOOK.map((r) => r.file), audits: [] }
  }
  const byName = new Map(entries.filter((e) => !e.isDir).map((e) => [e.name, e]))
  const files = REQUIRED_HANDBOOK.map((req) => {
    const hit = byName.get(req.file)
    return {
      file: req.file,
      label: req.label,
      exists: Boolean(hit),
      size: hit ? hit.size : 0,
      mtime: hit ? hit.mtime : null,
      emptySkeleton: hit ? hit.size < 400 : true,
    }
  })
  const audits = entries
    .filter((e) => !e.isDir && /^98-审计报告.*\.md$/.test(e.name))
    .map((e) => ({ file: e.name, size: e.size, mtime: e.mtime }))
  const extras = entries.filter((e) => !e.isDir && !REQUIRED_HANDBOOK.some((r) => r.file === e.name) && !/^98-/.test(e.name))
    .map((e) => ({ name: e.name, size: e.size, mtime: e.mtime }))
  return {
    dir,
    exists: true,
    files,
    extras,
    missing: files.filter((f) => !f.exists).map((f) => f.file),
    placeholderSkeleton: files.filter((f) => f.exists && f.emptySkeleton).map((f) => f.file),
    audits,
  }
}

/* ── preset 真身 ──────────────────────────────────────────────────── */

async function scanPresets() {
  const dir = presetDir()
  const entries = await safeDir(dir)
  if (!entries) return { dir, exists: false, presets: [] }
  const presets = []
  for (const e of entries) {
    if (e.isDir || !e.name.endsWith('.json')) continue
    const read = await readJsonFile(join(dir, e.name))
    if (!read.ok) {
      presets.push({ id: basename(e.name, '.json'), file: e.name, size: e.size, parseError: read.error })
      continue
    }
    const doc = read.data || {}
    const plugins = Array.isArray(doc.plugins) ? doc.plugins : []
    const persona = plugins.find((p) => p && /dsh-persona/.test(String(p.name || '')))
    const prefix = persona && persona.config ? String(persona.config.prefix || '') : ''
    presets.push({
      id: doc.id || basename(e.name, '.json'),
      name: doc.name || '',
      description: doc.description || '',
      order: doc.order,
      file: e.name,
      size: e.size,
      mtime: e.mtime,
      pluginCount: plugins.length,
      pluginNames: plugins.map((p) => String((p && p.name) || '')),
      personaChars: prefix.length,
      personaText: prefix,
      hasPersona: prefix.length > 0,
    })
  }
  presets.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return { dir, exists: true, presets }
}

/* ── 团队快照（sidecar） ──────────────────────────────────────────── */

async function collectTeam(teamId) {
  const base = sidecarBase()
  const teamsRes = await fetchJson(`${base}/api/teams`)
  const allTeams = teamsRes.ok
    ? (Array.isArray(teamsRes.data) ? teamsRes.data : teamsRes.data && Array.isArray(teamsRes.data.items) ? teamsRes.data.items : [])
    : []
  const tid = teamId || (allTeams[0] && allTeams[0].id) || null
  const out = {
    sidecar: { base, reachable: teamsRes.ok, error: teamsRes.ok ? null : teamsRes.error },
    teams: allTeams,
    teamId: tid,
    members: [],
    tasks: [],
    messages: [],
    memory: [],
    approvals: [],
    warnings: [],
  }
  if (!teamsRes.ok) return out
  if (!tid) {
    out.warnings.push('sidecar 可达但没有任何团队')
    return out
  }
  const [membersRes, tasksRes, msgRes, memRes] = await Promise.all([
    fetchJson(`${base}/api/teams/${tid}/members`),
    fetchJson(`${base}/api/tasks?team=${tid}&limit=200`),
    fetchJson(`${base}/api/messages?team=${tid}&limit=80`),
    fetchJson(`${base}/api/memory?team=${tid}&limit=200`),
  ])
  const pick = (res, key) => {
    if (!res.ok) return []
    const d = res.data
    if (Array.isArray(d)) return d
    if (d && Array.isArray(d.items)) return d.items
    if (d && Array.isArray(d[key])) return d[key]
    return []
  }
  // 只把在职成员放进快照。
  // retired 是已退役的历史记录，混进来会让 UI 把 11 条记录显示成「11 个成员」，
  // 而实际上班的只有 6 个。过滤放在源头，前端各页面就不必各写一遍。
  out.members = pick(membersRes, 'members').filter(
    (m) => m && m.status !== 'retired' && m.status !== 'failed',
  )
  out.tasks = pick(tasksRes, 'tasks')
  out.messages = pick(msgRes, 'messages')
  out.memory = pick(memRes, 'memories')
  if (!membersRes.ok) out.warnings.push(`成员接口不可用：${membersRes.error}`)
  if (!tasksRes.ok) out.warnings.push(`任务接口不可用：${tasksRes.error}`)
  if (!memRes.ok) out.warnings.push(`记忆接口不可用（成员 session 调用会 403，lead 可读）：${memRes.error}`)
  out.gaps = analyseGaps(out.members)
  // 99 规格修复 C 的插件侧降级：把「有记录但派不动」的成员标出来。
  // 只靠成员 status 会把「会话绑在旧父会话上」显示成 idle，用户以为在待命。
  out.teamHealth = TeamHealth.annotateMembers(
    TeamHealth.activeMembers(out.members))
  if (out.teamHealth.needsRebuild.length) {
    out.warnings.push(
      `成员会话失效（需重建）：${out.teamHealth.needsRebuild.map((x) => x.name).join('、')}`
      + ' —— 会话绑在旧父会话上（belongs to another parent session），'
      + 'retire 后由当前 Lead 重新 dsh_team_spawn 才能派活。')
  }
  if (out.teamHealth.unboundNames.length) {
    out.warnings.push(
      `成员只有记录、无宿主会话：${out.teamHealth.unboundNames.join('、')}`
      + ' —— 需要宿主 dsh_team_spawn 拉起，否则任务派不进去。')
  }
  return out
}

/* ── 页面快照（一次给全，面板不再来回请求） ─────────────────────────── */

async function buildSnapshot(query) {
  const scenario = String(query.scenario || 'ai-team')
  const teamId = query.team || null
  const [team, handbook, presets, handbookDirList] = await Promise.all([
    collectTeam(teamId),
    scanHandbook(scenario),
    scanPresets(),
    safeDir(handbookRoot()),
  ])
  const scenarios = (handbookDirList || []).filter((e) => e.isDir).map((e) => e.name)
  const akPreset = presets.presets.find((p) => p.id === scenario) || presets.presets[0] || null
  return {
    generatedAt: new Date().toISOString(),
    scenario,
    scenarios,
    roots: {
      userData: userDataRoot(),
      handbook: handbookRoot(),
      presets: presetDir(),
      dshHome: dshHome(),
    },
    team,
    gaps: team.gaps || analyseGaps(team.members),
    teamHealth: team.teamHealth || TeamHealth.annotateMembers(TeamHealth.activeMembers(team.members)),
    handbook,
    presets,
    activePreset: akPreset,
    checks: buildChecks({ team, handbook, activePreset: akPreset }),
  }
}

/* ── 验收自检（把手册里的 A 段变成可点出来的数字） ──────────────────── */

function buildChecks({ team, handbook, activePreset }) {
  const items = []
  const members = team.members || []
  items.push({
    id: 'preset-registered',
    label: '工作项 preset 存在且带 persona',
    pass: Boolean(activePreset && activePreset.hasPersona),
    detail: activePreset ? `${activePreset.id} · ${activePreset.pluginCount} 条插件 · persona ${activePreset.personaChars} 字` : '未找到任何 preset',
  })
  const twoRequired = activePreset
    ? ['@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-todo'].every((p) => activePreset.pluginNames.includes(p))
    : false
  items.push({
    id: 'preset-required-config',
    label: '两条必填 config 依赖在场（fs-search / todo）',
    pass: twoRequired,
    detail: twoRequired ? 'fs-search + todo 均在清单内（config 值需开 json 核对）' : '缺少 fs-search 或 todo，preset 会 broken',
  })
  // 在编人数才算名额（retired/failed 不占名额）：旧版用 members.length 把退休成员也算进去，
  // 11 条记录（在编 6 + 退休 5）会被误判超上限 8 → 假报红。
  const cappedMax = Number((team.teams || []).find((t) => t.id === team.teamId)?.maxMembers || 8)
  const activeMembers = members.filter((m) => m.status !== 'retired' && m.status !== 'failed')
  const offRoster = members.length - activeMembers.length
  items.push({
    id: 'members-capped',
    label: '成员数在上限内',
    pass: activeMembers.length > 0 && activeMembers.length <= cappedMax,
    detail: activeMembers.length > cappedMax
      ? `在编 ${activeMembers.length} 人 · 上限 ${cappedMax}：超上限 ${activeMembers.length - cappedMax} 人，到「成员」页调整上限或退休成员`
      : `在编 ${activeMembers.length} 人 · 上限 ${cappedMax}` + (offRoster > 0 ? `（另有 ${offRoster} 人已退休）` : ''),
  })
  const idle = members.filter((m) => String(m.status) === 'idle')
  const everWorked = members.filter((m) => m.currentTaskId || Number(m.seq || 0) > 3)
  items.push({
    id: 'members-not-idle',
    label: '成员都实际干过活（不是全程待命）',
    pass: members.length > 0 && everWorked.length > 0,
    detail: members.length
      ? `${everWorked.length}/${members.length} 人有过任务活动 · 当前 ${idle.length} 人 idle（idle 只是「此刻没在跑」，不代表没干活）`
      : '无成员',
  })
  const gaps = analyseGaps(members)
  items.push({
    id: 'capability-covered',
    label: '六大岗位齐全（产品/UI/前端/后端/测试/运维）',
    pass: gaps.missing.length === 0,
    detail: gaps.missing.length
      ? `缺 ${gaps.missing.length} 个岗位：${gaps.missing.map((g) => g.label).join('、')}`
      : '六个岗位都有承接',
  })
  items.push({
    id: 'handbook-complete',
    label: 'handbook 六件齐全且非空骨架',
    pass: handbook.exists && handbook.missing.length === 0 && handbook.placeholderSkeleton.length === 0,
    detail: !handbook.exists
      ? '目录不存在'
      : handbook.missing.length
        ? `缺 ${handbook.missing.join('、')}`
        : handbook.placeholderSkeleton.length
          ? `空骨架：${handbook.placeholderSkeleton.join('、')}`
          : '六件齐全',
  })
  items.push({
    id: 'handbook-audited',
    label: '已有审计报告',
    pass: (handbook.audits || []).length > 0,
    detail: (handbook.audits || []).length ? handbook.audits.map((a) => a.file).join('、') : '还没有审计报告',
  })
  const memOk = (team.memory || []).length > 0
  items.push({
    id: 'handoff-present',
    label: 'handoff 记忆已留痕',
    pass: memOk,
    detail: memOk ? `${team.memory.length} 条` : '0 条（成员 session 写 memory 会 403，只有 lead 能写）',
  })
  // 成员「能干活」而不是「有记录」。这一项专治「看着 idle 其实派不动」。
  const th = team.teamHealth || null
  if (th) {
    const bad = (th.counts.unbound || 0) + (th.counts.stale || 0)
    items.push({
      id: 'members-session-usable',
      label: '成员会话可用（有会话且归属有效，能真派活）',
      pass: th.counts.total > 0 && bad === 0,
      detail: th.counts.total === 0
        ? '团队里没有活成员'
        : `${th.summary}${th.counts.stale
          ? `；${th.staleNames.join('、')} 需 retire 后重新 spawn`
          : ''}${th.counts.unbound
          ? `；${th.unboundNames.join('、')} 需宿主 dsh_team_spawn 拉起`
          : ''}`,
    })
  }
  return { items, passed: items.filter((i) => i.pass).length, total: items.length }
}

/* ── HTTP 桥 ──────────────────────────────────────────────────────── */

function sameOrigin(req) {
  // 本机回环一律放行：官方桌面端 Origin 常是 app:// / file://，判空后会误 403。
  // 非回环才要求 Origin 与 Host 同源。
  const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (loopback) return true
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return true
  const origin = req.headers && req.headers.origin
  if (!origin) return true
  try {
    const u = new URL(origin)
    return !host || u.host === host
  } catch {
    return false
  }
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function handle(ctx, req, res) {
  if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin denied' })
  const url = new URL(req.url, 'http://127.0.0.1')
  const op = url.searchParams.get('op') || 'snapshot'
  const method = (req.method || 'GET').toUpperCase()

  // 读请求体（只有写操作需要）
  const readBody = async () => {
    if (method === 'GET') return {}
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
  }

  try {
    /* ── 读：快照 / 健康 / 场景 / 步骤目录 ─────────────────────── */
    if (op === 'snapshot') {
      return json(res, 200, await buildSnapshot({
        scenario: url.searchParams.get('scenario'),
        team: url.searchParams.get('team'),
      }))
    }
    if (op === 'health') {
      const base = sidecarBase()
      const probe = await fetchJson(`${base}/api/teams`, 2000)
      return json(res, 200, { ok: true, sidecar: { base, reachable: probe.ok, error: probe.ok ? null : probe.error } })
    }
    if (op === 'scenarios') {
      const base = await Reg.listScenarios()
      // 惰性对账：会话里建的团队自动补建成工作项、leadSessionId 不一致的反向修正。
      // sidecar 不可达时不阻断面板——退回原注册表数据（对账是增强，不是依赖）。
      try {
        const tRes = await fetchJson(`${sidecarBase()}/api/teams`, 4000)
        const teams = tRes.ok ? (tRes.data.items || tRes.data || []) : []
        const rec = Reg.reconcileTeams(teams, base.scenarios)
        if (rec.changed) await Reg.replaceScenarios(rec.scenarios)
        return json(res, 200, { ...base, scenarios: rec.scenarios, sync: {
          ok: true, added: rec.added, repaired: rec.repaired, changed: rec.changed,
        } })
      } catch (e) {
        return json(res, 200, { ...base, sync: { ok: false, error: String(e && e.message ? e.message : e) } })
      }
    }
    if (op === 'sync-teams') {
      // 供前端主动触发（与 scenarios 同一套对账逻辑，显式返回变更清单）
      try {
        const base = await Reg.listScenarios()
        const tRes = await fetchJson(`${sidecarBase()}/api/teams`, 4000)
        const teams = tRes.ok ? (tRes.data.items || tRes.data || []) : []
        const rec = Reg.reconcileTeams(teams, base.scenarios)
        if (rec.changed) await Reg.replaceScenarios(rec.scenarios)
        return json(res, 200, { ok: true, added: rec.added, repaired: rec.repaired, changed: rec.changed, scenarios: rec.scenarios })
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e && e.message ? e.message : e) })
      }
    }
    if (op === 'steps') {
      return json(res, 200, { ok: true, steps: Pipeline.stepCatalog })
    }
    /* ── 先进编排（迭代 2/4）：结构化工件 schema / 复杂度路由 ────── */
    if (op === 'artifact-schema') {
      // GET 无参数：schema 目录；GET/POST id=xxx：渲染该类工件的填写模板；
      // POST text=xxx（或 body.text）+ id：校验字段覆盖率。
      const id = url.searchParams.get('id')
      const template = url.searchParams.get('template')
      if (!id) return json(res, 200, { ok: true, schemas: Artifacts.listSchemas() })
      if (template === '1' || template === 'true') {
        const tpl = Artifacts.renderTemplate(id)
        return tpl
          ? json(res, 200, { ok: true, id, template: tpl })
          : json(res, 400, { ok: false, error: `未知工件类型：${id}`, known: ['brief', 'delivery', 'audit'] })
      }
      return json(res, 200, {
        ok: true,
        id,
        schema: Artifacts.ARTIFACT_SCHEMAS[id] || null,
        known: ['brief', 'delivery', 'audit'],
      })
    }
    if (op === 'artifact-validate') {
      const body = await readBody()
      const id = body.id || url.searchParams.get('id')
      if (!id) return json(res, 400, { ok: false, error: 'id 必填（brief|delivery|audit）' })
      const v = Artifacts.validateArtifact(id, body.text || '')
      return json(res, 200, { ok: v.ok, id, ...v })
    }
    if (op === 'complexity-route') {
      // GET 无参数：四问目录 + 三档定义；带 answers（GET query 或 POST body）：定档 + 判定轨迹
      let answers = null
      if (url.searchParams.get('answers')) {
        try { answers = JSON.parse(url.searchParams.get('answers')) } catch { answers = null }
      }
      if (!answers) {
        const body = await readBody().catch(() => ({}))
        if (body && body.answers && typeof body.answers === 'object') answers = body.answers
        else if (body && typeof body === 'object' && (body.products !== undefined || body.predictable !== undefined || body.verify !== undefined || body.independent !== undefined)) answers = body
      }
      if (!answers) {
        return json(res, 200, { ok: true, ...Complexity.routeCatalog() })
      }
      const lv = Complexity.routeLevel(answers)
      return json(res, 200, { ok: true, ...lv })
    }
    if (op === 'preflight') {
      const id = url.searchParams.get('scenario')
      if (!id) return json(res, 400, { ok: false, error: 'scenario 必填' })
      return json(res, 200, await Reg.preflight(id))
    }

    /* ── 写：建场景 / 改场景 / 跑流水线 ───────────────────────── */
    if (op === 'scenario-add') {
      const body = await readBody()
      // T15：服务端兜底。客户端会传 workspace/kind/presetId/name/constraints，
      // 但 id 可能缺或非法；这里按「ASCII 短哈希」兜底生成，并让 kind/preset 跟随。
      let rec = { ...body }
      if (rec.kind) rec.kind = Reg.sceneKindFromDetect(rec.kind) // 把 detect 原始 kind 归一
      if (!rec.id) {
        const h = simpleHash(rec.workspace || rec.name || 'proj')
        rec.id = 'proj-' + h
      }
      // 兜底 preset：没传或传了非法就按 kind 给
      if (!rec.presetId) rec.presetId = Reg.presetForKind(rec.kind || 'general')
      const added = await Reg.addScenario(rec)
      // T15 验收⑤：id 重复要明确提示，不能静默
      if (!added.ok) {
        const dup = Array.isArray(added.errors) && added.errors.some((e) => /已存在/.test(e))
        return json(res, 200, {
          ok: false,
          reason: dup ? 'duplicate' : 'invalid',
          errors: added.errors,
          hint: dup
            ? '该工作项 id 已存在。换一个 id，或到「工作项 / 编排」页管理已有项。'
            : (added.errors || []).join('；'),
        })
      }
      return json(res, 200, added)
    }
    if (op === 'scenario-update') {
      const body = await readBody()
      const id = body.id || url.searchParams.get('scenario')
      if (!id) return json(res, 400, { ok: false, error: 'id 必填' })
      const { id: _drop, ...patch } = body
      return json(res, 200, await Reg.updateScenario(id, patch))
    }
    if (op === 'scenario-delete') {
      const body = await readBody()
      const id = body.id || url.searchParams.get('scenario')
      if (!id) return json(res, 400, { ok: false, error: 'id 必填' })
      // T17：运行中（running/closing/awaiting）拒绝删除，避免删掉正在跑的场景
      const cur = await Reg.getScenario(id)
      if (!cur) {
        return json(res, 200, { ok: false, reason: 'not-found', errors: [`场景 ${id} 不存在`], hint: '该工作项不存在或已被删除。' })
      }
      if (['running', 'closing', 'awaiting'].includes(cur.state)) {
        return json(res, 200, {
          ok: false,
          reason: 'running',
          errors: [`场景 ${id} 当前 state=${cur.state}，不能删除`],
          hint: `运行中/收口中/等拍板的工作项不可删除。先等它回到 idle/done/opening 再删。`,
        })
      }
      const r = await Reg.removeScenario(id)
      return json(res, 200, r)
    }
    /* ── 手动标记本轮完成：running/awaiting → closing → done（两步走状态机）── */
    if (op === 'round-done') {
      const body = await readBody()
      const id = body.scenarioId || url.searchParams.get('scenario')
      if (!id) return json(res, 400, { ok: false, error: 'scenarioId 必填' })
      // 第一步：closing。失败（如 idle→closing 非法、场景不存在）如实报，不继续。
      const s1 = await Reg.setState(String(id), 'closing')
      if (!s1.ok) {
        return json(res, 200, { ok: false, step: 'closing', errors: s1.errors, hint: s1.hint, allowed: s1.allowed })
      }
      // 第二步：done。setState 内部在 to==='done' 时 rounds+1 并做一致性校验。
      // 若失败，工作项停在 closing——必须如实告知，绝不绕过状态机直接改 rounds。
      const s2 = await Reg.setState(String(id), 'done')
      if (!s2.ok) {
        return json(res, 200, { ok: false, step: 'done', state: 'closing',
          errors: s2.errors, hint: s2.hint, note: '工作项停在「收尾中(closing)」，未绕过状态机改轮次' })
      }
      return json(res, 200, { ok: true, state: 'done', rounds: s2.scenario.rounds, scenarioId: String(id) })
    }
    if (op === 'run') {
      const body = await readBody()
      const id = body.scenarioId || url.searchParams.get('scenario')
      if (!id) return json(res, 400, { ok: false, error: 'scenarioId 必填' })
      // 把宿主 ctx 透传给 pipeline，让 S2 能自动开 Lead 会话写 leadSessionId
      // 选路开关（）：freeDisabled=true 或 freeRoutes=false 时全走付费链，
      // freePool 可注入当天巡检（check-free-routes.mjs）的可用清单。
      const out = await Pipeline.runPipeline(id, {
        from: body.from,
        to: body.to,
        hostCtx: ctx,
        freeDisabled: body.freeDisabled === true || body.freeRoutes === false,
        freePool: Array.isArray(body.freePool) ? body.freePool : undefined,
        // 倍率/provider 门槛：把盘上的 route-config.json 注入流水线，
        // 让 S2_5 建成员时与 op=routes 用同一套门槛（不然面板显示可用、实际建不出来）
        routeConfig: (await routeConfig()).config,
        // 先进编排迭代 4：开团前四问答案（可选）。给了就定档并把判定留痕进 trace
        routeAnswers: body.routeAnswers && typeof body.routeAnswers === 'object' ? body.routeAnswers : null,
        // 先进编排迭代 3：显式跳过首件门（临时场景默认跳过）
        skipFirstPieceGate: body.skipFirstPieceGate === true,
      })
      return json(res, 200, out)
    }

    /* ── 写：招募成员（图1 的缺口 → 一键招） ───────────────────── */
    if (op === 'hire') {
      const body = await readBody()
      const teamId = body.teamId
      if (!teamId) return json(res, 400, { ok: false, error: 'teamId 必填' })

      // 先查名额：maxMembers 满了就只能排队，不能骗用户说招到了
      const tRes = await fetchJson(`${sidecarBase()}/api/teams`, 4000)
      const teams = tRes.ok ? (tRes.data.items || tRes.data || []) : []
      const team = teams.find((t) => t.id === teamId)
      if (!team) return json(res, 404, { ok: false, error: `团队 ${teamId} 不存在` })

      const mRes = await fetchJson(`${sidecarBase()}/api/teams/${teamId}/members`, 4000)
      const members = mRes.ok ? (mRes.data.items || []) : []
      const active = members.filter((m) => m.status !== 'retired')
      const cap = Number(team.maxMembers || 3)

      if (active.length >= cap) {
        return json(res, 200, {
          ok: false,
          reason: 'quota',
          detail: `名额已满（${active.length}/${cap}）。新成员会进 queued，不会真正干活。`,
          options: [
            '先 retire 一个不再需要的成员腾位',
            '到「成员」页把团队人数上限调高（即时生效，不用重建团队）',
            '不招人：把这块活派给现有成员',
          ],
          active: active.map((m) => ({ id: m.id, name: m.name, status: m.status })),
        })
      }

      const want = body.member || {}
      const probe = await fetchJsonPOST(`${sidecarBase()}/api/teams/${teamId}/members`, {
        name: want.name || 'recruit',
        role: want.role || want.name || 'teammate',
        model: want.model || null,
        agentProvider: want.agentProvider || null,
        agentPreset: want.agentPreset || 'standard',
        reasoningEffort: want.reasoningEffort || null,
        permissionPreset: want.permissionPreset || 'danger-full-access',
        contextMode: 'fresh',
      }, 8000)

      if (!probe.ok) {
        return json(res, 200, { ok: false, reason: 'sidecar', detail: probe.error, raw: probe.data })
      }
      return json(res, 200, {
        ok: true,
        member: probe.data,
        note: '成员记录已建。它要真正能干活，还需要宿主侧拉起会话（dsh_team_spawn 那一步）。',
      })
    }

    /* ── 自我迭代：skill 库 / 蒸馏 / 启用 ─────────────────────── */
    if (op === 'skills') {
      return json(res, 200, await Evolve.listSkills())
    }
    if (op === 'distill') {
      const body = await readBody()
      const id = body.scenarioId || url.searchParams.get('scenario')
      if (!id) return json(res, 400, { ok: false, error: 'scenarioId 必填' })
      return json(res, 200, await Evolve.maybeDistill(id))
    }
    if (op === 'skill-approve') {
      const body = await readBody()
      const id = body.scenarioId || url.searchParams.get('scenario')
      if (!id) return json(res, 400, { ok: false, error: 'scenarioId 必填' })
      return json(res, 200, await Evolve.approveSkill(id))
    }
    /* ── 蒸馏门槛配置：GET 读当前值 / POST 写 distillMinRounds(1-10) ── */
    if (op === 'evolve-config') {
      if (method === 'GET') {
        return json(res, 200, { ok: true, ...(await Evolve.readEvolveConfig()), range: Evolve.DISTILL_ROUNDS_RANGE })
      }
      const body = await readBody()
      const err = Evolve.validateMinRounds(body.distillMinRounds)
      if (err) return json(res, 400, { ok: false, error: err })
      return json(res, 200, await Evolve.writeEvolveConfig(body.distillMinRounds))
    }

    /* ── 选文件夹：探测 + 临时开团（不写注册表） ───────────────── */
    if (op === 'detect') {
      const dir = url.searchParams.get('dir')
      if (!dir) return json(res, 400, { ok: false, error: 'dir 必填' })
      return json(res, 200, await Detect.detectProject(dir))
    }
    if (op === 'workspace-suggest') {
      return json(res, 200, { ok: true, roots: await Detect.suggestWorkspaces({ userDataRoot: userDataRoot() }), kinds: Detect.knownKinds })
    }
    /* ── 浏览任意文件夹：dir-list（只列目录、规范化、500 限、错误可读）── */
    if (op === 'dir-list') {
      const raw = url.searchParams.get('path') || (await readBody()).path
      const fail = (error, code) => json(res, code || 200, { ok: false, path: raw || '', parent: null, dirs: [], error })
      // 空 path = 从根开始浏览（面板刚打开、输入框还没值）：返回有权限的盘符根列表，不报错。
      // 只有「非空但无效」才是真错误，保留原错误处理不吞。
      if (!raw || !String(raw).trim()) {
        const dirs = Detect.driveRoots().map((d) => ({ name: d.path, path: d.path }))
        return json(res, 200, { ok: true, path: '', parent: null, dirs })
      }
      const p = Detect.normalizeDir(raw)
      if (!p) return fail('路径无效：请给一个有效的文件夹路径', 400)
      if (!existsSync(p)) return fail('目录不存在：' + p)
      try {
        const names = await readdir(p)
        const dirs = []
        for (const name of names) {
          if (dirs.length >= 500) break
          const full = join(p, name)
          try { if (!(await stat(full)).isDirectory()) continue } catch { continue } // 跟随 junction/软链；坏链跳过
          dirs.push({ name, path: full })
        }
        dirs.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))
        const parentRaw = dirname(p)
        // 盘符根（D:\）或已到顶：parent=null，别让用户"上一级"跑到黑洞
        const parent = (parentRaw === p || /^[A-Za-z]:[\\/]?$/.test(p)) ? null : parentRaw
        return json(res, 200, { ok: true, path: p, parent, dirs })
      } catch (e) {
        return fail('无法读取目录：' + (e && e.message ? e.message : String(e)))
      }
    }
    /* ── 自定义工作区根：增/删（写 plugin-data/workspace-roots.json，去重+校验存在）── */
    if (op === 'workspace-add-root' || op === 'workspace-remove-root') {
      const body = await readBody()
      const raw = body.path || url.searchParams.get('path')
      const p = Detect.normalizeDir(raw)
      if (!p) return json(res, 400, { ok: false, error: 'path 必填且需为有效路径' })
      const file = Detect.workspaceRootsFile(userDataRoot())
      let roots = []
      try { roots = JSON.parse((await readFile(file, 'utf8')).replace(/^\ufeff/, '')).roots || [] } catch { /* 不存在/坏文件 → 空 */ }
      if (!Array.isArray(roots)) roots = []
      const key = (x) => Detect.normalizeDir(x && x.path).toLowerCase()
      if (op === 'workspace-add-root') {
        if (!existsSync(p)) return json(res, 200, { ok: false, error: '目录不存在：' + p })
        if (roots.some((r) => key(r) === p.toLowerCase())) {
          return json(res, 200, { ok: true, changed: false, roots, note: '该目录已在常用清单里' })
        }
        roots.push({ path: p, label: body.label || basename(p) || p })
      } else {
        const before = roots.length
        roots = roots.filter((r) => key(r) !== p.toLowerCase())
        if (roots.length === before) return json(res, 200, { ok: true, changed: false, roots, note: '该目录不在常用清单里' })
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ roots }, null, 2), 'utf8')
      return json(res, 200, { ok: true, changed: true, roots, file })
    }
    if (op === 'ephemeral') {
      const body = await readBody()
      const dir = body.dir || url.searchParams.get('dir')
      if (!dir) return json(res, 400, { ok: false, error: 'dir 必填' })
      return json(res, 200, await Reg.ephemeralScenario(dir, {
        name: body.name,
        presetId: body.presetId,
        knowledge: body.knowledge,
        constraints: body.constraints,
      }))
    }

    /* ── 自建聊天框 ───────────────────────────────────────────── */
    if (op === 'chat-capability') {
      return json(res, 200, { ok: true, ...Chat.probeCapability(ctx) })
    }
    if (op === 'chat-open') {
      const body = await readBody()
      // 把盘上的 route-config 注入 chat-open，回落按「显式传 > 配置链 > 宿主快照」，
      // 不再静默继承宿主主会话当时挂着的模型（修复前会落到被禁用的 raccoon）。
      const { config: chatRouteCfg, source: chatCfgSource, error: chatCfgErr } = await routeConfig()
      const opened = await Chat.openThread(ctx, { ...body, routeConfig: chatRouteCfg })
      if (opened && typeof opened === 'object') {
        opened.routeConfigSource = chatCfgSource
        if (chatCfgErr) opened.routeConfigError = chatCfgErr
      }
      return json(res, 200, opened)
    }
    if (op === 'chat-send') {
      const body = await readBody()
      return json(res, 200, await Chat.sendPrompt(ctx, body))
    }
    if (op === 'chat-cancel') {
      const body = await readBody()
      return json(res, 200, await Chat.cancelThread(ctx, body.sceneId))
    }
    if (op === 'chat-threads') {
      return json(res, 200, { ok: true, threads: Chat.listThreads() })
    }
    // 把线程里的真实对话读回来（面板轮询这个 op 显示气泡）。
    // sessionId 优先用显式传的（重启后内存线程表已失，客户端会带回来），
    // 其次从线程表查，都没有就明确说拿不到，不返回空数组糊过去。
    if (op === 'chat-read') {
      const body = await readBody()
      const sceneId = body.sceneId || url.searchParams.get('sceneId')
      const explicit = body.sessionId || url.searchParams.get('sessionId')
      const sessionId = explicit || (sceneId ? Chat.getThreadSessionId(sceneId) : null)
      if (!sessionId) {
        return json(res, 200, {
          ok: false,
          reason: 'no-session',
          error: '这个工作项还没有会话（或宿主重启后内存线程表已失）',
          hint: '先点「开启线程」，或把上次的 sessionId 一起传上来读历史。',
        })
      }
      const out = await Transcript.readTranscript(sessionId, { limit: body.limit })
      return json(res, 200, { ...out, sceneId: sceneId || null })
    }
    // 辅助：sessions 根探测（读不到日志时用它排查）
    if (op === 'chat-probe') {
      const root = await Transcript.resolveSessionsRoot()
      return json(res, 200, { ok: true, activeRoot: root, candidates: await Transcript.probeSessions() })
    }

    /* ── 团队上限：放开人头限制（少而精指能力域，不是人头数） ───── */
    if (op === 'team-cap') {
      const body = await readBody()
      const teamId = body.teamId || url.searchParams.get('team')
      const cap = Number(body.maxMembers || url.searchParams.get('max') || 0)
      if (!teamId) return json(res, 400, { ok: false, error: 'teamId 必填' })
      if (!cap || cap < 1 || cap > 64) return json(res, 400, { ok: false, error: 'maxMembers 需在 1-64 之间' })
      const r = await fetchJsonPATCH(`${sidecarBase()}/api/teams/${teamId}`, { maxMembers: cap }, 6000)
      if (!r.ok) return json(res, 200, { ok: false, error: r.error, raw: r.data })
      return json(res, 200, { ok: true, team: r.data, note: `上限已调整为 ${cap}` })
    }

    // 成员会话健康单查口（不拉全量快照就能看「谁派不动、为什么」）
    if (op === 'team-health') {
      const body = await readBody()
      const teamId = body.teamId || url.searchParams.get('team') || null
      const team = await collectTeam(teamId)
      return json(res, 200, {
        ok: Boolean(team.sidecar && team.sidecar.reachable),
        teamId: team.teamId,
        sidecar: team.sidecar,
        health: team.teamHealth || TeamHealth.annotateMembers(TeamHealth.activeMembers(team.members)),
        warnings: team.warnings || [],
      })
    }

    /* ── 按任务匹配团队：识别任务类型 → 在现有团队里找最合适的 ──
       给「团队模式」会话用的入口：用户输入一段任务描述，
       返回推荐的团队 + 编制详情 + 并行上限建议。不调模型，纯规则可复现。 */
    if (op === 'match-team') {
      const body = await readBody()
      const text = String(body.task || body.text || url.searchParams.get('task') || '').slice(0, 4000)
      if (!text) return json(res, 400, { ok: false, error: 'task 必填（任务描述文本）' })

      const base = sidecarBase()
      const teamsRes = await fetchJson(`${base}/api/teams`, 5000)
      const rawTeams = teamsRes.ok ? (teamsRes.data.items || teamsRes.data || []) : []

      // 团队 → 场景类型映射（registry 里存着 teamId→kind）
      const reg = await Reg.listScenarios().catch(() => ({ scenarios: [] }))
      const scByTeam = {}
      for (const s of (reg.scenarios || [])) if (s.teamId) scByTeam[s.teamId] = s

      const teams = []
      for (const tt of rawTeams) {
        if (tt.status === 'archived') continue
        const mr = await fetchJson(`${base}/api/teams/${tt.id}/members`, 4000)
        const members = mr.ok ? ((mr.data.items || []).filter((x) => x.status !== 'retired')) : []
        teams.push({
          id: tt.id,
          name: tt.name,
          kind: (scByTeam[tt.id] && scByTeam[tt.id].kind) || 'general',
          maxMembers: tt.maxMembers,
          maxConcurrency: tt.maxConcurrency,
          status: tt.status,
          members,
        })
      }

      const hint = {}
      if (body.workspaceKind) hint.workspaceKind = body.workspaceKind
      return json(res, 200, TaskMatch.matchTask(text, teams, hint))
    }

    /* ── 团队总览：所有团队的编制完成度（UI「团队编制」区块用）── */
    if (op === 'team-overview') {
      const base = sidecarBase()
      const teamsRes = await fetchJson(`${base}/api/teams`, 5000)
      const rawTeams = teamsRes.ok ? (teamsRes.data.items || teamsRes.data || []) : []

      const reg = await Reg.listScenarios().catch(() => ({ scenarios: [] }))
      const scByTeam = {}
      for (const s of (reg.scenarios || [])) if (s.teamId) scByTeam[s.teamId] = s

      const out = []
      for (const tt of rawTeams) {
        if (tt.status === 'archived') continue
        const mr = await fetchJson(`${base}/api/teams/${tt.id}/members`, 4000)
        const members = mr.ok ? ((mr.data.items || []).filter((x) => x.status !== 'retired')) : []
        const sc = scByTeam[tt.id]
        const kind = (sc && sc.kind) || 'general'
        const tpl = TaskMatch.templateOf(kind)
        const roleRows = tpl.roles.map((r) => {
          const hit = members.find((m) => TaskMatch.hasRoleOf([m], r.name))
          return {
            name: r.name,
            title: r.title,
            duty: r.duty,
            present: Boolean(hit),
            memberName: hit ? hit.name : null,
            memberLabel: hit ? TaskMatch.displayNameOf(hit.name) : null,
            memberStatus: hit ? hit.status : null,
            bound: hit ? Boolean(hit.agentSessionId) : false,
          }
        })
        const filled = roleRows.filter((x) => x.present).length
        out.push({
          teamId: tt.id,
          name: tt.name,
          cleanName: TaskMatch.cleanTeamNameOf(tt.name, kind),
          kind,
          kindLabel: tpl.label,
          describe: tpl.describe,
          maxMembers: tt.maxMembers,
          maxConcurrency: tt.maxConcurrency,
          memberCount: members.length,
          boundCount: members.filter((m) => m.agentSessionId).length,
          idleCount: members.filter((m) => m.status === 'idle').length,
          scenarioId: sc ? sc.id : null,
          scenarioState: sc ? sc.state : null,
          roster: { filled, total: tpl.roles.length, complete: filled === tpl.roles.length, roles: roleRows },
        })
      }
      out.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.name).localeCompare(String(b.name)))
      return json(res, 200, { ok: true, teams: out, count: out.length })
    }

    // 面板能不能替 Lead 投递 —— 实测口径，不是推测。
    // 探针用「必然不存在的目标」测 sender 实例校验，零副作用（见 leadProbe.mjs）。
    if (op === 'agent-probe') {
      const body = await readBody()
      const leadId = body.leadId || url.searchParams.get('lead')
      const capability = LeadProbe.probeHostCapability(ctx)
      const sendTest = body.skipSend
        ? null
        : await LeadProbe.testSendWithProbeTarget(ctx, leadId || undefined)
      const finalVerdict = !sendTest
        ? capability.verdict
        : (sendTest.verdict === 'sender-ok-target-missing'
          ? 'panel-can-deliver'
          : (sendTest.verdict === 'sender-not-exact-live'
            ? 'panel-cannot-deliver-handle-not-live'
            : `panel-cannot-deliver:${sendTest.verdict}`))
      return json(res, 200, {
        ok: true,
        capability,
        sendTest,
        finalVerdict,
        note: finalVerdict === 'panel-can-deliver'
          ? '面板能代 Lead 投递：S6 真投递一路可用。'
          : '面板不能代 Lead 投递：任务 brief 必须由 Lead 会话（dsh_team_task / dsh_team_send）发出。',
      })
    }

    // 上下文适配查询（）：每个成员当前 token 占用 + 切到各候选的 fit 结论。
    // 纯本地：只读本机 session 日志（zstd 解压）+ 算三态，不发任何外部请求。
    // 传 sessionId 只算那一个会话；传 teamId 算全队成员。
    if (op === 'route-fit') {
      const body = await readBody()
      const sessionId = body.sessionId || url.searchParams.get('sessionId') || null
      const teamIdIn = body.teamId || url.searchParams.get('team') || null
      const extraTokens = Number.isFinite(Number(body.extraTokens)) ? Number(body.extraTokens) : 0

      /** 读一个会话的当前占用 —— **三路优先，绝不填 0**（）：
       * ① token-meter 投影缓存：pressureTokens / projectedTokens（= GUI 上下文圆环同源）。
       * **Lead（主会话）只有这一路**——成员会话才在 session 日志里写 usage。
       * ② 会话日志最近一次 assistant/message 的 usage.totalTokens（成员会话口径，）。
       * ③ 都取不到 → ok:false + reason，让上层写 note，不拿 0 糊（0 会让所有候选判 safe，正好最危险）。
       * 实现在 orchestrator\sessionUsage.mjs —— 抽成模块是为了让离线脚本能原样调用同一份取数逻辑。
       */
      const usageOf = (sid) => SessionUsage.resolveUsage(sid)

      /** 单个会话 → 该会话所属能力域下每个候选的 fit（带倍率门槛结论）
       * ctxInfo.contextWindow 是实测窗口（token-meter 投影带出来的真实窗口，如 Lead 会话 1M）。
       * 给了就按 routeKey 覆盖窗口表：**仅当该 key 在链里**（成员当前模型恰好是候选之一）才生效；
       * 不在链里时覆盖不生效、判定照旧用表值 —— 端口是「有实测就优先实测」，不是改判定规则。
       * windowOverride 会随响应返回，便于面板显示「这条路由的窗口被实测值覆盖了」。
       */
      const fitForSessionOf = (cfg, domain, currentTokens, ctxInfo = {}) => {
        const norm = Routes.normalizeDomain(domain) || Routes.DEFAULT_DOMAIN
        const needed = currentTokens + extraTokens
        const winOv = ctxInfo.routeKey && typeof ctxInfo.contextWindow === 'number' && ctxInfo.contextWindow > 0
          ? { [ctxInfo.routeKey]: ctxInfo.contextWindow }
          : null
        const routeOpts = {
          neededTokens: needed,
          config: cfg,
          ...(winOv ? { contextWindows: winOv } : {}),
        }
        const chain = Routes.routeChain(norm, routeOpts)
        return {
          domain: norm,
          neededTokens: needed,
          extraTokens,
          windowOverride: winOv,
          chain: chain.map((c) => ({
            tier: c.tier,
            provider: c.provider || null,
            model: c.model,
            key: c.key,
            reasoningEffort: c.reasoningEffort ?? null,
            contextWindow: c.contextWindow,
            windowSource: c.windowSource,
            multiplier: c.multiplier,
            cap: c.cap,
            capSource: c.capSource,
            allowed: c.allowed,
            blockedBy: c.blockedBy,
            gateReason: c.gateReason,
            fit: c.fit,
            /** 一眼可读的结论：可以切 / 要先压缩 / 不能切 / 被倍率挡住 */
            verdict: c.allowed === false ? 'blocked'
              : (c.fit.state === 'safe' ? 'safe'
                : (c.fit.state === 'compress-first' ? 'compress-first' : 'reject')),
          })),
          selected: Routes.selectRoute(norm, routeOpts),
        }
      }

      // ① 单会话模式
      if (sessionId && !teamIdIn) {
        const u = await usageOf(sessionId)
        const current = u.ok ? u.currentTokens : null
        const domain = body.domain || url.searchParams.get('domain') || Routes.DEFAULT_DOMAIN
        const cfg = (await routeConfig()).config
        return json(res, 200, {
          ok: true,
          asOf: new Date().toISOString(),
          mode: 'session',
          sessionId,
          usage: u.usage,
          usageError: u.ok ? null : { reason: u.reason, error: u.error || null, hint: u.hint || null, projcacheReason: u.projcacheReason || null },
          usageSource: u.source || null,
          usedField: u.ok ? u.usedField : null,
          windowSource: u.ok ? u.windowSource : null,
          contextWindow: u.ok ? (u.contextWindow || null) : null,
          currentTokens: current,
          ...(current == null
            ? { note: '拿不到当前占用，无法给出窗口结论（不猜数字）—— 投影缓存与会话日志都没有可用字段' }
            : fitForSessionOf(cfg, domain, current, { routeKey: u.routeKey || null, contextWindow: u.contextWindow || null })),
          thresholds: Routes.FIT,
          defaultWindow: Routes.DEFAULT_WINDOW,
        })
      }

      // ② 团队模式：逐个成员读日志算占用
      const team = await collectTeam(teamIdIn)
      if (!team.sidecar || !team.sidecar.reachable) {
        return json(res, 200, { ok: false, reason: 'sidecar-unreachable', sidecar: team.sidecar, members: [] })
      }
      const cfgForFit = (await routeConfig()).config
      const rows = []
      for (const m of TeamHealth.activeMembers(team.members)) {
        const sid = m.agentSessionId ? String(m.agentSessionId) : null
        const u = await usageOf(sid)
        const current = u.ok ? u.currentTokens : (u.usage && typeof u.usage.contextTokens === 'number' ? u.usage.contextTokens : null)
        const domain = String(m.name || '').toLowerCase()
        const norm = Routes.normalizeDomain(domain) || Routes.DEFAULT_DOMAIN
        // 窗口覆盖按「该成员当前挂的路由」来：优先成员配置的 provider/model，其次投影缓存里的 lastUsed
        const routeKey = (m.agentProvider && m.model) ? Routes.routeKey({ provider: m.agentProvider, model: m.model }) : (u.routeKey || null)
        const row = {
          memberId: m.id || null,
          name: m.name || null,
          role: m.role || null,
          agentSessionId: sid,
          status: m.status || null,
          currentModel: m.model || null,
          currentProvider: m.agentProvider || null,
          domain: norm,
          usage: u.usage,
          usageError: u.ok ? null : { reason: u.reason, error: u.error || null, hint: u.hint || null, projcacheReason: u.projcacheReason || null },
          usageSource: u.source || null,
          usedField: u.ok ? u.usedField : null,
          windowSource: u.ok ? u.windowSource : null,
          contextWindow: u.ok ? (u.contextWindow || null) : null,
          currentTokens: current,
        }
        // 拿不到占用就明说，不拿 0 糊过去——0 会让所有候选都判 safe，正好是最危险的方向
        if (current != null) {
          Object.assign(row, fitForSessionOf(cfgForFit, norm, current, { routeKey, contextWindow: u.contextWindow || null }))
        } else {
          row.note = '拿不到当前占用（投影缓存无 contextPressure、会话日志也无 usage），不给窗口结论——不填 0'
        }
        rows.push(row)
      }
      const withTokens = rows.filter((r) => r.currentTokens != null)
      const fieldTally = withTokens.reduce((acc, r) => {
        const k = r.usedField || 'unknown'
        acc[k] = (acc[k] || 0) + 1
        return acc
      }, {})
      return json(res, 200, {
        ok: true,
        asOf: new Date().toISOString(),
        mode: 'team',
        teamId: team.teamId,
        extraTokens,
        members: rows,
        thresholds: Routes.FIT,
        defaultWindow: Routes.DEFAULT_WINDOW,
        summary: {
          members: rows.length,
          withTokens: withTokens.length,
          withoutTokens: rows.length - withTokens.length,
          usedFields: fieldTally,
        },
        note: '占用三路优先：① token-meter 投影缓存 pressureTokens/projectedTokens（Lead 会话只有这一路，'
          + '口径同 tools\\lead-context.mjs）② 会话日志最近一次 usage.totalTokens（成员会话，docs\\108 §2.1）'
          + '③ 都没有就写 note、不填 0。usedField 说明用了哪个字段；windowSource=session-projcache 时 '
          + 'contextWindow 是实测窗口，且会按当前路由 key 覆盖窗口表（覆盖不到不影响判定）。',
      })
    }

    // 选路查询：面板展示「免费首选 → 付费降级 → 备选」，也供巡检脚本对表。
    // 纯本地计算（routes.mjs 不联网），给 domain 就只算那一条链。
    // 上下文维度（）：传 neededTokens 就带上窗口适配结论，
    // 面板能区分「安全切 / 需压缩 / 拒绝切」，而不是切完才炸。
    // 倍率维度（用户 2026-11-21）：读 route-config.json，返回门槛结论。
    if (op === 'routes') {
      const body = await readBody()
      const domain = body.domain || url.searchParams.get('domain') || null
      const freeDisabled = body.freeDisabled === true || body.freeRoutes === false
      const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
      const neededTokens = num(body.neededTokens ?? url.searchParams.get('neededTokens'))
      const cfgRes = await routeConfig()
      const cfg = cfgRes.config
      const routeOpts = {
        freeDisabled,
        config: cfg,
        ...(neededTokens != null ? { neededTokens } : {}),
        ...(body.contextWindows && typeof body.contextWindows === 'object' ? { contextWindows: body.contextWindows } : {}),
        ...(body.tiers ? { tiers: body.tiers } : {}),
        ...(Array.isArray(body.freePool) ? { freePool: body.freePool } : {}),
      }
      return json(res, 200, {
        ok: true,
        freePool: Routes.FREE_POOL.map((r) => ({ ...r, key: Routes.routeKey(r) })),
        domains: Object.keys(Routes.ROUTE),
        tierOrder: Routes.TIER_ORDER,
        memberDomainMap: Routes.MEMBER_DOMAIN_TO_TASK_DOMAIN,
        defaultDomain: Routes.DEFAULT_DOMAIN,
        fitThreshold: Routes.FIT,
        defaultWindow: Routes.DEFAULT_WINDOW,
        providerPriority: Routes.PROVIDER_PRIORITY,
        /** 层级概念：14 个前缀是一个插件内的 14 条上游通道，不是 14 家厂商 */
        pluginId: Routes.PLUGIN_ID,
        relayEndpoint: Routes.RELAY_ENDPOINT,
        laneCount: Routes.LANE_COUNT,
        lanes: Routes.LANE_OF,
        config: cfg,
        /** 窗口真值与实测证据（）：面板/审计要能回答「这个 971000 哪来的」 */
        windowEvidence: Routes.CONTEXT_WINDOW_EVIDENCE,
        measuredDiscount: Routes.MEASURED_DISCOUNT,
        windowSources: Routes.CONTEXT_WINDOW_SOURCE,
        configSource: { source: cfgRes.source, file: cfgRes.file, error: cfgRes.error || null },
        chain: domain ? Routes.routeChain(domain, routeOpts) : Routes.routeCatalog(routeOpts),
        candidates: Routes.candidatePool({ config: cfg, ...(Array.isArray(body.freePool) ? { freePool: body.freePool } : {}) }),
        selected: domain ? Routes.selectRoute(domain, routeOpts) : null,
        note: '免费池是实测可用清单（docs\\103 §2），不是路由列表；每天用 scripts\\check-free-routes.mjs 复验。'
          + '付费按倍率门槛：workbuddy cap=0（只留 x0.00 的 hy4flash-free），其余吃全局 maxMultiplier。',
      })
    }

    // 模型配置读写（route-config.json）。**写盘只在 POST**，GET 只读。
    if (op === 'route-config') {
      const body = await readBody()
      if ((req.method || 'GET').toUpperCase() === 'POST') {
        const want = body.config && typeof body.config === 'object' ? body.config : body
        // 只接受认识的键，别把任意字段写进配置文件
        const cleaned = {}
        if (want.maxMultiplier !== undefined) cleaned.maxMultiplier = want.maxMultiplier
        if (want.providerMultiplierCap && typeof want.providerMultiplierCap === 'object') cleaned.providerMultiplierCap = want.providerMultiplierCap
        if (want.disabledProviders !== undefined) cleaned.disabledProviders = want.disabledProviders
        if (want.disabledRoutes !== undefined) cleaned.disabledRoutes = want.disabledRoutes
        if (want.disabledReason && typeof want.disabledReason === 'object') cleaned.disabledReason = want.disabledReason
        if (want.leadRoute && typeof want.leadRoute === 'object') cleaned.leadRoute = want.leadRoute
        // 在现有配置上覆盖，避免「只改一个字段」把其它字段清空
        const cur = await routeConfig()
        const merged = Routes.resolveConfig({ ...cur.config, ...cleaned })
        const saved = await Routes.saveRouteConfig(merged, PKG_ROOT)
        return json(res, saved.ok ? 200 : 500, {
          ok: saved.ok,
          file: saved.file,
          config: saved.config,
          verified: saved.verified,
          bytes: saved.bytes ?? null,
          error: saved.error || null,
          note: saved.ok ? '配置已落盘（无 BOM）。下次选路生效；已在跑的成员会话不受影响，要换模型请用 dsh_team_member update。' : '写盘失败，未生效',
        })
      }
      const cur = await routeConfig()
      return json(res, 200, {
        ok: true,
        file: cur.file,
        source: cur.source,
        error: cur.error || null,
        config: cur.config,
        defaults: Routes.DEFAULT_CONFIG,
        multipliers: Routes.MULTIPLIER,
        providerPriority: Routes.PROVIDER_PRIORITY,
        note: 'providerMultiplierCap 优先于 maxMultiplier；倍率未知的 route 一律排除（保守）。',
      })
    }

    // provider 停用/启用 + 倍率上限（一次调用改一项，避免「改一半」的中间态）
    if (op === 'provider-toggle') {
      const body = await readBody()
      const cur = await routeConfig()
      const cfg = { ...cur.config }
      let changed = null
      if (body.provider) {
        const p = String(body.provider).trim().toLowerCase()
        if (!p) return json(res, 400, { ok: false, error: 'provider 不能是空串' })
        if (body.enabled === false || body.disabled === true) {
          // 停用：进 disabledProviders（真正的「整厂停用」）
          if (!cfg.disabledProviders.map((x) => x.toLowerCase()).includes(p)) cfg.disabledProviders.push(p)
          // 记下「为什么禁的」：面板要显示「被禁用：账号级限流…」，而不是一片空白
          const why = typeof body.reason === 'string' && body.reason.trim()
            ? body.reason.trim()
            : `${new Date().toISOString().slice(0, 10)} 手动停用`
          cfg.disabledReason = { ...(cfg.disabledReason || {}), [p]: why }
          changed = `停用 provider ${p}（${why}）`
        } else if (body.enabled === true || body.disabled === false) {
          cfg.disabledProviders = cfg.disabledProviders.filter((x) => x.toLowerCase() !== p)
          // 启用就清掉原因，别留过期理由误导下一个看面板的人
          const rest = { ...(cfg.disabledReason || {}) }
          for (const k of Object.keys(rest)) if (k.toLowerCase() === p) delete rest[k]
          cfg.disabledReason = rest
          changed = `启用 provider ${p}`
        } else if (body.cap !== undefined) {
          // 只调该 provider 的倍率上限（推荐用法：不动 provider 开关，只调 cap）
          const cap = Number(body.cap)
          if (!Number.isFinite(cap) || cap < 0) return json(res, 400, { ok: false, error: 'cap 必须是非负数字' })
          cfg.providerMultiplierCap = { ...cfg.providerMultiplierCap, [p]: cap }
          changed = `provider ${p} 倍率上限设为 x${cap}`
        } else {
          return json(res, 400, { ok: false, error: 'provider-toggle 需要 enabled/disabled 或 cap 三者之一' })
        }
      } else if (body.route) {
        const rk = String(body.route).trim()
        if (!rk.includes('/')) return json(res, 400, { ok: false, error: 'route 必须是 provider/model 形式' })
        const list = new Set(cfg.disabledRoutes)
        if (body.enabled === false || body.disabled === true) list.add(rk)
        else list.delete(rk)
        cfg.disabledRoutes = [...list]
        changed = `${body.enabled === false || body.disabled === true ? '拉黑' : '恢复'} route ${rk}`
      } else if (body.maxMultiplier !== undefined) {
        const mm = Number(body.maxMultiplier)
        if (!Number.isFinite(mm) || mm < 0) return json(res, 400, { ok: false, error: 'maxMultiplier 必须是非负数字' })
        cfg.maxMultiplier = mm
        changed = `全局倍率上限设为 x${mm}`
      } else {
        return json(res, 400, { ok: false, error: '需要 provider / route / maxMultiplier 之一' })
      }
      const saved = await Routes.saveRouteConfig(cfg, PKG_ROOT)
      if (!saved.ok) return json(res, 500, { ok: false, error: saved.error || '写盘失败', file: saved.file })
      // 回带「改完的效果」：每个 provider 下现在有哪些 route 可选，谁被挡
      const pool = Routes.candidatePool({ config: saved.config })
      return json(res, 200, {
        ok: true,
        changed,
        file: saved.file,
        config: saved.config,
        verified: saved.verified,
        allowedCount: pool.filter((r) => r.allowed).length,
        blockedCount: pool.filter((r) => !r.allowed).length,
        candidates: pool,
        note: '已落盘；下次选路生效。已在跑的成员会话不受影响。',
      })
    }

    if (op === 'refresh-snap') {
      // P1a：重跑验收自检 = 重取快照（checks 重算 + 新 generatedAt 时间戳）
      const body = await readBody()
      const scenario = body.scenario || url.searchParams.get('scenario') || 'ai-team'
      const teamId = body.team || url.searchParams.get('team') || null
      const snapshot = await buildSnapshot({ scenario, team: teamId })
      return json(res, 200, { ok: true, generatedAt: snapshot.generatedAt, snapshot })
    }

    /* ── 写： 一键操作（T8） ─────────────────────────── */

    // 临时开团并直接跑首轮流水线（ephemeral → run 一步串完，面板不切页）
    if (op === 'ephemeral-run') {
      const body = await readBody()
      const dir = body.dir || url.searchParams.get('dir')
      if (!dir) return json(res, 400, { ok: false, error: 'dir 必填' })
      const eph = await Reg.ephemeralScenario(dir, {
        name: body.name,
        presetId: body.presetId,
        knowledge: body.knowledge,
        constraints: body.constraints,
      })
      if (!eph.ok) return json(res, 200, { ok: false, stage: 'ephemeral', errors: eph.errors || [eph.error], hint: eph.hint })
      // 临时场景不落注册表：把内存态场景直接交给流水线。
      // runPipeline 只认注册表 id，所以这里临时写入、跑完即删除。
      const id = eph.scenario.id
      const added = await Reg.addScenario({ ...eph.scenario, id })
      if (!added.ok) return json(res, 200, { ok: false, stage: 'register', errors: added.errors })
      try {
        // 临时场景跳过首件门：一次性活不设门（S6b 需要成员先跑完才有首件，
        // ephemeral 只跑到 S6 就删场景，门永远等不到记录——不设门是如实，不是漏）
        const out = await Pipeline.runPipeline(id, {
          from: 'S0',
          to: body.to || 'S6',
          hostCtx: ctx,
          routeAnswers: body.routeAnswers && typeof body.routeAnswers === 'object' ? body.routeAnswers : null,
          skipFirstPieceGate: true,
        })
        return json(res, 200, { ok: out.ok, stage: 'run', scenarioId: id, ephemeral: true, ...out })
      } finally {
        // 临时场景用完即删：不留注册表垃圾（失败也删，重试会重建）
        await Reg.removeScenario(id).catch(() => null)
      }
    }

    // P1a：中断卡住的任务（转发 sidecar POST /api/tasks/:id/abort）
    if (op === 'task-abort') {
      const body = await readBody()
      const taskId = body.taskId || url.searchParams.get('task')
      if (!taskId) return json(res, 400, { ok: false, error: 'taskId 必填' })
      const r = await fetchJsonPOST(`${sidecarBase()}/api/tasks/${encodeURIComponent(taskId)}/abort`, {}, 6000)
      if (!r.ok) {
        // 409 = 状态不允许（已 done/failed/aborted），把真实信息透传给面板
        const msg = r.data && r.data.error && r.data.error.message ? r.data.error.message : (r.error || `HTTP ${r.status}`)
        return json(res, 200, { ok: false, taskId, error: msg, status: r.status })
      }
      return json(res, 200, { ok: true, taskId, task: r.data && (r.data.task || r.data) })
    }

    // P1b：重建 handbook 骨架（缺失文件补最小占位，标明待补正文）
    if (op === 'handbook-skeleton') {
      const body = await readBody()
      const scenario = body.scenario || url.searchParams.get('scenario') || 'ai-team'
      const r = await rebuildHandbookSkeleton(scenario)
      return json(res, 200, r)
    }

    // 重建坏掉/缺失的 preset（解析失败、或清单缺必需插件）
    if (op === 'preset-rebuild') {
      const body = await readBody()
      const presetId = body.presetId || url.searchParams.get('preset')
      if (!presetId) return json(res, 400, { ok: false, error: 'presetId 必填' })
      const r = await rebuildPreset(String(presetId), {
        force: Boolean(body.force),
        kind: body.kind,
        name: body.name,
      })
      return json(res, 200, r)
    }
    /* ── 会话预设管理：读取 / 启停 / 调序（preset-rebuild 之外的新能力）── */
    if (op === 'presets') {
      const r = await PresetMgr.loadAllPresets(presetProfileFile(), presetBuiltinDir())
      return json(res, 200, { ok: r.errors.length === 0, ...r, needsRestart: true })
    }
    if (op === 'preset-toggle' || op === 'preset-order') {
      const body = await readBody()
      const instanceId = String(body.instanceId || '')
      if (!instanceId) return json(res, 400, { ok: false, error: 'instanceId 必填' })
      const edit = {}
      if (op === 'preset-toggle') {
        if (typeof body.disabled !== 'boolean') return json(res, 400, { ok: false, error: 'disabled 必须是布尔值' })
        edit.disabled = body.disabled
      } else {
        const n = typeof body.order === 'string' && body.order.trim() !== '' ? Number(body.order) : body.order
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 999) {
          return json(res, 400, { ok: false, error: 'order 必须是 0-999 的整数' })
        }
        edit.order = n
      }
      try {
        const r = await PresetMgr.editPreset(presetProfileFile(), instanceId, edit)
        if (!r.ok) return json(res, 400, r)
        return json(res, 200, { ...r, needsRestart: true, hint: '已改 preset 定义，需重启 DSH 生效' })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
      }
    }

    return json(res, 400, { error: `unknown op: ${op}` })
  } catch (err) {
    return json(res, 500, { error: String(err && err.message ? err.message : err) })
  }
}

/** POST 辅助（招募用） */
async function fetchJsonPOST(url, body, timeoutMs = 8000) {
  return fetchJsonWithMethod('POST', url, body, timeoutMs)
}

/** PATCH 辅助（改团队上限用） */
async function fetchJsonPATCH(url, body, timeoutMs = 8000) {
  return fetchJsonWithMethod('PATCH', url, body, timeoutMs)
}

async function fetchJsonWithMethod(method, url, body, timeoutMs = 8000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}),
    })
    const txt = await r.text()
    let data = null
    try { data = JSON.parse(txt) } catch { data = { raw: txt } }
    return { ok: r.ok, status: r.status, data, error: r.ok ? null : `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  } finally { clearTimeout(timer) }
}

/* ── P1b：重建 handbook 骨架（T8） ───────────────────────────────────
 * 只补缺失/空壳文件，已有正文绝不动。骨架是最小占位（标题 + 待补标注 +
 * 该文件的用途说明），让 preflight 不再因「文件不存在」全红。
 */
const SKELETONS = {
  '00-协议.md': (s) => `# ${s} 工作项协议\n\n<!-- 骨架重建：待补正文 -->\n\n- 目标：\n- 约束：\n- 交付：\n`,
  '01-成员卡.md': (s) => `# ${s} 成员卡\n\n<!-- 骨架重建：待补正文 -->\n\n## maker\n\n- 角色：\n- prompt：\n`,
  '02-preset.md': (s) => `# ${s} preset 说明\n\n<!-- 骨架重建：待补正文 -->\n\n- plugins：\n- persona：\n`,
  '03-验收清单.md': (s) => `# ${s} 验收清单\n\n<!-- 骨架重建：待补正文 -->\n\n## A\n- [ ] \n`,
  '04-启动指令.md': (s) => `# ${s} 启动指令\n\n<!-- 骨架重建：待补正文 -->\n\n1. \n`,
  '99-本轮变更.md': (s) => `# ${s} 本轮变更\n\n<!-- 骨架重建：待补正文 -->\n\n- \n`,
}

async function rebuildHandbookSkeleton(scenario) {
  const dir = join(handbookRoot(), scenario)
  const scan = await scanHandbook(scenario)
  const targets = (scan.files || []).filter((f) => !f.exists || f.emptySkeleton)
  if (!targets.length) {
    return { ok: true, scenario, dir, note: '六件齐全，无需重建', rebuilt: [] }
  }
  try {
    await mkdir(dir, { recursive: true })
    const rebuilt = []
    for (const f of targets) {
      const tpl = SKELETONS[f.file]
      if (!tpl) continue
      await writeFile(join(dir, f.file), tpl(scenario), 'utf8')
      rebuilt.push(f.file)
    }
    return { ok: true, scenario, dir, rebuilt, note: `已重建 ${rebuilt.length} 个骨架文件（正文待补）` }
  } catch (err) {
    return { ok: false, scenario, dir, error: String(err && err.message ? err.message : err) }
  }
}

/* ── 重建 preset（T18） ─────────────────────────────────────────
 * 只重建「坏掉」的：
 * - 文件解析失败（JSON 坏）
 * - 文件在、但清单缺必需插件（会让 preset broken）
 * 健康的默认不动；要强上必须显式 force:true（记在返回值里，不静默）。
 * 原文件先备份成 `<file>.bak-<ts>`，覆盖是可回滚的。
 * 重建产物是**最小可用骨架**：必需插件齐全 + persona 占位，正文待补。
 */
const PRESET_REQUIRED_PLUGINS = ['@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-todo']

function presetSkeleton({ id, name, kind }) {
  return {
    id,
    name: name || `${id}（重建）`,
    description: `重建的最小可用 preset（${kind || 'general'}）：必需插件齐全，persona 与工具明细待补。`,
    order: 50,
    plugins: [
      {
        name: '@deepseek-ai/dsh-persona',
        config: {
          prefix: `你是 ${id} 工作项的执行成员。开工前先读 handbook 的 00-协议.md 与 03-验收清单.md，按验收清单交付；交付必须带产物绝对路径与可执行命令，不写「建议」「可以考虑」。`,
        },
      },
      { name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      { name: '@deepseek-ai/dsh-tool-fs' },
      { name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
      { name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    ],
  }
}

export async function rebuildPreset(presetId, opt = {}) {
  const dir = presetDir()
  const file = join(dir, `${presetId}.json`)
  const existed = existsSync(file)
  let backup = null
  let brokenReason = null

  if (existed) {
    const read = await readJsonFile(file)
    if (!read.ok) {
      brokenReason = `解析失败：${read.error}`
    } else {
      const doc = read.data || {}
      const plugins = Array.isArray(doc.plugins) ? doc.plugins : []
      const missing = PRESET_REQUIRED_PLUGINS.filter((p) => !plugins.some((x) => x && x.name === p))
      if (!missing.length && !opt.force) {
        return {
          ok: true,
          presetId,
          file,
          skipped: true,
          note: '该 preset 健康（可解析且必需插件齐全），未覆盖。要强制重建请带 force:true。',
        }
      }
      if (missing.length) brokenReason = `清单缺必需插件：${missing.join('、')}`
    }
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
    backup = `${file}.bak-${ts}`
    try { await copyFile(file, backup) } catch { backup = null }
  }

  const doc = presetSkeleton({ id: presetId, name: opt.name, kind: opt.kind })
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  } catch (err) {
    return { ok: false, presetId, file, error: String(err && err.message ? err.message : err), backup }
  }
  return {
    ok: true,
    presetId,
    file,
    backup,
    replaced: existed,
    reason: brokenReason,
    note: `已写入最小可用 preset（${doc.plugins.length} 条插件）；persona 与工具明细待补，别当成「已修好」。`,
  }
}

export function apply(ctx) {
  // ── 装本地数据层：拦截 127.0.0.1:4317/api/* 的请求，用插件自己的库应答 ──
  // 此前团队/成员/任务都寄存在别人的 dsh-team sidecar 里，那个插件一卸载数据就断。
  // 现在数据在本插件自己的 team.db，接口形状保持不变，上层调用点一行不用改。
  // 只做健康检查与统计，**不改 globalThis.fetch**。
  // 第一版这里替换了全局 fetch，把宿主自己的网络请求也劫持了，
  // 严重到用户打不开界面。现在本地数据层由各调用点显式走
  // LocalSidecar.sidecarFetch()，全局副作用为零。
  try {
    const s = LocalSidecar.Store.stats()
    console.info(
      `[ai-team-console] 本地数据层就绪：`
      + `${s.teams} 团队 / ${s.members} 成员 / ${s.tasks} 任务（${s.dbPath}）`,
    )
  } catch (e) {
    console.warn(`[ai-team-console] 本地数据层读取失败：${e && e.message ? e.message : e}`)
  }

  // 走适配层：宿主缺 webServer / effect 时降级，不崩整个插件
  const registered = Host.registerEffect(ctx, () => Host.registerWebRoute(ctx, {
    kind: 'exact',
    path: '/ai-team/api',
    handler: (req, res) => handle(ctx, req, res),
  }), 'dsh-ai-team-console: http bridge')

  if (!registered) {
    // 拿不到 HTTP 桥时插件仍能加载，只是没有 API 可用——不要静默
    console.warn('[ai-team-console] 宿主未提供 webServer/effect，HTTP 桥未注册，面板功能不可用')
  }

  // 插件卸载时还原 fetch，避免污染宿主
  Host.registerEffect(ctx, () => () => {
    try { LocalSidecar.Store.close() } catch { /* 已关闭 */ }
  }, 'dsh-ai-team-console: local store teardown')
}
