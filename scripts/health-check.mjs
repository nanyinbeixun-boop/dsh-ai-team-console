#!/usr/bin/env node
/**
 * 健康巡检 —— 一条命令回答「现在这个插件还能正常工作吗」。
 *
 * 覆盖四类：
 *   1. 宿主能力     —— DSH 升级后内部 API 是否还在（走 host.mjs 探测）
 *   2. 上游版本     —— 仓库有没有新提交 / npm 有没有新版
 *   3. sidecar 可达 —— dsh-team 服务是否响应
 *   4. 数据结构漂移 —— sidecar 返回的字段是否还是我们认识的样子
 *
 * 用法：
 *   node scripts/health-check.mjs          # 人类可读
 *   node scripts/health-check.mjs --json   # 机器可读
 *   node scripts/health-check.mjs --offline  # 跳过联网检查
 *
 * 退出码：全部正常 0；有警告 1；有错误 2。
 */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const offline = argv.includes('--offline')

// ── 检查结果收集 ─────────────────────────────────────────
const results = []
function add(section, name, status, detail) {
  results.push({ section, name, status, detail: String(detail || '') })
}

// ══════════════════════════════════════════════════════════
// 1. 宿主能力（静态分析：lib 里对 ctx 的调用 + host.mjs 的探测函数）
// ══════════════════════════════════════════════════════════
async function checkHost() {
  const HOST = join(ROOT, 'lib', 'orchestrator', 'host.mjs')
  try {
    const mod = await import('file:///' + HOST.replace(/\\/g, '/'))
    const fns = ['capabilities', 'healthReport', 'listAgents', 'getAgent',
      'canFollowup', 'followup', 'clearInbox', 'canSendToMember',
      'sendToMember', 'registerSlot', 'registerEffect', 'registerWebRoute']
    const missing = fns.filter((f) => typeof mod[f] !== 'function')
    if (missing.length) {
      add('宿主适配层', '导出完整性', 'error', `缺少 ${missing.join('、')}`)
    } else {
      add('宿主适配层', '导出完整性', 'ok', `${fns.length} 个能力函数齐全`)
    }
    // 空 ctx 探测：应该全部 false 且不抛错
    try {
      const caps = mod.capabilities({})
      const allFalse = Object.values(caps).every((v) => v === false)
      add('宿主适配层', '空 ctx 降级', allFalse ? 'ok' : 'warn',
        allFalse ? '空 ctx 下全部能力返回 false（不抛错）' : `有字段异常：${JSON.stringify(caps)}`)
    } catch (e) {
      add('宿主适配层', '空 ctx 降级', 'error', `抛错：${e.message}`)
    }
  } catch (e) {
    add('宿主适配层', '模块加载', 'error', `host.mjs 加载失败：${e.message}`)
  }

  // 静态扫描：还有没有绕过适配层的直连
  const { execFileSync } = await import('node:child_process')
  let direct = 0
  try {
    const out = execFileSync('grep', ['-rE', '-c',
      'ctx\\.slots\\.(inject|register)|agents\\.(list|get)\\(|subagents\\.sendMessage\\(',
      join(ROOT, 'lib')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split('\n')) {
      const m = line.match(/:(\d+)$/)
      if (m) direct += parseInt(m[1], 10)
    }
  } catch { /* grep 没命中会非零退出，正常 */ }
  add('宿主适配层', '绕过检查', direct <= 2 ? 'ok' : 'warn',
    `${direct} 处直连（leadProbe 探针直连宿主属预期；>2 需检查）`)
}

// ══════════════════════════════════════════════════════════
// 2. 上游版本
// ══════════════════════════════════════════════════════════
async function checkUpstream() {
  if (offline) {
    add('上游版本', 'git 远程', 'skip', '--offline 已跳过')
    return
  }
  try {
    const r = await execFileAsync('git', ['ls-remote', '--heads', 'origin', 'main'],
      { cwd: ROOT, timeout: 20000 })
    const remoteSha = (r.stdout || '').trim().split(/\s/)[0]
    const localR = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT })
    const localSha = (localR.stdout || '').trim()
    if (!remoteSha) {
      add('上游版本', 'git 远程', 'warn', '拿不到远程 HEAD（网络或权限）')
    } else if (remoteSha === localSha) {
      add('上游版本', 'git 远程', 'ok', `本地 = 远程（${localSha.slice(0, 8)}）`)
    } else {
      add('上游版本', 'git 远程', 'warn', `本地 ${localSha.slice(0, 8)} / 远程 ${remoteSha.slice(0, 8)}（可能需 push 或 pull）`)
    }
  } catch (e) {
    add('上游版本', 'git 远程', 'warn', `查询失败：${String(e.message || e).slice(0, 80)}`)
  }
}

