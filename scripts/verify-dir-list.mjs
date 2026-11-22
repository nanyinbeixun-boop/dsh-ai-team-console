#!/usr/bin/env node
/**
 * verify-dir-list.mjs —— 工作区浏览行为锁
 * 真跑 Detect 纯函数 + 真实文件系统；index.js 的 op 接线做静态核对
 * （服务端已加载旧代码，重启才生效，故不依赖 HTTP）。
 */
import * as Detect from '../lib/orchestrator/detect.mjs'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}

console.log('\n[1] normalizeDir 路径规范化')
t('去尾斜杠', Detect.normalizeDir('D:\\软件\\DSH\\') === 'D:\\软件\\DSH', Detect.normalizeDir('D:\\软件\\DSH\\'))
t('盘符根保留单斜杠', Detect.normalizeDir('D:\\') === 'D:\\', Detect.normalizeDir('D:\\'))
t('空/非字符串返回 null', Detect.normalizeDir('') === null && Detect.normalizeDir(null) === null)
t('相对路径解析为绝对', /^[A-Za-z]:[\\/]/.test(Detect.normalizeDir('.') || ''))

console.log('\n[2] dir-list 核心行为（真实文件系统，模拟 handle 内逻辑）')
function dirList(raw) {
  const fail = (error) => ({ ok: false, path: raw || '', parent: null, dirs: [], error })
 // 空 path = 从根浏览，返回盘符根列表（与 index.js handle 同构）
  if (!raw || !String(raw).trim()) {
    const dirs = Detect.driveRoots().map((d) => ({ name: d.path, path: d.path }))
    return { ok: true, path: '', parent: null, dirs }
  }
  const p = Detect.normalizeDir(raw)
  if (!p) return fail('路径无效')
  if (!existsSync(p)) return fail('目录不存在：' + p)
  try {
    const names = readdirSync(p)
    const dirs = []
    for (const name of names) {
      if (dirs.length >= 500) break
      const full = join(p, name)
      try { if (!statSync(full).isDirectory()) continue } catch { continue }
      dirs.push({ name, path: full })
    }
    dirs.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))
    const parentRaw = dirname(p)
    const parent = (parentRaw === p || /^[A-Za-z]:[\\/]?$/.test(p)) ? null : parentRaw
    return { ok: true, path: p, parent, dirs }
  } catch (e) { return fail('无法读取目录：' + e.message) }
}
const root = fileURLToPath(new URL('..', import.meta.url)) // ai-team-console 目录
const one = dirList(root)
t('真实目录 → ok=true', one.ok === true, JSON.stringify({ ok: one.ok, err: one.error }))
t('只列目录不列文件', one.dirs.every((d) => statSync(d.path).isDirectory()))
t('按名称排序', one.dirs.map((d) => d.name).join(',') === one.dirs.map((d) => d.name).slice().sort((a, b) => a.localeCompare(b, 'zh-CN')).join(','))
t('parent 是上一级', one.parent === dirname(root), `${one.parent} vs ${dirname(root)}`)
const rootDrv = dirList('D:\\')
t('盘符根 parent=null', rootDrv.ok && rootDrv.parent === null, `${rootDrv.parent}`)
t('盘符根能列出子目录', rootDrv.dirs.length > 0, String(rootDrv.dirs.length))
const missing = dirList('Z:\\不存在')
t('不存在的路径 → ok=false + 可读错误', missing.ok === false && /不存在/.test(missing.error), JSON.stringify(missing))
const notDir = dirList(join(root, 'package.json'))
t('文件（非目录）→ ok=false', notDir.ok === false, JSON.stringify(notDir))
// P2 回归锁：空 path 从根浏览，不报"路径无效"
const empty = dirList('')
t('空 path → ok=true', empty.ok === true, JSON.stringify(empty))
t('  → dirs 至少含一个盘符根', empty.dirs.length > 0 && empty.dirs.every((d) => /^[A-Za-z]:\\$/.test(d.path)), JSON.stringify(empty.dirs))
t('  → parent=null、path=""', empty.parent === null && empty.path === '')
t('空串/未定义都当根浏览', dirList(undefined).ok === true && dirList('   ').ok === true)

console.log('\n[3] suggestWorkspaces 可扩展（配置 + 盘符根，结构不变）')
const sug = await Detect.suggestWorkspaces({ roots: [{ path: root, label: '测试根' }] })
t('返回结构 path/label/children 不变', sug.length > 0 && sug.every((r) => r.path && r.label && Array.isArray(r.children)))
t('注入的自定义根出现在结果', sug.some((r) => r.path === Detect.normalizeDir(root) && r.label === '测试根'))
t('盘符根被追加（D:\\ 在结果里）', sug.some((r) => r.path === 'D:\\'), sug.map((r) => r.path).join(' | '))
t('去重（无重复 path）', new Set(sug.map((r) => r.path.toLowerCase())).size === sug.length)
t('children 只含目录', sug.every((r) => r.children.every((c) => statSync(c.path).isDirectory())))
const sugDefault = await Detect.suggestWorkspaces({ userDataRoot: 'Z:\\不存在的用户数据根' })
t('配置不存在时回落默认三个 + 盘符根（不抛）', Array.isArray(sugDefault) && sugDefault.some((r) => r.path === 'D:\\'))

