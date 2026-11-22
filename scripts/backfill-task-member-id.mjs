/**
 * 回填 task.member_id（旧库没有这一列，migrate 时漏了）
 *
 * 语义：旧库把归属只记在 assignee 上（值就是 member.id）。
 * 新库两列并存——member_id 用于索引与关联，assignee 保留原始文本以便对账。
 * 本脚本把 assignee 里能对上 member.id 的都回填进 member_id，幂等。
 *
 * 用法：node scripts/backfill-task-member-id.mjs [--dry]
 */
import * as Store from '../lib/orchestrator/localStore.mjs'

const DRY = process.argv.includes('--dry')
const db = Store.open()

console.log('='.repeat(78))
console.log(DRY ? '  试运行（不写库）' : '  回填 task.member_id')
console.log('='.repeat(78))

const total = db.prepare('SELECT COUNT(*) AS c FROM task').get().c
const empty = db.prepare('SELECT COUNT(*) AS c FROM task WHERE member_id IS NULL').get().c
console.log(`  任务总数 ${total} / member_id 为空 ${empty}`)

if (!empty) {
  console.log('\n  ✅ 已全部有值，无需回填')
  Store.close()
  process.exit(0)
}

// 直接把 assignee 对上 member.id 的填进去。
// 用 SQL 一次搞定：UPDATE ... WHERE EXISTS 子查询，
// 比逐个 select+update 快得多，且天然幂等（只处理 NULL 的）。
const before = db.prepare('SELECT COUNT(*) AS c FROM task WHERE member_id IS NULL').get().c

if (!DRY) {
  db.exec(`
    UPDATE task
    SET member_id = assignee
    WHERE member_id IS NULL
      AND assignee IS NOT NULL
      AND EXISTS (SELECT 1 FROM member m WHERE m.id = task.assignee)
  `)
}

const after = db.prepare('SELECT COUNT(*) AS c FROM task WHERE member_id IS NULL').get().c
const filled = before - after

console.log(`\n  回填 ${DRY ? '（试运行，未写）' : ''} ${filled} 条`)
console.log(`  member_id 为空：${before} → ${after}`)

// 剩下的空值是什么原因
const rest = db.prepare(`
  SELECT assignee, COUNT(*) AS c FROM task
  WHERE member_id IS NULL GROUP BY assignee
`).all()
if (rest.length) {
  console.log('\n  仍未回填的（assignee 对不上任何 member.id）:')
  for (const r of rest) {
    console.log(`    ${String(r.assignee).padEnd(24)} ${r.c} 条`)
  }
} else {
  console.log('\n  ✅ 全部回填完毕')
}

// 核对：assignee 与 member_id 是否一致
const mismatch = db.prepare(`
  SELECT COUNT(*) AS c FROM task
  WHERE member_id IS NOT NULL AND assignee IS NOT NULL AND member_id != assignee
`).get().c
console.log(`  assignee 与 member_id 不一致：${mismatch} 条 ${mismatch === 0 ? '✅' : '⚠'}`)

Store.close()
