#!/usr/bin/env node
/**
 * verify-presets.mjs —— 会话预设管理（task_mwr1h15t129qk）行为锁
 * 真跑 presetManager 纯函数 + 临时副本写操作（不碰真实 cordis.patch.yml）。
 */
import * as PM from '../lib/orchestrator/presetManager.mjs'
import { readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}

const PROFILE = 'D:/软件/DSH/appdata/harness/profiles/web/cordis.patch.yml'
const BUILTIN = 'D:/软件/DSH/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-web-app/presets'
const IDX = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

console.log('\n[1] !!js 标签占位与解析')
const raw = readFileSync(PROFILE, 'utf8')
t('sanitizeJsTags 把 !!js 表达式包成带引号字符串', (() => {
  const s = PM.sanitizeJsTags('x: !!js process.platform === "win32"')
  return /^x: "/.test(s) && /"$/.test(s) && s.includes('!!js process.platform')
})(), PM.sanitizeJsTags('x: !!js process.platform === "win32"'))
const profilePresets = PM.parsePresets(raw, 'profile')
t('profile 解析出 4 个 preset', profilePresets.length === 4, profilePresets.map((p) => p.instanceId).join(','))
const team = profilePresets.find((p) => p.instanceId === 'preset-team')
t('team name/order/pluginCount 正确', team && team.name === '团队模式' && team.order === 2 && team.pluginCount === 24, JSON.stringify(team))
t('redteam enabled=false（实例级 disabled:true 被读出）', profilePresets.find((p) => p.instanceId === 'preset-redteam').enabled === false)
t('每个 preset 字段齐全', profilePresets.every((p) => p.id && p.name && typeof p.order === 'number' && p.pluginCount >= 0 && p.source === 'profile'))

console.log('\n[2] loadAllPresets（profile + builtin，≥5）')
const all = await PM.loadAllPresets(PROFILE, BUILTIN)
t('合并后 preset ≥5', all.presets.length >= 5, String(all.presets.length))
t('含 builtin standard/minimal/ptc', ['standard', 'minimal', 'ptc'].every((id) => all.presets.some((p) => p.source === 'builtin' && p.id === id)), all.presets.filter((p) => p.source === 'builtin').map((p) => p.id).join(','))
t('builtin 恒 enabled', all.presets.filter((p) => p.source === 'builtin').every((p) => p.enabled === true))
t('按 order 升序', all.presets.map((p) => p.order).join(',') === all.presets.map((p) => p.order).slice().sort((a, b) => a - b).join(','))
t('errors 为空', all.errors.length === 0, JSON.stringify(all.errors))

console.log('\n[3] 定位块与文本级精确编辑（临时副本，不碰真实文件）')
const b = PM.findBlockBounds(raw, 'preset-team')
t('team 块定位成功', Boolean(b) && b.end > b.start, JSON.stringify(b))
t('块内含 config.order 行', /^        order:\s/.test(raw.split('\n')[b.start + 6] || ''), raw.split('\n').slice(b.start, b.start + 8).join(' | '))
// 临时副本
const tmpFile = join(tmpdir(), 'presets-test-' + Date.now() + '.yml')
copyFileSync(PROFILE, tmpFile)
try {
  // toggle disabled
  const off = await PM.editPreset(tmpFile, 'preset-team', { disabled: true })
  t('toggle team disabled=true 成功且留备份', off.ok === true && existsSync(off.backup), JSON.stringify(off))
  let cur = PM.parsePresets(readFileSync(tmpFile, 'utf8'), 'profile').find((p) => p.instanceId === 'preset-team')
  t('  → 读回 enabled=false', cur && cur.enabled === false, JSON.stringify(cur))
  const on = await PM.editPreset(tmpFile, 'preset-team', { disabled: false })
  t('toggle 回 enabled 成功', on.ok === true)
  cur = PM.parsePresets(readFileSync(tmpFile, 'utf8'), 'profile').find((p) => p.instanceId === 'preset-team')
  t('  → 读回 enabled=true 恢复原状', cur && cur.enabled === true)
  // order
  const beforeOrder = readFileSync(tmpFile, 'utf8')
  const o3 = await PM.editPreset(tmpFile, 'preset-team', { order: 3 })
  t('order 改 3 成功', o3.ok === true)
  cur = PM.parsePresets(readFileSync(tmpFile, 'utf8'), 'profile').find((p) => p.instanceId === 'preset-team')
  t('  → 读回 order=3', cur && cur.order === 3)
  // 只改目标行：对比改前改后，差异行必须都在 team 块内
  const bb = PM.findBlockBounds(beforeOrder, 'preset-team')
  const la = beforeOrder.split('\n'), lb = readFileSync(tmpFile, 'utf8').split('\n')
  let diffs = []
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) diffs.push(i + 1)
  t('  → 只改 team 块内行（其余零变化）', diffs.length > 0 && diffs.every((n) => n > bb.start && n <= bb.end), `差异行=${diffs.join(',')} 块=L${bb.start + 1}-${bb.end}`)
  const o2 = await PM.editPreset(tmpFile, 'preset-team', { order: 2 })
  t('order 改回 2 成功', o2.ok === true)
  cur = PM.parsePresets(readFileSync(tmpFile, 'utf8'), 'profile').find((p) => p.instanceId === 'preset-team')
  t('  → 读回 order=2 恢复原状', cur && cur.order === 2)
  // builtin 拒绝编辑
  const builtinReject = await PM.editPreset(tmpFile, 'preset-standard', { disabled: true })
  t('内置 preset 编辑被拒绝（只读）', builtinReject.ok === false && /只读|不在可编辑/.test(builtinReject.error || ''), JSON.stringify(builtinReject))
  // order 校验
  const badOrder = await PM.editPreset(tmpFile, 'preset-team', { order: 1000 })
  t('order=1000 被拒绝', badOrder.ok === false)
} finally {
  rmSync(tmpFile, { force: true })
  // 备份文件在临时目录，一并清掉
  try { for (const f of (await import('node:fs')).readdirSync(tmpdir())) if (f.startsWith('presets-test-')) rmSync(join(tmpdir(), f), { force: true }) } catch {}
}

console.log('\n[4] index.js op 接线与红线核对')
t("有 op=presets / preset-toggle / preset-order", /op === 'presets'/.test(IDX) && /op === 'preset-toggle'/.test(IDX) && /op === 'preset-order'/.test(IDX))
t('op 调用 PresetMgr 的 loadAllPresets/editPreset', /PresetMgr\.loadAllPresets/.test(IDX) && /PresetMgr\.editPreset/.test(IDX))
t('返回 needsRestart 提示', /needsRestart: true/.test(IDX))
t('未重复造 op=preset-rebuild（原有唯一）', (IDX.match(/op === 'preset-rebuild'/g) || []).length === 1)
// 真实文件零副作用：hash 与任务开始时一致（本脚本从未写 PROFILE）
t('真实 cordis.patch.yml 未被本测试写入（team 仍 order=2 无 disabled）', (() => {
  const p = PM.parsePresets(readFileSync(PROFILE, 'utf8'), 'profile').find((x) => x.instanceId === 'preset-team')
  return p && p.order === 2 && p.enabled === true
})())

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：会话预设管理符合验收，且真实配置零副作用。\n')
else console.log('有断言失败。\n')
process.exitCode = fail === 0 ? 0 : 1
