/**
 * 项目探测 —— 面板选文件夹后，自动判断这是什么项目、该给什么约束。
 *
 * 为什么要这一步：之前我把「某项目」硬编码进面板，等于把「会话栏能选任意文件夹」
 * 退化成「只能开某项目」。正确做法是运行时探测。
 *
 * 探测不猜：只认文件系统里真实存在的标记文件。认不出就明说「未识别」，
 * 让用户手选类型，不拿默认值糊。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, basename, extname, resolve } from 'node:path'

/** 各项目类型的识别标记与默认约束 */
const KINDS = [
  {
    kind: 'dotnet-script',
    label: 'C# 直编脚本项目（无 csproj）',
    markers: ['编译.ps1'],
    strong: (dir) => {
      // 编译.ps1 + 大量 .cs + 没有 csproj = 某项目这类
      try {
        const has = readdirSync(dir).includes('编译.ps1')
        return has
      } catch { return false }
    },
    constraints: {
      csharpVersion: '7.3',
      allowNewNuget: false,
      mustSnapshot: true,
      mustCompile: true,
      autoLoop: false,
      buildEntry: '编译.ps1（根目录，Roslyn csc.dll 直编 源码\\**\\*.cs；本项目无 csproj，auto_test 之类必失败）',
    },
  },
  {
    kind: 'dotnet',
    label: 'C# / .NET 工程',
    markers: ['*.csproj', '*.sln'],
    constraints: {
      mustSnapshot: true,
      mustCompile: true,
      autoLoop: false,
      buildEntry: 'dotnet build',
    },
  },
  {
    kind: 'node',
    label: 'Node.js / 前端工程',
    markers: ['package.json'],
    constraints: {
      mustSnapshot: true,
      mustCompile: true,
      autoLoop: false,
      buildEntry: 'package.json 的 scripts.build / scripts.test',
    },
  },
  {
    kind: 'python',
    label: 'Python 工程',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    constraints: {
      mustSnapshot: true,
      mustCompile: false,
      autoLoop: false,
      buildEntry: 'python -m pytest / python -m compileall',
    },
  },
  {
    kind: 'rust',
    label: 'Rust 工程',
    markers: ['Cargo.toml'],
    constraints: { mustSnapshot: true, mustCompile: true, autoLoop: false, buildEntry: 'cargo build' },
  },
  {
    kind: 'go',
    label: 'Go 工程',
    markers: ['go.mod'],
    constraints: { mustSnapshot: true, mustCompile: true, autoLoop: false, buildEntry: 'go build ./...' },
  },
  {
    kind: 'docs',
    label: '文档目录',
    markers: ['*.md', '*.txt'],
    constraints: { autoLoop: false },
  },
]

/**
 * 探测一个目录是什么项目。
 * @returns {{ok:boolean, dir:string, kind:string|null, label:string, evidence:string[], constraints:object, stats:object, reason?:string}}
 */
