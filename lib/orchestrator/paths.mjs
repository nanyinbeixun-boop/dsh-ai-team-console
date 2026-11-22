/**
 * 数据目录解析（全插件唯一来源）。
 *
 * 位置由宿主决定，插件不写死任何本机路径。解析顺序：
 *   1. DSH_USER_DATA_ROOT —— 显式覆盖（部署方设的，最高优先级）
 *   2. DSH_HOME/data      —— 官方风格命名（存在则直接用）
 *   3. DSH_HOME/user-data —— 备选命名
 *   4. ~/.dsh/user-data   —— 无 DSH_HOME 时的跨平台兜底
 *
 * DSH_HOME 由宿主注入（桌面端通常是 <APPDATA>/dsh-desktop/harness）。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

/** DSH 数据根：优先环境变量，其次按平台推导 */
export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const appData = process.env.APPDATA
  if (appData) {
    const cand = join(appData, 'dsh-desktop', 'harness')
    if (existsSync(cand)) return cand
  }
  return join(homedir(), '.dsh')
}

/**
 * 插件数据根目录。
 * 选了「DSH_HOME 下已存在的第一个候选」，都没有就用第一个候选名（会自动创建）。
 */
export function userDataRoot() {
  if (process.env.DSH_USER_DATA_ROOT) return process.env.DSH_USER_DATA_ROOT
  const home = dshHome()
  // 已存在的优先：data → user-data → 用户数据（旧版兼容）
  const candidates = [
    join(home, 'data'),
    join(home, 'user-data'),
    join(home, '用户数据'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return candidates[0]
}

/** 插件自己的运行数据子目录（工作区根配置等） */
export function pluginDataDir() {
  return join(userDataRoot(), 'plugin-data')
}

/** 会话日志根（候选顺序由 transcript.mjs 决定，这里只给起点） */
export function sessionRoots() {
  const home = dshHome()
  return [
    join(userDataRoot(), '.dsh', 'sessions'),
    join(home, 'sessions'),
    join(home, 'appdata', 'harness', 'sessions'),
  ]
}

/** profile 的 cordis.patch.yml（按 DSH_HOME / APPDATA 推导） */
export function profileFile() {
  return join(dshHome(), 'profiles', 'web', 'cordis.patch.yml')
}

/** 内置 preset 目录（随 DSH 安装包；找不到时返回推导路径，由调用方判存在） */
export function builtinPresetDir() {
  const rel = ['resources', 'app', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets']
  const cands = []
  if (process.env.DSH_APP_DIR) cands.push(join(process.env.DSH_APP_DIR, ...rel))
  if (process.env.DSH_HOME) cands.push(join(process.env.DSH_HOME, ...rel))
  for (const c of cands) if (existsSync(c)) return c
  return cands[0] || join(dshHome(), ...rel)
}
