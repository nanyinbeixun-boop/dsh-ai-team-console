/**
 * 场景注册表 —— 多场景的单一真相源
 *
 * 存 `_AI团队手册\_registry.json`，一个 JSON 文件管全部场景。
 * 为什么不用数据库：单文件可手改、可 git 管、面板直接读、无需迁移。
 *
 * 每个场景记录：哪个 preset、哪个 handbook 目录、哪个 team、什么状态、什么领域约束。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

const USER_DATA = process.env.DSH_USER_DATA_ROOT || 'D:\\软件\\DSH\\用户数据'
const HANDBOOK_ROOT = join(USER_DATA, '_AI团队手册')
const REGISTRY_PATH = join(HANDBOOK_ROOT, '_registry.json')

/** 场景状态机：合法转换表。非法转换一律拒绝，不猜。 */
const TRANSITIONS = {
  idle: ['opening'],
  opening: ['running', 'idle'],          // 失败可退回 idle
  running: ['awaiting', 'closing', 'idle'],
  awaiting: ['revising', 'closing', 'idle'],
  revising: ['running', 'awaiting', 'idle'],
  closing: ['done', 'idle'],
  done: ['opening'],                      // 可以开下一轮
}

const SCENARIO_KINDS = ['software', 'docs', 'ecom', 'research', 'general']

/**
 * detect.mjs 探测出的原始 kind → 注册表 scene.kind 的统一映射（T15）。
 * 口径：dotnet-script/dotnet/node/python/rust/go 都是「软件」活，docs 是文档目录，
 * 其余（未识别/general）归 general。客户端「存为工作项」也用同一套，两端不得各写各的。
 */
const DETECT_KIND_TO_SCENE_KIND = {
  'dotnet-script': 'software',
  dotnet: 'software',
  node: 'software',
  python: 'software',
  rust: 'software',
  go: 'software',
  docs: 'docs',
}

/** scene.kind → 推荐 preset 的统一映射（T15，含 ephemeral 修复；T16 docs 改名） */
const KIND_TO_PRESET = {
  software: 'software',
  // T16：docs 没有 docs.json preset，落到 ai-team 通用 preset，不能指向不存在的 preset
  docs: 'ai-team',
  general: 'ai-team',
}

/** detect 原始 kind → 注册表 scene.kind；认不出归 general，不猜 */
export function sceneKindFromDetect(detectKind) {
  return DETECT_KIND_TO_SCENE_KIND[detectKind] || 'general'
}

/** scene.kind → 推荐 preset；认不出回落 ai-team（通用） */
export function presetForKind(kind) {
  return KIND_TO_PRESET[kind] || 'ai-team'
}

function dshHome() {
  const env = process.env.DSH_HOME
  if (env) return env
  const dSide = join(USER_DATA, '.dsh')
  if (existsSync(dSide)) return dSide
  return join(homedir(), '.dsh')
}

function presetDir() {
  const env = process.env.DSH_TEAM_PRESET_DIR
  if (env) return env
  const dSide = join(USER_DATA, '.dsh', 'team', 'presets')
  if (existsSync(dSide)) return dSide
  return join(dshHome(), 'team', 'presets')
}

const EMPTY = { version: 1, updatedAt: null, scenarios: [] }

async function readRaw() {
  if (!existsSync(REGISTRY_PATH)) return { ...EMPTY, scenarios: [] }
  try {
    let txt = await readFile(REGISTRY_PATH, 'utf8')
    // 去掉 UTF-8 BOM：Windows 上用 PowerShell Set-Content -Encoding UTF8、
    // 或记事本另存，都会带 BOM，JSON.parse 会直接拒绝（真踩过）。
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1)
    txt = txt.replace(/^\uFEFF/, '')
    const doc = JSON.parse(txt)
    if (!Array.isArray(doc.scenarios)) doc.scenarios = []
    return doc
  } catch (err) {
    // 注册表坏了不要静默重建 —— 那会丢场景。返回带错误标记的空表，让上层提示。
    return { ...EMPTY, scenarios: [], _readError: String(err && err.message ? err.message : err) }
  }
}

async function writeRaw(doc) {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true })
  doc.updatedAt = new Date().toISOString()
  // 不带 BOM 写：JSON.parse 对 BOM 零容忍
  await writeFile(REGISTRY_PATH, JSON.stringify(doc, null, 2), 'utf8')
  return doc
}

