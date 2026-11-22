/**
 * 本地团队数据层 —— 取代 hunmer 的 dsh-team sidecar。
 *
 * 背景：
 *   此前所有团队/成员/任务数据都存在别人的 sidecar（127.0.0.1:4317 + team.db）。
 *   现在改成插件自持：数据落在 SQLite（本项目自己的库），接口形状与旧 sidecar 兼容，
 *   上层 14 个调用点一行都不用改。
 *
 * 设计取舍：
 *   1. 用 node:sqlite（Node 22+ 内置），不引入第三方依赖——本插件一直是零依赖
 *   2. 表结构照搬 team.db 的核心列名（team_id / agent_session_id 等），
 *      方便一次性把历史数据迁进来
 *   3. 对外返回的 JSON 键名用 camelCase（与旧 sidecar 一致），DB 内部用 snake_case
 *   4. 时间一律 ISO 字符串，与旧数据对齐
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as Paths from './paths.mjs'

let _db = null

/** 数据库文件路径：放在插件自己的数据目录，不碰 .dsh/team */
export function dbPath() {
  // 优先用插件目录下的 data/（符合本机存储铁律：DSH 数据一律在 D:\软件\DSH）
  // 环境变量可覆盖，便于测试与迁移
  if (process.env.ATC_DB_PATH) return process.env.ATC_DB_PATH
  try {
    return join(Paths.pluginDataDir(), 'team.db')
  } catch {
    return join(process.cwd(), 'data', 'team.db')
  }
}

/** 打开（或创建）数据库，幂等 */
export function open() {
  if (_db) return _db
  const p = dbPath()
  mkdirSync(dirname(p), { recursive: true })
  _db = new DatabaseSync(p)
  _db.exec('PRAGMA journal_mode = WAL')
  _db.exec('PRAGMA foreign_keys = ON')
  migrate(_db)
  return _db
}

export function close() {
  if (_db) {
    try { _db.close() } catch { /* 已关闭 */ }
    _db = null
  }
}

/** 建表。全部用 IF NOT EXISTS，可重复执行 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace TEXT,
      max_members INTEGER NOT NULL DEFAULT 8,
      max_concurrency INTEGER NOT NULL DEFAULT 3,
      failure_policy TEXT DEFAULT 'continue',
      max_attempts INTEGER DEFAULT 3,
      permission_preset TEXT DEFAULT 'danger-full-access',
      agent_preset TEXT,
      lead_session_id TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS member (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT,
      model TEXT,
      agent_provider TEXT,
      reasoning_effort TEXT,
      agent_preset TEXT,
      permission_preset TEXT DEFAULT 'danger-full-access',
      context_mode TEXT DEFAULT 'fresh',
      agent_session_id TEXT,
      parent_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_member_team ON member(team_id);

    CREATE TABLE IF NOT EXISTS member_state (
      member_id TEXT PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'idle',
      current_task_id TEXT,
      seq INTEGER NOT NULL DEFAULT 0,
      last_active_at TEXT,
      note TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES team(id) ON DELETE CASCADE,
      member_id TEXT,
      assignee TEXT,
      subject TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      kind TEXT,
      result TEXT,
      error TEXT,
      seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_team ON task(team_id);
    CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);

    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES team(id) ON DELETE CASCADE,
      task_id TEXT,
      sender TEXT,
      recipient TEXT,
      kind TEXT DEFAULT 'note',
      body TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_team ON message(team_id);

    CREATE TABLE IF NOT EXISTS artifact (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES team(id) ON DELETE CASCADE,
      task_id TEXT,
      member_id TEXT,
      name TEXT,
      path TEXT,
      kind TEXT,
      content TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_team ON artifact(team_id);

    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES team(id) ON DELETE CASCADE,
      scope TEXT DEFAULT 'team',
      title TEXT,
      body TEXT,
      tags TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_team ON memory(team_id);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)
}

/* ── 小工具 ───────────────────────────────────────────────── */

