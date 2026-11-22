/**
 * 编排层 —— 9 步流水线
 *
 * 这是「自动调用整套机制」的核心。每一步都有判定条件与失败处理，不靠 AI 临场发挥。
 *
 * 设计原则：
 * 1. 每一步都能单独重试，不要求从头跑
 * 2. 失败必须给出「下一步该做什么」，不是只报错
 * 3. 不猜：读不到就说读不到，不拿默认值糊过去
 * 4. 某项目类项目的风险分级优先于本层判断
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Reg from './registry.mjs'
import * as TeamHealth from './teamHealth.mjs'
import * as Routes from './routes.mjs'
import * as Host from './host.mjs'
import * as Tpl from './teamTemplates.mjs'

// 自动开 Lead 会话用。用函数形式的动态 import 避免顶层 import 失败
// 在 node 直跑（无宿主 ctx）时把整个 pipeline 模块拉崩——只有真正需要
// openThread 时才加载 chat.mjs，降级路径不依赖它。
// ctx 是宿主 Cordis context（无 .scenario）；场景信息（preset/cwd）必须
// 由调用方作为单独参数传入，不要读 ctx.scenario（宿主 ctx 上没有它）。
async function openLeadThread(ctx, sceneId, teamId, sceneMeta = {}) {
  try {
    const { openThread } = await import('./chat.mjs')
    const opened = await openThread(ctx, {
      sceneId,
      title: `Lead · ${sceneId}`,
      preset: sceneMeta.preset || undefined,
      cwd: sceneMeta.cwd || undefined,
    })
    if (opened.ok && opened.thread && opened.thread.sessionId) {
      const sessionId = opened.thread.sessionId
      await Reg.updateScenario(sceneId, { leadSessionId: sessionId })
      return { ok: true, sessionId, reused: opened.reused }
    }
    return { ok: false, reason: opened.reason || 'open-failed', error: opened.error || '未拿到 sessionId' }
  } catch (err) {
    // T11：exception 根因定位——把 stack 与 code 一并带出，别只留 message。
    // 否则重启后拿不到真实堆栈，无法判断是 import 抛还是别处抛。
    return {
      ok: false,
      reason: 'exception',
      error: String(err && err.message ? err.message : err),
      code: err && err.code ? String(err.code) : null,
      stack: err && err.stack ? String(err.stack) : null,
    }
  }
}

const SIDECAR = process.env.DSH_TEAM_SIDECAR_URL || 'http://127.0.0.1:4317'

/* ── 团队编制与成员会话健康（99 规格修复 B·C） ──────────────────
 * 判据与措辞统一放在团队健康模块里，面板与流水线共用同一套口径，
 * 不让「派不动」在一处显示成「待命」、在另一处显示成「失败」。
 * 1. 核心能力域三个：architect（造规则）/ maker（干活）/ auditor（验活）。
 * 2. 「成员记录存在」≠「成员能干活」：记录是 sidecar 的，宿主会话要 spawn。
 * 3. 「会话能投递」≠「会话归属有效」：旧父会话下的成员会被 authorizeLineage 拒绝。
 */
const CORE_DOMAINS = TeamHealth.CORE_DOMAINS
const LINEAGE_ERROR_RE = TeamHealth.LINEAGE_ERROR_RE
const domainOwned = TeamHealth.domainOwned
const memberSessionHealth = TeamHealth.memberSessionHealth
const annotateMembers = TeamHealth.annotateMembers

/** 读团队活成员（retired 不计）；读不到如实返回，不返回空数组糊过去 */
async function readMembers(teamId) {
  const r = await jget(`${SIDECAR}/api/teams/${teamId}/members`)
  if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}`, members: [] }
  const rows = r.data && (r.data.items || r.data)
  return { ok: true, error: null, members: TeamHealth.activeMembers(rows) }
}

async function jget(url, timeout = 5000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } })
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` }
    return { ok: true, data: await r.json() }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  } finally { clearTimeout(t) }
}

async function jpost(url, body, timeout = 8000) {
  return jrequest('POST', url, body, timeout)
}

/** PATCH：sidecar 的成员热改（role / permissionPreset）走这个，别用 POST 糊 */
async function jpatch(url, body, timeout = 8000) {
  return jrequest('PATCH', url, body, timeout)
}