/** 校验场景记录的最小完整性 */
function validateScenario(input, { requireId = true } = {}) {
  const errs = []
  if (requireId && !input.id) errs.push('id 必填')
  if (input.id && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.id)) {
    errs.push('id 只能是小写英文/数字/连字符，≤32 字符')
  }
  if (input.kind && !SCENARIO_KINDS.includes(input.kind)) {
    errs.push(`kind 必须是 ${SCENARIO_KINDS.join(' / ')} 之一`)
  }
  return errs
}

/* ── 读 ─────────────────────────────────────────────────────────── */

export async function listScenarios() {
  const doc = await readRaw()
  return {
    ok: !doc._readError,
    error: doc._readError || null,
    path: REGISTRY_PATH,
    updatedAt: doc.updatedAt,
    scenarios: doc.scenarios,
    kinds: SCENARIO_KINDS,
  }
}

export async function getScenario(id) {
  const doc = await readRaw()
  const hit = doc.scenarios.find((s) => s.id === id)
  return hit || null
}

/* ── 会话建团队 → 面板工作项 的惰性对账（2026-11-21）──────────────
 * sidecar 里用会话建的团队，面板注册表里可能没有对应工作项（用户反馈：看不到）。
 * 这里把 sidecar 的 teams 与当前 scenarios 对齐：缺的补建、leadSessionId 不一致的修正。
 * 纯函数、不写盘，便于断言；写盘由 replaceScenarios 单独做。
 */

/** leadSessionId 规范化：统一去掉 session- 前缀，留纯 UUID（读写两处共用） */
export function normalizeSessionId(sid) {
  return String(sid == null ? '' : sid).trim().replace(/^session-/i, '')
}

/** team id → 合规 scenario id（team_mwpsxeul9lagp → team-ul9lagp，符合 ^[a-z0-9-]{1,32}$） */
export function scenarioIdForTeam(teamId) {
  const raw = String(teamId == null ? '' : teamId).toLowerCase().replace(/^team[_-]/, '')
  const suffix = raw.slice(-6) || 'team'
  return 'team-' + suffix
}

/** 由 team 推断 scene kind（scene.kind 只认 software/docs/ecom/research/general） */
function kindForTeam(team) {
  const ws = String((team && team.workspace) || '')
  if (/代码|code|软件|software|src/i.test(ws)) return 'software'
  if (/资料|文档|docs|doc/i.test(ws)) return 'docs'
  return 'general'
}

/**
 * 对账：sidecar teams + 当前 scenarios → 新 scenarios（含补建/修正），并给出变更清单。
 * 幂等：同样输入再算一次 added/repaired 为空、changed=false。
 * @returns {{scenarios:Array, added:Array<string>, repaired:Array<{scenarioId,from,to}>, changed:boolean}}
 */
export function reconcileTeams(teams, currentScenarios) {
  const list = Array.isArray(teams) ? teams : []
  const scenarios = (Array.isArray(currentScenarios) ? currentScenarios : []).map((s) => ({ ...s }))
  const added = []
  const repaired = []
  for (const team of list) {
    if (!team || !team.id) continue
    const wantSid = normalizeSessionId(team.leadSessionId)
    const hit = scenarios.find((s) => s && s.teamId === team.id)
    if (!hit) {
      const kind = kindForTeam(team)
      const rec = {
        id: scenarioIdForTeam(team.id),
        name: team.name || team.id,
        kind,
        workspace: team.workspace || null,
        presetId: presetForKind(kind),
        handbookDir: join(HANDBOOK_ROOT, scenarioIdForTeam(team.id)),
        teamId: team.id,
        leadSessionId: wantSid || null,
        rounds: Number.isFinite(team.rounds) ? team.rounds : 0,
        state: String(team.status || '').toLowerCase() === 'running' ? 'running' : 'idle',
        createdAt: new Date().toISOString(),
        ephemeral: false,
        syncedFromTeam: true,
      }
      scenarios.push(rec)
      added.push(rec.id)
      continue
    }
    // 反向对齐：以 sidecar 为准修正 leadSessionId（保留其它字段不动）
    const curSid = normalizeSessionId(hit.leadSessionId)
    if (curSid !== wantSid) {
      const from = hit.leadSessionId
      hit.leadSessionId = wantSid || null
      repaired.push({ scenarioId: hit.id, from: from == null ? null : String(from), to: hit.leadSessionId })
    }
  }
  return { scenarios, added, repaired, changed: added.length > 0 || repaired.length > 0 }
}

/** 用对账后的完整列表覆盖写盘（只在 changed 时由调用方触发） */
export async function replaceScenarios(scenarios) {
  const doc = await readRaw()
  if (doc._readError) return { ok: false, errors: [doc._readError] }
  doc.scenarios = Array.isArray(scenarios) ? scenarios : []
  await writeRaw(doc)
  return { ok: true, count: doc.scenarios.length, path: REGISTRY_PATH }
}

