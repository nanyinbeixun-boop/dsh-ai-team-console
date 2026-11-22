/**
 * 会话预设管理：读取 / 启停 / 调序 DSH 的 agent preset。
 * - 解析 cordis.patch.yml 的 agent preset（!!js 标签占位后交给 js-yaml）
 * - 文本级精确编辑：只改目标 preset 块的 disabled / config.order 两行，绝不 dump 整个 YAML
 * 纯函数模块：IO 由调用方（index.js）做，便于断言。
 */
import { createRequire } from 'node:module'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 解析 js-yaml：宿主在 profile 的 node_modules 里装了它，但 profile 位置因
// 安装方式而异。按「环境变量 → 常见默认位置 → 本模块解析链」依次尝试，
// 全失败时给出可执行的修复指引，而不是抛一个找不到模块的裸错误。
function resolveYaml() {
  const cands = []
  if (process.env.DSH_PROFILE_DIR) cands.push(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_HOME) {
    cands.push(join(process.env.DSH_HOME, 'profiles', 'web'))
    cands.push(join(process.env.DSH_HOME, 'appdata', 'harness', 'profiles', 'web'))
  }
  // 桌面端的配置目录（Windows）
  if (process.env.APPDATA) {
    cands.push(join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'web'))
  }
  cands.push(join(homedir(), '.dsh', 'profiles', 'web'))

  const tried = []
  for (const dir of cands) {
    try {
      const req = createRequire(join(dir, 'package.json'))
      return req('js-yaml')
    } catch (e) {
      tried.push(`${dir} (${e && e.code ? e.code : 'error'})`)
    }
  }
  // 最后一试：从本模块的解析链加载（js-yaml 被提升到上层时有效）
  try {
    const req = createRequire(import.meta.url)
    return req('js-yaml')
  } catch { /* 继续到下方统一报错 */ }

  throw new Error(
    '找不到 js-yaml（会话预设功能需要它解析 YAML）。\n' +
    '修法：设置 DSH_PROFILE_DIR 指向含 node_modules 的 profile 目录，例如\n' +
    '  export DSH_PROFILE_DIR=<DSH_HOME>/profiles/web\n' +
    '尝试过的位置:\n  ' + tried.join('\n  ')
  )
}

const yaml = resolveYaml()

/** 把 !!js 表达式换成字符串字面量（仅内存解析用），避免 js-yaml 因未知 tag 报错 */
export function sanitizeJsTags(text) {
  return String(text == null ? '' : text).replace(/!!js[ \t]+([^\n]*)/g, (_, expr) => JSON.stringify('!!js ' + String(expr).trim()))
}

/** 解析 YAML 文本，返回所有 @deepseek-ai/dsh-agent-preset 实例（source 由调用方标注） */
export function parsePresets(text, source = 'profile') {
  const doc = yaml.load(sanitizeJsTags(text))
  const out = []
  const entries = Array.isArray(doc) ? doc : []
  for (const entry of entries) {
    const inserts = entry && entry.insert ? (Array.isArray(entry.insert) ? entry.insert : [entry.insert]) : []
    for (const it of inserts) {
      if (!it || it.name !== '@deepseek-ai/dsh-agent-preset') continue
      const cfg = it.config || {}
      out.push({
        instanceId: String(it.id || ''),
        id: String(cfg.id || ''),
        name: String(cfg.name || cfg.id || ''),
        description: String(cfg.description || ''),
        order: Number.isFinite(Number(cfg.order)) ? Number(cfg.order) : null,
        pluginCount: Array.isArray(cfg.plugins) ? cfg.plugins.length : 0,
        source,
        // 只有 profile 实例才能操作；builtin 恒 enabled 且拒绝写
        enabled: it.disabled === true ? false : true,
      })
    }
  }
  return out
}

/**
 * 定位 preset 实例的文本块起止行（含 start，不含 end）。
 * 块起点：恰好 4 空格 + "- id: <instanceId>"；终点：下一个同级实例/顶层 entry 或 EOF。
 */
export function findBlockBounds(text, instanceId) {
  const lines = String(text == null ? '' : text).split('\n')
  const startRe = new RegExp('^    - id: ' + instanceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$')
  let start = -1
  for (let i = 0; i < lines.length; i++) if (startRe.test(lines[i])) { start = i; break }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    // 下一个 preset 实例（4 空格）或下一个顶层 entry（0 空格 "- "）或顶层 key
    if (/^    - id:\s/.test(lines[i]) || /^- \S/.test(lines[i])) { end = i; break }
  }
  return { start, end }
}