async function jrequest(method, url, body, timeout = 8000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const txt = await r.text()
    let data = null
    try { data = JSON.parse(txt) } catch { data = { raw: txt } }
    return { ok: r.ok, status: r.status, data, error: r.ok ? null : `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  } finally { clearTimeout(t) }
}

/* ── 10 步定义（S0–S8，含 S2_5 与 S6b）────────────────────────────
 * 每步：{ id, title, gate, hint, run(ctx) }　run 返回 { ok, detail, next?, data? }
 *
 * gate（门类型列，先进编排迭代 3）：每步标注它过的是什么门——
 *   continue 继续门：判定通过即走下一步
 *   halt     终止门：判定不过即停（默认）
 *   human    人工门：等用户拍板
 *   first    首件门：S6b 专用——首个产物交 auditor 快速核对方向，错则打回
 */

const STEPS = [
  {
    id: 'S0',
    title: '场景路由',
    gate: 'continue',
    hint: '查注册表拿到场景、preset、handbook、约束',
    async run(ctx) {
      const sc = await Reg.getScenario(ctx.scenarioId)
      if (!sc) return { ok: false, detail: `场景 ${ctx.scenarioId} 未注册`, fix: '先 addScenario 或在面板建场景' }
      ctx.scenario = sc
      return { ok: true, detail: `${sc.name}（${sc.kind}）state=${sc.state} rounds=${sc.rounds || 0}` }
    },
  },
  {
    id: 'S1',
    title: '前置检查',
    gate: 'halt',
    hint: 'preset / handbook / workspace / skill 四项',
    async run(ctx) {
      const pf = await Reg.preflight(ctx.scenarioId)
      if (!pf.ok) {
        return {
          ok: false,
          detail: `卡在：${pf.blocking.join('、')}`,
          fix: pf.checks.filter((c) => !c.pass && !c.optional).map((c) => `${c.id}: ${c.detail}`).join(' | '),
        }
      }
      ctx.preflight = pf
      return {
        ok: true,
        detail: pf.skill ? `全部就绪（有 skill，可加速）` : '全部就绪（无 skill，走默认流程）',
        data: { skill: pf.skill, presetFile: pf.presetFile },
      }
    },
  },
  {
    id: 'S2',
    title: '建队 / 复用',
    gate: 'halt',
    hint: '已有 team 就复用，没有就建；建队/复用后自动开 Lead 会话写 leadSessionId',
    async run(ctx) {
      const sc = ctx.scenario
      let teamId = null
      let reused = false
      if (sc.teamId) {
        const r = await jget(`${SIDECAR}/api/teams`)
        const all = r.ok ? (r.data.items || r.data || []) : []
        const hit = all.find((t) => t.id === sc.teamId)
        if (hit) {
          teamId = sc.teamId
          reused = true
        }
      }
      if (!teamId) {
        // 名额按场景模板的角色数定，不写死 3。
        // 写死 3 是软件开发场景建不出 6 人团队的直接原因：
        // 建队时上限就是 3，S2_5 想补 pm/ui/qa/devops 也补不进去。
        const newTpl = Tpl.templateFor(sc.kind)
        const seatCount = newTpl.roles.length
        const r = await jpost(`${SIDECAR}/api/teams`, {
          name: `ai-team-${sc.id}`,
          workspace: sc.workspace || Reg.paths.userData,
          maxMembers: seatCount,
          maxConcurrency: Math.min(seatCount, 4),
          permissionPreset: 'danger-full-access',
          agentPreset: sc.presetId,
        })
        if (!r.ok) return { ok: false, detail: `建队失败`, fix: r.error }
        const team = r.data.team || r.data
        teamId = team.id
        await Reg.updateScenario(sc.id, { teamId })
      }

      // ── 编制匹配：按场景类型检查团队编制，缺角色如实报出来 ──
      // 此前场景绑哪个团队就永远用哪个，不看编制是否匹配场景类型。
      // 软件开发场景只有 3 人、文档场景塞了 6 人，都会拖累产出质量。
      const tpl = Tpl.templateFor(sc.kind)
      let rosterCheck = null
      try {
        const mr = await jget(`${SIDECAR}/api/teams/${teamId}/members`)
        const rows = mr.ok ? (mr.data.items || mr.data || []) : []
        rosterCheck = Tpl.checkTeamAgainstTemplate(rows, sc.kind)
        ctx.state.rosterCheck = rosterCheck
        ctx.state.rosterMissing = rosterCheck.missing
      } catch {
        rosterCheck = null // 读不到成员不阻塞，S2_5 会再查一次
      }

      // 建队/复用后自动开 Lead 会话，把 sessionId 写进场景 leadSessionId。
      // 没有宿主 ctx 时（node 直跑、临时场景）降级：不阻塞主流程，只如实标注。
      // T11：场景信息（preset/cwd）从 sc 单独传入，不读 ctx.hostCtx.scenario（宿主 ctx 没有它）。
      let lead = { ok: false, reason: 'no-ctx', error: '未提供宿主 ctx，跳过自动开 Lead 会话' }
      if (ctx.hostCtx) {
        lead = await openLeadThread(ctx.hostCtx, sc.id, teamId, { preset: sc.presetId, cwd: sc.workspace })
      }
      // 编制缺口说明（拼进 detail，让用户一眼看到缺谁）
      const rosterNote = rosterCheck && !rosterCheck.ok
        ? `；编制 ${tpl.label} 缺 ${rosterCheck.missing.length} 个角色（${rosterCheck.missing.map((r) => r.title).join('、')}），S2_5 会补齐`
        : rosterCheck
          ? `；编制符合 ${tpl.label}（${rosterCheck.present.length}/${tpl.roles.length}）`
          : ''
      if (lead.ok) {
        return {
          ok: true,
          detail: `${reused ? '复用' : '新建'}团队 ${teamId}${rosterNote}；Lead 会话已开（${lead.sessionId}${lead.reused ? '，复用' : ''}）`,
          data: { teamId, reused, leadSessionId: lead.sessionId, roster: rosterCheck },
        }
      }
      // T11：lead 未开时，把 reason/error/code/stack 全带进 detail，供重启后定位
      const leadDetail = [lead.reason, lead.error].filter(Boolean).join('：') + (lead.code ? `（code=${lead.code}）` : '')
      return {
        ok: true,
        detail: `${reused ? '复用' : '新建'}团队 ${teamId}${rosterNote}；Lead 会话未开（${leadDetail}）`,
        data: { teamId, reused, leadSessionId: null, roster: rosterCheck, lead: { reason: lead.reason, error: lead.error, code: lead.code, stack: lead.stack } },
      }
    },
  },
  {
    id: 'S2_5',
    title: '补齐成员编制',
    gate: 'halt',
    hint: '按核心能力域查活成员，缺谁就建谁的成员记录（只建记录，不建会话）',
    async run(ctx) {
      const teamId = ctx.state.teamId
      if (!teamId) return { ok: false, detail: '没有 teamId（S2 未建队）', fix: '从 S2 重跑' }

      const read = await readMembers(teamId)
      if (!read.ok) return { ok: false, detail: `读不到成员列表：${read.error}`, fix: 'sidecar 不可达或 teamId 失效' }
      const before = read.members

      // 名额：从 teams 列表读真实上限，不写死
      const teamsRes = await jget(`${SIDECAR}/api/teams`)
      const teams = teamsRes.ok ? (teamsRes.data.items || teamsRes.data || []) : []
      const cap = Number((teams.find((t) => t.id === teamId) || {}).maxMembers || 8)

      // ── 按场景类型取模板，补全该类型需要的全部角色 ──
      // 此前只补 3 个核心域（architect/maker/auditor），不看场景类型：
      // 软件开发场景只有 3 人、没有 pm/ui/qa/devops，编制与工作不匹配。
      // 现在按 teamTemplates 的编制补：software=6人 / docs=3人 / research=3人 …
      const kind = ctx.scenario ? ctx.scenario.kind : ''
      const tpl = Tpl.templateFor(kind)
      ctx.state.tplKind = tpl.kind
      ctx.state.tplRoles = tpl.roles

      // 缺口 = 模板里还没有成员的角儿
      const hasRole = (role) => {
        const re = new RegExp(role.name, 'i')
        return before.some((m) => re.test(String(m.name || '')) || re.test(String(m.role || '')))
      }
      const needRoles = tpl.roles.filter((r) => !hasRole(r))
      // 兜底：模板角色都齐了，但核心三域仍缺（极少见，比如角色名对上了但域没认出来）
      const missingDomains = CORE_DOMAINS.filter((d) => !domainOwned(before, d.domain))
      const created = []
      const failed = []
      // 选路开关：免费优先是默认；今天免费全灭或用户明确要求时从 scenario.constraints
      // 或 op=run 的 opts 关掉（走付费链）。不在这一步探测免费可用性——那是
      // scripts\check-free-routes.mjs 的日常巡检活，流水线不替它发一堆请求。
      const routeOpts = {
        freeDisabled: ctx.freeDisabled === true
          || (ctx.scenario && ctx.scenario.constraints && (ctx.scenario.constraints.freeDisabled === true
            || ctx.scenario.constraints.freeRoutes === false)),
        freePool: Array.isArray(ctx.freePool) ? ctx.freePool : undefined,
        // 倍率/provider 门槛（route-config.json）。op=run 可注入，未注入时用默认配置：
        // workbuddy cap=0（只留 x0.00 的 hy4flash-free），全局限 x0.6。
        ...(ctx.routeConfig ? { config: ctx.routeConfig } : {}),
      }
      const memberRoutes = {}

      // 待建清单：模板缺的角色优先；模板齐了再用核心域兜底（防「角色名对上但域没认出来」）
      const toCreate = needRoles.length
        ? needRoles.map((r) => ({ name: r.name, role: r.duty, title: r.title, reasoningEffort: r.reasoningEffort, domain: r.name }))
        : missingDomains.map((d) => ({ name: d.name, role: d.role, title: d.name, reasoningEffort: d.reasoningEffort, domain: d.domain }))

      for (const d of toCreate) {
        // 名额在循环里重算：每建一个就占一位，不能拿循环前的数一路用到底
        const active = before.length + created.length
        if (active >= cap) {
          failed.push({ domain: d.domain, error: `名额已满（${active}/${cap}）；建议调大 maxMembers 或先 retire 闲置成员` })
          continue
        }
        // 按能力域选 route（ 决策矩阵）：免费首选 → 付费降级 → 备选，
        // 不再硬编码 reasoningEffort，也不再让成员继承 Lead 的 route。
        const route = Routes.selectRoute(d.domain, routeOpts)
        memberRoutes[d.domain] = route
        // 能力基线写进 role（：静态基线，不额外起 LLM 探查）
        const roleText = Routes.capabilityRole(d.domain, d.role, route)
        const body = {
          name: d.name,
          role: roleText,
          agentPreset: ctx.scenario && ctx.scenario.presetId ? ctx.scenario.presetId : 'standard',
          agentProvider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          permissionPreset: 'danger-full-access',
          contextMode: 'fresh',
        }
        const r = await jpost(`${SIDECAR}/api/teams/${teamId}/members`, body)
        if (!r.ok) {
          const msg = (r.data && (r.data.error || r.data.message)) || r.error || `HTTP ${r.status}`
          failed.push({ domain: d.domain, error: String(msg).slice(0, 200), route })
          continue
        }
        created.push({ domain: d.domain, name: d.name, member: r.data && (r.data.member || r.data), route, role: roleText })
      }
      ctx.state.memberRoutes = memberRoutes

      const after = await readMembers(teamId)
      const members = after.ok ? after.members : before

      /* 已有成员的能力基线补齐（ / 本任务验收④）。
       * 只补 role 文本，不动 provider/model/effort：
       * - role 在 sidecar 属 HOT_PATCH_FIELDS（core.mjs:354），热改不影响在跑会话；
       * - model/agentProvider 改了会重建会话（dsh_team_member update 的语义），
       * 在跑的任务会被打断，不是「补齐编制」这一步该干的事。
       * best-effort：补不动不算本步失败（记录层的好坏由下面的 missing/unbound 判）。
       */
      const enriched = []
      const enrichFailed = []
      const needEnrich = members.filter((m) => {
        const name = String(m.name || '').toLowerCase()
        const role = String(m.role || '')
        const hit = CORE_DOMAINS.find((d) => d.domain === name)
        return Boolean(hit) && !role.includes('擅长：')
      })
      for (const m of needEnrich) {
        const domain = String(m.name || '').toLowerCase()
        const route = memberRoutes[domain] || Routes.selectRoute(domain, routeOpts)
        const roleText = Routes.capabilityRole(domain, m.role || '', route)
        const pr = await jpatch(`${SIDECAR}/api/members/${m.id}`, { role: roleText })
        if (pr.ok) {
          enriched.push({ name: m.name, id: m.id, role: roleText, route })
        } else {
          const msg = (pr.data && (pr.data.error || pr.data.message)) || pr.error || `HTTP ${pr.status}`
          enrichFailed.push({ name: m.name, id: m.id, error: String(msg).slice(0, 200) })
        }
      }
      if (enriched.length) {
        // 重读一次：role 已变，后面 S3 的编制判定要看到新 role
        const again = await readMembers(teamId)
        if (again.ok) ctx.state.members = again.members
      }

      const finalMembers = ctx.state.members || members
      // 会话健康：记录存在 ≠ 能干活。这一层必须在 detail 里说清，不混着报成功。
      const health = finalMembers.map((m) => ({ name: m.name, ...memberSessionHealth(m), agentSessionId: m.agentSessionId || null }))
      const unbound = health.filter((x) => x.state === 'unbound')
      const stale = health.filter((x) => x.state === 'stale-lineage')
      const stillMissing = CORE_DOMAINS.filter((d) => !domainOwned(finalMembers, d.domain))
      ctx.state.members = finalMembers
      ctx.state.memberHealth = health

      const sessionNote = `已绑定宿主会话 ${health.length - unbound.length}/${health.length}`
        + (unbound.length ? `；未绑定 ${unbound.map((x) => x.name).join('、')}（需宿主 dsh_team_spawn 拉起）` : '')
        + (stale.length ? `；会话归属失效 ${stale.map((x) => x.name).join('、')}` : '')
      // 选路要说清怎么选的：免费还是降级，否则「用了什么模型」在黑盒里
      const routeNote = Object.keys(memberRoutes).length
        ? `；选路 ` + Object.values(memberRoutes)
          .map((r) => `${r.domain}=${r.provider}/${r.model}${r.reasoningEffort ? '·' + r.reasoningEffort : ''}（${r.tier}${r.degraded ? '·降级' : ''}）`)
          .join('、')
        : ''
      const enrichNote = enriched.length
        ? `；能力基线写入 ${enriched.map((e) => e.name).join('、')} 的 role`
        : (enrichFailed.length ? `；能力基线写入失败 ${enrichFailed.map((e) => e.name).join('、')}` : '')

      // 模板编制核对（按场景类型，不只看核心 3 域）
      const tplCheck = Tpl.checkTeamAgainstTemplate(finalMembers, kind)
      const tplNote = `编制 ${tpl.label} ${tpl.roles.length - tplCheck.missing.length}/${tpl.roles.length}`
        + (tplCheck.missing.length ? `（缺 ${tplCheck.missing.map((r) => r.title).join('、')}）` : ' 齐全')

      // ok 只对「记录层」负责：模板编制齐了就算本步做到。
      // 会话层的缺口原样传下去，由 S6 用真实投递结果判真假——不在这里替它圆。
      //
      // 两套标准的关系：**模板是主标准，核心域只是保底**。
      // 模板齐了就不再要求核心三域——否则 software 编制（pm/ui/frontend/maker/qa/devops）
      // 永远缺 architect/auditor，明明人已配齐却判失败；而 6 个座位已满，想补也补不进去。
      if (stillMissing.length && tplCheck.missing.length) {
        return {
          ok: false,
          detail: `${tplNote}；核心能力域仍缺 ${stillMissing.map((d) => d.domain).join('、')}；${failed.length ? '建记录失败：' + failed.map((f) => `${f.domain}(${f.error})`).join('；') : '名额不足'}${routeNote}`,
          fix: failed.length && /名额已满/.test(failed[0].error)
            ? `团队上限 ${cap} 已满，先 retire 一个不再需要的成员或调大 maxMembers（面板「成员 / 缺口」页或 op=team-cap）`
            : '检查 sidecar POST /api/teams/:id/members 是否可用，或手动在面板「成员 / 缺口」页招募',
          data: { created, failed, members: finalMembers, health, cap, missing: stillMissing.map((d) => d.domain), memberRoutes, enriched, enrichFailed, tpl: tpl.kind, tplCheck },
        }
      }
      return {
        ok: true,
        detail: created.length
          ? `新建成员记录 ${created.map((c) => c.name).join('、')}；${tplNote}；${sessionNote}${routeNote}${enrichNote}`
          : `${tplNote}（无需补人）；${sessionNote}${routeNote}${enrichNote}`,
        fix: stale.length
          ? `${stale.map((x) => x.name).join('、')} 的会话绑在旧父会话上（belongs to another parent session）：先 retire 这些成员再让 Lead 重新 dsh_team_spawn，否则 S6 投递必失败`
          : (unbound.length
            ? `${unbound.map((x) => x.name).join('、')} 只有成员记录、没有宿主会话：让 Lead 用 dsh_team_spawn 拉起，S6 才能真投递`
            : null),
        data: { created, failed, members: finalMembers, health, cap, missing: [], recordsOnly: unbound.length > 0, memberRoutes, enriched, enrichFailed },
      }
    },
  },
  {
    id: 'S3',
    title: '成员编制核对',
    gate: 'halt',
    hint: '按能力域判断缺不缺人（人头数看团队上限，不再写死 3）',
    async run(ctx) {
      const teamId = ctx.state.teamId
      const read = await readMembers(teamId)
      if (!read.ok) return { ok: false, detail: `读不到成员：${read.error}`, fix: 'sidecar 不可达或 teamId 失效' }
      const members = read.members

      // 团队上限：从 teams 列表读，不写死
      const teamsRes = await jget(`${SIDECAR}/api/teams`)
      const teams = teamsRes.ok ? (teamsRes.data.items || teamsRes.data || []) : []
      const cap = Number((teams.find((t) => t.id === teamId) || {}).maxMembers || 8)

      // 按场景类型核对编制（不再只看核心 3 域）
      const kind3 = ctx.scenario ? ctx.scenario.kind : ''
      const tpl3 = Tpl.templateFor(kind3)
      const tplC = Tpl.checkTeamAgainstTemplate(members, kind3)
      const missing = tplC.missing.map((r) => r.name)
      ctx.state.members = members
      // 会话健康与编制分开报：编制齐了但会话没绑定/失效，等于派不动，不能算齐。
      const health = members.map((m) => ({ name: m.name, ...memberSessionHealth(m) }))
      const stale = health.filter((x) => x.state === 'stale-lineage')
      const unbound = health.filter((x) => x.state === 'unbound')
      ctx.state.memberHealth = health
      return {
        ok: missing.length === 0,
        detail: `现有 ${members.length}/${cap} 人：${members.map((m) => m.name).join('、')}；编制 ${tpl3.label} ${tplC.present.length}/${tpl3.roles.length}`
          + (missing.length ? `（缺 ${tplC.missing.map((r) => r.title).join('、')}）` : ' 齐全')
          + (unbound.length ? `；未绑定会话 ${unbound.map((x) => x.name).join('、')}` : '')
          + (stale.length ? `；会话失效 ${stale.map((x) => x.name).join('、')}` : ''),
        fix: missing.length
          ? `缺 ${tplC.missing.map((r) => r.title).join('、')}；上限 ${cap}，${members.length < cap ? '还有名额可直接招（或从 S2_5 重跑自动补齐）' : '已满员需先提上限或腾位'}`
          : (stale.length
            ? `${stale.map((x) => x.name).join('、')} 需重建成员会话（retire 后重新 spawn）`
            : (unbound.length ? `${unbound.map((x) => x.name).join('、')} 需宿主 dsh_team_spawn 拉起会话` : null)),
        data: { members, missing, cap, health },
      }
    },
  },
  {
    id: 'S4',
    title: '领域知识注入',
    gate: 'continue',
    hint: '把场景 constraints 拼成给成员看的硬约束',
    async run(ctx) {
      const sc = ctx.scenario
      const c = sc.constraints || {}
      const lines = []
      if (c.csharpVersion) lines.push(`C# 版本锁 ${c.csharpVersion}，禁更高语法`)
      if (c.allowNewNuget === false) lines.push('禁止引入新 NuGet 包')
      if (c.mustSnapshot) lines.push('改码前必须 git 快照')
      if (c.mustCompile) lines.push('改码后必须编译验证')
      if (c.autoLoop === false) lines.push('禁止自动后台循环，必须人工触发')
      if (c.riskPolicy) lines.push(`风险分级：${c.riskPolicy}`)

      // 读 knowledge 目录里的约定文件。
      // T13：优先用 detect 探测（在项目根按候选顺序找含 .md 的知识目录），
      // 探测不到再回落旧 sc.knowledge 配置（保留旧数据兼容）。
      let knowledgeFiles = []
      const knowledgeDirs = []
      if (sc.workspace && existsSync(sc.workspace)) {
        let det
        try {
          const { detectKnowledgeDirs } = await import('./detect.mjs')
          det = detectKnowledgeDirs(sc.workspace)
        } catch { det = null }
        if (det && det.knowledgeFiles && det.knowledgeFiles.length) {
          knowledgeFiles = det.knowledgeFiles
          if (det.knowledgeDirs) knowledgeDirs.push(...det.knowledgeDirs)
        }
      }
      // 回落：探测没找到，才看旧 sc.knowledge（patterns + knownIssues）
      if (knowledgeFiles.length === 0) {
        const kcfg = sc.knowledge || {}
        if (kcfg.patterns && kcfg.patterns.length) {
          const roots = [
            kcfg.knowledgeDir,
            kcfg.selfEvolution ? join(kcfg.selfEvolution, 'knowledge', 'wiki') : null,
            kcfg.selfEvolution ? join(kcfg.selfEvolution, 'knowledge') : null,
          ].filter(Boolean)
          for (const root of roots) {
            if (!existsSync(root)) continue
            const found = kcfg.patterns
              .filter((f) => existsSync(join(root, f)))
              .map((f) => join(root, f))
            if (found.length) { knowledgeFiles = found; break }
          }
          if (kcfg.knownIssues) {
            for (const root of roots) {
              const kp = join(root, kcfg.knownIssues)
              if (existsSync(kp) && !knowledgeFiles.includes(kp)) { knowledgeFiles.push(kp); break }
            }
          }
        }
      }
      // 技能正文：S1 的 preflight 已读 content，且 S1 返回的 data:{skill:pf.skill} 会被
      // 主循环自动合并进 ctx.state（见 runPipeline 的 ctx.state = {...ctx.state, ...res.data}），
      // 所以这里优先复用 ctx.state.skill，避免重复读盘；从 S4 起跑（跳过 S1）时回落 findSkillFor。
      // P0（task_mwr5s4v72yf766）：此前 skill 只存进 state 从未进 brief，批准技能对 AI 零影响。
      const skillRes = ctx.state.skill || (await Reg.findSkillFor(ctx.scenarioId))
      if (skillRes && skillRes.found && skillRes.content) {
        ctx.state.skillText = skillRes.content
        ctx.state.skillPath = skillRes.path
      }
      ctx.state.constraintsText = lines.join('\n')
      ctx.state.knowledgeFiles = knowledgeFiles
      return {
        ok: true,
        detail: knowledgeFiles.length
          ? `${lines.length} 条硬约束 + ${knowledgeFiles.length} 份领域知识（${knowledgeFiles.map((f) => f.split(/[\\/]/).pop()).join('、')}）${ctx.state.skillText ? ' + 技能正文' : ''}`
          : `${lines.length} 条硬约束 + 0 份领域知识（探测与旧 knowledge 配置都没找到，检查项目根下是否有 ai_self_evolution/knowledge、.ai/knowledge、knowledge、docs/patterns）${ctx.state.skillText ? ' + 技能正文' : ''}`,
        data: { constraintsText: ctx.state.constraintsText, knowledgeFiles, knowledgeDirs,
          skillText: ctx.state.skillText || null, skillPath: ctx.state.skillPath || null },
      }
    },
  },
  {
    id: 'S5',
    title: '派首轮任务',
    gate: 'halt',
    hint: '按场景类型给默认首轮任务',
    async run(ctx) {
      const sc = ctx.scenario
      const firstTask = firstTaskFor(sc)
      ctx.state.firstTask = firstTask
      if (!firstTask) {
        return { ok: false, detail: `场景类型 ${sc.kind} 没有默认首轮任务`, fix: '手写一个任务派给 maker' }
      }
      // 修复：任务必须指定 assignee。不带 assignee 的任务会被调度器随机
      // 派给 idle 成员（实测派给了 architect，它报 blocked —— 干活的活不归它）。
      // 解析不到目标成员宁可停下，也不建无主任务。
      const wantName = firstTask.assignee
      if (!wantName) {
        return { ok: false, detail: `场景类型 ${sc.kind} 的首轮任务未定义 assignee`, fix: 'firstTaskFor 返回值加 assignee 字段' }
      }
      const mRes = await jget(`${SIDECAR}/api/teams/${ctx.state.teamId}/members`)
      const members = mRes.ok ? (mRes.data.items || []) : []
      const target = members.find((m) => (m.name === wantName || m.id === wantName) && m.status !== 'retired')
      if (!target) {
        return {
          ok: false,
          detail: `任务要求派给 ${wantName}，但团队里找不到该成员（现有：${members.map((m) => m.name).join('、') || '无'}）`,
          fix: `先招募 ${wantName}，或改 firstTaskFor 的 assignee`,
        }
      }
      // 修复：建任务前先去重——同 team 同 subject 且状态仍是
      // pending/ready/running 的任务直接复用，不再新建（实测流水线重跑
      // 会连续建出多条同题任务，成员被同题轰炸）。
      const dupRes = await jget(`${SIDECAR}/api/tasks?team=${ctx.state.teamId}&limit=100`)
      const liveStates = new Set(['pending', 'ready', 'running'])
      const existing = dupRes.ok
        ? ((dupRes.data.items || dupRes.data || []).find(
            (t) => String(t.subject) === firstTask.subject && liveStates.has(String(t.status))))
        : null
      if (existing) {
        ctx.state.firstTaskId = existing.id
        return {
          ok: true,
          detail: `复用已有任务 ${existing.id}（${existing.status}，assignee=${existing.assignee || '未定'}）——同主题任务仍在进行，不新建`,
          data: { taskId: existing.id, assignee: existing.assignee || null, subject: firstTask.subject, reused: true },
        }
      }
      const r = await jpost(`${SIDECAR}/api/tasks`, {
        teamId: ctx.state.teamId,
        subject: firstTask.subject,
        assignee: target.id,
        plan: firstTask.plan,
        acceptance: firstTask.acceptance,
        dispatch: false,
      })
      if (!r.ok) return { ok: false, detail: '建任务失败', fix: r.error }
      const task = r.data.task || r.data
      ctx.state.firstTaskId = task.id
      return {
        ok: true,
        detail: `任务 ${task.id} 已建，指派 ${wantName}（${target.id}；未派发，等 S6 唤醒）`,
        data: { taskId: task.id, assignee: target.id, subject: firstTask.subject },
      }
    },
  },
  {
    id: 'S6',
    title: '唤醒并派发',
    gate: 'halt',
    hint: 'dispatch 认领任务后，把 brief 真投进成员会话；投不进去就是失败，不许假通过',
    async run(ctx) {
      const teamId = ctx.state.teamId
      if (!teamId) return { ok: false, detail: '没有 teamId（S2 未建队）', fix: '从 S2 重跑' }

      // 修复：任务刚建好时还落在 sidecar 的 settleMs 建图窗口内，
      // 不在 ready 集合里，dispatch 会返回 dispatched:false + no_ready_task + running=0。
      // 这是时序问题，不是真失败——稍后重试即可命中，别立即报假失败。
      // 注：sidecar dispatch 响应实测字段为 dispatched/reason/running/hint，无 settled 字段；
      // running===0 即「任务仍在 settle 窗口、尚未进入 ready」的正确判据。
      const MAX_RETRIES = 3
      const RETRY_DELAY_MS = 250 // 大于 sidecar settleMs=200，重试一次即出窗口
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      const doDispatch = async () => jpost(`${SIDECAR}/api/agents/dispatch`, { teamId })

      let r = await doDispatch()
      if (!r.ok) {
        return {
          ok: false,
          detail: `派发请求失败：${r.error || `HTTP ${r.status}`}`,
          fix: `sidecar 不可达（${SIDECAR}）；确认 dsh-team 服务在跑，或从 S6 重试`,
          data: { taskId: ctx.state.firstTaskId || null, dispatch: null },
        }
      }

      let d = r.data || {}
      let running = Number(d.running || 0)
      let retries = 0

      while (!d.dispatched && d.reason === 'no_ready_task' && running === 0 && retries < MAX_RETRIES) {
        retries++
        await sleep(RETRY_DELAY_MS)
        r = await doDispatch()
        if (!r.ok) {
          return {
            ok: false,
            detail: `派发请求失败（第 ${retries} 次重试时）：${r.error || `HTTP ${r.status}`}`,
            fix: `sidecar 不可达（${SIDECAR}）；确认 dsh-team 服务在跑，或从 S6 重试`,
            data: { taskId: ctx.state.firstTaskId || null, dispatch: null, retries },
          }
        }
        d = r.data || {}
        running = Number(d.running || 0)
      }

      // ── 关键改动（99 规格修复 B）：dispatch 只代表「调度器认领了任务」，
      // 不代表「任务真进了成员会话」。这里把 brief 投进去，投递结果决定真假。
      if (d.dispatched) {
        const retryNote = retries > 0 ? `——重试 ${retries} 次后成功` : ''
        const delivered = await deliverBrief(ctx, teamId, d.task, d.member)
        const head = `已派发：调度器认领 ${d.task && d.task.id ? d.task.id : '任务'}`
          + `（成员 ${d.member && d.member.name ? d.member.name : '?'}，running=${running}）${retryNote}`
        if (!delivered.ok) {
          // 投递失败必须 ok:false——否则就是「什么都没送进去还报通过」
          return {
            ok: false,
            detail: `${head}；但任务 brief 没投进成员会话：${delivered.detail}`,
            fix: delivered.fix,
            data: {
              taskId: ctx.state.firstTaskId || null,
              dispatch: d,
              retries,
              delivery: delivered.report,
            },
          }
        }
        return {
          ok: true,
          detail: `${head}；任务 brief 已投进成员会话（${delivered.report.via}）`,
          data: {
            taskId: ctx.state.firstTaskId || null,
            dispatch: d,
            retries,
            delivery: delivered.report,
          },
        }
      }
      // no_ready_task 但有任务在跑：判断本轮任务是不是真在里面。
      // 不能只看「有东西在跑」就算过——别的任务在跑、本轮任务却没进 running，
      // 正是「看着在跑、其实本轮的活没人接」的假通过来源（）。
      if (d.reason === 'no_ready_task' && running > 0) {
        const mine = await inspectRoundTask(ctx, teamId)
        const liveStates = new Set(['running', 'ready', 'pending', 'done'])
        if (mine.found && !liveStates.has(String(mine.status))) {
          return {
            ok: false,
            detail: `running=${running} 但本轮任务 ${mine.taskId || '?'} 状态是 ${mine.status}，没被真正执行`,
            fix: mine.fix || '本轮任务不在运行集合里：确认派发目标成员有可用会话后重跑 S6',
            data: { taskId: ctx.state.firstTaskId || null, dispatch: d, roundTask: mine },
          }
        }
        return {
          ok: true,
          detail: `无 ready 任务但 running=${running}`
            + (mine.found ? `（本轮任务 ${mine.taskId} 在 ${mine.status}，已被接走）` : `（本轮未指定任务，团队里 ${running} 条任务在跑）`),
          data: { taskId: ctx.state.firstTaskId || null, dispatch: d, roundTask: mine },
        }
      }
      // 其余 dispatched:false：按 reason 给不同的可执行下一步，不合并成一句「派发未生效」。
      return {
        ok: false,
        detail: `派发未生效：${d.reason || '未派发'}（running=${running}${retries ? `，已重试 ${retries} 次` : ''}）`,
        fix: dispatchFixFor(d.reason, teamId, ctx),
        data: { taskId: ctx.state.firstTaskId || null, dispatch: d, retries },
      }
    },
  },
  {
    /* ── S6b 首件检查门（先进编排迭代 3）───────────────────────────
     * 对齐 Anthropic prompt chaining 的 gate：maker 做完首份产物后暂停，
     * 把「首件产物 + 首件自检表」交 auditor 快速核对方向——不到整轮审计深度，
     * 方向错立即打回，只损失一步而非一轮。
     * 判据全部可判定：handbook 里有 97-首件核对-*.md；结论二选一（方向正确/打回）。
     * 没记录 → ok:false 如实停：「没人守的门」和「没有门」是同一个失败。
     * 产物数 <2 的单产物任务不设门（没有「第一件」可停）：直过并说明。 */
    id: 'S6b',
    title: '首件检查门',
    gate: 'first',
    hint: 'maker 首份产物交 auditor 快速核对方向；方向错打回，只损失一步而非一轮',
    async run(ctx) {
      const sc = ctx.scenario
      const artifactCount = countRoundArtifacts(ctx)
      if (artifactCount !== null && artifactCount < 2) {
        return {
          ok: true,
          detail: `本轮预计产物 ${artifactCount} 件（<2），不设首件门——单产物任务没有「第一件」可停，整轮审计在 S7 兜底`,
          data: { gateSkipped: true, reason: 'single-artifact', artifactCount },
        }
      }
      const dir = sc.handbookDir
      if (!existsSync(dir)) {
        return { ok: false, blocking: true, detail: 'handbook 目录不存在，首件检查无处留痕', fix: '先建 handbook（op=handbook-skeleton）再从 S6b 重跑' }
      }
      const { readdir } = await import('node:fs/promises')
      const files = (await readdir(dir)).filter((f) => /^97-首件核对.*\.md$/.test(f)).sort()
      if (!files.length) {
        return {
          ok: false,
          blocking: true,
          detail: '还没有首件核对记录：maker 产出首份产物后应暂停并交 auditor 做方向核对（写入 97-首件核对-*.md）',
          fix: '派 auditor 做首件核对（3 条以内快速核对项，不要求整轮审计深度），或确认本轮为单产物任务',
          data: { expected: '97-首件核对-*.md' },
        }
      }
      const latest = files[files.length - 1]
      const txt = await readFile(join(dir, latest), 'utf8')
      const rejected = /打回|方向错|不通过/.test(txt)
      const approved = /方向正确|通过/.test(txt)
      ctx.state.firstPieceGate = { file: latest, rejected }
      if (rejected) {
        return {
          ok: false,
          detail: `首件门打回（${latest}）：方向错误在第一个产物处被拦截，未流入后续步骤`,
          fix: '按 97-首件核对 里的整改建议改任务简报或方法，再从 S6 重跑——不要带着方向错继续',
          data: { file: latest, verdict: 'rejected' },
        }
      }
      if (!approved) {
        return {
          ok: false,
          blocking: true,
          detail: `首件核对记录 ${latest} 存在但没有可判定的结论（既无「方向正确」也无「打回」）`,
          fix: '让 auditor 在 97-首件核对 里写明结论：方向正确 / 打回，二选一',
          data: { file: latest, verdict: 'undetermined' },
        }
      }
      return {
        ok: true,
        detail: `${latest} → 方向正确（首件已核对，继续整轮）`,
        data: { file: latest, verdict: 'approved' },
      }
    },
  },
  {
    /* S7 分段审计（先进编排迭代 3 第 2 条）：产物>=3 时每完成一个即可增量审。
     * 分段以 96-分段审计-*.md 计数，只盘点「已有几段、结论各是什么」；
     * 分段不阻塞整轮——整轮三态结论仍是本步判据。 */
    id: 'S7',
    title: '等审计',
    gate: 'human',
    hint: '读最新审计报告，不自己判断对错；产物>=3 时支持分段增量审计（96-分段审计-*）',
    async run(ctx) {
      const sc = ctx.scenario
      const dir = sc.handbookDir
      if (!existsSync(dir)) return { ok: false, detail: 'handbook 目录不存在', fix: '先建 handbook' }
      const { readdir } = await import('node:fs/promises')
      // 分段审计：每多一份 96-分段审计-*.md 就算多一段已增量审过
      const segFiles = (await readdir(dir)).filter((f) => /^96-分段审计.*\.md$/.test(f)).sort()
      const segments = []
      for (const sf of segFiles.slice(-8)) {
        const segTxt = await readFile(join(dir, sf), 'utf8')
        const segVerdict = /不通过/.test(segTxt) ? '不通过' : /通过/.test(segTxt) ? '通过' : '未判定'
        segments.push({ file: sf, verdict: segVerdict })
      }
      const files = (await readdir(dir)).filter((f) => /^98-审计报告.*\.md$/.test(f)).sort()
      if (!files.length) {
        return {
          ok: false,
          blocking: true,
          detail: `还没有审计报告${segments.length ? `（已有 ${segments.length} 段分段审计：${segments.map((x) => `${x.file}→${x.verdict}`).join('、')}）` : ''}`,
          fix: '派 auditor 出一份',
          data: { segments },
        }
      }
      const latest = files[files.length - 1]
      const txt = await readFile(join(dir, latest), 'utf8')
      const verdict = /不通过/.test(txt) ? '不通过' : /有条件通过/.test(txt) ? '有条件通过' : /通过/.test(txt) ? '通过' : '未判定'
      ctx.state.audit = { file: latest, verdict }
      const segNote = segments.length
        ? `；分段审计 ${segments.length} 段（${segments.map((x) => x.verdict).join('、')}${segments.some((x) => x.verdict === '不通过') ? '——有分段被打回，整轮结论大概率不通过' : ''}）`
        : ''
      return {
        ok: true,
        detail: `${latest} → ${verdict}${segNote}`,
        data: { file: latest, verdict, segments },
      }
    },
  },
  {
    id: 'S8',
    title: '收口',
    gate: 'continue',
    hint: '写 handoff + 记一轮 + 成本记账（先进编排迭代 5）+ 检查是否该蒸馏',
    async run(ctx) {
      const r = await Reg.recordRound(ctx.scenarioId, `${ctx.state.firstTask?.subject || '一轮'} → ${ctx.state.audit?.verdict || '未审'}`)
      /* 成本记账（先进编排迭代 5 第 2 条）：每轮收口组装一行——
       * 任务数 / 成员数 / 模型路由 / 估算 token / 是否值得。全从 ctx.state 真实取数，
       * 取不到记 null，不填 0 糊（与 sessionUsage「不填 0」同一纪律）。 */
      const cost = buildCostLedgerLine(ctx)
      if (cost) ctx.state.costLedgerLine = cost
      // 收口推进。完整一轮的终态是 done，状态机合法路径 opening → running → closing → done。
      // 之前这里直接 setState('done')，在 opening/running 态下是非法转换被静默吞掉，
      // 且 runPipeline 末尾又推进 running 覆盖语义，导致完整跑完 state 停在 running 而非 done。
      let doneRes = { ok: false, errors: ['未推进收口'] }
      try {
        let cur = await Reg.getScenario(ctx.scenarioId)
        let guard = 0
        while (cur && cur.state !== 'done' && guard < 5) {
          guard++
          const from = cur.state
          if (from === 'opening') {
            const sr = await Reg.setState(ctx.scenarioId, 'running')
            if (!sr.ok) { doneRes = sr; break }
            cur = sr.scenario
          } else if (from === 'running') {
            const sr = await Reg.setState(ctx.scenarioId, 'closing')
            if (!sr.ok) { doneRes = sr; break }
            cur = sr.scenario
          } else if (from === 'closing') {
            doneRes = await Reg.setState(ctx.scenarioId, 'done')
            cur = doneRes.ok ? doneRes.scenario : cur
            break
          } else {
            doneRes = { ok: false, errors: [`当前 state=${from} 无法收口到 done`] }
            break
          }
        }
        if (cur && cur.state === 'done' && !doneRes.ok) doneRes = { ok: true, scenario: cur }
      } catch (e) {
        doneRes = { ok: false, errors: [String(e && e.message ? e.message : e)] }
      }
      const stateNote = doneRes.ok
        ? `state=done rounds=${doneRes.scenario.rounds}`
        : `收口状态未推进（${(doneRes.errors || []).join('；')}）`
      const costNote = cost ? `；成本记账已备（${cost.taskCount} 任务 / ${cost.memberCount} 成员）` : ''
      return {
        ok: true,
        detail: `${r.hint}；${stateNote}${costNote}`,
        data: { rounds: r.rounds, distillDue: r.distillDue, state: doneRes.ok ? 'done' : null, stateNote, costLedgerLine: cost },
      }
    },
  },
]