/* ── 写 ─────────────────────────────────────────────────────────── */

export async function addScenario(input) {
  const errs = validateScenario(input)
  if (errs.length) return { ok: false, errors: errs }

  const doc = await readRaw()
  if (doc.scenarios.some((s) => s.id === input.id)) {
    return { ok: false, errors: [`场景 ${input.id} 已存在；要改请用 updateScenario`] }
  }

  const rec = {
    id: input.id,
    name: input.name || input.id,
    kind: input.kind || 'general',
    workspace: input.workspace || null,
    // T15：presetId 跟随 kind（software→software、docs→ai-team、其他→ai-team），
    // 不再拿 input.id 当 preset 名（id 可能只是 proj-xxx 短哈希，不是 preset）。
    presetId: input.presetId || presetForKind(input.kind || 'general'),
    handbookDir: input.handbookDir || join(HANDBOOK_ROOT, input.id),
    teamId: null,
    leadSessionId: null,
    state: 'idle',
    rounds: 0,
    createdAt: new Date().toISOString(),
    knowledge: input.knowledge || null,
    constraints: input.constraints || {},
  }
  doc.scenarios.push(rec)
  await writeRaw(doc)
  return { ok: true, scenario: rec, path: REGISTRY_PATH }
}

export async function updateScenario(id, patch) {
  const doc = await readRaw()
  const i = doc.scenarios.findIndex((s) => s.id === id)
  if (i < 0) return { ok: false, errors: [`场景 ${id} 不存在`] }
  const cur = doc.scenarios[i]
  // 状态机绕过修复（）：patch 里带 state 必须走 TRANSITIONS 校验，
  // 不许从 updateScenario 侧门把 idle 直接改成 running/done。
  // 合法转换统一走 setState（补 stateSince 与 rounds 语义）。
  if (Object.prototype.hasOwnProperty.call(patch, 'state')) {
    const from = cur.state || 'idle'
    const to = patch.state
    if (to !== from) {
      const allowed = TRANSITIONS[from] || []
      if (!allowed.includes(to)) {
        return {
          ok: false,
          errors: [`非法状态转换 ${from} → ${to}`],
          allowed,
          hint: `从 ${from} 只能转到：${allowed.join(' / ') || '（终态）'}；改状态请用 setState`,
        }
      }
      return setState(id, to, stripState(patch))
    }
  }
  // id 不可改
  const next = { ...cur, ...patch, id: cur.id }
  const errs = validateScenario(next)
  if (errs.length) return { ok: false, errors: errs }
  // 一致性校验：patch 合入后若 state=running，必须满足 teamId/leadSessionId/rounds 约束
  const cons = checkScenarioConsistency(next)
  if (cons.length) {
    return {
      ok: false,
      errors: [`场景 ${id} 一致性校验未过：${cons.join('；')}`],
      hint: 'state=running 需要 teamId 与 leadSessionId 非空；补齐字段或走 setState',
    }
  }
  doc.scenarios[i] = next
  await writeRaw(doc)
  return { ok: true, scenario: next }
}

/** 把 patch 里的 state 键剥掉（state 本身由 setState 写入，避免同章双写） */
function stripState(patch) {
  const p = { ...patch }
  delete p.state
  return p
}

/**
 * 场景一致性校验（ 修复，95 清单改动点①； 调整）。
 * 判定规则：
 * - state=running → teamId 必须非空、leadSessionId 必须非空
 * （无 lead 会话的 running = 空转假象；rounds 在 running 阶段不卡——
 * 开团首轮 rounds 还是 0，rounds 校验不能拦 running，否则 idle→opening→running 全链被卡死）
 * - state=done → rounds>=1（done 是「完成一轮」的终态，rounds 必须已计过轮）
 * - 其余状态不卡（idle/opening/awaiting/revising/closing）。
 * 用法：先 getScenario(id) 拿记录，再传给本函数；返回违规项列表（空 = 一致）。
 * @param {object} sc 场景记录
 * @returns {string[]}
 */
export function checkScenarioConsistency(sc) {
  const errs = []
  if (!sc) return ['场景记录为空']
  if (sc.state === 'running') {
    if (!sc.teamId) errs.push('state=running 但 teamId 为空')
    if (!sc.leadSessionId) errs.push('state=running 但 leadSessionId 为空（无 lead 会话的 running = 空转假象）')
  }
  if (sc.state === 'done') {
    if (!(Number(sc.rounds) >= 1)) errs.push('state=done 但 rounds=0（应有已完成轮次）')
  }
  return errs
}

