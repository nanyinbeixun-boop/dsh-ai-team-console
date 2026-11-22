#!/usr/bin/env node
/**
 * verify-capability-domains.mjs —— 6 个真实岗位能力域的行为锁
 *
 * 由来：旧版 CAPABILITY_DOMAINS 是 5 个抽象职能域
 * （造规则/干活/验活/查资料/做视觉），「成员/缺口」页认不出团队真实编制，
 * 且 architect 域用 /^standard$/ 当 matchPreset，会把全队认领成同一域。
 *
 * 本脚本锁死四件事，任何一项退化都会红
 * 1. 六域定义齐：id/label/covers/matchRole/hireWhen/suggest 六字段全在，
 * id 恰为 pm/ui/frontend/backend/qa/devops，无多无少；
 * 2. 单一命中：6 名真实成员（name+role）每人只命中自己那一个域，
 * 无跨域误判、无漏配；
 * 3. 诱导词反证：role 里的「对接后端接口」「设计业务逻辑」「页面美观」
 * 这些词不得把 frontend/maker/ui 拉进别的域；
 * 4. hireWhen 用户视角：每条都说清「缺这个岗位会怎样」，不许是
 * 「团队里没有…」这种以系统为中心的空洞话。
 *
 * 补锁：capability-covered 自检项曾按旧三域 id
 * （architect/maker/auditor）过滤 missing，旧 id 永不出现 → 恒真「假通过」。
 * 第 7 组专治这个：真跑 buildChecks，删掉某岗位后它必须为 false。
 *
 * 用法：node scripts\verify-capability-domains.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。纯本地，不碰 sidecar，不建团队。
 */

import { CAPABILITY_DOMAINS, analyseGaps, buildChecks } from '../lib/index.js'