/**
 * 估本轮产物数（S6b 首件门用）。判据：任务 plan 里 action=write 的步骤数；
 * 没有任务就回 null（不知道，不猜）。
 */
function countRoundArtifacts(ctx) {
  const ft = ctx.state && ctx.state.firstTask
  if (!ft || !Array.isArray(ft.plan)) return null
  const writes = ft.plan.filter((p) => p && (p.action === 'write' || p.action === 'exec')).length
  return writes > 0 ? writes : null
}

/**
 * 成本记账行（先进编排迭代 5 第 2 条）。
 * 格式（方案原文）：任务数 / 成员数 / 模型路由 / 估算 token / 是否值得。
 * 全部从 ctx.state 真实取数；取不到的项记 unknown——记账行的价值在长期数据，
 * 一轮填不齐不能编数（编了就毁了整个账本）。
 */
function buildCostLedgerLine(ctx) {
  const st = ctx.state || {}
  const teamId = st.teamId || null
  const members = Array.isArray(st.members) ? st.members : []
  const routes = st.memberRoutes && typeof st.memberRoutes === 'object' ? st.memberRoutes : {}
  const routeNote = Object.keys(routes).length
    ? Object.entries(routes).map(([dom, r]) => `${dom}=${r.provider}/${r.model}`).join('、')
    : 'unknown'
  // 估算 token：优先把成员会话的 usage 汇总交给 op 层（有 sessionUsage 三路取数）；
  // 流水线内部没有日志访问能力，这里只记「有无」，数值由 op=run 收口时补。
  return {
    at: new Date().toISOString(),
    scenarioId: ctx.scenarioId,
    teamId,
    taskCount: st.firstTaskId ? 1 : (st.firstTask ? 1 : 0),
    memberCount: members.length,
    memberNames: members.map((m) => m.name),
    modelRoutes: routeNote,
    estimatedTokens: null, // op 层（index.js）收口时经 sessionUsage 补数值；流水线层不猜
    worthIt: null, // 方案口径：由用户/审计对照路由档位回看后填，不自动判
    level: st.routeLevel || null,
  }
}

