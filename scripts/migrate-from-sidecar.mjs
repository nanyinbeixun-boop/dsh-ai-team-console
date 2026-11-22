/**
 * 把旧 sidecar 的 team.db 数据迁进本地库。
 *
 * 用法：
 *   node scripts/migrate-from-sidecar.mjs [源db路径] [--dry]
 *
 * 设计：
 *   · 幂等——重复跑不会产生重复数据（按 id upsert 语义：已存在就跳过并计数）
 *   · 只迁必要字段，probe 类成员（__probe__ / __cap_probe__）跳过
 *   · 迁完打印对照表，逐表核对条数
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import * as Store from '../lib/orchestrator/localStore.mjs'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const SRC = args.filter((a) => !a.startsWith('--'))[0]
  || 'D:\\软件\\DSH\\用户数据\\.dsh\\team\\team.db'

if (!existsSync(SRC)) {
  console.error(`❌ 源库不存在：${SRC}`)
  process.exit(1)
}

console.log('='.repeat(78))
console.log(DRY ? '  试运行（不写库）' : '  迁移 sidecar 数据 → 本地库')
console.log('='.repeat(78))
console.log(`  源: ${SRC}`)
console.log(`  目标: ${Store.dbPath()}`)
console.log('')

const src = new DatabaseSync(SRC, { readonly: true })
const dst = DRY ? null : Store.open()

/** 该 id 在本地库里是否已存在 */
function exists(table, id) {
  if (DRY) return false
  return Boolean(dst.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(String(id)))
}

const counts = { team: 0, member: 0, task: 0, message: 0, artifact: 0, memory: 0 }
const skipped = { team: 0, member: 0, task: 0, message: 0, artifact: 0, memory: 0 }

/** 只留真成员，探测用途的临时成员不迁 */
function isProbe(name) {
  return /^_+\w+_+$/.test(String(name || '').trim().toLowerCase())
}

/* ── 1. team ── */
console.log('┄ team ┄')
const teams = src.prepare('SELECT * FROM team').all()
for (const t of teams) {
  if (exists('team', t.id)) { skipped.team++; continue }
  if (!DRY) {
    Store.createTeam({
      id: t.id,
      name: t.name,
      workspace: t.workspace,
      maxMembers: t.max_members,
      maxConcurrency: t.max_concurrency,
      permissionPreset: t.permission_preset,
      agentPreset: t.agent_preset,
    })
    if (t.lead_session_id) Store.updateTeam(t.id, { leadSessionId: t.lead_session_id })
    if (t.archived_at) Store.updateTeam(t.id, { archivedAt: t.archived_at })
  }
  counts.team++
  console.log(`  ✅ ${t.name}`)
}

/* ── 2. member（含 member_state） ── */
console.log('\n┄ member ┄')
const members = src.prepare('SELECT * FROM member').all()
const states = new Map()
for (const s of src.prepare('SELECT * FROM member_state').all()) states.set(s.member_id, s)

for (const m of members) {
  if (isProbe(m.name)) { skipped.member++; console.log(`  ⊘ ${m.name}（探测用，跳过）`); continue }
  if (exists('member', m.id)) { skipped.member++; continue }
  const st = states.get(m.id)
  if (!DRY) {
    Store.createMember(m.team_id, {
      id: m.id,
      name: m.name,
      role: m.role,
      model: m.model,
      agentProvider: m.agent_provider,
      reasoningEffort: m.reasoning_effort,
      agentPreset: m.agent_preset,
      permissionPreset: m.permission_preset,
      contextMode: m.context_mode,
      agentSessionId: m.agent_session_id,
      parentSessionId: m.parent_session_id,
      status: st ? st.status : 'idle',
    })
    // member_state 的 seq / last_active_at 单独补
    if (st && (st.seq || st.last_active_at)) {
      dst.prepare(
        'UPDATE member_state SET seq = ?, last_active_at = ? WHERE member_id = ?',
      ).run(Number(st.seq || 0), st.last_active_at || null, m.id)
    }
  }
  counts.member++
}
console.log(`  迁入 ${counts.member}，跳过 ${skipped.member}`)

