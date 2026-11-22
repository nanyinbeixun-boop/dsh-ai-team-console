/**
 * 回填 memory 的团队归属与成员归属。
 *
 * 背景：
 *   记忆正文存在 memory/objects/*.json（只有 title/body），
 *   归属关系（属于哪个团队、哪个成员、哪条任务）存在旧库的 memory_link 表。
 *   迁移时我只搬了正文，没搬归属，导致 106 条记忆全是 team_id=null——
 *   面板按团队筛记忆时它们会集体失踪。
 *
 * 用法：node scripts/backfill-memory-link.mjs [--dry]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import * as Store from '../lib/orchestrator/localStore.mjs'

const OLD = 'D:\\软件\\DSH\\备份\\_dsh-team-data-20261122-235357\\team.db'
const DRY = process.argv.includes('--dry')

console.log('='.repeat(78))
console.log(DRY ? '  试运行' : '  回填 memory 归属')
console.log('='.repeat(78))

if (!existsSync(OLD)) {
  console.error(`  ❌ 旧库不存在：${OLD}`)
  process.exit(1)
}

const old = new DatabaseSync(OLD, { readonly: true })
const links = old.prepare('SELECT memory_id, team_id, scope, member_id, task_id FROM memory_link').all()
old.close()
console.log(`  旧库 memory_link ${links.length} 条`)

const db = Store.open()

// memory 表要加 member_id / task_id 两列（原来只有 team_id / scope）
const cols = db.prepare('PRAGMA table_info(memory)').all().map((c) => c.name)
if (!cols.includes('member_id')) {
  db.exec('ALTER TABLE memory ADD COLUMN member_id TEXT')
  console.log('  ➕ 新增列 member_id')
}
if (!cols.includes('task_id')) {
  db.exec('ALTER TABLE memory ADD COLUMN task_id TEXT')
  console.log('  ➕ 新增列 task_id')
}

const before = db.prepare('SELECT COUNT(*) AS c FROM memory WHERE team_id IS NULL').get().c
console.log(`  待回填：${before} 条 team_id 为空`)

let filled = 0
let skipped = 0
if (!DRY) {
  const upd = db.prepare(`
    UPDATE memory SET team_id = ?, scope = ?, member_id = ?, task_id = ?
    WHERE id = ? AND team_id IS NULL
  `)
  for (const l of links) {
    // 只更新库里真有的记忆（objects 目录可能缺几条）
    const exists = db.prepare('SELECT 1 FROM memory WHERE id = ?').get(l.memory_id)
    if (!exists) { skipped++; continue }
    const r = upd.run(l.team_id || null, l.scope || 'team', l.member_id || null, l.task_id || null, l.memory_id)
    filled += r.changes
  }
}

const after = db.prepare('SELECT COUNT(*) AS c FROM memory WHERE team_id IS NULL').get().c
console.log(`\n  回填 ${DRY ? '（试运行未写）' : ''} ${filled} 条，跳过 ${skipped} 条（记忆不存在）`)
console.log(`  team_id 为空：${before} → ${after}`)

// 分布核对
const dist = db.prepare(`
  SELECT team_id, COUNT(*) AS c FROM memory GROUP BY team_id ORDER BY c DESC
`).all()
console.log('\n  按团队分布:')
for (const d of dist) {
  const t = d.team_id ? db.prepare('SELECT name FROM team WHERE id = ?').get(d.team_id) : null
  console.log(`    ${String(d.team_id).padEnd(22)} ${String(d.c).padStart(3)} 条  ${t ? t.name : '（无归属）'}`)
}

Store.close()