export async function detectProject(dir) {
  if (!dir) return { ok: false, dir, kind: null, label: '未指定', evidence: [], constraints: {}, stats: {}, reason: '目录为空' }
  if (!existsSync(dir)) {
    return { ok: false, dir, kind: null, label: '不存在', evidence: [], constraints: {}, stats: {}, reason: `目录不存在：${dir}` }
  }
  let st
  try { st = statSync(dir) } catch (e) {
    return { ok: false, dir, kind: null, label: '不可读', evidence: [], constraints: {}, stats: {}, reason: String(e.message) }
  }
  if (!st.isDirectory()) {
    return { ok: false, dir, kind: null, label: '不是目录', evidence: [], constraints: {}, stats: {}, reason: '需要传文件夹而不是文件' }
  }

  // 统计（限深度，避免大仓库卡住）
  const stats = await quickStats(dir)

  // 逐个判据，返回所有命中的证据
  const evidence = []
  let matched = null
  for (const k of KINDS) {
    for (const marker of k.markers) {
      if (marker.startsWith('*.')) {
        const ext = marker.slice(1)
        if (stats.byExt[ext] > 0) {
          if (!matched && k.kind !== 'docs') { matched = k; }
          evidence.push(`${marker} × ${stats.byExt[ext]}`)
        }
      } else if (existsSync(join(dir, marker))) {
        if (!matched) matched = k
        evidence.push(marker)
      }
    }
    if (k.strong && k.strong(dir)) {
      matched = k
      evidence.push('编译.ps1（C# 直编脚本标记）')
      break
    }
  }

  // 容器目录优先：如果一个目录下已经有成熟项目（带 .git 或构建标记的子目录），
  // 就不该把它自己判成小说/文稿 —— 那是把「代码仓库的父目录」误当文稿目录。
  // 实例：某个代码根目录下有数百个 .md（都在子项目里），曾经被误判为文档目录。
  const childProjects = detectChildProjects(dir)
  if (childProjects.length > 0 && !matched) {
    return {
      ok: true,
      dir,
      kind: 'container',
      label: '容器目录（下有多个项目）',
      evidence: childProjects.slice(0, 6).map((c) => c.name),
      constraints: {},
      stats,
      children: childProjects,
      reason: `这里是项目容器，不是单一项目。请选下面某个具体项目：${childProjects.map((c) => c.name).slice(0, 5).join('、')}`,
    }
  }

  // 文档目录是兜底：只有大量 md/txt 且没有代码标记、也不是容器时才算
  if (!matched && (stats.byExt['.md'] || 0) + (stats.byExt['.txt'] || 0) > 5) {
    matched = KINDS.find((k) => k.kind === 'docs')
    evidence.push(`.md/.txt × ${(stats.byExt['.md'] || 0) + (stats.byExt['.txt'] || 0)}`)
  }

  if (!matched) {
    return {
      ok: true, dir, kind: null, label: '未识别', evidence,
      constraints: {}, stats,
      reason: '没有命中任何项目标记。可以手动指定类型，或直接当通用目录用。',
    }
  }

  // 该类型特有信息
  const extra = {}
  if (matched.kind === 'dotnet-script' || matched.kind === 'dotnet') {
    extra.csprojCount = stats.csprojCount
  }
  if (matched.kind === 'node') {
    try {
      const pj = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      extra.packageName = pj.name
      extra.scripts = Object.keys(pj.scripts || {})
    } catch { /* package.json 坏了不影响探测 */ }
  }

  return {
    ok: true,
    dir,
    kind: matched.kind,
    label: matched.label,
    evidence,
    constraints: { ...matched.constraints },
    stats,
    extra,
    gitRepo: existsSync(join(dir, '.git')),
  }
}

/** 快速统计：限深度 3，限条目数，避免超大仓库拖死面板 */
async function quickStats(dir, maxDepth = 3, maxEntries = 6000) {
  const byExt = {}
  let files = 0
  let csprojCount = 0
  let scanned = 0
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'bin', 'obj', '.next', 'target', '__pycache__', '历史归档', '_backup', 'Quarantine', 'RegBackups'])

  const walk = (d, depth) => {
    if (depth > maxDepth || scanned > maxEntries) return
    let names
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      if (scanned++ > maxEntries) return
      if (SKIP.has(n)) continue
      const p = join(d, n)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) { walk(p, depth + 1); continue }
      files++
      const e = extname(n).toLowerCase()
      if (e) byExt[e] = (byExt[e] || 0) + 1
      if (e === '.csproj') csprojCount++
    }
  }
  walk(dir, 0)

  return { files, byExt, csprojCount, scanned, truncated: scanned > maxEntries }
}

/**
 * 探测直接子目录里哪些是「成熟项目」（有 .git 或构建标记）。
 * 用于识别「容器目录」，避免把「代码根目录」这种父目录误判成文稿目录。
 */
function detectChildProjects(dir) {
  const BUILD_MARKERS = [
    '编译.ps1', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
    'requirements.txt', 'setup.py', 'pom.xml', 'build.gradle',
  ]
  let names
  try { names = readdirSync(dir) } catch { return [] }
  const out = []
  for (const n of names) {
    const p = join(dir, n)
    let s
    try { s = statSync(p) } catch { continue }
    if (!s.isDirectory()) continue
    const hasGit = existsSync(join(p, '.git'))
    const hits = BUILD_MARKERS.filter((m) => existsSync(join(p, m)))
    // 也看一眼有没有 .csproj/.sln（不限顶层）
    let hasProj = false
    try {
      const inner = readdirSync(p)
      hasProj = inner.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))
    } catch { /* ignore */ }
    if (hasGit || hits.length > 0 || hasProj) {
      out.push({ name: n, path: p, hasGit, markers: hits.concat(hasProj ? ['.csproj'] : []) })
    }
  }
  return out
}