/* ── 3. task ── */
console.log('\n┄ task ┄')
const tasks = src.prepare('SELECT * FROM task').all()
for (const t of tasks) {
  if (exists('task', t.id)) { skipped.task++; continue }
  if (!DRY) {
    Store.createTask({
      id: t.id,
      teamId: t.team_id,
      memberId: t.member_id,
      assignee: t.assignee,
      subject: t.subject,
      body: t.body,
      status: t.status,
      kind: t.kind,
      seq: t.seq,
    })
    // 时间戳与终态单独补（createTask 会写 now()）
    const patch = {}
    if (t.result) patch.result = t.result
    if (t.error) patch.error = t.error
    if (t.started_at) patch.startedAt = t.started_at
    if (t.ended_at) patch.endedAt = t.ended_at
    if (Object.keys(patch).length) Store.updateTask(t.id, patch)
    dst.prepare('UPDATE task SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(t.created_at || new Date().toISOString(), t.updated_at || t.created_at || new Date().toISOString(), t.id)
  }
  counts.task++
}
console.log(`  迁入 ${counts.task}，跳过 ${skipped.task}`)

/* ── 4. message ── */
console.log('\n┄ message ┄')
const msgs = src.prepare('SELECT * FROM message').all()
for (const m of msgs) {
  if (exists('message', m.id)) { skipped.message++; continue }
  if (!DRY) {
    Store.addMessage({
      id: m.id,
      teamId: m.team_id,
      taskId: m.task_id,
      sender: m.sender,
      recipient: m.recipient,
      kind: m.kind,
      body: m.body,
    })
    if (m.created_at) {
      dst.prepare('UPDATE message SET created_at = ? WHERE id = ?').run(m.created_at, m.id)
    }
  }
  counts.message++
}
console.log(`  迁入 ${counts.message}，跳过 ${skipped.message}`)

/* ── 5. artifact ── */
console.log('\n┄ artifact ┄')
const arts = src.prepare('SELECT * FROM artifact').all()
for (const a of arts) {
  if (exists('artifact', a.id)) { skipped.artifact++; continue }
  if (!DRY) {
    Store.addArtifact({
      id: a.id,
      teamId: a.team_id,
      taskId: a.task_id,
      memberId: a.member_id,
      name: a.name,
      path: a.path,
      kind: a.kind,
      content: a.content,
    })
    if (a.created_at) {
      dst.prepare('UPDATE artifact SET created_at = ? WHERE id = ?').run(a.created_at, a.id)
    }
  }
  counts.artifact++
}
console.log(`  迁入 ${counts.artifact}，跳过 ${skipped.artifact}`)

/* ── 6. memory（来自文件树的 mem_*.json，不是 db 表） ── */
console.log('\n┄ memory ┄')
const MEM_DIR = 'D:\\软件\\DSH\\用户数据\\.dsh\\team\\memory\\objects'
let memCount = 0
if (existsSync(MEM_DIR)) {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  for (const f of readdirSync(MEM_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const o = JSON.parse(readFileSync(join(MEM_DIR, f), 'utf8'))
      const id = String(o.id || f.replace(/\.json$/, ''))
      if (exists('memory', id)) { skipped.memory++; continue }
      if (!DRY) {
        Store.addMemory({
          id,
          teamId: o.teamId || o.team_id || null,
          scope: o.scope || 'team',
          title: o.title || null,
          body: o.body || o.content || null,
          tags: Array.isArray(o.tags) ? o.tags.join(',') : (o.tags || null),
        })
      }
      memCount++
    } catch { /* 单条坏数据不阻塞整体 */ }
  }
}
counts.memory = memCount
console.log(`  迁入 ${memCount}，跳过 ${skipped.memory}`)

src.close()

/* ── 核对 ── */
console.log('\n' + '='.repeat(78))
console.log('  迁移结果核对')
console.log('='.repeat(78))
console.log(`  ${'表'.padEnd(12)} ${'迁入'.padStart(8)} ${'跳过'.padStart(8)}`)
for (const k of Object.keys(counts)) {
  console.log(`  ${k.padEnd(12)} ${String(counts[k]).padStart(8)} ${String(skipped[k]).padStart(8)}`)
}

if (!DRY) {
  const s = Store.stats()
  console.log('\n  本地库实际条数:')
  console.log(`    团队 ${s.teams} / 成员 ${s.members} / 任务 ${s.tasks}`)
  console.log(`    消息 ${s.messages} / 工件 ${s.artifacts} / 记忆 ${s.memory}`)
  console.log(`    库文件: ${s.dbPath}`)
  Store.close()
}
console.log('')