/**
 * 查本轮任务（S5 建的那条）现在到底是什么状态（）。
 *
 * 为什么必须单独查：S6 在 `no_ready_task + running>0` 时曾无条件报通过，
 * 但「running>0」说的是**整个团队**有任务在跑，可能一条都不是本轮的。
 * 本轮任务的真实状态只能回 sidecar 逐条对，不能靠计数推断。
 *
 * @returns {{found:boolean, taskId:string|null, status:string|null, assignee:string|null, fix:string|null}}
 */
async function inspectRoundTask(ctx, teamId) {
  const taskId = ctx.state.firstTaskId || null
  if (!taskId) return { found: false, taskId: null, status: null, assignee: null, fix: null }
  const r = await jget(`${SIDECAR}/api/tasks?team=${teamId}&limit=200`)
  if (!r.ok) {
    return { found: false, taskId, status: null, assignee: null, fix: `读不到任务列表（${r.error}），无法确认本轮任务是否被接走` }
  }
  const rows = r.data && (r.data.items || r.data) || []
  const hit = (Array.isArray(rows) ? rows : []).find((t) => t && t.id === taskId)
  if (!hit) {
    return {
      found: false,
      taskId,
      status: null,
      assignee: null,
      fix: `本轮任务 ${taskId} 在 sidecar 里查不到（可能已被删除或从未建成）`,
    }
  }
  const status = String(hit.status || '')
  const assignee = hit.assignee || null
  let fix = null
  if (status === 'failed' || status === 'blocked' || status === 'aborted') {
    const blockers = Array.isArray(hit.blockers) ? hit.blockers : []
    const lineage = blockers.some((b) => LINEAGE_ERROR_RE.test(typeof b === 'string' ? b : JSON.stringify(b || '')))
    fix = lineage
      ? `本轮任务派发卡在 ${assignee}：其会话绑在旧父会话上（belongs to another parent session），`
        + 'retire 该成员后由当前 Lead 重新 dsh_team_spawn，再重跑 S6'
      : `本轮任务 ${taskId} 状态 ${status}：看 op=snapshot 的 teamHealth 与 DAG，必要时 task-abort 后重派`
  }
  return { found: true, taskId, status, assignee, fix }
}