console.log('\n[3.5] roots 来源标记 source（default/drive/user，前端据此显示删除按钮）')
t('每个根都带 source 字段且取值合法', sug.every((r) => ['default', 'drive', 'user'].includes(r.source)), sug.map((r) => `${r.path}:${r.source}`).join(' | '))
// 默认三个根 source=default（在默认配置下）
const defSug = await Detect.suggestWorkspaces({ userDataRoot: 'Z:\\无配置' })
for (const d of ['D:\\代码', 'D:\\软件\\DSH\\用户数据', 'D:\\资料']) {
  const hit = defSug.find((r) => Detect.normalizeDir(r.path) === Detect.normalizeDir(d))
  if (hit) t(`默认根 ${d} source=default`, hit.source === 'default', JSON.stringify(hit))
}
t('盘符根 source=drive', defSug.filter((r) => /^[A-Za-z]:\\$/.test(r.path)).every((r) => r.source === 'drive'),
  defSug.filter((r) => /^[A-Za-z]:\\$/.test(r.path)).map((r) => `${r.path}:${r.source}`).join(','))
// 写一个自定义根到临时配置，验证 source=user + 去重不重复 + 优先级覆盖
{
  const fsProm = await import('node:fs/promises')
  const tmpRoot = join(tmpdir(), 'dsh-atc-verify-' + Date.now())
  const cfgFile = Detect.workspaceRootsFile(tmpRoot)
  const customPath = Detect.normalizeDir(root) // 一个真实存在的目录
  try {
    await fsProm.mkdir(dirname(cfgFile), { recursive: true })
    await fsProm.writeFile(cfgFile, JSON.stringify({ roots: [{ path: customPath, label: '测试自定义根' }] }), 'utf8')
    const userSug = await Detect.suggestWorkspaces({ userDataRoot: tmpRoot })
    const userHit = userSug.filter((r) => Detect.normalizeDir(r.path) === customPath)
    t('自定义根 source=user', userHit.length === 1 && userHit[0].source === 'user', JSON.stringify(userHit))
    t('  → 同一路径只出现一次（不重复）', userHit.length === 1, `出现 ${userHit.length} 次`)
    // 默认根的位置由 detect 模块决定（可从环境变量覆盖），这里动态取，
    // 不写死具体路径——否则换了数据目录就会误报失败。
    const defaults = Detect.defaultRoots().map((r) => Detect.normalizeDir(r.path))
    t('  → 默认三个仍在（并集，不再被自定义顶掉）',
      defaults.every((d) => userSug.some((r) => Detect.normalizeDir(r.path) === d)),
      `默认=${JSON.stringify(defaults)} 实际=${JSON.stringify(userSug.map((r) => r.path))}`)
 // 同路径既是默认又是用户（如把默认根写进配置）→ source 应为 user（用户更具体）
    await fsProm.writeFile(cfgFile, JSON.stringify({ roots: [{ path: 'D:\\代码', label: '我把默认根也加了' }] }), 'utf8')
    const clashSug = await Detect.suggestWorkspaces({ userDataRoot: tmpRoot })
    const clashHit = clashSug.filter((r) => Detect.normalizeDir(r.path) === Detect.normalizeDir('D:\\代码'))
    t('同路径默认+用户冲突 → source=user（user>default）', clashHit.length === 1 && clashHit[0].source === 'user', JSON.stringify(clashHit))
    t('strongerSource 优先级函数正确', Detect.strongerSource('user', 'default') === 'user'
      && Detect.strongerSource('default', 'drive') === 'default' && Detect.strongerSource('drive', 'user') === 'user')
  } finally {
    await fsProm.rm(tmpRoot, { recursive: true, force: true }).catch(() => {}) // 测试数据还原
  }
}

console.log('\n[4] index.js op 接线（静态核对，服务端重启才生效）')
const idx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
t("有 op === 'dir-list' 分支", /op === 'dir-list'/.test(idx))
t("有 op === 'workspace-add-root' 分支", /op === 'workspace-add-root'/.test(idx))
t("有 op === 'workspace-remove-root' 分支", /op === 'workspace-remove-root'/.test(idx))
t('dir-list 分支含 500 上限与 parent', /dirs\.length >= 500/.test(idx) && /parent =/.test(idx))
// P2 空 path 分支：锁 index.js 真用 driveRoots 返回盘符列表（不只靠测试脚本里的模拟函数）
t('空 path 分支调用 driveRoots 返回盘符（非空但无效仍报错）',
  /!raw \|\| !String\(raw\)\.trim\(\)/.test(idx)
  && /Detect\.driveRoots\(\)\.map/.test(idx)
  && /return json\(res, 200, \{ ok: true, path: '', parent: null, dirs \}\)/.test(idx)
  && /fail\('路径无效/.test(idx))
t('workspace-suggest 传入 userDataRoot', /suggestWorkspaces\(\{ userDataRoot: userDataRoot\(\) \}\)/.test(idx))
t('add/remove 写 workspace-roots.json 且去重', /workspaceRootsFile\(userDataRoot\(\)\)/.test(idx) && /changed: false/.test(idx))

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：工作区浏览与根目录扩展符合验收。\n')
else console.log('有断言失败。\n')
process.exitCode = fail === 0 ? 0 : 1