/** 删除场景（ 临时场景跑完即删用；只删记录，不删 handbook 目录） */
export async function removeScenario(id) {
  const doc = await readRaw()
  const i = doc.scenarios.findIndex((s) => s.id === id)
  if (i < 0) return { ok: false, errors: [`场景 ${id} 不存在`] }
  const [removed] = doc.scenarios.splice(i, 1)
  await writeRaw(doc)
  return { ok: true, removed }
}

/** 状态转换：非法转换直接拒绝，不静默 */export async function setState(id, to, meta = {}) {
  const doc = await readRaw()
  const i = doc.scenarios.findIndex((s) => s.id === id)
  if (i < 0) return { ok: false, errors: [`场景 ${id} 不存在`] }
  const cur = doc.scenarios[i]
  const from = cur.state || 'idle'
  const allowed = TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    return {
      ok: false,
      errors: [`非法状态转换 ${from} → ${to}`],
      allowed,
      hint: `从 ${from} 只能转到：${allowed.join(' / ') || '（终态）'}`,
    }
  }
  const next = { ...cur, state: to, stateSince: new Date().toISOString(), ...meta }
  if (to === 'done') next.rounds = (cur.rounds || 0) + 1
  // 一致性校验（ 调整）：推进到 running 前必须 teamId/leadSessionId 非空；
  // rounds 不再卡 running（开团首轮 rounds=0 是合法态），由 done 态校验。
  // 校验不通过宁可拒绝推进，也不制造「跑着但空转」的假象。
  const cons = checkScenarioConsistency(next)
  if (cons.length) {
    return {
      ok: false,
      errors: [`场景 ${id} 一致性校验未过：${cons.join('；')}`],
      hint: '补全 leadSessionId 后再推进到 running；脏数据订正见 97-修复记录',
    }
  }
  doc.scenarios[i] = next
  await writeRaw(doc)
  return { ok: true, from, to, scenario: next }
}

/* ── 开团前置检查（M1 流水线 S0-S1） ───────────────────────────── */

/**
 * 从任意文件夹「临时开团」——不写注册表，用完即走。
 *
 * 这是对旧设计的修正：以前场景必须预先注册（workspace 写死），
 * 等于把「会话栏能选任意文件夹」退化成「只能开预设好的那几个」。
 * 现在的做法：选文件夹 → 探测类型 → 生成一个内存态场景 → 直接进流水线。
 * 只有用户明确点「保存为场景」时才落注册表。
 */
export async function ephemeralScenario(dir, opts = {}) {
  const { detectProject } = await import('./detect.mjs')
  const det = await detectProject(dir)
  if (!det.ok) {
    return { ok: false, errors: [det.reason || '目录不可用'], dir }
  }
  if (det.kind === 'container') {
    return {
      ok: false,
      errors: ['这是项目容器，不是单一项目'],
      hint: det.reason,
      children: det.children,
      dir,
    }
  }

  const id = opts.id || `ephemeral-${Date.now().toString(36)}`
  const sceneKind = sceneKindFromDetect(det.kind)
  const scenario = {
    id,
    name: opts.name || `${basename(dir)}（临时）`,
    kind: sceneKind,
    workspace: dir,
    // T15：presetId 跟随 scene.kind（software→software、docs→ai-team、其他→ai-team），
    // 不再写死 'ai-team'——否则软件类临时工作项拿到通用 preset，缺软件工程纪律。
    presetId: opts.presetId || presetForKind(sceneKind),
    handbookDir: opts.handbookDir || join(HANDBOOK_ROOT, id),
    teamId: null,
    leadSessionId: null,
    state: 'idle',
    rounds: 0,
    ephemeral: true,
    createdAt: new Date().toISOString(),
    detected: {
      kind: det.kind,
      label: det.label,
      evidence: det.evidence,
      gitRepo: det.gitRepo,
    },
    knowledge: opts.knowledge || null,
    constraints: { ...det.constraints, ...(opts.constraints || {}) },
  }
  return { ok: true, scenario, detected: det, persisted: false }
}

/** 查该场景是否已有可复用的蒸馏 skill（M3 闭环的入口） */
export async function findSkillFor(id) {
  const skillDirs = [
    join(USER_DATA, 'ai-team-console', 'skills'),
    join(HANDBOOK_ROOT, id, 'skills'),
  ]
  for (const d of skillDirs) {
    const f = join(d, `${id}-onboarding.md`)
    if (existsSync(f)) {
      try {
        return { found: true, path: f, content: await readFile(f, 'utf8') }
      } catch { /* 读不到就当没有 */ }
    }
  }
  return { found: false }
}