/**
 * 探测项目的「知识目录」—— 项目根下按候选顺序找含 .md 的知识约定目录。
 *
 * 为什么靠探测不靠硬编码：知识目录的位置因项目而异（某项目在
 * ai_self_evolution/knowledge/wiki，别的项目可能在 .ai/knowledge 或 docs/patterns）。
 * 写死路径 = 换项目就失效。这里按固定候选顺序逐个探，第一个「存在且含 .md」的目录即命中。
 *
 * 候选顺序（越具体越靠前）：
 * 1. ai_self_evolution/knowledge/wiki
 * 2. ai_self_evolution/knowledge
 * 3. .ai/knowledge
 * 4. knowledge
 * 5. docs/patterns
 *
 * @param {string} root 项目根目录
 * @returns {{knowledgeDirs:string[], knowledgeFiles:string[]}} 找到的目录与文件；找不到返回空数组，不报错。
 */
export function detectKnowledgeDirs(root) {
  const candidates = [
    join(root, 'ai_self_evolution', 'knowledge', 'wiki'),
    join(root, 'ai_self_evolution', 'knowledge'),
    join(root, '.ai', 'knowledge'),
    join(root, 'knowledge'),
    join(root, 'docs', 'patterns'),
  ]
  const knowledgeDirs = []
  const knowledgeFiles = []
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    let mdFiles = []
    try {
      mdFiles = readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.md'))
        .map((n) => join(dir, n))
    } catch { /* 目录不可读就跳过 */ }
    if (mdFiles.length > 0) {
      knowledgeDirs.push(dir)
      for (const f of mdFiles) knowledgeFiles.push(f)
    }
  }
  return { knowledgeDirs, knowledgeFiles }
}

/* ── 工作区候选根：可扩展（2026-11-21）─────────────────────────────
 * 旧版三个根目录写死在数组里，用户想加自己的目录只能改代码。现在：
 * ① 读用户配置 <userDataRoot>/plugin-data/workspace-roots.json（不存在用默认三个）；
 * ② 追加当前所有有权限的盘符根（C:\ / D:\ …）；
 * ③ 规范化 + 去重 + 只保留真实存在的目录。
 * 每个根带 source（default/drive/user），前端据此只对 user 显示删除按钮。
 * 返回结构在 {path,label,children} 基础上多一个 source 字段（不破坏前端）。
 */
/**
 * 内置默认工作区候选。
 *
 * 这三个只是「开箱即用的便利」，不是功能依赖：
 *   - 目录不存在会被过滤掉（见下方 existsSync 判断）
 *   - 用户可用 `DSH_WORKSPACE_ROOTS`（分号分隔）整组覆盖
 *   - 用户自己添加的目录（source='user'）优先级最高，
 *     盘符根（source='drive'）由运行时自动枚举
 */
function defaultRoots() {
  const fromEnv = process.env.DSH_WORKSPACE_ROOTS
  if (fromEnv) {
    return fromEnv
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => ({ path: p, label: p, source: 'default' }))
  }
  return [
    { path: 'D:\\代码', label: '代码', source: 'default' },
    { path: 'D:\\软件\\DSH\\用户数据', label: 'DSH 用户数据', source: 'default' },
    { path: 'D:\\资料', label: '资料', source: 'default' },
  ]
}

/** source 优先级：用户自定义 > 内置默认 > 自动盘符（去重时保留最具体的标签） */
const SOURCE_RANK = { user: 3, default: 2, drive: 1 }
export function strongerSource(a, b) {
  return (SOURCE_RANK[a] || 0) >= (SOURCE_RANK[b] || 0) ? a : b
}