/** 在目标块里改/加实例级 disabled 行，只动这一行；返回新文本或 throw 可读错误 */
export function setDisabledInText(text, instanceId, disabled) {
  const b = findBlockBounds(text, instanceId)
  if (!b) throw new Error(`找不到 preset 实例 ${instanceId}`)
  const lines = String(text).split('\n')
  const want = disabled === true ? 'true' : 'false'
  let found = false
  for (let i = b.start + 1; i < b.end; i++) {
    // 实例级 disabled：恰好 6 空格；plugin 内的 disabled 是 12+ 空格，不能动
    if (/^      disabled:\s*/.test(lines[i])) { lines[i] = `      disabled: ${want}`; found = true; break }
  }
  if (!found) {
    // 没有就插在 name 行之前（保持 name/config 结构），找不到 name 就插在块首后
    let at = -1
    for (let i = b.start + 1; i < b.end; i++) if (/^      name:\s/.test(lines[i])) { at = i; break }
    if (at < 0) at = b.start + 1
    lines.splice(at, 0, `      disabled: ${want}`)
  }
  return lines.join('\n')
}

/** 在目标块里改 config.order 行，只动这一行；校验 0-999 整数 */
export function setOrderInText(text, instanceId, order) {
  const n = typeof order === 'string' && order.trim() !== '' ? Number(order) : order
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 999) throw new Error('order 必须是 0-999 的整数')
  const b = findBlockBounds(text, instanceId)
  if (!b) throw new Error(`找不到 preset 实例 ${instanceId}`)
  const lines = String(text).split('\n')
  let found = false
  for (let i = b.start + 1; i < b.end; i++) {
    // config 内 order：恰好 8 空格
    if (/^        order:\s/.test(lines[i])) { lines[i] = `        order: ${n}`; found = true; break }
  }
  if (!found) throw new Error(`${instanceId} 块内找不到 config.order 行，拒绝猜测写入`)
  return lines.join('\n')
}

/** 写后回读校验：新文本仍能被解析，且目标 preset 的字段符合预期 */
export function verifyWritten(text, instanceId, expect) {
  const list = parsePresets(text, 'profile')
  const hit = list.find((p) => p.instanceId === instanceId)
  if (!hit) return false
  if (expect && Object.prototype.hasOwnProperty.call(expect, 'enabled') && hit.enabled !== expect.enabled) return false
  if (expect && Object.prototype.hasOwnProperty.call(expect, 'order') && hit.order !== expect.order) return false
  return true
}

/* ── IO 封装（路径由调用方注入，模块不写死机器路径）───────────────── */

/** 读所有 preset：profile 文件（可操作）+ 内置目录（只读），按 order 排序 */
export async function loadAllPresets(profileFile, builtinDir, builtinNames = ['standard', 'minimal', 'ptc']) {
  const errors = []
  const out = []
  try {
    out.push(...parsePresets(await readFile(profileFile, 'utf8'), 'profile'))
  } catch (e) { errors.push({ source: 'profile', error: String(e && e.message ? e.message : e) }) }
  if (builtinDir) {
    for (const name of builtinNames) {
      try {
        const text = await readFile(join(builtinDir, `${name}.patch.yml`), 'utf8')
        const parsed = parsePresets(text, 'builtin')
        // 内置 preset 的 instanceId 用 preset-<name>（安装目录里 id 可能缺失），恒 enabled
        for (const p of parsed) {
          out.push({ ...p, instanceId: p.instanceId || ('preset-' + (p.id || name)), enabled: true, source: 'builtin' })
        }
      } catch (e) { errors.push({ source: 'builtin:' + name, error: String(e && e.message ? e.message : e) }) }
    }
  }
  out.sort((a, b) => (a.order == null ? 9999 : a.order) - (b.order == null ? 9999 : b.order))
  return { presets: out, errors }
}

/**
 * 精确编辑 profile 文件里的目标 preset：备份 → 只改两行 → 回读校验 → 写盘。
 * builtin（instanceId 不在 profile 里）拒绝。
 * @param {string} file profile cordis.patch.yml 路径
 * @param {string} instanceId 目标实例 id
 * @param {{disabled?:boolean, order?:number}} edit
 */
export async function editPreset(file, instanceId, edit) {
  const original = await readFile(file, 'utf8')
  const profileList = parsePresets(original, 'profile')
  if (!profileList.some((p) => p.instanceId === instanceId)) {
    return { ok: false, error: `实例 ${instanceId} 不在可编辑的 profile 预设里（内置预设只读）` }
  }
  let next = original
  try {
    if (Object.prototype.hasOwnProperty.call(edit, 'disabled')) next = setDisabledInText(next, instanceId, edit.disabled)
    if (Object.prototype.hasOwnProperty.call(edit, 'order')) next = setOrderInText(next, instanceId, edit.order)
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
  const expect = {}
  if (Object.prototype.hasOwnProperty.call(edit, 'disabled')) expect.enabled = edit.disabled !== true
  if (Object.prototype.hasOwnProperty.call(edit, 'order')) expect.order = Number(edit.order)
  if (!verifyWritten(next, instanceId, expect)) return { ok: false, error: '写后回读校验未过，未写盘' }
  // 备份（只在真要写时）
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${file}.bak-preset-${stamp}`
  await copyFile(file, backup)
  await writeFile(file, next, 'utf8')
  return { ok: true, backup, changedLines: original.split('\n').length !== next.split('\n').length ? 'inserted' : 'in-place' }
}