/**
 * 按 dispatch 的拒绝原因给可执行的下一步（）。
 * 关键：`no_idle_agent` 与 `belongs to another parent session` 是两种完全不同的病，
 * 混成一句「等成员回 idle」会让用户一直等一个永远不会来的 idle。
 */
function dispatchFixFor(reason, teamId, ctx) {
  const stale = (ctx.state.memberHealth || []).filter((x) => x.state === 'stale-lineage')
  const unbound = (ctx.state.memberHealth || []).filter((x) => x.state === 'unbound')
  if (reason === 'no_idle_agent') {
    if (stale.length) {
      return `${stale.map((x) => x.name).join('、')} 的会话绑在旧父会话上（belongs to another parent session），`
        + `调度器因此认为没有可用成员：retire 这些人后由当前 Lead 重新 dsh_team_spawn（成员 id：`
        + `${stale.map((x) => x.id || x.name).join('、')}），再重跑 S6`
    }
    if (unbound.length) {
      return `${unbound.map((x) => x.name).join('、')} 还没有宿主会话（agentSessionId 为空）：`
        + '让 Lead 用 dsh_team_spawn 拉起它们，再重跑 S6'
    }
    return `没有空闲成员可派：先看 op=snapshot 的 teamHealth（团队会话健康）确认成员状态；`
      + `都 idle 但仍派不动，多半是成员会话归属失效，retire 后重新 spawn`
  }
  if (reason === 'concurrency') return '并发上限卡住：等 running 任务回 idle 后重试，或调大团队 maxConcurrency'
  if (reason === 'no_lead_agent') {
    return 'sidecar 侧没有 Lead 句柄：先由 Lead 会话调一次任意 dsh_team_* 工具（如 dsh_team_status）建立绑定，再重跑 S6'
  }
  if (reason === 'busy') return '调度器正在为这个团队派发中：稍等后重跑 S6，不要并发触发'
  return `任务 ${ctx.state.firstTaskId || '?'} 未被派发也无人运行（reason=${reason || 'unknown'}）；`
    + '查 op=snapshot 的 teamHealth 与 DAG 任务状态，确认成员有会话、任务在 ready 集合里'
}