/** 路径规范化：绝对路径、去尾斜杠（盘符根保留一个 \）；失败返回 null */
export function normalizeDir(input) {
  if (typeof input !== 'string' || !input.trim()) return null
  try {
    let p = resolve(input.trim())
    // resolve('D:\\') 在 Windows 返回 'D:\'；去掉多余尾斜杠但保留盘符根
    const rootMatch = p.match(/^([A-Za-z]:)[\\\/]+$/)
    if (rootMatch) return rootMatch[1] + '\\'
    while (p.length > 1 && /[\\\/]$/.test(p)) p = p.slice(0, -1)
    return p
  } catch { return null }
}

/** 配置文件绝对路径（userDataRoot 由调用方注入，缺省取环境变量或默认） */
export function workspaceRootsFile(userDataRoot) {
  const base = userDataRoot || process.env.DSH_USER_DATA_ROOT || 'D:\\软件\\DSH\\用户数据'
  return join(base, 'plugin-data', 'workspace-roots.json')
}

/** 读工作区根：内置默认三个 + 用户自定义（workspace-roots.json）的并集，各带 source。
 * 旧版是「有 custom 就用 custom，否则用默认」——用户加了根后默认三个消失；
 * 现在改成并集，前端能同时看到默认/用户根并按 source 决定能否删除。坏文件不影响面板。 */
export async function readWorkspaceRoots(userDataRoot) {
  let custom = []
  try {
    const raw = await readFile(workspaceRootsFile(userDataRoot), 'utf8')
    const parsed = JSON.parse(raw.replace(/^\ufeff/, ''))
    if (Array.isArray(parsed.roots)) custom = parsed.roots.filter((r) => r && r.path).map((r) => ({ ...r, source: 'user' }))
  } catch { /* 文件不存在/坏 JSON → 只有默认 */ }
  // 默认在前、用户在后；规范化 + 去重（同路径保留更强 source）
  const byKey = new Map()
  for (const r of [...defaultRoots(), ...custom]) {
    const p = normalizeDir(r.path)
    if (!p || !existsSync(p)) continue
    const k = p.toLowerCase()
    const src = r.source || 'default'
    const prev = byKey.get(k)
    if (prev) { prev.source = strongerSource(prev.source, src); continue }
    byKey.set(k, { path: p, label: r.label || p, source: src })
  }
  return [...byKey.values()]
}

/** 枚举当前有权限的盘符根（Windows: C:\~Z:\，逐盘试 readdir） */
export function driveRoots() {
  if (process.platform !== 'win32') return []
  const out = []
  for (let c = 65; c <= 90; c++) { // A-Z
    const letter = String.fromCharCode(c)
    const p = letter + ':\\'
    if (!existsSync(p)) continue
    try { readdirSync(p); out.push({ path: p, label: p, source: 'drive' }) } catch { /* 无权限/光驱空盘，跳过 */ }
  }
  return out
}

/** 常见工作区候选（面板快捷入口）：用户配置 + 盘符根，去重后只留存在的目录 */
export async function suggestWorkspaces(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const cands = o.roots
    ? o.roots.map((r) => ({ path: normalizeDir(r.path), label: r.label || r.path, source: r.source || 'user' })).filter((r) => r.path && existsSync(r.path))
    : await readWorkspaceRoots(o.userDataRoot)
  // 追加盘符根；去重时同路径保留更强 source（user>default>drive），但不改变首次出现的位置（保序）
  const byKey = new Map()
  for (const r of [...cands, ...driveRoots()]) {
    const k = r.path.toLowerCase()
    const prev = byKey.get(k)
    if (prev) { prev.source = strongerSource(prev.source, r.source || 'drive'); continue }
    byKey.set(k, { ...r, source: r.source || 'drive' })
  }
  const merged = [...byKey.values()]
  const out = []
  for (const c of merged) {
    let children = []
    try {
      children = readdirSync(c.path)
        .map((n) => join(c.path, n))
        .filter((p) => { try { return statSync(p).isDirectory() } catch { return false } })
        .sort()
        .slice(0, 30)
    } catch { /* ignore */ }
    out.push({ ...c, children: children.map((p) => ({ path: p, name: basename(p) })) })
  }
  return out
}

export const knownKinds = KINDS.map((k) => ({ kind: k.kind, label: k.label, markers: k.markers }))
