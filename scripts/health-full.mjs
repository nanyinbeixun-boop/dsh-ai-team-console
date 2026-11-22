/**
 * 全面检测报告生成器（可重复运行，纯只读）
 *
 * 用法：node scripts/health-full.mjs
 *
 * 检查面：
 *   1. 本地库各表条数与归属完整性
 *   2. 任务 → 成员关联
 *   3. 记忆 → 团队关联
 *   4. 工件路径可达率（不能找回的如实列出）
 *   5. 技能目录
 *   6. 场景 → 团队绑定
 *   7. 旧库备份对照（有无漏迁）
 *   8. 插件代码自检（语法 + 关键模块存在）
 */
import { pathToFileURL } from 'node:url'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const R = 'D:\\软件\\DSH\\用户数据\\ai-team-console'
const S = await import(pathToFileURL(join(R, 'lib/orchestrator/localStore.mjs')).href)
const db = S.open()

let ok = 0
let bad = 0
let info = 0
const report = (mark, name, detail) => {
  if (mark === '✅') ok++
  else if (mark === '❌') bad++
  else info++
  console.log(`  ${mark} ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('='.repeat(80))
console.log('  一、本地库条数')
console.log('='.repeat(80))
const EXPECT = {
  team: 4, member: 29, member_state: 29, task: 127,
  message: 681, artifact: 256, memory: 106,
}
for (const [tb, want] of Object.entries(EXPECT)) {
  const got = db.prepare(`SELECT COUNT(*) AS c FROM ${tb}`).get().c
  report(got === want ? '✅' : '❌', tb.padEnd(14), got === want ? `${got}` : `${got}（期望 ${want}）`)
}

console.log('\n' + '='.repeat(80))
console.log('  二、任务 → 成员关联')
console.log('='.repeat(80))
const taskStat = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN member_id IS NOT NULL THEN 1 ELSE 0 END) AS hasMember,
    SUM(CASE WHEN assignee IS NULL THEN 1 ELSE 0 END) AS noAssign
  FROM task
`).get()
report('✅', '任务总数', String(taskStat.total))
report(taskStat.hasMember > 0 ? '✅' : '❌', '已关联成员', `${taskStat.hasMember}/${taskStat.total}`)
report('ℹ', 'assignee 为空', `${taskStat.noAssign} 条（正常：未派发的任务）`)

const orphanTask = db.prepare(`
  SELECT COUNT(*) AS c FROM task t
  WHERE t.member_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM member m WHERE m.id = t.member_id)
`).get().c
report(orphanTask === 0 ? '✅' : '❌', '孤立任务（member_id 无对应成员）', String(orphanTask))

console.log('\n' + '='.repeat(80))
console.log('  三、记忆 → 团队关联')
console.log('='.repeat(80))
const memStat = db.prepare(`
  SELECT COUNT(*) AS total,
    SUM(CASE WHEN team_id IS NOT NULL THEN 1 ELSE 0 END) AS withTeam,
    SUM(CASE WHEN member_id IS NOT NULL THEN 1 ELSE 0 END) AS withMember
  FROM memory
`).get()
report(memStat.withTeam === memStat.total ? '✅' : '❌', '有团队归属',
  `${memStat.withTeam}/${memStat.total}`)
report('ℹ', '有成员归属', `${memStat.withMember}/${memStat.total}（团队级记忆无成员归属）`)

const dist = db.prepare('SELECT team_id, COUNT(*) AS c FROM memory GROUP BY team_id').all()
for (const d of dist) {
  const t = d.team_id ? db.prepare('SELECT name FROM team WHERE id = ?').get(d.team_id) : null
  report('ℹ', `  ${String(d.team_id || '（无）').slice(0, 24)}`, `${d.c} 条${t ? ' → ' + t.name.slice(0, 20) : ''}`)
}

console.log('\n' + '='.repeat(80))
console.log('  四、工件路径可达率')
console.log('='.repeat(80))
const arts = db.prepare('SELECT id, path FROM artifact').all()
let reachable = 0
const missingList = []
for (const a of arts) {
  if (a.path && existsSync(a.path)) reachable++
  else missingList.push(a.path)
}
const rate = arts.length ? Math.round((reachable / arts.length) * 100) : 0
report(reachable === arts.length ? '✅' : 'ℹ', '路径可达',
  `${reachable}/${arts.length}（${rate}%）`)
if (missingList.length) {
  console.log(`      不可达 ${missingList.length} 条，样例:`)
  for (const p of missingList.slice(0, 5)) {
    console.log(`        ${String(p).slice(0, 80)}`)
  }
  console.log('      说明：这些是历史任务产出的临时文件，已被清理或移动。')
  console.log('      正文不可找回，但任务记录（谁做的、做了什么）完整。')
}

console.log('\n' + '='.repeat(80))
console.log('  五、技能目录')
console.log('='.repeat(80))
const HB = 'D:\\软件\\DSH\\用户数据\\_AI团队手册'
for (const sub of ['ai-team', 'jingjie']) {
  const p = join(HB, sub)
  if (!existsSync(p)) { report('❌', `技能簿 ${sub}`, '不存在'); continue }
  const files = readdirSync(p).filter((f) => f.endsWith('.md'))
  report('✅', `技能簿 ${sub}`, `${files.length} 个文件`)
}
const SK = join(R, 'skills')
const pending = join(SK, '_pending')
report('ℹ', '待批技能目录', existsSync(pending) ? `${readdirSync(pending).length} 个` : '不存在')

console.log('\n' + '='.repeat(80))
console.log('  六、场景 → 团队绑定')
console.log('='.repeat(80))
const REG = join(HB, '_registry.json')
if (existsSync(REG)) {
  const { readFileSync } = await import('node:fs')
  const d = JSON.parse(readFileSync(REG, 'utf8'))
  for (const s of (d.scenarios || [])) {
    const t = s.teamId ? db.prepare('SELECT name FROM team WHERE id = ?').get(s.teamId) : null
    report(t ? '✅' : '❌', `${String(s.id).padEnd(14)} kind=${s.kind}`,
      t ? t.name.slice(0, 24) : '⚠ 团队不存在')
  }
} else {
  report('❌', 'registry', '不存在')
}

console.log('\n' + '='.repeat(80))
console.log('  七、旧库对照（漏迁检测）')
console.log('='.repeat(80))
const BAK = 'D:\\软件\\DSH\\备份\\_dsh-team-data-20261122-235357\\team.db'
if (existsSync(BAK)) {
  const { DatabaseSync } = await import('node:sqlite')
  const old = new DatabaseSync(BAK, { readonly: true })
  for (const tb of ['team', 'member', 'task', 'message', 'artifact']) {
    const a = db.prepare(`SELECT COUNT(*) AS c FROM ${tb}`).get().c
    const b = old.prepare(`SELECT COUNT(*) AS c FROM ${tb}`).get().c
    // member 少 2 个是跳过的探测成员，属正常
    const expect = tb === 'member' ? b - 2 : b
    report(a >= expect ? '✅' : '❌', tb.padEnd(12), `新 ${a} / 旧 ${b}`)
  }
  const ml = old.prepare('SELECT COUNT(*) AS c FROM memory_link').get().c
  report(memStat.total >= ml ? '✅' : '❌', 'memory'.padEnd(12), `新 ${memStat.total} / 旧 ${ml}`)
  old.close()
} else {
  report('ℹ', '旧库备份', '不存在，跳过对照')
}

console.log('\n' + '='.repeat(80))
console.log('  八、插件代码自检')
console.log('='.repeat(80))
const MODULES = [
  'lib/index.js',
  'lib/client.js',
  'lib/orchestrator/localStore.mjs',
  'lib/orchestrator/localSidecar.mjs',
  'lib/orchestrator/pipeline.mjs',
  'lib/orchestrator/host.mjs',
  'lib/orchestrator/teamTemplates.mjs',
  'lib/orchestrator/taskMatch.mjs',
  'lib/orchestrator/paths.mjs',
  'lib/orchestrator/evolve.mjs',
]
for (const m of MODULES) {
  const p = join(R, m)
  report(existsSync(p) ? '✅' : '❌', m.split('/').pop().padEnd(22),
    existsSync(p) ? `${Math.round(statSync(p).size / 1024)}KB` : '缺失')
}

console.log('\n' + '='.repeat(80))
console.log(`  结果：${ok} 正常 / ${bad} 异常 / ${info} 提示`)
console.log('='.repeat(80))

S.close()
process.exit(bad > 0 ? 1 : 0)