/** 收集开团所需的全部上下文（不猜，读不到就报缺） */
export async function preflight(id) {
  const sc = await getScenario(id)
  if (!sc) return { ok: false, errors: [`场景 ${id} 未注册`], hint: '先 addScenario' }

  const checks = []

  // 1. preset 存在性（读文件系统，不调 sidecar）
  const pj = join(presetDir(), `${sc.presetId}.json`)
  let preset = { exists: false }
  if (existsSync(pj)) {
    try {
      const doc = JSON.parse(await readFile(pj, 'utf8'))
      const plugins = Array.isArray(doc.plugins) ? doc.plugins : []
      const persona = plugins.find((p) => /dsh-persona/.test(String(p && p.name)))
      const hasRequired = ['@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-todo']
        .every((n) => plugins.some((p) => String(p && p.name) === n))
      preset = {
        exists: true,
        file: pj,
        pluginCount: plugins.length,
        hasPersona: Boolean(persona && persona.config && persona.config.prefix),
        hasRequiredConfig: hasRequired,
      }
    } catch (err) {
      preset = { exists: true, file: pj, broken: String(err.message || err) }
    }
  }
  checks.push({
    id: 'preset',
    label: '场景 preset 可用',
    pass: preset.exists && !preset.broken && preset.hasPersona && preset.hasRequiredConfig,
    detail: !preset.exists
      ? `缺 ${pj}`
      : preset.broken
        ? `解析失败：${preset.broken}`
        : `${preset.pluginCount} 插件 / persona ${preset.hasPersona ? '有' : '缺'} / 必填 config ${preset.hasRequiredConfig ? '全' : '缺'}`,
  })

  // 2. handbook 目录
  const hb = sc.handbookDir
  const hbFiles = ['00-协议.md', '01-成员卡.md', '02-preset.md', '03-验收清单.md', '04-启动指令.md']
  const present = existsSync(hb) ? hbFiles.filter((f) => existsSync(join(hb, f))) : []
  checks.push({
    id: 'handbook',
    label: 'handbook 五件齐全',
    pass: present.length === hbFiles.length,
    detail: present.length === hbFiles.length
      ? `${hb}（5/5）`
      : `${hb}（${present.length}/5）缺：${hbFiles.filter((f) => !present.includes(f)).join('、') || '目录不存在'}`,
  })

  // 3. workspace（软件类必须有）
  if (sc.kind === 'software') {
    checks.push({
      id: 'workspace',
      label: '代码仓库可访问',
      pass: Boolean(sc.workspace) && existsSync(sc.workspace),
      detail: sc.workspace || '未设置 workspace',
    })
  }

  // 4. 是否已有 skill（有则跳过人工判断）
  const skill = await findSkillFor(id)
  checks.push({
    id: 'skill',
    label: '已有蒸馏 skill（有则跑得更快）',
    pass: true, // 不作为失败项，只是加速项
    detail: skill.found ? skill.path : '无（将走默认 9 步）',
    optional: true,
  })

  const blocking = checks.filter((c) => !c.pass && !c.optional)
  return {
    ok: blocking.length === 0,
    scenario: sc,
    checks,
    blocking: blocking.map((c) => c.id),
    skill: skill.found ? { path: skill.path } : null,
    presetFile: preset.file || null,
  }
}

/* ── 收口：记一轮完成（M3 自我迭代的计数依据） ─────────────────── */

export async function recordRound(id, summary) {
  const doc = await readRaw()
  const i = doc.scenarios.findIndex((s) => s.id === id)
  if (i < 0) return { ok: false, errors: [`场景 ${id} 不存在`] }
  const cur = doc.scenarios[i]
  if (!Array.isArray(cur.history)) cur.history = []
  cur.history.push({ at: new Date().toISOString(), summary: summary || '' })
  doc.scenarios[i] = cur
  await writeRaw(doc)

  const doneCount = cur.history.length
  return {
    ok: true,
    rounds: doneCount,
    distillDue: doneCount > 0 && doneCount % 3 === 0,
    hint: doneCount % 3 === 0
      ? `已满 ${doneCount} 轮，该蒸馏 skill 了（memory-to-skill）`
      : `已 ${doneCount} 轮，距下次蒸馏还差 ${3 - (doneCount % 3)} 轮`,
  }
}

export const paths = {
  registry: REGISTRY_PATH,
  handbookRoot: HANDBOOK_ROOT,
  presetDir,
  userData: USER_DATA,
}
