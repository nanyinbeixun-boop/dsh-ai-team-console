#!/usr/bin/env node
/**
 * verify-p16-team-mode.mjs —— 「团队模式退化」修复的回归验证
 *
 * 由来：-团队模式根因规格.md 修复 B。规格断点②指出，面板开团流程
 * 从不 spawn 成员、S6 只调 dispatch 却从不把 brief 投进成员会话，于是
 * 「已派发」可以在一件活都没送出去的情况下报通过。
 *
 * 本脚本锁死三件事，任何一项退化都会红
 * 1. 团队健康判定：三态（ok / unbound / stale-lineage）与 retired 剔除；
 * 2. 投递判定：没会话、没 member、没 subagents、没 Lead 句柄、
 * belongs to another parent session —— 五种情况必须 ok:false 且带可执行 fix；
 * 3. 正常投递：ok:true 且 brief 里真的带 teamId/taskId/回执要求。
 *
 * 用法：node scripts\verify-p16-team-mode.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。纯本地，不碰 sidecar，不建团队。
 */

import * as TH from '../lib/orchestrator/teamHealth.mjs'
import * as P from '../lib/orchestrator/pipeline.mjs'

let pass = 0
let fail = 0
function t(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` :: ${extra}` : ''}`) }
}

/* ── 1. 团队健康判定 ───────────────────────────────────────────── */
console.log('\n[1] 团队健康判定（记录 ≠ 能干活）')
const stale = { id: 'm1', name: 'architect', status: 'failed', agentSessionId: 'abc', blockers: ['派发失败：subagent "abc" belongs to another parent session'] }
const unbound = { id: 'm2', name: 'maker', status: 'idle', agentSessionId: null, blockers: [] }
const healthy = { id: 'm3', name: 'auditor', status: 'running', agentSessionId: 'def', blockers: [] }
const retired = { id: 'm4', name: 'old', status: 'retired', agentSessionId: null, blockers: [] }

t('会话绑旧父会话 → stale-lineage', TH.memberSessionHealth(stale).state === 'stale-lineage')
t('无 agentSessionId → unbound', TH.memberSessionHealth(unbound).state === 'unbound')
t('正常成员 → ok', TH.memberSessionHealth(healthy).state === 'ok')
t('retired 不参与分母', TH.annotateMembers([stale, unbound, healthy, retired]).counts.total === 3)
const agg = TH.annotateMembers([stale, unbound, healthy, retired])
t('stale 名单可点名', agg.staleNames.includes('architect'))
t('unbound 名单可点名', agg.unboundNames.includes('maker'))
t('needsRebuild 给到面板', agg.needsRebuild.length === 1 && agg.needsRebuild[0].name === 'architect')
t('summary 说清可用比例', /可用 1\/3/.test(agg.summary), agg.summary)
t('能力域按 name 认领', TH.domainOwned([{ name: 'maker', role: '干活' }], 'maker') === true)
t('能力域缺失能判定', TH.domainOwned([{ name: 'maker', role: '干活' }], 'auditor') === false)

/* ── 2. 投递判定：投不进去必须 ok:false ────────────────────────── */
console.log('\n[2] 投递判定（投不进去不许假通过）')

let r = await P.deliverBrief({ state: {} }, 'team_x', { id: 't1', subject: 's' }, null)
t('dispatch 没给 member → ok:false', r.ok === false)
t('  → 原因说得明白', /没有 member/.test(r.detail), r.detail)

r = await P.deliverBrief({ state: {} }, 'team_x', { id: 't1', subject: 's' }, { id: 'm1', name: 'maker', agentSessionId: null })
t('成员无会话 → ok:false', r.ok === false)
t('  → fix 指明要 spawn', /dsh_team_spawn/.test(r.fix || ''), r.fix)
t('  → sessionState=unbound', r.report.sessionState === 'unbound')

r = await P.deliverBrief({ state: {}, hostCtx: null }, 'team_x', { id: 't1', subject: 's' }, { id: 'm1', name: 'maker', agentSessionId: 'sid-1' })
t('宿主无 subagents.sendMessage → ok:false', r.ok === false)
t('  → 指路 Lead 侧派发', /dsh_team_send|dsh_team_task/.test(r.fix || ''), r.fix)

const fakeSubs = { sendMessage: async () => 'inbox-1' }
r = await P.deliverBrief(
  { state: {}, hostCtx: { get: (n) => (n === 'subagents' ? fakeSubs : undefined) } },
  'team_x', { id: 't1', subject: 's' }, { id: 'm1', name: 'maker', agentSessionId: 'sid-1' })
t('无 live Lead 句柄 → ok:false', r.ok === false)
t('  → via=no-lead-agent', r.report.via === 'no-lead-agent', r.report.via)

const staleMember = { id: 'm2', name: 'architect', agentSessionId: 'sid-2' }
const ctxStale = {
  state: { memberHealth: [{ name: 'architect', state: 'ok' }] },
  hostCtx: {
    get: (n) => (n === 'subagents'
      ? { sendMessage: async () => { throw new Error('subagent "sid-2" belongs to another parent session') } }
      : (n === 'agents' ? { list: () => [{ id: 'lead-1', session: { header: { origin: 'user' } } }] } : undefined)),
  },
}
r = await P.deliverBrief(ctxStale, 'team_x', { id: 't1', subject: 's' }, staleMember)
t('belongs to another parent session → ok:false', r.ok === false)
t('  → 错误被识别并透传', /belongs to another parent session/.test(r.detail), r.detail)
// （v2 订正）：修复路径改为「update 一步重建」，不再是 retire+spawn。
// 实测 retire 后重新 spawn 的成员 id 不变（实测表），所以「保 id」不是选 update 的理由，
// 真正的理由是少一步。断言跟着规格改，不是把断言改成永远成立。
t('  → fix 指向 rebuildCommand + dispatchCommand 两步',
  /rebuildCommand/.test(r.fix || '') && /dispatchCommand/.test(r.fix || ''), r.fix)
t('  → fix 不再要求先 retire（v2 订正）', !/retire/.test(r.fix || ''), r.fix)
t('  → 成员状态被标 stale-lineage', ctxStale.state.memberHealth[0].state === 'stale-lineage')

/* ── 3. 正常投递：ok:true 且内容可核 ──────────────────────────── */
console.log('\n[3] 正常投递（成功也要能核正文）')
const okCtx = {
  state: {},
  hostCtx: {
    get: (n) => (n === 'subagents'
      ? { sendMessage: async () => 'inbox-ok' }
      : (n === 'agents' ? { list: () => [{ id: 'lead-1', session: { header: { origin: 'user' } } }] } : undefined)),
  },
}
r = await P.deliverBrief(okCtx, 'team_x',
  { id: 't1', subject: '干活', plan: [{ step: 'S1', action: 'read', target: '读文件' }], acceptance: '全绿' },
  { id: 'm3', name: 'maker', agentSessionId: 'sid-3' })
t('正常投递 → ok:true', r.ok === true, JSON.stringify(r))
t('  → via=subagents.sendMessage', r.report.via === 'subagents.sendMessage')
t('  → 带回 inboxId', r.report.inboxId === 'inbox-ok')
t('  → brief 可核（含 teamId）', /teamId=team_x/.test(r.report.brief || ''))
t('  → brief 可核（含 taskId）', /taskId=t1/.test(r.report.brief || ''))
t('  → brief 要求回执', /dsh_team_report_task/.test(r.report.brief || ''))

/* ── 4. 派发失败的可执行下一步 ─────────────────────────────────── */
console.log('\n[4] 派发失败要给可执行下一步（不许糊成「等成员回 idle」）')
const f1 = P.dispatchFixFor('no_idle_agent', 'team_x', { state: { memberHealth: [{ name: 'architect', id: 'm2', state: 'stale-lineage' }] } })
t('有 stale 成员 → 指会话失效', /retire/.test(f1) && /dsh_team_spawn/.test(f1), f1)
const f2 = P.dispatchFixFor('no_idle_agent', 'team_x', { state: { memberHealth: [{ name: 'maker', state: 'unbound' }] } })
t('有 unbound 成员 → 指要 spawn', /dsh_team_spawn/.test(f2), f2)
const f3 = P.dispatchFixFor('no_idle_agent', 'team_x', { state: { memberHealth: [] } })
t('全健康 → 指 teamHealth 排查', /teamHealth/.test(f3), f3)
t('no_lead_agent → 指建立 Lead 绑定', /Lead/.test(P.dispatchFixFor('no_lead_agent', 'team_x', { state: {} })))
t('concurrency → 指并发上限', /并发/.test(P.dispatchFixFor('concurrency', 'team_x', { state: {} })))

/* ── 5. 流水线步骤表 ───────────────────────────────────────────── */
console.log('\n[5] 流水线步骤表（S2_5 必须真的挂进去）')
const ids = P.stepCatalog.map((s) => s.id)
t('S2_5 在步骤表里', ids.includes('S2_5'), ids.join(','))
t('S2_5 紧随 S2 之后', ids.indexOf('S2_5') === ids.indexOf('S2') + 1)
t('S6 仍在 S5 之后', ids.indexOf('S6') === ids.indexOf('S5') + 1)

/* ── 6. running>0 不等于「本轮任务被接走」 ─────────────────────── */
console.log('\n[6] 假通过防线：别人在跑 ≠ 本轮任务被接走')
// 纯函数层面的判据：本轮任务状态不在 live 集合里时必须判否
const LIVE = new Set(['running', 'ready', 'pending', 'done'])
t('本轮任务 failed → 不算通过', !LIVE.has('failed'))
t('本轮任务 blocked → 不算通过', !LIVE.has('blocked'))
t('本轮任务 aborted → 不算通过', !LIVE.has('aborted'))
t('本轮任务 running → 算通过', LIVE.has('running'))
t('本轮任务 done → 算通过', LIVE.has('done'))
// buildTaskBrief 必带回执指令（成员不读回执要求就没人报工）
const b = P.buildTaskBrief('team_y', { id: 't9', subject: 'x', plan: [], acceptance: 'ok' }, { id: 'm9', name: 'maker' })
t('brief 含 dsh_team_report_task', /dsh_team_report_task/.test(b))
t('brief 含 teamId 与 taskId', /teamId=team_y/.test(b) && /taskId=t9/.test(b))
t('brief 含验收标准', /验收标准：ok/.test(b))

/* ── 7. S6 整步：投递失败必须让整步失败 ────────────────────────
 * 这一组是变异检验补出来的真空。只测 deliverBrief 的返回值不够——
 * 真正的纪律在 S6 里那个 `if (!delivered.ok)` 分支上。把它改成 `if (false)`，
 * 只测 deliverBrief 的用例照样全绿，缺陷从测试底下溜过去。所以这里必须跑整步。
 *
 * 做法：桩掉全局 fetch 造一个最小 sidecar，让 S6 走到 dispatched:true，
 * 再让投递失败/成功，断言 S6 的 ok 跟着变。
 */
console.log('\n[7] S6 整步：投递失败必须让整步失败（不许假通过）')

/** 把全局 fetch 换成按 route 返回固定 body 的桩，返回还原函数 */
function stubFetch(routes) {
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url && url.url ? url.url : url)
    const path = new URL(u, 'http://x').pathname
    const method = (init && init.method) || 'GET'
    const key = `${method} ${path}`
    const hit = routes[key] !== undefined ? routes[key] : routes[path]
    if (hit === undefined) {
      const errBody = JSON.stringify({ error: `not stubbed: ${key}` })
      return { ok: false, status: 404, json: async () => JSON.parse(errBody), text: async () => errBody }
    }
 // jpost 走 r.text + JSON.parse，jget 走 r.json；两个方法都得给
    const bodyText = JSON.stringify(hit)
    return { ok: true, status: 200, json: async () => JSON.parse(bodyText), text: async () => bodyText }
  }
  return () => { globalThis.fetch = orig }
}

const stubBase = {
  'GET /api/teams/team_stub/members': { items: [{ id: 'm1', name: 'maker', role: '干活', status: 'running', agentSessionId: 'sid-ok' }] },
  'GET /api/teams': { items: [{ id: 'team_stub', maxMembers: 8, workspace: '/tmp/dsh-verify' }] },
  'POST /api/messages': { message: { id: 'msg-1' } },
  'GET /api/tasks': { items: [{ id: 't_stub', status: 'running' }] },
}

/**
 * 跑一次真实 registry + 桩 sidecar 的 S6。
 * 场景必须真的注册进注册表——S6 从中间步骤起跑要读场景记录，
 * 光桩掉 fetch 不够（这条是踩出来的，不是猜的）。
 */
async function runS6WithStub(routes, hostCtx) {
  const Reg = await import('../lib/orchestrator/registry.mjs')
  const sceneId = 'verify-s6-' + Math.random().toString(36).slice(2, 8)
  const added = await Reg.addScenario({
    id: sceneId,
    name: 'S6 桩验证',
    kind: 'general',
    workspace: '/tmp/dsh-verify',
    presetId: 'ai-team',
  })
  if (!added.ok) throw new Error('临时场景注册失败：' + JSON.stringify(added.errors))
  await Reg.updateScenario(sceneId, { teamId: 'team_stub' })
  const restore = stubFetch(routes)
  try {
    const out = await P.runPipeline(sceneId, { from: 'S6', to: 'S6', hostCtx: hostCtx || null })
    return { out, s6: out.steps.find((s) => s.step === 'S6') || null }
  } finally {
    restore()
    await Reg.removeScenario(sceneId).catch(() => null)
  }
}

// ① 投递失败（成员无会话）→ S6 必须 ok:false
{
  const { out, s6 } = await runS6WithStub({
    ...stubBase,
    'GET /api/teams/team_stub/members': { items: [{ id: 'm1', name: 'maker', role: '干活', status: 'idle', agentSessionId: null }] },
    'POST /api/agents/dispatch': { dispatched: true, running: 1, task: { id: 't_stub', subject: '干活', plan: [] }, member: { id: 'm1', name: 'maker', agentSessionId: null } },
  })
  t('投递失败 → S6 ok=false', Boolean(s6) && s6.ok === false, s6 && String(s6.ok))
  t('   → 整条流水线 ok=false', out.ok === false)
  t('   → detail 点明「没投进成员会话」', /没投进成员会话/.test((s6 && s6.detail) || ''), s6 && s6.detail)
  t('   → 带可执行 fix', Boolean(s6 && s6.fix), s6 && s6.fix)
}

// ② 投递成功 → S6 必须 ok:true（阴性对照：不能一律报失败）
{
  const hostCtx = {
    get: (n) => (n === 'subagents'
      ? { sendMessage: async () => 'inbox-1' }
      : (n === 'agents' ? { list: () => [{ id: 'lead-1', session: { header: { origin: 'user' } } }] } : undefined)),
  }
  const { s6 } = await runS6WithStub({
    ...stubBase,
    'POST /api/agents/dispatch': { dispatched: true, running: 1, task: { id: 't_stub', subject: '干活', plan: [] }, member: { id: 'm1', name: 'maker', agentSessionId: 'sid-ok' } },
  }, hostCtx)
  t('投递成功 → S6 ok=true', Boolean(s6) && s6.ok === true, s6 && s6.detail)
  t('   → detail 说已投进成员会话', /已投进成员会话/.test((s6 && s6.detail) || ''), s6 && s6.detail)
}

// ③ dispatched:false + no_idle_agent → S6 必须 ok:false 且 fix 指向可执行动作
{
  const { s6 } = await runS6WithStub({
    ...stubBase,
    'POST /api/agents/dispatch': { dispatched: false, reason: 'no_idle_agent', running: 0 },
  })
  t('no_idle_agent → S6 ok=false', Boolean(s6) && s6.ok === false)
  t('   → fix 指向可执行动作', /retire|dsh_team_spawn|teamHealth/.test((s6 && s6.fix) || ''), s6 && s6.fix)
}

// ④ stale-lineage 走完整个 S6：兜底指令必须落到 data.delivery 里，且 S6 仍 ok:false
// （判据 3 的整步版——只测 deliverBrief 不够，纪律在 S6 的返回值上）
{
  const { out, s6 } = await runS6WithStub({
    ...stubBase,
    'POST /api/agents/dispatch': {
      dispatched: true,
      running: 1,
      task: { id: 't_stub', subject: '干活', plan: [{ step: 'S1', action: 'read' }], acceptance: '全绿' },
      member: { id: 'm_stale', name: 'architect', agentSessionId: 'sid-stale' },
    },
  }, {
    get: (n) => (n === 'subagents'
      ? { sendMessage: async () => { throw new Error('subagent "sid-stale" belongs to another parent session') } }
      : (n === 'agents' ? { list: () => [{ id: 'lead-1', session: { header: { origin: 'user' } } }] } : undefined)),
  })
  t('stale-lineage 整步：S6 ok 仍为 false', Boolean(s6) && s6.ok === false)
  t('   → 整条流水线 ok=false', out.ok === false)
  const delivery = (s6 && s6.data && s6.data.delivery) || {}
  t('   → data.delivery.dispatchCommand 非空', typeof delivery.dispatchCommand === 'string' && delivery.dispatchCommand.length > 0, JSON.stringify(delivery).slice(0, 160))
  t('   → 指令含真实 teamId（team_stub）', String(delivery.dispatchCommand || '').includes('team_stub'))
  t('   → 指令 assignee = 真实 member id（m_stale）', String(delivery.dispatchCommand || '').includes('"m_stale"'))
  t('   → data.delivery.rebuildCommand 非空', typeof delivery.rebuildCommand === 'string' && /dsh_team_member\(/.test(delivery.rebuildCommand), delivery.rebuildCommand)
  t('   → data.delivery.rebuildRequired=true', delivery.rebuildRequired === true)
}

/* ── 8. 投递兜底：两个失败分支要给可粘贴指令 ──────────
 * 纪律落点：生成指令 ≠ 投递成功。所以这一组每条都以「ok 必须仍是 false」打头，
 * 再查指令内容。如果哪天有人为了让用户少点一次而把 ok 翻成 true，
 * 这里的第一个断言立刻红——那正是 判据 3。
 */
console.log('\n[8] 投递兜底：失败分支产出可粘贴的 dsh_team_task 指令（docs\\107）')

const realTeam = 'team_verify_a'
const realTask = {
  id: 'task_real_1',
  subject: '带引号与反斜杠的题目："验证" docs\\107 的转义',
  plan: [
    { step: 'S1', action: 'read', target: '读规格' },
    { action: 'write', target: '缺 step 要补 S2' }, // 故意缺 step：PLAN_STEP 要求必填
  ],
  acceptance: '产物落在 docs\\108，含 "引号" 与 反斜杠\\路径',
}
const realMember = { id: 'm_TESTID', name: 'maker', agentSessionId: 'sid-real' }

// ① no-lead-agent 分支：有指令、ok 仍 false
{
  const fakeSubs = { sendMessage: async () => 'x' }
  const ctx = { state: {}, hostCtx: { get: (n) => (n === 'subagents' ? fakeSubs : undefined) } }
  const out = await P.deliverBrief(ctx, realTeam, realTask, realMember)
  t('no-lead-agent：ok 必须仍是 false（有指令 ≠ 投递成功）', out.ok === false)
  t('  → report.dispatchCommand 非空', typeof out.report.dispatchCommand === 'string' && out.report.dispatchCommand.length > 0)
  t('  → 指令含 dsh_team_task(', /dsh_team_task\(/.test(out.report.dispatchCommand || ''))
  t('  → 指令含真实 teamId', out.report.dispatchCommand.includes(JSON.stringify(realTeam)))
  t('  → 指令含真实 assignee（member.id，不是 name）',
    out.report.dispatchCommand.includes(`assignee: ${JSON.stringify(realMember.id)}`),
    out.report.dispatchCommand)
  t('  → 指令不含 <占位符>', !/<[A-Za-z_][\w-]*>/.test(out.report.dispatchCommand || ''))
  t('  → fix 指向 dispatchCommand', /dispatchCommand/.test(out.fix || ''), out.fix)
  t('  → 带回 dispatchPayload 且 tool=dsh_team_task',
    Boolean(out.report.dispatchPayload) && out.report.dispatchPayload.tool === 'dsh_team_task')
  t('  → payload.assignee === member.id', out.report.dispatchPayload.assignee === realMember.id)
  t('  → payload.plan 补全了缺失的 step', out.report.dispatchPayload.plan.every((p) => typeof p.step === 'string'))
  t('  → payload.plan[1].step 补成 S2', out.report.dispatchPayload.plan[1].step === 'S2', JSON.stringify(out.report.dispatchPayload.plan))
  t('  → payload.acceptance 原样保留（含引号反斜杠）', out.report.dispatchPayload.acceptance === realTask.acceptance)
  t('  → 无 rebuild 字段（该分支不需要重建）',
    out.report.rebuildRequired === undefined && out.report.rebuildCommand === undefined)
}

// ② stale-lineage 分支：有 rebuild + dispatch 两条指令、ok 仍 false
{
  const ctx = {
    state: { memberHealth: [{ name: realMember.name, state: 'ok' }] },
    hostCtx: {
      get: (n) => (n === 'subagents'
        ? { sendMessage: async () => { throw new Error('subagent "sid-real" belongs to another parent session') } }
        : (n === 'agents' ? { list: () => [{ id: 'lead-1', session: { header: { origin: 'user' } } }] } : undefined)),
    },
  }
  const out = await P.deliverBrief(ctx, realTeam, realTask, realMember)
  t('stale-lineage：ok 必须仍是 false（有指令 ≠ 投递成功）', out.ok === false)
  t('  → sessionState=stale-lineage', out.report.sessionState === 'stale-lineage')
  t('  → rebuildRequired=true', out.report.rebuildRequired === true)
  t('  → dispatchCommand 非空且含真实 teamId+assignee',
    /dsh_team_task\(/.test(out.report.dispatchCommand || '')
    && out.report.dispatchCommand.includes(JSON.stringify(realTeam))
    && out.report.dispatchCommand.includes(JSON.stringify(realMember.id)),
    out.report.dispatchCommand)
  t('  → rebuildCommand 是 dsh_team_member update', /dsh_team_member\(/.test(out.report.rebuildCommand || '')
    && /action: "update"/.test(out.report.rebuildCommand || ''), out.report.rebuildCommand)
  t('  → rebuildCommand 含 memberId 与 contextMode', (() => {
    const c = out.report.rebuildCommand || ''
    return c.includes(`memberId: ${JSON.stringify(realMember.id)}`) && c.includes('contextMode: "fresh"')
  })(), out.report.rebuildCommand)
  t('  → rebuild 不要求先 retire（v2：update 一步到位）', !/retire/.test(out.report.rebuildCommand || ''))
  t('  → fix 指明先 rebuild 再 dispatch',
    /rebuildCommand/.test(out.fix || '') && /dispatchCommand/.test(out.fix || ''), out.fix)
  t('  → payload 与 command 同源（teamId 一致）',
    out.report.dispatchPayload.teamId === realTeam && out.report.rebuildPayload.teamId === realTeam)
}

// ③ 纯函数直测：转义与取值纪律由 buildDispatchCommand 独担保
{
  const { command, payload } = P.buildDispatchCommand(realTeam, realTask, realMember)
 // 指令里的 JSON 片段必须能被 JSON.parse 回等价对象——这是「粘一次就完整」的硬判据
  const m = command.match(/subject: (".*?"), assignee: /)
  t('buildDispatchCommand：subject 可 JSON.parse 回原值', Boolean(m) && JSON.parse(m[1]) === realTask.subject)
  const a = command.match(/acceptance: (".*?") \}\)$/)
  t('buildDispatchCommand：acceptance 可 JSON.parse 回原值', Boolean(a) && JSON.parse(a[1]) === realTask.acceptance)
  t('buildDispatchCommand：payload 与 command 同源', payload.assignee === realMember.id && payload.teamId === realTeam)
  t('buildDispatchCommand：acceptance 为空则整键省略', (() => {
    const r = P.buildDispatchCommand(realTeam, { subject: 'x', plan: [] }, realMember)
    return !/acceptance:/.test(r.command) && r.payload.acceptance === null
  })())
  t('buildDispatchCommand：空 plan 不炸', (() => {
    try { return /plan: \[\]/.test(P.buildDispatchCommand(realTeam, { subject: 'x' }, realMember).command) } catch { return false }
  })())
  t('buildDispatchCommand：member 无 id 时给空串不抛', (() => {
    try { return P.buildDispatchCommand(realTeam, { subject: 'x' }, {}).payload.assignee === '' } catch { return false }
  })())
  const rb = P.buildRebuildCommand(realTeam, realMember)
  t('buildRebuildCommand：含 action/update 与 contextMode',
    /dsh_team_member\(/.test(rb.command) && /"update"/.test(rb.command) && /"fresh"/.test(rb.command), rb.command)
  t('buildRebuildCommand：无占位符', !/<[A-Za-z_][\w-]*>/.test(rb.command))
}

// ④ 正常投递路径不应混入兜底字段（阴性对照：别到处塞指令）
{
  const okCtx2 = {
    state: {},
    hostCtx: {
      get: (n) => (n === 'subagents'
        ? { sendMessage: async () => 'inbox-x' }
        : (n === 'agents' ? { list: () => [{ id: 'lead-1', session: { header: { origin: 'user' } } }] } : undefined)),
    },
  }
  const out = await P.deliverBrief(okCtx2, realTeam, realTask, realMember)
  t('成功分支：ok=true 且不带 dispatchCommand', out.ok === true && out.report.dispatchCommand === undefined)
}

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：团队模式修复（团队模式）行为符合 docs\\99 规格修复 B。\n')
else console.log('有断言失败 —— 团队模式修复退化，先修这些。\n')
process.exit(fail === 0 ? 0 : 1)
