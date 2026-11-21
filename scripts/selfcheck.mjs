/**
 * 插件自检 —— 装完/改完后跑一次，防「入口掉了」这类事故。
 *
 * 起源：2026-11-21 面板入口整片消失，根因是 package.json 被 PowerShell
 * 的 Set-Content -Encoding UTF8 写入了 UTF-8 BOM，DSH 读不了 package.json，
 * 整个插件不加载，于是 sidebar 入口全部消失。
 *
 * 用法：node scripts/selfcheck.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
let failed = 0

function check(name, fn) {
  try {
    const r = fn()
    if (r === true) results.push({ ok: true, name })
    else {
      results.push({ ok: false, name, detail: typeof r === 'string' ? r : '未通过' })
      failed++
    }
  } catch (e) {
    results.push({ ok: false, name, detail: String(e && e.message ? e.message : e) })
    failed++
  }
}

/** BOM 检测：这是本轮事故的直接原因 */
function hasBOM(path) {
  const b = readFileSync(path)
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git') continue
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (['.json', '.js', '.mjs', '.md', '.yml'].includes(extname(n))) out.push(p)
  }
  return out
}

/* ── 1. 所有文本文件无 BOM（最关键） ──────────────────────────── */
check('所有 .json/.js/.mjs/.md/.yml 无 BOM', () => {
  const bad = walk(ROOT).filter(hasBOM).map((p) => p.slice(ROOT.length + 1))
  return bad.length === 0 ? true : `带 BOM：${bad.join('、')}`
})

/* ── 2. package.json 可解析 ────────────────────────────────────── */
check('package.json 是合法 JSON', () => {
  const pj = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (pj.name !== 'dsh-ai-team-console') return `name 异常：${pj.name}`
  return true
})

/* ── 3. package.json 声明的入口文件都存在 ──────────────────────── */
check('package.json 的 main/exports/bundle.patch 均存在', () => {
  const pj = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const need = [pj.main, pj.exports?.['.']?.import, pj.exports?.['./client'], pj.dsh?.bundle?.patch].filter(Boolean)
  const missing = need.filter((p) => !existsSync(join(ROOT, p)))
  return missing.length === 0 ? true : `缺：${missing.join('、')}`
})

/* ── 4. client 的 inject 与 package.json 的 dsh.client.inject 一致 ── */
check('client 服务依赖声明一致', () => {
  const pj = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const declared = (pj.dsh?.client?.inject) || []
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const m = src.match(/var inject = \[([^\]]*)\]/)
  if (!m) return 'client.js 里找不到 inject 声明'
  const actual = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  // client.js 用短名（slots），package.json 用包名；只要数量匹配且短名能在包名里找到即可
  const ok = actual.every((a) => declared.some((d) => d.includes(a)))
  return ok ? true : `client 用了 [${actual.join(',')}]，package 声明 [${declared.join(',')}]`
})

/* ── 5. 各模块语法真解析（不再只看「文件非空」） ────────────────
 * 旧版这一项只检查文件非空，等于声称「语法无误」却不做语法检查——
 * 和流水线 S6 假通过同一类毛病。这里改成真跑一次解析：
 * 1) 先试 node --check（对 ESM/CJS 都有效）
 * 2) 失败再试 new Function（浏览器 factory 包裹的 client.js 用它兜底）
 * 两种都失败才算语法错。
 */
check('lib 下 JS 模块语法无误（真解析）', () => {
  const files = walk(join(ROOT, 'lib')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  const errs = []
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1)
    const txt = readFileSync(f, 'utf8')
    if (!txt.trim()) { errs.push(`${rel} 为空`); continue }
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
    if (r.status === 0) continue
    try {
      // eslint-disable-next-line no-new-func
      new Function(txt)
    } catch (e) {
      const msg = String((r.stderr || '').split('\n').find((l) => /Error|error/.test(l)) || e.message || '解析失败').trim()
      errs.push(`${rel}: ${msg.slice(0, 160)}`)
    }
  }
  return errs.length === 0 ? true : errs.join('；')
})

/* ── 8. 客户端调的 op 服务端都认得（防「点了按钮 400 unknown op」） ──
 * 面板大量功能靠 op 名串起来，拼错或漏实现不会在加载期报错，
 * 只在用户真点时炸。这里静态对表，把这类回归挡在重启之前。
 */
check('client 调用的 op 在服务端都有分支', () => {
  const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const serverSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

  const used = new Set()
  for (const m of clientSrc.matchAll(/op=([a-z][a-z0-9-]+)/g)) used.add(m[1])
  for (const m of clientSrc.matchAll(/mut\.send\(\s*'([a-z][a-z0-9-]+)'/g)) used.add(m[1])

  const handled = new Set()
  for (const m of serverSrc.matchAll(/op === '([a-z][a-z0-9-]+)'/g)) handled.add(m[1])

  const missing = [...used].filter((x) => !handled.has(x)).sort()
  return missing.length === 0 ? true : `服务端没有这些 op 分支：${missing.join('、')}`
})

/* ── 6. cordis 挂载块存在 ──────────────────────────────────────── */
check('profile 的 cordis.patch.yml 里有挂载块', () => {
  const p = 'D:\\软件\\DSH\\appdata\\harness\\profiles\\web\\cordis.patch.yml'
  if (!existsSync(p)) return 'cordis.patch.yml 不存在'
  const txt = readFileSync(p, 'utf8')
  return /- id: dsh-ai-team-console/.test(txt) ? true : '缺少 - id: dsh-ai-team-console 挂载行'
})

/* ── 7. node_modules junction 存在且指向本目录 ─────────────────── */
check('profile/node_modules 里有 dsh-ai-team-console', () => {
  const p = 'D:\\软件\\DSH\\appdata\\harness\\profiles\\web\\node_modules\\dsh-ai-team-console'
  if (!existsSync(p)) return `不存在：${p}`
  if (!existsSync(join(p, 'package.json'))) return 'junction 指向的目录里没有 package.json'
  return true
})

/* ── 输出 ─────────────────────────────────────────────────────── */
console.log('\n=== dsh-ai-team-console 自检 ===\n')
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`)
  if (!r.ok && r.detail) console.log(`      ${r.detail}`)
}
console.log('')
if (failed === 0) {
  console.log(`全部 ${results.length} 项通过。`)
} else {
  console.log(`${failed}/${results.length} 项未通过 —— 先修这些再重启 DSH。`)
  console.log('\n最常见的原因：package.json 被写入了 UTF-8 BOM（PowerShell Set-Content -Encoding UTF8 会加）。')
  console.log('修法：用 [System.IO.File]::WriteAllText(path, text, (New-Object System.Text.UTF8Encoding($false)))')
  process.exitCode = 1
}