/**
 * 把任务 brief 真投进成员会话（99 规格修复 B 的投递半边）。
 *
 * 为什么必须做这一步：sidecar 的 `POST /api/agents/dispatch` 只负责「认领任务 +
 * 标记 running」，它不写成员会话的 inbox。真正的投递在宿主侧
 * （`subagents.sendMessage(leadAgent, member.agentSessionId, brief)`，见
 * dsh-team-control 的 deliverTask）。面板若只调 dispatch，任务就会停在
 * 「running 但没人收到活」——正是用户报的「看着在跑，其实单会话」。
 *
 * 边界（诚实说明）：
 * - 投递需要 sender 是**精确的 live Lead agent**（宿主 authorizeLineage 校验），
 * 面板拿不到那个句柄时无法代为投递，只能如实报「面板不能投，需 Lead 投」。
 * - 成员会话绑在旧父会话上时宿主报 belongs to another parent session，
 * 插件侧不能重建宿主会话，只能标记 + 给下一步。
 *
 * @returns {{ok:boolean, detail:string, fix:string|null, report:object}}
 */
async function deliverBrief(ctx, teamId, task, member) {
  const report = {
    taskId: task && task.id ? task.id : null,
    memberId: member && member.id ? member.id : null,
    memberName: member && member.name ? member.name : null,
    sessionId: member && member.agentSessionId ? String(member.agentSessionId) : null,
    via: null,
    messageId: null,
  }
  if (!member) {
    return { ok: false, detail: 'dispatch 返回里没有 member（调度器认领了任务但没给成员）', fix: '检查 sidecar 派发结果，或从 S5 重跑建任务', report }
  }
  if (!member.agentSessionId) {
    const h = memberSessionHealth(member)
    return {
      ok: false,
      detail: `成员 ${member.name} 没有宿主会话（agentSessionId 为空），任务无处可投`,
      fix: h.advice || `让 Lead 用 dsh_team_spawn 拉起 ${member.name}，再重跑 S6`,
      report: { ...report, sessionState: h.state },
    }
  }

  // P0：把 S4 落进 state 的三段（硬约束/领域知识文件/技能正文）真正传给 brief
  const brief = buildTaskBrief(teamId, task, member, {
    constraintsText: ctx.state.constraintsText,
    knowledgeFiles: ctx.state.knowledgeFiles,
    skillText: ctx.state.skillText,
  })
  const sessionId = String(member.agentSessionId)

  // ① 先把 brief 记进 sidecar 消息通道：面板「任务 / 消息」页才有提问→回复可配对。
  // 记录失败不影响投递本身（与宿主 deliverTask 的处理一致）。
  try {
    const rec = await jpost(`${SIDECAR}/api/messages`, {
      teamId,
      from: 'lead',
      to: member.id,
      kind: 'note',
      payload: { text: brief, taskId: task && task.id ? task.id : null },
    })
    if (rec.ok && rec.data) report.messageId = (rec.data.message && rec.data.message.id) || rec.data.id || null
  } catch { report.messageId = null }

  // ② 真投递：需要精确的 live Lead agent 句柄。
  const subs = safeGetService(ctx.hostCtx, 'subagents')
  const agents = safeGetService(ctx.hostCtx, 'agents') || safeGetService(ctx.hostCtx, 'agentRegistry')
  const lead = pickLeadAgent(agents)
  if (!subs || typeof subs.sendMessage !== 'function') {
    return {
      ok: false,
      detail: '宿主没有暴露 subagents.sendMessage，面板无法把 brief 投进成员会话',
      fix: '宿主未启用 dsh-subagent 或其 sendMessage 不可用：请在 Lead 会话里用 dsh_team_send 或 dsh_team_task 派发',
      report: { ...report, via: 'unavailable', brief },
    }
  }
  if (!lead) {
    // 兜底（）：投不进去不假装投进去了，但把「下一步那条命令」生成出来。
    // ok 必须保持 false —— 生成指令 ≠ 投递成功（判据 3）。
    const { command: dispatchCommand, payload: dispatchPayload } = buildDispatchCommand(teamId, task, member)
    return {
      ok: false,
      detail: '拿不到当前活着的 Lead agent 句柄（宿主要求 sender 是精确的 live agent），brief 没投进成员会话',
      fix: '把 report.dispatchCommand 整段粘进 Lead 会话回车即可：它等价于在 Lead 会话里手动派发本任务（面板代投做不到，指令照做就行）',
      report: { ...report, via: 'no-lead-agent', brief, dispatchCommand, dispatchPayload },
    }
  }
  try {
    const messageId = await subs.sendMessage(
      lead,
      sessionId,
      [{ type: 'text', text: brief }],
      { signal: AbortSignal.timeout(30000) },
    )
    report.via = 'subagents.sendMessage'
    report.inboxId = messageId != null ? String(messageId) : null
    // brief 一并带回：投递成功了也要能核「到底送进去了什么」，不留黑盒
    report.brief = brief
    return { ok: true, detail: `已投递（inbox ${report.inboxId || 'accepted'}）`, fix: null, report }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err)
    if (LINEAGE_ERROR_RE.test(msg)) {
      const detail = `成员 ${member.name} 的会话绑在旧父会话上：${msg}`
      // 兜底（/§5）：两步指令——先重建会话对齐 lineage，再派发。
      // 同样 ok:false：两条命令都还只是「待人手粘」，没一个字进过任何会话。
      const { command: dispatchCommand, payload: dispatchPayload } = buildDispatchCommand(teamId, task, member)
      const { command: rebuildCommand, payload: rebuildPayload } = buildRebuildCommand(teamId, member)
      const advice = `先粘 report.rebuildCommand 重建 ${member.name} 的会话（对齐当前 Lead），`
        + '再粘 report.dispatchCommand 派发；两步都在 Lead 会话里回车执行。'
        + `（成员 id=${member.id}，重建后仍用同一 id，assignee 不必改）`
      // 标记进状态，让 S3/面板后续也看得见，不是一次性的提示
      if (Array.isArray(ctx.state.memberHealth)) {
        const hit = ctx.state.memberHealth.find((x) => x.name === member.name)
        if (hit) { hit.state = 'stale-lineage'; hit.lineageHit = msg }
      }
      return {
        ok: false,
        detail,
        fix: advice,
        report: {
          ...report,
          via: 'sendMessage',
          error: msg,
          sessionState: 'stale-lineage',
          brief,
          dispatchCommand,
          dispatchPayload,
          rebuildRequired: true,
          rebuildCommand,
          rebuildPayload,
        },
      }
    }
    return {
      ok: false,
      detail: `投递失败：${msg}`,
      fix: '确认成员会话仍然存活（op=snapshot 看 teamHealth）；必要时 retire 后重新 spawn',
      report: { ...report, via: 'sendMessage', error: msg, brief },
    }
  }
}

/** 安全取 Cordis 服务：未 inject 时点属性会抛，不能让它冒泡成 500 */
function safeGetService(c, name) {
  try {
    if (!c) return undefined
    if (typeof c.get === 'function') return c.get(name)
    return c[name]
  } catch {
    return undefined
  }
}