function now() {
  return new Date().toISOString()
}

/** 生成短 id：前缀 + 时间戳36 + 随机 */
export function newId(prefix) {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${t}${r}`
}

/** snake_case 行 → camelCase 对象（对外接口用） */
function toCamel(row) {
  if (!row) return row
  const o = {}
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    o[ck] = v
  }
  return o
}

/* ── team ─────────────────────────────────────────────────── */

export function listTeams() {
  const db = open()
  const rows = db.prepare(
    'SELECT * FROM team WHERE archived_at IS NULL ORDER BY created_at ASC',
  ).all()
  return rows.map((r) => {
    const t = toCamel(r)
    // 带上成员数与成员列表，旧 sidecar 的 /api/teams 也这么返回
    const members = db.prepare('SELECT * FROM member WHERE team_id = ?').all(r.id)
    t.memberCount = members.length
    t.members = members.map((m) => toCamel(withState(m)))
    return t
  })
}

export function getTeam(id) {
  const db = open()
  const r = db.prepare('SELECT * FROM team WHERE id = ?').get(String(id))
  if (!r) return null
  const t = toCamel(r)
  const members = listMembers(id)
  t.memberCount = members.length
  t.members = members
  return t
}

export function createTeam({ id, name, workspace, maxMembers, maxConcurrency, permissionPreset, agentPreset }) {
  const db = open()
  const tid = id || newId('team')
  const ts = now()
  db.prepare(`
    INSERT INTO team (id, name, workspace, max_members, max_concurrency,
                      permission_preset, agent_preset, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tid, String(name || 'team'), workspace || null,
    Number(maxMembers ?? 8), Number(maxConcurrency ?? 3),
    permissionPreset || 'danger-full-access', agentPreset || null, ts, ts,
  )
  return getTeam(tid)
}

export function updateTeam(id, patch) {
  const db = open()
  const map = {
    name: 'name', workspace: 'workspace', maxMembers: 'max_members',
    maxConcurrency: 'max_concurrency', permissionPreset: 'permission_preset',
    agentPreset: 'agent_preset', leadSessionId: 'lead_session_id',
    archivedAt: 'archived_at',
  }
  const sets = []
  const vals = []
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[k]) }
  }
  if (!sets.length) return getTeam(id)
  sets.push('updated_at = ?')
  vals.push(now(), String(id))
  db.prepare(`UPDATE team SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return getTeam(id)
}

export function deleteTeam(id) {
  const db = open()
  db.prepare('DELETE FROM team WHERE id = ?').run(String(id))
  return { ok: true }
}

/* ── member ───────────────────────────────────────────────── */

/** member 行 + member_state 合并成外部形状 */
function withState(m) {
  const db = open()
  const st = db.prepare('SELECT * FROM member_state WHERE member_id = ?').get(m.id)
  const o = { ...m }
  o.status = st ? st.status : 'idle'
  o.current_task_id = st ? st.current_task_id : null
  o.seq = st ? st.seq : 0
  o.last_active_at = st ? st.last_active_at : null
  return o
}

export function listMembers(teamId) {
  const db = open()
  const rows = db.prepare('SELECT * FROM member WHERE team_id = ? ORDER BY created_at ASC').all(String(teamId))
  return rows.map((r) => toCamel(withState(r)))
}

export function getMember(id) {
  const db = open()
  const r = db.prepare('SELECT * FROM member WHERE id = ?').get(String(id))
  return r ? toCamel(withState(r)) : null
}

export function findMember(teamId, name) {
  const db = open()
  const r = db.prepare('SELECT * FROM member WHERE team_id = ? AND name = ?').get(String(teamId), String(name))
  return r ? toCamel(withState(r)) : null
}

export function createMember(teamId, m) {
  const db = open()
  const mid = m.id || newId('m')
  const ts = now()
  db.prepare(`
    INSERT INTO member (id, team_id, name, role, model, agent_provider, reasoning_effort,
                        agent_preset, permission_preset, context_mode, agent_session_id,
                        parent_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mid, String(teamId), String(m.name || 'member'), m.role || null, m.model || null,
    m.agentProvider || null, m.reasoningEffort || null, m.agentPreset || null,
    m.permissionPreset || 'danger-full-access', m.contextMode || 'fresh',
    m.agentSessionId || null, m.parentSessionId || null, ts, ts,
  )
  db.prepare(`
    INSERT INTO member_state (member_id, status, seq, updated_at) VALUES (?, ?, ?, ?)
  `).run(mid, m.status || 'idle', 0, ts)
  return getMember(mid)
}