// ══════════════════════════════════════════════════════════
// 3. sidecar 可达
// ══════════════════════════════════════════════════════════
const SIDECAR = process.env.DSH_TEAM_SIDECAR_URL
  || process.env.DSH_TEAM_SIDECAR
  || 'http://127.0.0.1:4317'

async function checkSidecar() {
  if (offline) {
    add('sidecar', '可达性', 'skip', '--offline 已跳过')
    return
  }
  const t0 = Date.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${SIDECAR}/api/teams`, { signal: ctrl.signal })
    clearTimeout(timer)
    const ms = Date.now() - t0
    if (!res.ok) {
      add('sidecar', '可达性', 'error', `HTTP ${res.status}（${ms}ms）`)
      return
    }
    add('sidecar', '可达性', 'ok', `HTTP ${res.status}（${ms}ms）@ ${SIDECAR}`)

    // ── 数据结构漂移检测 ──
    const doc = await res.json()
    const teams = Array.isArray(doc) ? doc : (doc.items || doc.teams || [])
    if (!Array.isArray(teams)) {
      add('sidecar', '数据结构', 'error', `teams 不是数组：${typeof teams}`)
      return
    }
    add('sidecar', '数据结构', 'ok', `teams 数组，${teams.length} 条`)

    if (teams.length > 0) {
      const t = teams[0]
      // 我们依赖的字段
      const REQUIRED = ['id', 'name']
      const OPTIONAL = ['maxMembers', 'memberCount', 'status', 'leadSessionId']
      const missReq = REQUIRED.filter((k) => !(k in t))
      const missOpt = OPTIONAL.filter((k) => !(k in t))
      if (missReq.length) {
        add('sidecar', '字段漂移', 'error', `必填字段缺失：${missReq.join('、')}`)
      } else if (missOpt.length) {
        add('sidecar', '字段漂移', 'warn', `可选字段缺失：${missOpt.join('、')}（降级但可用）`)
      } else {
        add('sidecar', '字段漂移', 'ok', '依赖字段齐全')
      }
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    add('sidecar', '可达性', 'error',
      msg.includes('abort') ? `超时（>8s）@ ${SIDECAR}` : `连接失败：${msg.slice(0, 80)}`)
  }
}

// ══════════════════════════════════════════════════════════
// 4. 本地完整性（profile 挂载 / 数据目录 / 预设在位）
// ══════════════════════════════════════════════════════════
async function checkLocal() {
  const Paths = await import('file:///' + join(ROOT, 'lib', 'orchestrator', 'paths.mjs').replace(/\\/g, '/'))
  const { existsSync } = await import('node:fs')

  const profile = Paths.profileFile()
  add('本地完整性', 'profile 文件', existsSync(profile) ? 'ok' : 'error', profile)

  const dataRoot = Paths.userDataRoot()
  add('本地完整性', '数据目录', existsSync(dataRoot) ? 'ok' : 'warn', dataRoot)

  const builtin = Paths.builtinPresetDir()
  add('本地完整性', '内置预设', existsSync(builtin) ? 'ok' : 'warn',
    existsSync(builtin) ? builtin : `未找到（工程装在其他目录属正常）：${builtin}`)
}

// ══════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════
await checkHost()
await checkLocal()
await checkUpstream()
await checkSidecar()

const errors = results.filter((r) => r.status === 'error')
const warns = results.filter((r) => r.status === 'warn')
const oks = results.filter((r) => r.status === 'ok')

if (asJson) {
  console.log(JSON.stringify({
    ok: errors.length === 0,
    errors: errors.length,
    warns: warns.length,
    oks: oks.length,
    results,
  }, null, 2))
} else {
  console.log('\n' + '='.repeat(64))
  console.log('  健康巡检')
  console.log('='.repeat(64) + '\n')
  let cur = ''
  const ICON = { ok: 'OK  ', warn: 'WARN', error: 'FAIL', skip: '--  ' }
  for (const r of results) {
    if (r.section !== cur) {
      if (cur) console.log('')
      console.log(`  [${r.section}]`)
      cur = r.section
    }
    console.log(`    ${ICON[r.status]} ${r.name.padEnd(14)} ${r.detail}`)
  }
  console.log('\n' + '-'.repeat(64))
  console.log(`  ${oks.length} 正常   ${warns.length} 警告   ${errors.length} 错误`)
  if (errors.length > 0) {
    console.log('\n  错误项：')
    for (const e of errors) console.log(`    · ${e.section} / ${e.name}：${e.detail}`)
  }
  console.log('')
}

process.exit(errors.length > 0 ? 2 : warns.length > 0 ? 1 : 0)
