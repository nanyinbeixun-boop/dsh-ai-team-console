#!/usr/bin/env node
/**
 * dsh-ai-team-console 更新检查
 *
 * 无第三方依赖，纯 Node 内置模块。两种检测源，按可用性自动选择：
 * 1) git 远程：仓库配置了 remote 时，`git fetch`（只读，不改工作区）后比较 HEAD 与上游
 *   2) npm registry：包名可解析时，查 https://registry.npmjs.org/<name>/latest
 *
 * 只做检测与提示，**不自动拉取、不修改任何文件**——更新动作留给用户执行。
 *
 * 用法：
 * node scripts/check-update.mjs            # 人类可读输出，有更新时 exit 0
 * node scripts/check-update.mjs --json     # 机器可读 JSON
 * node scripts/check-update.mjs --strict   # 有更新时 exit 1（给 CI / 脚本用）
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'package.json')

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const strict = argv.includes('--strict')

/** semver 粗比较：返回 1 表示 a>b，-1 表示 a<b，0 相同。只处理 x.y.z[-pre] */
function cmpSemver(a, b) {
  const norm = (v) => String(v || '0').replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const [a1, a2, a3] = norm(a)
  const [b1, b2, b3] = norm(b)
  if (a1 !== b1) return a1 > b1 ? 1 : -1
  if (a2 !== b2) return a2 > b2 ? 1 : -1
  if (a3 !== b3) return a3 > b3 ? 1 : -1
  // 预发布版本低于同版本正式版
  const aPre = String(a).includes('-'), bPre = String(b).includes('-')
  if (aPre !== bPre) return aPre ? -1 : 1
  return 0
}

async function readLocal() {
  const pkg = JSON.parse(await readFile(PKG, 'utf8'))
  return { name: pkg.name, version: pkg.version }
}

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: ROOT, timeout: 15000 })
  return stdout.trim()
}

/** 检测 1：git 上游是否领先 */
async function checkGit() {
  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree'])
    if (inside !== 'true') return { ok: false, reason: '不是 git 仓库' }

    let remoteUrl = ''
    try {
      remoteUrl = await git(['remote', 'get-url', 'origin'])
    } catch {
      return { ok: false, reason: '未配置 origin 远程（纯本地仓库，无上游可比）' }
    }

    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
    const localHead = await git(['rev-parse', 'HEAD'])
    const localShort = localHead.slice(0, 8)

    // 只做只读 fetch，不改工作区
    try {
      await execFileAsync('git', ['fetch', '--quiet', 'origin', branch], { cwd: ROOT, timeout: 30000 })
    } catch (e) {
      return { ok: false, reason: `fetch 失败（${String(e.message || e).slice(0, 120)}）`, remoteUrl, localShort }
    }

    let upstream = ''
    try {
      upstream = await git(['rev-parse', `origin/${branch}`])
    } catch {
      return { ok: false, reason: `上游分支 origin/${branch} 不存在`, remoteUrl, localShort }
    }

    const behind = upstream !== localHead
    let aheadCount = 0
    try {
      aheadCount = parseInt(await git(['rev-list', '--count', `HEAD..origin/${branch}`]), 10) || 0
    } catch { /* ignore */ }

    return {
      ok: true,
      source: 'git',
      remoteUrl,
      branch,
      localShort,
      upstreamShort: upstream.slice(0, 8),
      hasUpdate: behind && aheadCount > 0,
      commitsBehind: aheadCount,
    }
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 160) }
  }
}

/** 检测 2：npm registry 最新版 */
async function checkNpm(name, localVersion) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/latest`
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, reason: `registry 返回 HTTP ${res.status}` }
    const doc = await res.json()
    const latest = String(doc.version || '')
    if (!latest) return { ok: false, reason: 'registry 未返回 version 字段' }
    return {
      ok: true,
      source: 'npm',
      latest,
      hasUpdate: cmpSemver(latest, localVersion) > 0,
    }
  } catch (e) {
    const msg = String(e.message || e)
    return { ok: false, reason: msg.includes('abort') ? '连接 registry 超时' : `registry 查询失败（${msg.slice(0, 100)}）` }
  }
}

async function main() {
  const local = await readLocal()

  const gitRes = await checkGit()
  const npmRes = gitRes.ok ? { ok: false, reason: '已由 git 检测覆盖' } : await checkNpm(local.name, local.version)

  const primary = gitRes.ok ? gitRes : npmRes
  const hasUpdate = primary.ok && primary.hasUpdate === true

  const report = {
    name: local.name,
    localVersion: local.version,
    hasUpdate,
    checkedAt: new Date().toISOString(),
    git: gitRes,
    npm: npmRes,
    advice: hasUpdate
      ? (gitRes.ok
        ? `上游领先 ${gitRes.commitsBehind} 个提交：cd "${ROOT}" && git pull --ff-only`
        : `有新版本 ${npmRes.latest}：npm i -g ${local.name}@${npmRes.latest}`)
      : null,
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    console.log('=== dsh-ai-team-console 更新检查 ===')
    console.log(`  本地版本: ${local.version}`)
    if (gitRes.ok) {
      console.log(`  源      : git  (${gitRes.remoteUrl}, 分支 ${gitRes.branch})`)
      console.log(`  本地 HEAD: ${gitRes.localShort}   上游: ${gitRes.upstreamShort}`)
      console.log(`  上游领先: ${gitRes.commitsBehind} 个提交`)
    } else if (npmRes.ok) {
      console.log(`  源      : npm registry`)
      console.log(`  最新版本: ${npmRes.latest}`)
      console.log(`  git 检测: 跳过（${gitRes.reason}）`)
    } else {
      console.log(`  git 检测: 不可用（${gitRes.reason}）`)
      console.log(`  npm 检测: 不可用（${npmRes.reason}）`)
    }
    console.log('')
    if (hasUpdate) {
      console.log(`  ↑ 有更新：${report.advice}`)
    } else if (primary.ok) {
      console.log('  ✓ 已是最新')
    } else {
      console.log('  ? 无法确定（无可用检测源）——按上面的原因处理后重试')
    }
  }

  if (strict && hasUpdate) process.exit(1)
}

main().catch((e) => {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n')
  } else {
    console.error('检查失败:', e.message)
  }
  process.exit(2)
})