let pass = 0
let fail = 0
function t(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra !== undefined ? ` :: ${extra}` : ''}`) }
}

/* ── 真实成员 fixture（sidecar 2026-11-21 实测 name+role，含 retired 剔除）── */
const MEMBERS = [
  { id: 'm_TESTID', name: 'architect', role: '产品经理（PM）：收集需求，输出原型，规划功能，协调各方，把控需求范围与版本排期', agentPreset: 'standard', status: 'idle' },
  { id: 'm_TESTID', name: 'auditor', role: '测试（QA）：编写测试用例，功能验证，发现并提交 bug，回归验证，保障交付质量', agentPreset: 'standard', status: 'idle' },
  { id: 'm_TESTID', name: 'maker', role: '后端开发：设计业务逻辑、接口、数据库，提供数据服务，保障后台功能稳定', agentPreset: 'standard', status: 'idle' },
  { id: 'm_mwq6thz911lcn', name: 'ui-designer', role: 'UI 设计师：设计软件界面、图标、配色，输出视觉稿，保证页面美观统一', agentPreset: 'standard', status: 'idle' },
  { id: 'm_mwq6tiey24aw4', name: 'frontend-dev', role: '前端开发：实现页面界面与交互效果，适配多端，对接后端接口，处理页面兼容性', agentPreset: 'standard', status: 'idle' },
  { id: 'm_mwq6ttj24ln41', name: 'devops', role: '运维 / DevOps：搭建部署环境，上线发布，服务器维护，监控线上服务，处理环境故障', agentPreset: 'standard', status: 'running' },
]

/* ── 1. 六域定义完整性 ─────────────────────────────────────────── */
console.log('\n[1] 六域定义（id/label/covers/matchRole/hireWhen/suggest）')
const ids = CAPABILITY_DOMAINS.map((d) => d.id)
t('恰好 6 个域', CAPABILITY_DOMAINS.length === 6, JSON.stringify(ids))
t('六个真实岗位 id 齐全且顺序稳定',
  JSON.stringify(ids) === JSON.stringify(['pm', 'ui', 'frontend', 'backend', 'qa', 'devops']), JSON.stringify(ids))
t('每域六字段齐全且非空', CAPABILITY_DOMAINS.every((d) =>
  d.id && d.label && d.covers && d.matchRole instanceof RegExp && d.hireWhen &&
  d.suggest && d.suggest.name && d.suggest.agentPreset && d.suggest.provider && d.suggest.model && d.suggest.effort),
  JSON.stringify(CAPABILITY_DOMAINS.map((d) => Object.keys(d))))
t('全部 matchPreset=null（防 standard 一把梭）', CAPABILITY_DOMAINS.every((d) => d.matchPreset === null))
const EXPECT_LABEL = { pm: '产品经理', ui: 'UI设计', frontend: '前端开发', backend: '后端开发', qa: '测试', devops: '运维DevOps' }
t('中文标签对齐真实岗位', CAPABILITY_DOMAINS.every((d) => d.label === EXPECT_LABEL[d.id]),
  JSON.stringify(CAPABILITY_DOMAINS.map((d) => `${d.id}=${d.label}`)))

/* ── 2. 各域 covers 关键词到位 ─────────────────────────────────── */
console.log('\n[2] 各域 covers 写清职责')
const COVERS_KW = {
  pm: ['需求', '原型', '排期'],
  ui: ['界面', '图标', '配色', '视觉稿'],
  frontend: ['交互', '适配', '接口', '兼容'],
  backend: ['业务逻辑', '接口', '数据库', '后台'],
  qa: ['测试用例', '功能验证', 'bug', '回归'],
  devops: ['部署', '上线', '服务器', '监控', '故障'],
}
for (const d of CAPABILITY_DOMAINS) {
  const miss = (COVERS_KW[d.id] || []).filter((k) => !d.covers.includes(k))
  t(`${d.id} covers 覆盖职责关键词`, miss.length === 0, `缺：${miss.join('、')}`)
}

/* ── 3. 单一命中：每人只认领自己的域 ───────────────────────────── */
console.log('\n[3] 6 名真实成员各自只命中自己的域（无跨域误判、无漏配）')
const EXPECT_OWNER = {
  architect: 'pm', auditor: 'qa', maker: 'backend',
  'ui-designer': 'ui', 'frontend-dev': 'frontend', devops: 'devops',
}
/** 返回该成员命中的域 id 列表（复用 analyseGaps 的同款判定逻辑） */
function hitDomains(m) {
  return CAPABILITY_DOMAINS.filter((d) =>
    d.matchRole.test(String(m.role || '')) || d.matchRole.test(String(m.name || ''))).map((d) => d.id)
}
for (const m of MEMBERS) {
  const hits = hitDomains(m)
  const want = EXPECT_OWNER[m.name]
  t(`${m.name} → 只命中 ${want}`, hits.length === 1 && hits[0] === want, `实际：${JSON.stringify(hits)}`)
}

/* ── 4. 诱导词反证：role 里的跨域词不得拉错域 ─────────────────── */
console.log('\n[4] 诱导词反证（role 里的跨域词不得误判）')
// 这两条是真实踩坑点：frontend 的 role 含「对接后端接口」，maker 的 role 含「设计业务逻辑」
const frontend = MEMBERS.find((m) => m.name === 'frontend-dev')
const maker = MEMBERS.find((m) => m.name === 'maker')
const ui = MEMBERS.find((m) => m.name === 'ui-designer')
const backendDom = CAPABILITY_DOMAINS.find((d) => d.id === 'backend')
const pmDom = CAPABILITY_DOMAINS.find((d) => d.id === 'pm')
const uiDom = CAPABILITY_DOMAINS.find((d) => d.id === 'ui')
t('「对接后端接口」不把前端认成后端',
  !(backendDom.matchRole.test(frontend.role) || backendDom.matchRole.test(frontend.name)))
t('「设计业务逻辑」不把后端认成产品',
  !(pmDom.matchRole.test(maker.role) || pmDom.matchRole.test(maker.name)))
t('「页面美观统一」不把 UI 认成前端',
  !(CAPABILITY_DOMAINS.find((d) => d.id === 'frontend').matchRole.test(ui.role)
    || CAPABILITY_DOMAINS.find((d) => d.id === 'frontend').matchRole.test(ui.name)))
// 正向反证：这些词本身也要能被自己域认到（防止把正则砍成恒 false 蒙混过关）
t('后端域仍能认到真后端', backendDom.matchRole.test(maker.role) || backendDom.matchRole.test(maker.name))
t('产品域仍能认到真产品', pmDom.matchRole.test(MEMBERS[0].role) || pmDom.matchRole.test(MEMBERS[0].name))
t('UI 域仍能认到真 UI', uiDom.matchRole.test(ui.role) || uiDom.matchRole.test(ui.name))

/* ── 5. analyseGaps 集成：六域全覆盖、missing 为空 ─────────────── */
console.log('\n[5] analyseGaps 集成（真实编制应六域全覆盖）')
const gaps = analyseGaps(MEMBERS)
t('total=6', gaps.total === 6, String(gaps.total))
t('coveredCount=6', gaps.coveredCount === 6, String(gaps.coveredCount))
t('missing 为空', gaps.missing.length === 0, JSON.stringify(gaps.missing))
t('每域 owner 恰 1 人', gaps.rows.every((r) => r.owners.length === 1),
  JSON.stringify(gaps.rows.map((r) => `${r.id}:${r.owners.length}`)))
// 缺人时 suggest 必须出现且用的是未禁用通道 workbuddy/hy4flash-free
const oneMissing = analyseGaps(MEMBERS.filter((m) => m.name !== 'devops'))
const devopsRow = oneMissing.rows.find((r) => r.id === 'devops')
t('缺人域给招募建议', devopsRow.status === 'missing' && Boolean(devopsRow.suggest))
t('建议不用被禁通道（workbuddy/hy4flash-free）',
  devopsRow.suggest.provider === 'workbuddy' && devopsRow.suggest.model === 'hy4flash-free',
  JSON.stringify(devopsRow.suggest))

/* ── 6. hireWhen 用户视角：说清「缺了会怎样」 ─────────────────── */
console.log('\n[6] hireWhen 用户视角（缺这个岗位会怎样）')
for (const d of CAPABILITY_DOMAINS) {
 // 用户视角 = 讲后果（跑偏/返工/用不上/没人发现/落不了地/部署不上去），
 // 而不是「团队里没有任何成员能…」这种以系统为中心的老文案。
  const oldStyle = /团队里没有|^没有能|当前成员只有/.test(d.hireWhen)
  t(`${d.id} hireWhen 讲后果非老文案`, !oldStyle && d.hireWhen.length >= 12, d.hireWhen)
}

/* ── 7. capability-covered 自检项：假通过防复发 ──────────────────
 * 这是踩出来的真事故：旧版 pass 用旧三域 id 过滤 missing，恒为空 → 恒 true。
 * 这里真跑 buildChecks（不读源码正则），删掉任一岗位后它必须为 false。
 */
console.log('\n[7] capability-covered 自检项（删岗位必须变 false，不许恒真）')
const STUB_TEAM = { teamId: 'team_stub', teams: [{ id: 'team_stub', maxMembers: 8 }] }
const STUB_HANDBOOK = { exists: true, missing: [], placeholderSkeleton: [], audits: [] }
function coveredCheck(members) {
  const result = buildChecks({ team: { ...STUB_TEAM, members }, handbook: STUB_HANDBOOK, activePreset: null })
  return result.items.find((c) => c.id === 'capability-covered')
}
const full = coveredCheck(MEMBERS)
t('六岗位齐全 → capability-covered pass=true', Boolean(full) && full.pass === true, JSON.stringify(full))
t('  → label 是六大岗位', /六大岗位齐全/.test(full && full.label), full && full.label)
t('  → 全齐 detail 说「六个岗位都有承接」', /六个岗位都有承接/.test(full && full.detail), full && full.detail)

// 逐个删掉每个岗位，自检项都必须变 false（这是「不再恒真」的核心证据）
for (const m of MEMBERS) {
  const c = coveredCheck(MEMBERS.filter((x) => x.name !== m.name))
  const wantLabel = EXPECT_LABEL[EXPECT_OWNER[m.name]]
  t(`删掉 ${m.name}(${wantLabel}) → capability-covered=false`,
    Boolean(c) && c.pass === false, JSON.stringify(c))
  t(`  → detail 点名缺 ${wantLabel}`, Boolean(c) && String(c.detail).includes(wantLabel), c && c.detail)
}
// 一次删两个：detail 要同时点名两个岗位（测试岗的成员 name 是 auditor）
const twoGone = coveredCheck(MEMBERS.filter((x) => x.name !== 'devops' && x.name !== 'auditor'))
t('删两岗 → detail 同时点名两个中文岗位',
  Boolean(twoGone) && /运维/.test(twoGone.detail) && /测试/.test(twoGone.detail), twoGone && twoGone.detail)

/* ── 7.5 members-capped：退休成员不占名额（假报红防复发）─────────
 *：旧版用 members.length 比较上限，11 条记录（在编6+退休5）
 * 会被误判超上限 8 → 假报红。这里真跑 buildChecks 验证按在编人数判定。
 */
console.log('\n[7.5] members-capped 自检项（退休不占名额，按在编人数判）')
function cappedCheck(members) {
  const result = buildChecks({ team: { ...STUB_TEAM, members }, handbook: STUB_HANDBOOK, activePreset: null })
  return result.items.find((c) => c.id === 'members-capped')
}
// 在编 6 + 退休 5 = 11 条记录，上限 8 → 必须 pass（旧版这里会红）
const sixPlusFive = [
  ...MEMBERS.map((m) => ({ ...m })), // 6 在编
  ...Array.from({ length: 5 }, (_, i) => ({ id: 'ret_' + i, name: 'retired-' + i, status: 'retired' })),
]
t('构造前提：总记录 11 = 在编 6 + 退休 5', sixPlusFive.length === 11)
const capOk = cappedCheck(sixPlusFive)
t('在编6+退休5=11（上限8）→ members-capped pass=true（不假报红）',
  Boolean(capOk) && capOk.pass === true, JSON.stringify(capOk))
t('  → detail 展示在编6/上限8/另5退休',
  Boolean(capOk) && /在编 6 人 · 上限 8/.test(capOk.detail) && /另有 5 人已退休/.test(capOk.detail), capOk && capOk.detail)
// 无退休时只显示在编与上限，不出现"退休"字样
const capNoRetired = cappedCheck(MEMBERS.map((m) => ({ ...m })))
t('退休数=0 → detail 只显示「在编 6 人 · 上限 8」',
  Boolean(capNoRetired) && /在编 6 人 · 上限 8/.test(capNoRetired.detail) && !/退休/.test(capNoRetired.detail), capNoRetired && capNoRetired.detail)
// 在编确实超上限（9>8）→ 必须 false，且给可执行提示
const nineActive = [
  ...MEMBERS.map((m) => ({ ...m })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: 'extra_' + i, name: 'extra-' + i, status: 'idle' })),
]
const capOver = cappedCheck(nineActive)
t('在编 9（上限 8）→ members-capped pass=false',
  Boolean(capOver) && capOver.pass === false, JSON.stringify(capOver))
t('  → detail 给可执行提示「超上限…调整上限或退休成员」',
  Boolean(capOver) && /超上限 1 人/.test(capOver.detail) && /调整上限或退休成员/.test(capOver.detail), capOver && capOver.detail)
t('  → 不再用「需重建团队」过时说法',
  Boolean(capOver) && !/重建团队/.test(capOver.detail), capOver && capOver.detail)
// op=hire 的过时提示同步改掉（静态核对，op=team-cap 已支持动态改）
const idxSrc = (await import('node:fs')).readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
t('op=hire 名额已满提示已去「重建团队」、指向「成员页调上限」',
  /到「成员」页把团队人数上限调高/.test(idxSrc) && !/通常要重建团队/.test(idxSrc))

/* ── 8. retired/failed 成员不算承接人（假齐备防复发） ────────────
 *：analyseGaps 曾不过滤 status，唯一承接人退休/失败时
 * 缺口页仍显示齐备、capability-covered 也判通过。这里真跑 analyseGaps 验证。
 */
console.log('\n[8] retired/failed 不算承接人（假齐备防复发）')
const ACTIVE = (name) => MEMBERS.find((m) => m.name === name)
const withStatus = (name, status) => ({ ...ACTIVE(name), status })

// ① 某域唯一承接人 retired → 该域 missing，coveredCount 减一
{
  const rows = analyseGaps(MEMBERS.map((m) => m.name === 'devops' ? withStatus('devops', 'retired') : m))
  const row = rows.rows.find((r) => r.id === 'devops')
  t('唯一承接人 retired → devops 域 missing', row.status === 'missing', JSON.stringify(row))
  t('  → owners 为空、给招募建议', row.owners.length === 0 && Boolean(row.suggest), JSON.stringify(row))
  t('  → coveredCount 不计入（6→5）', rows.coveredCount === 5 && rows.missing.length === 1,
    `covered=${rows.coveredCount} missing=${rows.missing.length}`)
}
// ② 同域 retired + active → 只统计 active，仍 covered，owner 只有 active 那一个
{
  const extraActiveDevops = { ...ACTIVE('devops'), id: 'm_active_devops', name: 'devops-active', status: 'idle' }
  const rows = analyseGaps([
    ...MEMBERS.map((m) => m.name === 'devops' ? withStatus('devops', 'retired') : m),
    extraActiveDevops,
  ])
  const row = rows.rows.find((r) => r.id === 'devops')
  t('retired + active 同域 → 仍 covered', row.status === 'covered', JSON.stringify(row))
  t('  → owners 只含 active 不含 retired',
    row.owners.length === 1 && row.owners[0].name === 'devops-active',
    JSON.stringify(row.owners))
  t('  → coveredCount 仍为 6', rows.coveredCount === 6, String(rows.coveredCount))
}
// ③ failed 同样不算承接人
{
  const rows = analyseGaps(MEMBERS.map((m) => m.name === 'maker' ? withStatus('maker', 'failed') : m))
  const row = rows.rows.find((r) => r.id === 'backend')
  t('唯一承接人 failed → backend 域 missing', row.status === 'missing' && row.owners.length === 0, JSON.stringify(row))
}
// ④ capability-covered 集成：唯一承接人 retired → 判 false（不再假齐备）
{
  const retiredMembers = MEMBERS.map((m) => m.name === 'auditor' ? withStatus('auditor', 'retired') : m)
  const c = coveredCheck(retiredMembers)
  t('唯一承接人 retired → capability-covered=false', Boolean(c) && c.pass === false, JSON.stringify(c))
  t('  → detail 点名缺「测试」', Boolean(c) && /测试/.test(c.detail), c && c.detail)
}
// ⑤ 全部成员 retired → 六域全 missing、coveredCount=0
{
  const allRetired = MEMBERS.map((m) => ({ ...m, status: 'retired' }))
  const rows = analyseGaps(allRetired)
  t('全 retired → 六域全 missing、coveredCount=0',
    rows.coveredCount === 0 && rows.missing.length === 6,
    `covered=${rows.coveredCount} missing=${rows.missing.length}`)
}

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：6 个真实岗位能力域单一命中、无跨域误判、无漏配。\n')
else console.log('有断言失败 —— 能力域定义退化，先修这些。\n')
process.exit(fail === 0 ? 0 : 1)
