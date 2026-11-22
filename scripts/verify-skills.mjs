#!/usr/bin/env node
/**
 * verify-skills.mjs —— op=skills 元数据行为锁
 * 临时 userDataRoot + 动态 import，隔离真实 skill 库。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-meta-'))
process.env.DSH_USER_DATA_ROOT = tmpRoot
const stamp = Date.now()
const Evolve = await import(`../lib/orchestrator/evolve.mjs?t=${stamp}`)

console.log('\n[1] 纯函数 roughChars / previewOf')
t('roughChars 去 markdown 标记后计数', Evolve.roughChars('# 标题\n**粗体** `code`\n正文一二三') === 13, Evolve.roughChars('# 标题\n**粗体** `code`\n正文一二三'))
t('roughChars 空值不炸', Evolve.roughChars(null) === 0)
const long = '甲'.repeat(500)
const pv = Evolve.previewOf(long, 300)
t('previewOf 截断到 300 + 省略号', pv.length === 301 && pv.endsWith('…'), String(pv.length))
t('previewOf 短文本原样', Evolve.previewOf('短文本') === '短文本')
t('previewOf 压缩空白', Evolve.previewOf('a  b\nc') === 'a b c')

console.log('\n[2] listSkills 元数据（临时目录假 md）')
const skillDir = join(tmpRoot, 'ai-team-console', 'skills')
const pendingDir = join(skillDir, '_pending')
mkdirSync(pendingDir, { recursive: true })
const mdContent = '# 测试技能\n\n这是一个用于验证元数据的技能草稿。\n\n## 做了什么\n完成了一系列操作。\n'
writeFileSync(join(skillDir, 'active-test.md'), mdContent, 'utf8')
writeFileSync(join(pendingDir, 'pending-test.md'), mdContent + '待批内容。', 'utf8')
const res = await Evolve.listSkills()
t('返回含 active/pending/errors/root/pendingRoot', Array.isArray(res.active) && Array.isArray(res.pending) && Array.isArray(res.errors) && res.root && res.pendingRoot)
t('active 1 项、pending 1 项', res.active.length === 1 && res.pending.length === 1, JSON.stringify({ a: res.active.length, p: res.pending.length }))
const a = res.active[0]
t('保留 file/path 不变', a.file === 'active-test.md' && a.path === join(skillDir, 'active-test.md'), JSON.stringify(a))
t('bytes>0 且等于文件真实字节数', a.bytes > 0 && a.bytes === readFileSync(a.path).length, String(a.bytes))
t('chars>0', a.chars > 0, String(a.chars))
t('preview 是正文前缀', typeof a.preview === 'string' && mdContent.replace(/\s+/g, ' ').trim().startsWith(a.preview.replace(/…$/, '')), a.preview)
t('preview 长度≤300', typeof a.preview === 'string' && a.preview.length <= 300, String(a.preview))
t('mtime 是正数时间戳', typeof a.mtime === 'number' && a.mtime > 0, String(a.mtime))
const p = res.pending[0]
t('pending 项同样有元数据', p.bytes > 0 && p.chars > 0 && typeof p.mtime === 'number' && typeof p.preview === 'string' && p.preview.length <= 300, JSON.stringify(p))
t('正常情况 errors 为空数组', res.errors.length === 0, JSON.stringify(res.errors))

console.log('\n[3] 单文件读失败不拖垮接口（errors 记录）')
// 造一个 dangling symlink（stat 失败）→ 应跳过并记录 error，不影响另一正常项
let linkOk = false
try {
  const { symlinkSync } = await import('node:fs')
  symlinkSync(join(skillDir, 'nonexistent-target.md'), join(skillDir, 'broken-link.md'))
  linkOk = true
} catch { /* Windows 无权限建链接则跳过本子测试 */ }
if (linkOk) {
  const res2 = await Evolve.listSkills()
  t('坏链接被跳过、正常项仍在', res2.active.some((x) => x.file === 'active-test.md') && !res2.active.some((x) => x.file === 'broken-link.md'), JSON.stringify(res2.active.map((x) => x.file)))
  t('  → errors 记一条 broken-link', res2.errors.some((e) => e.file === 'broken-link.md'), JSON.stringify(res2.errors))
} else {
  t('（跳过 symlink 子测试：当前环境无建链接权限）', true)
}

console.log('\n[4] 静态接线与失败隔离（防"读失败抛穿整个接口"回归）')
const idx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
t("op === 'skills' 仍调用 Evolve.listSkills", /op === 'skills'/.test(idx) && /Evolve\.listSkills\(\)/.test(idx))
const evSrc = readFileSync(new URL('../lib/orchestrator/evolve.mjs', import.meta.url), 'utf8')
t('listSkills 单文件读失败走 errors.push 而非 throw',
  /errors\.push\(\{ kind, file: f, path: full, error:/.test(evSrc)
  && !/errors\.push[\s\S]{0,80}throw e/.test(evSrc))
t('两个目录都经过 enrich（active/pending 同逻辑）',
  /await enrich\(SKILL_ROOT, active, 'active'\)/.test(evSrc) && /await enrich\(PENDING_ROOT, pending, 'pending'\)/.test(evSrc))

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：op=skills 元数据齐全且不影响读失败隔离。\n')
else console.log('有断言失败。\n')
process.exitCode = fail === 0 ? 0 : 1
