#!/usr/bin/env node
/**
 * verify-team-sync.mjs —— 会话团队→面板工作项同步（task_mwqeqn7h1a5f7）行为锁
 * 纯函数真跑 reconcileTeams/normalizeSessionId + index.js 接线静态核对，不碰真实注册表。
 */
import * as Reg from '../lib/orchestrator/registry.mjs'
import { readFileSync } from 'node:fs'
let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}

console.log('\n[1] normalizeSessionId 规范化（统一去 session- 前缀）')
t('去 session- 前缀', Reg.normalizeSessionId('session-89cfacec-33d1-4150-9d2c-4bcfc9852d15') === '89cfacec-33d1-4150-9d2c-4bcfc9852d15')
t('无前缀原样', Reg.normalizeSessionId('5871579b-846d-4d27-8ef6-5c6037afd2f0') === '5871579b-846d-4d27-8ef6-5c6037afd2f0')
t('大小写前缀也去', Reg.normalizeSessionId('SESSION-abc') === 'abc')
t('空值不炸', Reg.normalizeSessionId(null) === '' && Reg.normalizeSessionId(undefined) === '')

console.log('\n[2] 2 团队 + 1 工作项 → 同步成 2 项，teamId 一一对应')
const TEAMS = [
  { id: 'team_mwpg8cjh43btf', name: 'AI 团队管理升级版', workspace: 'D:\\软件\\DSH\\用户数据', leadSessionId: 'session-89cfacec-33d1-4150-9d2c-4bcfc9852d15', agentPreset: 'standard', status: 'idle' },
  { id: 'team_mwpsxeul9lagp', name: 'ai-team-console 迭代组', workspace: 'D:\\软件\\DSH\\用户数据', leadSessionId: 'session-6e33f884-2cb3-4fe3-9e26-d86cf97af24d', agentPreset: 'standard', status: 'running' },
]
const CURRENT = [{
  id: 'jingjie-2', name: '净界2.0优化', kind: 'software', teamId: 'team_mwpg8cjh43btf',
  leadSessionId: '5871579b-846d-4d27-8ef6-5c6037afd2f0', state: 'running', rounds: 1,
}]
const r1 = Reg.reconcileTeams(TEAMS, CURRENT)
t('同步后 scenarios = 2 条', r1.scenarios.length === 2, String(r1.scenarios.length))
t('补建 1 条（第二团队）', r1.added.length === 1 && r1.changed === true, JSON.stringify(r1.added))
t('补建项 teamId 正确', r1.scenarios.some((s) => s.teamId === 'team_mwpsxeul9lagp'))
t('补建项 id 合规（小写英数连字符）', r1.scenarios.filter((s) => s.syncedFromTeam).every((s) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(s.id)), r1.scenarios.map((s) => s.id).join(','))
const addedTeam = r1.scenarios.find((s) => s.teamId === 'team_mwpsxeul9lagp')
t('补建项 leadSessionId 去前缀', Boolean(addedTeam) && addedTeam.leadSessionId === '6e33f884-2cb3-4fe3-9e26-d86cf97af24d')
t('补建项 state 按 status 映射（running→running）', Boolean(addedTeam) && addedTeam.state === 'running')
t('补建项 ephemeral=false', Boolean(addedTeam) && addedTeam.ephemeral === false)
t('两团队 teamId 一一对应（无重复）', TEAMS.every((tm) => r1.scenarios.filter((s) => s.teamId === tm.id).length === 1))

console.log('\n[3] 反向对齐 leadSessionId 不一致 → repaired 记录')
t('jingjie-2 被修正', r1.repaired.length === 1 && r1.repaired[0].scenarioId === 'jingjie-2', JSON.stringify(r1.repaired))
t('  → from=旧值 to=sidecar规范化值', r1.repaired[0].from === '5871579b-846d-4d27-8ef6-5c6037afd2f0'
  && r1.repaired[0].to === '89cfacec-33d1-4150-9d2c-4bcfc9852d15', JSON.stringify(r1.repaired[0]))
t('  → 修正后 scenario.leadSessionId 以 sidecar 为准', r1.scenarios.find((s) => s.id === 'jingjie-2').leadSessionId === '89cfacec-33d1-4150-9d2c-4bcfc9852d15')

console.log('\n[4] 幂等：再对账一次不重复建/改')
const r2 = Reg.reconcileTeams(TEAMS, r1.scenarios)
t('再调一次 added=0 repaired=0 changed=false', r2.added.length === 0 && r2.repaired.length === 0 && r2.changed === false, JSON.stringify({ a: r2.added, r: r2.repaired, c: r2.changed }))
t('再调一次 scenarios 仍 2 条', r2.scenarios.length === 2)

console.log('\n[5] 边界：sidecar 空/脏数据不炸')
t('teams=null → 原样返回', Reg.reconcileTeams(null, CURRENT).scenarios.length === 1)
t('team 缺 id 跳过', Reg.reconcileTeams([{ name: 'x' }], CURRENT).scenarios.length === 1)
t('无 leadSessionId → 补建项 lead=null（不编）', (() => {
  const r = Reg.reconcileTeams([{ id: 'team_abcdef1234', name: 'x', workspace: '' }], [])
  return r.scenarios.length === 1 && r.scenarios[0].leadSessionId === null
})())

console.log('\n[6] index.js 接线（静态，服务端重启才生效）')
const idx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
t('op=scenarios 做惰性对账', /op === 'scenarios'/.test(idx) && /reconcileTeams\(teams, base\.scenarios\)/.test(idx))
t('有 op=sync-teams 主动触发', /op === 'sync-teams'/.test(idx))
t('changed 时才 replaceScenarios 写盘', /if \(rec\.changed\) await Reg\.replaceScenarios/.test(idx))
t('返回带 repaired/added 清单', /repaired: rec\.repaired/.test(idx) && /added: rec\.added/.test(idx))

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：会话团队同步到工作项符合验收。\n')
else console.log('有断言失败。\n')
process.exitCode = fail === 0 ? 0 : 1