/** 从 agents 注册表挑一个「不是子会话本体」的活 agent 当 Lead sender */
function pickLeadAgent(agents) {
  if (!agents || typeof agents.list !== 'function') return undefined
  try {
    // 直接用传进来的注册表（调用方已从 host 取好），不再依赖外层 ctx
    const list = agents.list() || []
    if (!Array.isArray(list)) return undefined
    for (const a of list) {
      const hdr = a && a.session && a.session.header
      if (!hdr) continue
      if (hdr.origin !== 'subagent') return a
    }
    // 退一步：没有 header 信息的，用第一个带 followup 的
    return list.find((a) => a && typeof a.followup === 'function')
  } catch {
    return undefined
  }
}

/**
 * 兜底指令：把「这条 dsh_team_task 调用」拼成人能直接粘进 Lead 会话的字符串
 * （）。为什么只能是字符串：投递的唯一合法路径是宿主
 * `subagents.sendMessage(lead, …)`，它要求 sender 是精确的 live Lead agent。
 * 面板 HTTP 桥拿不到那个句柄时，插件侧没有任何字节级手段代投——伪造
 * parentSession 要改宿主 dsh-subagent，那是  那类需批准的改动。
 * 所以兜底形态固定为「产出可粘贴指令」，由用户在真正的 Lead 会话里执行。
 *
 * 取值纪律（ 表）：
 * - teamId 取入参；
 * - assignee 必须是 **member.id**，不是 name（dsh_team_task 的 assignee 只收 id）；
 * - plan 元素缺 step 时补 S{i+1}（宿主 PLAN_STEP 要求 step 必填）；
 * - acceptance 非空才拼，空则整键省略；
 * - 一律 JSON.stringify 转义——subject/acceptance 里出现引号、反斜杠
 * （如 ``）不会破坏调用结构。
 *
 * @returns {{command:string, payload:object}} command 与 payload 同源生成，不各取一次
 */
function buildDispatchCommand(teamId, task, member) {
  const plan = (Array.isArray(task && task.plan) ? task.plan : []).map((p, i) => (
    p && typeof p === 'object' && p.step ? p : { step: `S${i + 1}`, ...(p && typeof p === 'object' ? p : {}) }
  ))
  const payload = {
    tool: 'dsh_team_task',
    teamId: String(teamId == null ? '' : teamId),
    subject: task && task.subject ? String(task.subject) : '',
    assignee: member && member.id ? String(member.id) : '',
    plan,
    acceptance: task && task.acceptance ? String(task.acceptance) : null,
  }
  const parts = [`dsh_team_task({ teamId: ${JSON.stringify(payload.teamId)}`]
  parts.push(`, subject: ${JSON.stringify(payload.subject)}`)
  parts.push(`, assignee: ${JSON.stringify(payload.assignee)}`)
  parts.push(`, plan: ${JSON.stringify(payload.plan)}`)
  if (payload.acceptance) parts.push(`, acceptance: ${JSON.stringify(payload.acceptance)}`)
  parts.push(' })')
  return { command: parts.join(''), payload }
}

/**
 * 重建成员会话的指令（，v2 订正版）。
 *
 * 为什么是 `update` 而不是 `retire + spawn`：两条路都会换 agentSessionId
 * （都走 startActivation，lineage 重新对齐当前 Lead），实测 retire 后重新 spawn
 * 的成员 id 与 createdAt 都没变（ 实测表）。所以「保 id」不是选
 * update 的理由，真正的理由是 **少一步**：不必先退再建。
 * 只有当用户还要改 spawn 专属字段（name/prompt/description）时才该走 retire+spawn。
 *
 * `contextMode` 必须显式传：dsh-team-control 的 restart 判据是
 * `['model','agentProvider','contextMode','agentPreset','reasoningEffort'].some(has)`，
 * 只要显式出现该键（即使值就是 'fresh'）就走 rebuild 路径。
 */
function buildRebuildCommand(teamId, member) {
  const payload = {
    tool: 'dsh_team_member',
    teamId: String(teamId == null ? '' : teamId),
    action: 'update',
    memberId: member && member.id ? String(member.id) : '',
    contextMode: 'fresh',
  }
  const command = `dsh_team_member({ teamId: ${JSON.stringify(payload.teamId)}, action: "update", `
    + `memberId: ${JSON.stringify(payload.memberId)}, contextMode: "fresh" })`
  return { command, payload }
}

/**
 * 任务 brief：成员要能只看这条消息就把活干完并回执。
 * 字段口径对齐宿主 dsh-team-control 的 taskBrief（teamId/memberId/taskId + 回执要求）。
 *
 * 先进编排落地（迭代 2/3/5）：
 * - 回执四要素（迭代 5）：summary 不再是「一句话」，固定为
 * 产物路径 / 内容摘要（≤80字/件）/ 可信度 / 下游须知，禁止贴产物正文。
 * - 首件停顿（迭代 3）：预计产物 ≥2 时，要求 maker 做完第一份产物先暂停
 * 交 auditor 核对方向（对应 S6b 首件门）。
 * - 结构化工件（迭代 2）：按 artifacts.mjs 的 delivery schema 落盘交付报告。
 */
function buildTaskBrief(teamId, task, member, opts = {}) {
  const plan = ((task && task.plan) || []).map((p, i) => {
    const detail = p.detail || p.action || p.phase || p.target || 'do'
    return `${i + 1}. [${p.step || `S${i + 1}`}] ${detail}`
  })
  const acceptance = task && task.acceptance ? `验收标准：${task.acceptance}` : null
  const writeSteps = ((task && task.plan) || []).filter((p) => p && (p.action === 'write' || p.action === 'exec')).length
  const firstPiece = writeSteps >= 2
    ? [
      '',
      '首件停顿（检查门）：预计本轮产物 ≥2 件。完成**第一份产物后必须先暂停**，'
      + '把「首件产物路径 + 3 条以内自检结果」发给 auditor 做方向核对；'
      + 'auditor 在 handbook 目录写 97-首件核对-<轮次>.md（结论二选一：方向正确 / 打回），'
      + '方向正确才继续做后面的产物——方向错只损失一步，不损失一轮。',
    ]
    : null
  return [
    '【dsh-team 任务派发】',
    `teamId=${teamId}`,
    `memberId=${member.id}`,
    `memberName=${member.name}`,
    `taskId=${task ? task.id : ''}`,
    `subject：${task ? task.subject : ''}`,
    ...(plan.length ? ['计划步骤：', ...plan] : []),
    ...(acceptance ? [acceptance] : []),
    ...(firstPiece || []),
    // P0（task_mwr5s4v72yf766）：把 S4 注入的硬约束/领域知识/技能正文真正带进 brief。
    // 技能正文完整注入不截断（给 AI 用），只标注总长便于排查 token 压力。
    ...(opts.constraintsText ? ['', '本场景硬约束（必须遵守）：', opts.constraintsText] : []),
    ...(opts.knowledgeFiles && opts.knowledgeFiles.length
      ? ['', '领域知识文件（动手前先读）：', ...opts.knowledgeFiles.map((f) => `- ${f}`)]
      : []),
    ...(opts.skillText
      ? ['', '【本项目历史经验·必读】',
         `以下是这个工作项前几轮踩过的坑，动手前先看一遍，不要重复（全文 ${opts.skillText.length} 字，已全部注入）：`,
         '', opts.skillText]
      : []),
    '',
    '执行要求：',
    '1) 直接在本会话里做这件事（用你自己的工具，不要委派给别的 agent）。',
    '2) 每开始或完成一步、以及验收通过后，调用 dsh_team_todo 更新该任务的计划清单。',
    `3) 完成后调用 dsh_team_report_task({ teamId: "${teamId}", taskId: "${task ? task.id : ''}", status: "done", summary: "..." })。`,
    '',
    'summary 必须是四要素结构（压缩回传，不许只写一句话、禁止贴产物正文）：',
    '- 产物路径：每件产物一行路径',
    '- 内容摘要：每件 ≤80 字，说清里面有什么',
    '- 可信度：自检哪些项过了、哪些没把握',
    '- 下游须知：用这个产物前必须知道的一件事',
    '- 踩坑（如有）：用「坑：<一句话>」单独起一个分句写，便于后续蒸馏精确抽取；没踩坑就不写这一行。',
    '- 可复用做法（**必填，不能跳过**）：这次干完这件事，如果别人遇到同类任务，照哪几步能做出来？',
    '  按下面的格式写（标题不带「完成/已修/搞定」，一步一个动作、每步≤40字、不要以版本号开头）：',
    '  做法：<这件事叫什么>',
    '  1) <第一步做什么>',
    '  2) <第二步做什么>',
    '  3) <第三步做什么>',
    '  如果这次确实没有任何可复用的（比如只改了一个字），写「做法：无」。',
    '  这一栏会被蒸馏成技能手册，下次开团自动带进上下文——写清楚，团队下次就少摸索一遍。',
    '',
    '交付报告（落盘版，含在 summary 之外）：按「交付报告」结构化工件 schema 写，'
    + '必填字段：产物路径列表 / 内容摘要 / 自检结论（对照验收标准逐条）/ 已知风险；'
    + '写入 handbook 目录的 99-交付报告-<轮次>.md。字段口径见 op=artifact-schema（id=delivery）。',
  ].join('\n')
}

/**
 * 按场景类型给默认首轮任务（低风险起步）
 *
 * 这里写的是**实测确认过的事实**，不是假设。
 * 某项目踩过的坑：主项目没有 .csproj（全项目非归档区 0 个），
 * 所以 auto_test.ps1 / quick_build.ps1 必然报 No .csproj file found。
 * 唯一编译入口是根目录 编译.ps1（Roslyn csc.dll 直编 源码\**\*.cs）。
 */
