#!/usr/bin/env node
/**
 * 敏感信息扫描 —— 提交前必跑
 *
 * 扫描 git 已跟踪文件（或暂存区），检测凭据、网络拓扑、账号标识。
 * 有命中返回 exit 1，可直接接进 CI 或 pre-commit。
 *
 * 用法：
 * node scripts/scan-secrets.mjs            # 扫全部已跟踪文件
 * node scripts/scan-secrets.mjs --staged   # 只扫暂存区（pre-commit 用）
 * node scripts/scan-secrets.mjs --json     # 机器可读
 *
 * 规则来源：见本文件 RULES 表的注释（每类都写了为什么排除）
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const stagedOnly = argv.includes('--staged')
const asJson = argv.includes('--json')

/* ── 检测规则 ─────────────────────────────────────────────── */
/** 回环地址与私有网段：不算泄露—— 127.x/10.x/192.168.x/172.16-31.x 不携带拓扑信息 */
const LOOPBACK_PRIVATE = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0|255\.)/

const RULES = [
  { name: 'API Key (sk-)', re: /\bsk-[A-Za-z0-9_-]{16,}/g, level: 'high' },
  { name: 'Bearer Token', re: /\bBearer\s+[A-Za-z0-9_\-.=]{20,}/gi, level: 'high' },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, level: 'high' },
  { name: 'password 赋值', re: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{4,}["']/gi, level: 'high' },
  { name: 'secret 赋值', re: /(?:secret|apiKey|api_key|accessKey|access_key|privateKey|private_key)\s*[:=]\s*["'][^"']{8,}["']/gi, level: 'high' },
  { name: 'token 赋值', re: /(?:token|authToken|accessToken|refreshToken)\s*[:=]\s*["'][^"']{16,}["']/gi, level: 'high' },
  { name: 'Authorization 头', re: /Authorization\s*:\s*["']?(?:Bearer|Basic|Token)\s+\S{12,}/gi, level: 'high' },
  { name: '订阅链接 token', re: /subscribe\?token=[A-Za-z0-9]{16,}/gi, level: 'high' },
  // 代理节点域名：不列举具体服务商（列举本身即泄露线索），改按通用特征匹配
  { name: '代理节点域名', re: /\b[a-z]{3,12}\d{1,3}(?:dns|node|proxy|vpn|sub)\b/gi, level: 'high' },
  { name: '公网 IPv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, level: 'high', filter: (m) => !LOOPBACK_PRIVATE.test(m) },
  { name: '手机号(含掩码)', re: /\b1[3-9]\d(?:\*{4}|\d{4})\d{4}\b/g, level: 'high' },
  { name: '邮箱', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, level: 'medium' },
  { name: '长16进制账号ID', re: /\b[0-9a-f]{24}\b/g, level: 'medium' },
]

/** 允许出现的示例值（文档举例、占位符） */
const ALLOWLIST = [
  /^(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255)$/,
  // 文档里说明「掩码也不安全」时用的占位号码，不是真实账号：
  // 中间四位星号 + 尾号是 1234 / 0000 / 5678 这类典型示例
  /^1[3-9]\d\*{4}(?:1234|0000|5678)$/,
  /@example\.(?:com|org)$/,
  /^(?:0{24}|f{24})$/,
]

/* 掩码手机号默认仍然报：形状如「前三后四、中间四位星号」的形式
   仍能唯一定位账号 —— 掩码不是脱敏，是弱化。
   确需放行的示例值写进下方 ALLOWLIST。 */

function mask(s) {
  if (s.length <= 10) return s
  return s.slice(0, 6) + '…' + s.slice(-4)
}

async function gitFiles() {
  const args = stagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['ls-files']
  const { stdout } = await execFileAsync('git', args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 })
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.zstd', '.zip', '.gz'])

async function main() {
  let files
  try {
    files = await gitFiles()
  } catch (e) {
    console.error('无法读取 git 文件列表:', e.message)
    process.exit(2)
  }

  // 本文件自身含规则定义，跳过避免自命中
  const SELF = 'scripts/scan-secrets.mjs'

  const findings = []
  let scanned = 0

  for (const rel of files) {
    if (rel === SELF) continue
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
    if (SKIP_EXT.has(ext)) continue
    const abs = join(ROOT, rel.split('/').join(sep))
    let text
    try {
      const buf = await readFile(abs)
      if (isBinary(buf)) continue
      text = buf.toString('utf8')
    } catch {
      continue
    }
    scanned++

    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(text)) !== null) {
        const hit = m[0]
        if (rule.filter && !rule.filter(hit)) continue
        if (ALLOWLIST.some((a) => a.test(hit))) continue
        const line = text.slice(0, m.index).split('\n').length
        findings.push({ file: rel, line, rule: rule.name, level: rule.level, sample: mask(hit) })
      }
    }
  }

  const high = findings.filter((f) => f.level === 'high')
  const medium = findings.filter((f) => f.level === 'medium')

  if (asJson) {
    process.stdout.write(JSON.stringify({
      scanned, stagedOnly,
      high: high.length, medium: medium.length,
      findings,
    }, null, 2) + '\n')
  } else {
    console.log('=== 敏感信息扫描 ===')
    console.log(`  模式  : ${stagedOnly ? '暂存区' : '全部已跟踪文件'}`)
    console.log(`  扫描  : ${scanned} 个文本文件`)
    console.log('')

    if (findings.length === 0) {
      console.log('  ✓ 未发现敏感信息')
    } else {
      if (high.length) {
        console.log(`  ✗ 高危 ${high.length} 处：`)
        for (const f of high.slice(0, 40)) {
          console.log(`      ${f.file}:${f.line}  [${f.rule}]  ${f.sample}`)
        }
        if (high.length > 40) console.log(`      …还有 ${high.length - 40} 处`)
      }
      if (medium.length) {
        console.log(`  ⚠ 中危 ${medium.length} 处：`)
        for (const f of medium.slice(0, 20)) {
          console.log(`      ${f.file}:${f.line}  [${f.rule}]  ${f.sample}`)
        }
        if (medium.length > 20) console.log(`      …还有 ${medium.length - 20} 处`)
      }
      console.log('')
      console.log('  处理方式：凭据先撤销再清历史；网络/账号移出仓库并加 .gitignore。')
    }
  }

  if (high.length > 0) process.exit(1)
  if (stagedOnly && medium.length > 0) process.exit(1)
}

main().catch((e) => {
  console.error('扫描失败:', e.message)
  process.exit(2)
})
