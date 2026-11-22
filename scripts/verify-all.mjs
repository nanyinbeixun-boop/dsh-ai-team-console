#!/usr/bin/env node
/**
 * 统一验证入口：跑全部 verify-* 脚本并汇总。
 *
 * 用法
 * node scripts/verify-all.mjs # 跑全部，汇总表格
 * node scripts/verify-all.mjs --fast # 跳过 --slow 标记的脚本
 * node scripts/verify-all.mjs routes # 只跑名字含 "routes" 的
 * node scripts/verify-all.mjs --json # 机器可读
 *
 * 退出码：全部通过 0，有失败 1，无法执行 2。
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const fastOnly = argv.includes('--fast')
const filter = argv.find((a) => !a.startsWith('--'))

/** 已知较慢的脚本（跑满整条路由链） */
const SLOW = new Set(['verify-routes.mjs', 'verify-after-restart.mjs'])

async function main() {
  let entries = await readdir(HERE)
  let scripts = entries
    .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs') && f !== 'verify-all.mjs')
    .sort()

  if (filter) scripts = scripts.filter((f) => f.includes(filter))
  if (fastOnly) scripts = scripts.filter((f) => !SLOW.has(f))

  if (scripts.length === 0) {
    console.error('没有匹配的验证脚本')
    process.exit(2)
  }

  const results = []
  const started = Date.now()

  for (const s of scripts) {
    const t0 = Date.now()
    let status = 'pass'
    let out = ''
    let detail = ''
    try {
      const r = await execFileAsync(process.execPath, [join(HERE, s)], {
        cwd: ROOT,
        timeout: 180000,
        maxBuffer: 16 * 1024 * 1024,
      })
      out = (r.stdout || '') + (r.stderr || '')
    } catch (e) {
      status = 'fail'
      out = String((e.stdout || '') + (e.stderr || '') || e.message || '')
    }
    const ms = Date.now() - t0
    if (status !== 'fail') {
 // 非零退出码也可能是 script 主动 exit(1) 表示断言失败
      if (/\bpass=\d+\s+fail=[1-9]/.test(out)) status = 'fail'
      if (/未通过|不通过|FAIL\b/.test(out)) status = 'fail'
    }
 // 取最后一行非空作为摘要
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
    detail = lines.reverse().find((l) => /pass=|全部通过|通过|失败|fail=/i.test(l)) || lines[0] || ''
    results.push({ script: s, status, ms, detail: detail.slice(0, 100) })
  }

  const total = Date.now() - started
  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.length - passed

  if (asJson) {
    process.stdout.write(JSON.stringify({ total, passed, failed, results }, null, 2) + '\n')
  } else {
    console.log('\n' + '='.repeat(66))
    console.log('  验证套件')
    console.log('='.repeat(66) + '\n')
    const w = Math.max(...results.map((r) => r.script.length))
    for (const r of results) {
      const mark = r.status === 'pass' ? 'PASS' : 'FAIL'
      console.log(`  [${mark}] ${r.script.padEnd(w)}  ${String(r.ms).padStart(6)}ms  ${r.detail}`)
    }
    console.log('\n' + '-'.repeat(66))
    console.log(`  ${passed}/${results.length} 通过   总耗时 ${(total / 1000).toFixed(1)}s`)
    if (failed > 0) {
      console.log(`\n  ${failed} 个脚本未通过，逐条看上面的摘要`)
    }
    console.log('')
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('验证套件执行失败:', e.message)
  process.exit(2)
})