export function updateMember(id, patch) {
  const db = open()
  const map = {
    name: 'name', role: 'role', model: 'model', agentProvider: 'agent_provider',
    reasoningEffort: 'reasoning_effort', agentPreset: 'agent_preset',
    permissionPreset: 'permission_preset', contextMode: 'context_mode',
    agentSessionId: 'agent_session_id', parentSessionId: 'parent_session_id',
  }
  const sets = []
  const vals = []
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[k]) }
  }
  if (sets.length) {
    sets.push('updated_at = ?')
    vals.push(now(), String(id))
    db.prepare(`UPDATE member SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }
  if (patch.status !== undefined) setMemberStatus(id, patch.status)
  return getMember(id)
}

export function setMemberStatus(id, status, extra = {}) {
  const db = open()
  const ts = now()
  const exists = db.prepare('SELECT member_id FROM member_state WHERE member_id = ?').get(String(id))
  if (exists) {
    const sets = ['status = ?', 'updated_at = ?', 'last_active_at = ?']
    const vals = [String(status), ts, ts]
    if (extra.currentTaskId !== undefined) { sets.push('current_task_id = ?'); vals.push(extra.currentTaskId) }
    if (extra.note !== undefined) { sets.push('note = ?'); vals.push(extra.note) }
    vals.push(String(id))
    db.prepare(`UPDATE member_state SET ${sets.join(', ')} WHERE member_id = ?`).run(...vals)
  } else {
    db.prepare(`
      INSERT INTO member_state (member_id, status, current_task_id, seq, last_active_at, note, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(String(id), String(status), extra.currentTaskId || null, ts, extra.note || null, ts)
  }
  return getMember(id)
}

/** 退役：状态置 retired（不物理删除，保留历史归属） */
export function retireMember(id) {
  return setMemberStatus(id, 'retired')
}

/* ── task ─────────────────────────────────────────────────── */

export function listTasks({ teamId, status, limit = 200 } = {}) {
  const db = open()
  const cond = []
  const vals = []
  if (teamId) { cond.push('team_id = ?'); vals.push(String(teamId)) }
  if (status) { cond.push('status = ?'); vals.push(String(status)) }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : ''
  vals.push(Number(limit))
  const rows = db.prepare(
    `SELECT * FROM task ${where} ORDER BY created_at DESC LIMIT ?`,
  ).all(...vals)
  return rows.map(toCamel)
}

export function getTask(id) {
  const db = open()
  const r = db.prepare('SELECT * FROM task WHERE id = ?').get(String(id))
  return r ? toCamel(r) : null
}

export function createTask(t) {
  const db = open()
  const tid = t.id || newId('task')
  const ts = now()
  db.prepare(`
    INSERT INTO task (id, team_id, member_id, assignee, subject, body, status, kind,
                      seq, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tid, t.teamId || null, t.memberId || null, t.assignee || null,
    t.subject || null, t.body || null, t.status || 'queued', t.kind || null,
    Number(t.seq ?? 0), ts, ts,
  )
  return getTask(tid)
}

export function updateTask(id, patch) {
  const db = open()
  const map = {
    status: 'status', result: 'result', error: 'error', assignee: 'assignee',
    memberId: 'member_id', body: 'body', subject: 'subject', kind: 'kind',
    startedAt: 'started_at', endedAt: 'ended_at',
  }
  const sets = []
  const vals = []
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[k]) }
  }
  if (!sets.length) return getTask(id)
  sets.push('updated_at = ?')
  vals.push(now(), String(id))
  db.prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return getTask(id)
}

/* ── message ──────────────────────────────────────────────── */

export function listMessages({ teamId, limit = 80 } = {}) {
  const db = open()
  const rows = teamId
    ? db.prepare('SELECT * FROM message WHERE team_id = ? ORDER BY created_at DESC LIMIT ?').all(String(teamId), Number(limit))
    : db.prepare('SELECT * FROM message ORDER BY created_at DESC LIMIT ?').all(Number(limit))
  return rows.map(toCamel)
}

export function addMessage(m) {
  const db = open()
  const id = m.id || newId('msg')
  db.prepare(`
    INSERT INTO message (id, team_id, task_id, sender, recipient, kind, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, m.teamId || null, m.taskId || null, m.sender || null,
    m.recipient || null, m.kind || 'note', m.body || null, now())
  return id
}

/* ── artifact ─────────────────────────────────────────────── */

export function listArtifacts({ teamId, limit = 100 } = {}) {
  const db = open()
  const rows = teamId
    ? db.prepare('SELECT id, team_id, task_id, member_id, name, path, kind, created_at FROM artifact WHERE team_id = ? ORDER BY created_at DESC LIMIT ?').all(String(teamId), Number(limit))
    : db.prepare('SELECT id, team_id, task_id, member_id, name, path, kind, created_at FROM artifact ORDER BY created_at DESC LIMIT ?').all(Number(limit))
  return rows.map(toCamel)
}

export function addArtifact(a) {
  const db = open()
  const id = a.id || newId('art')
  db.prepare(`
    INSERT INTO artifact (id, team_id, task_id, member_id, name, path, kind, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, a.teamId || null, a.taskId || null, a.memberId || null,
    a.name || null, a.path || null, a.kind || null, a.content || null, now())
  return id
}

/* ── memory ───────────────────────────────────────────────── */

export function listMemory({ teamId, limit = 200 } = {}) {
  const db = open()
  const rows = teamId
    ? db.prepare('SELECT * FROM memory WHERE team_id = ? ORDER BY created_at DESC LIMIT ?').all(String(teamId), Number(limit))
    : db.prepare('SELECT * FROM memory ORDER BY created_at DESC LIMIT ?').all(Number(limit))
  return rows.map(toCamel)
}

export function addMemory(m) {
  const db = open()
  const id = m.id || newId('mem')
  db.prepare(`
    INSERT INTO memory (id, team_id, scope, title, body, tags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, m.teamId || null, m.scope || 'team', m.title || null,
    m.body || null, m.tags || null, now())
  return id
}

export function getMemory(id) {
  const db = open()
  const r = db.prepare('SELECT * FROM memory WHERE id = ?').get(String(id))
  return r ? toCamel(r) : null
}

/* ── 统计 ─────────────────────────────────────────────────── */

export function stats() {
  const db = open()
  const one = (sql, ...a) => {
    try { return db.prepare(sql).get(...a)?.c ?? 0 } catch { return 0 }
  }
  return {
    teams: one('SELECT COUNT(*) AS c FROM team WHERE archived_at IS NULL'),
    members: one('SELECT COUNT(*) AS c FROM member'),
    tasks: one('SELECT COUNT(*) AS c FROM task'),
    messages: one('SELECT COUNT(*) AS c FROM message'),
    artifacts: one('SELECT COUNT(*) AS c FROM artifact'),
    memory: one('SELECT COUNT(*) AS c FROM memory'),
    dbPath: dbPath(),
  }
}
