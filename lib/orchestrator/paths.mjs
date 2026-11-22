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
import { fileURLToPath } from 'node:url'

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
 *
 * 解析顺序（先按宿主约定，再按本机存储铁律兜底）：
 *   1. DSH_USER_DATA_ROOT   —— 显式覆盖（部署方设的，最高优先级）
 *   2. 插件安装目录的 data/ —— 铁律：DSH 数据统一落在插件实体所在目录，
 *                              插件实体就在那里，数据跟着走才不会写到 C 盘
 *   3. DSH_HOME/data        —— 宿主官方约定
 *   4. DSH_HOME/user-data   —— 备选命名
 *
 * 第 2 条排在第 3 条前面是有意的：本机把 DSH 相关数据统一收在 D 盘，
 * 宿主给的 data 目录在 C:\...\AppData，直接用它会把数据留在 C 盘。
 */
export function userDataRoot() {
  if (process.env.DSH_USER_DATA_ROOT) return process.env.DSH_USER_DATA_ROOT

  // 插件自身目录（本文件在 <plugin>/lib/orchestrator/，往上三层是插件根）
  const pluginRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')
  const ownData = join(pluginRoot, 'data')
  // 插件根下已有 data/ 就说明这本插件的存储就在那儿
  if (existsSync(ownData) && existsSync(join(pluginRoot, 'package.json'))) {
    return ownData
  }

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
  return userDataRoot()
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