function firstTaskFor(sc) {
  if (sc.kind === 'software') {
    const repo = sc.workspace || '<workspace>'
    return {
      subject: '低风险体检：只出报告，不改码',
      assignee: 'maker',
      plan: [
        {
          step: 'S1',
          action: 'read',
          target: `读 ${sc.knowledge?.knowledgeDir || repo + '\\ai_self_evolution\\knowledge\\wiki'} 下的 known_issues.md 与 gdi_patterns.md，建立已知问题基线`,
        },
        {
          step: 'S2',
          action: 'exec',
          target: `对 ${repo} 的 源码\\ 做只读扫描，产出问题清单（文件 + 行号 + 类型）`,
        },
        {
          step: 'S3',
          action: 'write',
          target: '报告写到场景 handbook 目录的 97-体检报告.md',
        },
        {
          step: 'S4',
          action: 'verify',
          target: `跑 ${repo}\\编译.ps1 确认基线可编译（判据：[OK] Compile succeeded 与 EXIT: 0 同时出现；该脚本只取前 20 条 error，只看末行会漏）`,
        },
        {
          step: 'S5',
          action: 'verify',
          target: `git -C ${repo} status --porcelain 必须与本轮开轮基线逐行一致——本轮不许新增任何源码改动`,
        },
      ],
      acceptance: [
        '报告含文件/行号/类型三列',
        '与 known_issues 基线比对出新增/已修/误报',
        '编译.ps1 通过（[OK] Compile succeeded + EXIT: 0）',
        'git status 相对开轮基线零新增改动',
      ].join('；'),
    }
  }
  if (sc.kind === 'docs') {
    return {
      subject: '首章验证：按承诺书写一章',
      assignee: 'maker',
      plan: [
        { step: 'S1', action: 'read', target: '读场景 handbook 的协议与承诺书' },
        { step: 'S2', action: 'write', target: '按细纲写第一章' },
        { step: 'S3', action: 'verify', target: '机审通过 + 承诺兑现' },
      ],
      acceptance: '① 字数达标 ② 机审通过 ③ 无承诺违背',
    }
  }
  return null
}

/* ── 执行器 ─────────────────────────────────────────────────────── */

/**
 * 跑完整流水线。
 * @param {string} scenarioId
 * @param {{ from?: string, to?: string, dryRun?: boolean, hostCtx?: object,
 * routeAnswers?: object, skipFirstPieceGate?: boolean }} opts
 * hostCtx：宿主 Cordis context（index.js 透传），供 S2 自动开 Lead 会话用。
 * routeAnswers：开团前四问答案（先进编排迭代 4）。给了就走 complexity.routeLevel
 * 定档并把判定留痕进 trace（L0 会如实报「该单干」——面板据此提示不开团，
 * 不是本函数替用户拒跑）；L2 时建队参数放宽 maxMembers/maxConcurrency 支持扇出。
 * skipFirstPieceGate：true 时跳过 S6b（临时场景 ephemeral-run 默认跳）。
 */
export async function runPipeline(scenarioId, opts = {}) {
  const from = opts.from || 'S0'
  const to = opts.to || 'S8'
  const startedAt = new Date().toISOString()

  const ctx = {
    scenarioId,
    scenario: null,
    preflight: null,
    state: {},
    hostCtx: opts.hostCtx || null,
    // 选路开关透传（）：免费优先是默认，op=run 可显式关掉或换池
    freeDisabled: opts.freeDisabled === true,
    freePool: Array.isArray(opts.freePool) ? opts.freePool : undefined,
    // 倍率/provider 门槛配置（route-config.json 的内容，由 op 层读盘后注入）
    routeConfig: opts.routeConfig && typeof opts.routeConfig === 'object' ? opts.routeConfig : null,
    // 复杂度路由（迭代 4）：四问答案定档；L0/L2 都如实执行，不替用户做决定
    routeAnswers: opts.routeAnswers && typeof opts.routeAnswers === 'object' ? opts.routeAnswers : null,
    skipFirstPieceGate: opts.skipFirstPieceGate === true,
  }

  const startIdx = STEPS.findIndex((s) => s.id === from)
  const endIdx = STEPS.findIndex((s) => s.id === to)
  if (startIdx < 0 || endIdx < 0) {
    return { ok: false, error: `未知步骤：from=${from} to=${to}`, available: STEPS.map((s) => s.id) }
  }

  const trace = []
  let halted = null

  // 复杂度路由留痕（迭代 4）：四问给了答案就定档并把判定轨迹写进 trace。
  // L0 不是拒跑：如实执行并在 trace 顶部说明「按四问该档 L0，单干即可」，
  // 由面板/用户决定要不要继续开团——本层只提供可判定的判定，不做主。
  if (ctx.routeAnswers) {
    try {
      const { routeLevel } = await import('./complexity.mjs')
      const lv = routeLevel(ctx.routeAnswers)
      ctx.state.routeLevel = lv.level
      trace.push({
        step: 'ROUTE',
        title: `复杂度定档 ${lv.level} · ${lv.levelDef.label}`,
        gate: 'continue',
        ok: true,
        detail: `${lv.trail.join(' → ')}；形态：${lv.levelDef.form}`,
        fix: null,
        ms: 0,
        data: { level: lv.level, answers: lv.answers, trail: lv.trail },
      })
    } catch (e) {
      trace.push({ step: 'ROUTE', title: '复杂度定档失败', gate: 'continue', ok: true, detail: String(e && e.message ? e.message : e), fix: null, ms: 0, data: null })
    }
  }

  // 支持从中间重跑：先把 S0 的产物（场景记录）补齐，
  // 否则从 S4 起跑时 ctx.scenario 是 null（真踩过）。
  if (startIdx > 0) {
    ctx.scenario = await Reg.getScenario(scenarioId)
    if (!ctx.scenario) {
      return {
        ok: false,
        scenarioId,
        error: '场景未注册，无法从中间步骤开始',
        steps: [],
        halted: { step: 'S0', title: '场景路由', detail: `场景 ${scenarioId} 不存在`, fix: '先建场景' },
        summary: `场景 ${scenarioId} 未注册`,
      }
    }
    // 已绑定的团队也补进状态，供 S3 之后使用
    if (ctx.scenario.teamId) ctx.state.teamId = ctx.scenario.teamId
  }

  for (let i = startIdx; i <= endIdx; i++) {
    const step = STEPS[i]
    // S6b 首件门可显式跳过（ephemeral-run 临时团默认跳：一次性活不设门）
    if (step.id === 'S6b' && ctx.skipFirstPieceGate) {
      trace.push({ step: 'S6b', title: step.title, gate: step.gate, ok: true, detail: '已按参数跳过（skipFirstPieceGate）', fix: null, ms: 0, data: { skipped: true } })
      continue
    }
    const t0 = Date.now()
    let res
    try {
      res = await step.run(ctx)
    } catch (err) {
      res = { ok: false, detail: `步骤异常：${err && err.message ? err.message : err}` }
    }
    trace.push({
      step: step.id,
      title: step.title,
      gate: step.gate,
      ok: res.ok,
      detail: res.detail || '',
      fix: res.fix || null,
      ms: Date.now() - t0,
      data: res.data || null,
    })
    // 关键：把本步产出的 data 合并进共享状态，下一步才能读到。
    // 不做这一步，S2 建队返回的 teamId 就到不了 S3（真踩过）。
    if (res.data && typeof res.data === 'object') {
      ctx.state = { ...ctx.state, ...res.data }
    }
    if (!res.ok) {
      // blocking 步骤（如没审计报告）直接停；其它也停，但不叫失败叫「需要人」
      halted = { step: step.id, title: step.title, detail: res.detail, fix: res.fix || null }
      break
    }
  }

  // 状态推进：全通过则 idle→opening→running。
  // 这段只在「没跑到 S8 收口」时生效。完整 S0→S8 由 S8 自己推进到 done
  // （opening → running → closing → done），这里再推 running 会非法转换并产生 NOTE。
  const S8_IDX = STEPS.findIndex((s) => s.id === 'S8')
  if (!halted && ctx.scenario && endIdx < S8_IDX) {
    try {
      const live = await Reg.getScenario(scenarioId)
      const cur = live ? live.state : ctx.scenario.state
      if (cur === 'idle') await Reg.setState(scenarioId, 'opening')
      if (cur === 'done') await Reg.setState(scenarioId, 'opening')
      // 推进到 running 受一致性校验约束（teamId+leadSessionId 非空）。
      // 校验拒绝时不掩盖主流程（run 结果已 ok），只在 summary 里如实说明。
      const sr = await Reg.setState(scenarioId, 'running').catch((e) => ({ ok: false, errors: [String(e)] }))
      if (!sr.ok && Array.isArray(sr.errors)) {
        trace.push({ step: 'NOTE', title: '状态推进被一致性校验拦下', ok: true, detail: sr.errors.join('；'), fix: sr.hint || null, ms: 0, data: null })
      }
    } catch { /* 状态推进失败不影响主流程报告 */ }
  }

  return {
    ok: !halted,
    scenarioId,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps: trace,
    halted,
    // 成本记账行（迭代 5）：S8 收口时组装；S8 没跑到则为 null，不猜
    costLedgerLine: ctx.state.costLedgerLine || null,
    // 复杂度定档（迭代 4）：有答案才定档，否则 null
    routeLevel: ctx.state.routeLevel || null,
    summary: !halted
      ? `跑到 ${to} 全部通过`
      : `停在 ${halted.step}（${halted.title}）：${halted.detail}${halted.fix ? ' → ' + halted.fix : ''}`,
  }
}

export const stepCatalog = STEPS.map((s) => ({ id: s.id, title: s.title, gate: s.gate, hint: s.hint }))

/* 内部判定函数具名导出：给自证脚本与后续 op 复用。
 * 这几个函数是「投不进去就报失败」这条纪律的落点，必须能被单独验证，
 * 而不是只能靠跑整条流水线撞运气。
 * buildDispatchCommand / buildRebuildCommand 按  一并导出：
 * 兜底指令的拼装规则（assignee 用 member.id、plan 补 step、JSON.stringify 转义）
 * 要能被脚本单独断言，不必每次都构造一整条失败链路。 */
export { dispatchFixFor, deliverBrief, buildTaskBrief, buildDispatchCommand, buildRebuildCommand, buildCostLedgerLine, countRoundArtifacts }
