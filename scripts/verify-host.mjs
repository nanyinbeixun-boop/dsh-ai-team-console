#!/usr/bin/env node
/**
 * 宿主适配层 + 健康巡检 的行为锁。
 *
 * 断言三件事：
 *   1. 适配层在空 ctx / 残缺 ctx 下全部降级而不抛错
 *   2. 每个能力函数的返回形状稳定（调用方依赖它）
 *   3. 健康巡检能识别出 sidecar 的字段漂移
 */
import * as Host from '../lib/orchestrator/host.mjs'

let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}

console.log('\n[1] 适配层在空/残缺 ctx 下降级')
{
  const caps = Host.capabilities({})
  t('空 ctx 不抛错', typeof caps === 'object')
  t('全部能力为 false', Object.values(caps).every((v) => v === false), JSON.stringify(caps))

  t('listAgents(null) 返回空数组', Array.isArray(Host.listAgents(null)) && Host.listAgents(null).length === 0)
  t('getAgent(null) 返回 null', Host.getAgent(null, 'x') === null)
  t('createAgent(null) 返回 ok:false', Host.createAgent(null, {}).ok === false)
  t('canFollowup(null) 为 false', Host.canFollowup(null) === false)
  t('clearInbox(null) 为 false', Host.clearInbox(null) === false)
  t('canSendToMember(null) 为 false', Host.canSendToMember(null) === false)
  t('registerSlot(null) 为 false', Host.registerSlot(null, 'x', {}, () => null) === false)
  // registerWebRoute 成功返回 disposer 函数，失败返回 null——
  // 返回值语义从「布尔」改成「可撤销句柄」，这里按新契约断言
  t('registerWebRoute(null) 返回 null', Host.registerWebRoute(null, {}) === null)
  t('modelSelection(null) 为 null', Host.modelSelection(null) === null)
}

console.log('\n[2] 残缺 ctx：get 抛错也要兜住')
{
  const evil = { get() { throw new Error('boom') } }
  const caps = Host.capabilities(evil)
  t('get 抛错时能力全 false', Object.values(caps).every((v) => v === false))
  t('listAgents 抛错 → 空数组', Host.listAgents(evil).length === 0)
  t('健康报告标出缺失', Host.healthReport(evil).ok === false)
}

console.log('\n[3] 正常 ctx：能力探测 + 调用')
{
  const sent = []
  const agent = { id: 'a1', followup: async (m) => { sent.push(m); return 'done' }, inbox: { cleared: 0, clear() { this.cleared++ } } }
  const ctx = {
    get(n) {
      if (n === 'agents') return { list: () => [agent], get: (id) => (id === 'a1' ? agent : null), create: () => agent }
      if (n === 'subagents') return { sendMessage: async (s, to, content) => { sent.push({ to, content }); return 'inbox-1' } }
      if (n === 'webServer') return { register: () => {} }
      return undefined
    },
    effect: (fn) => fn(),
    slots: { inject: (n, fn) => fn(), register: (o, c) => ({ o, c }) },
  }

  const caps = Host.capabilities(ctx)
  t('agentsList 为 true', caps.agentsList === true)
  t('agentsGet 为 true', caps.agentsGet === true)
  t('subagentsSend 为 true', caps.subagentsSend === true)
  t('slots 为 true', caps.slots === true)
  t('effect 为 true', caps.effect === true)

  t('listAgents 拿到 1 个', Host.listAgents(ctx).length === 1)
  t('getAgent 按 id 取到', Host.getAgent(ctx, 'a1') === agent)
  t('getAgent 不存在返回 null', Host.getAgent(ctx, 'nope') === null)

  const fu = await Host.followup(agent, 'hi', 1000)
  t('followup 成功', fu.ok === true && fu.result === 'done')
  t('followup 真的调了 agent', sent.includes('hi'))

  t('clearInbox 返回 true', Host.clearInbox(agent) === true)
  t('inbox.clear 被调用', agent.inbox.cleared === 1)

  const s = await Host.sendToMember(ctx, agent, 'sid-1', [{ type: 'text', text: 'x' }], {})
  t('sendToMember 成功', s.ok === true && s.via === 'subagents.sendMessage')
  t('sendToMember 透传 4 个参数', sent.some((x) => x && x.to === 'sid-1'))

  t('registerSlot 成功', Host.registerSlot(ctx, 'sidebar', { id: 'x' }, () => null) === true)
  t('registerEffect 成功', Host.registerEffect(ctx, () => {}, 'label') === true)
  t('registerWebRoute 成功', typeof Host.registerWebRoute(ctx, {}) === 'function')
}

console.log('\n[4] sendToMember 的失败分支')
{
  // 宿主没有 sendMessage
  const noApi = { get: (n) => (n === 'subagents' ? {} : undefined) }
  const r1 = await Host.sendToMember(noApi, null, 's', [])
  t('无 API → ok:false reason=no-api', r1.ok === false && r1.reason === 'no-api', JSON.stringify(r1))

  // sendMessage 抛错
  const throws = { get: (n) => (n === 'subagents' ? { sendMessage: async () => { throw new Error('lineage mismatch') } } : undefined) }
  const r2 = await Host.sendToMember(throws, null, 's', [])
  t('抛错 → ok:false reason=threw', r2.ok === false && r2.reason === 'threw', JSON.stringify(r2))
  t('错误文本被保留', /lineage mismatch/.test(r2.error))
}

console.log('\n[5] followup 超时')
{
  const slow = { followup: () => new Promise((res) => setTimeout(() => res('late'), 500)) }
  const r = await Host.followup(slow, 'x', 50)
  t('超时 → ok:false', r.ok === false, JSON.stringify(r))
  t('错误提到超时', /超时/.test(r.error))
}

console.log('\n[6] hostCtx 包装形态（测试夹具）')
{
  const inner = {
    get(n) {
      if (n === 'subagents') return { sendMessage: async () => 'ok' }
      if (n === 'agents') return { list: () => [{ id: 'lead' }] }
      return undefined
    },
  }
  const wrapped = { state: {}, hostCtx: inner }
  t('从 hostCtx 取到 subagents', Host.canSendToMember(wrapped) === true)
  t('从 hostCtx 取到 agents', Host.listAgents(wrapped).length === 1)
}

console.log('\n[7] healthReport 形状')
{
  const r = Host.healthReport({})
  t('有 ok 字段', typeof r.ok === 'boolean')
  t('有 capabilities', typeof r.capabilities === 'object')
  t('有 missing 数组', Array.isArray(r.missing))
  t('有 summary 字符串', typeof r.summary === 'string' && r.summary.length > 0)
  t('空 ctx 时 ok=false', r.ok === false)
}

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail > 0) {
  console.log('有断言失败。')
  process.exit(1)
}
console.log('全部通过：宿主适配层在各类 ctx 下都能安全降级，调用契约稳定。')
