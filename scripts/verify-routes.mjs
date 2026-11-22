#!/usr/bin/env node
/**
 * verify-routes.mjs —— 成员模型路由（routes.mjs）的行为锁
 *
 * 依据：docs\103（路由矩阵）+ docs\108（上下文感知切换规格）。
 * 不联网、不碰 sidecar、不建团队；纯函数 + 桩 sidecar 集成。
 *
 * 锁住的纪律（每条都是踩过或会踩的）：
 *   1. 五域四档三元组（free/paid/backup/last）——防有人顺手改链；
 *   2. 付费纪律：V4.1 系（x0.11）排在 dsv4-pro（x0.51）之前，pro 只许 last；
 *   3. 免费池口径：只放实测可用的 7 条（原 4 条 + 3 条 our-free-model EAC 实测可用），
 *      qoder/qfmodel 一律不进；已 EOL 的 our-free-model 2 条走 disabledRoutes 精确拉黑；
 *   4. 未知域回落、别名与成员域归一；
 *   5. effort 白名单夹取（raccoon 只认 on，宿主会拒非法值）；
 *   6. 窗口表：有依据的才用大值，未标注一律 128K 保守（估大 → 硬切 → 截断）；
 *   7. fitCheck 三态边界（docs\108 §3 三个具体数字）与「reject 绝不返回」；
 *   8. selectRoute 按档位逐档判，窗口不足跳过而非选后失败；
 *   9. 能力基线 role 写/读往返；
 *  10. S2_5 集成：真用 selectRoute 建成员，不硬编码；
 *  11. 变异反证：neededTokens 判定若被改成恒 true，断言必须报红。
 *
 * 用法：node scripts\verify-routes.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */

import * as R from '../lib/orchestrator/routes.mjs'

let pass = 0
let fail = 0
function t(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra !== undefined ? ` :: ${extra}` : ''}`) }
}
const triple = (r) => `${r.provider}/${r.model}/${r.reasoningEffort === undefined ? '∅' : r.reasoningEffort}`

/* ── 期望表（docs\108 §4.2 新链，四档）────────────────────────────
 * last 档专放 dsv4-pro（或该域的最终兜底），只在 V4.1 系全不可用时启用。
 */
const EXPECT = {
  code: {
    free: 'raccoon/sn-sensenova-6-8-flash/on',
    paid: 'workbuddy/deepseek-v4.1-flash/high',
    backup: 'raccoon/sn-deepseek-v4-1-flash-1017/on',
    last: 'workbuddy/deepseek-v4-pro/high',
  },
  audit: {
    free: 'qodercn/qfmodel/xhigh',
    paid: 'deepseek-official/deepseek-flash/max',
    backup: 'workbuddy/deepseek-v4.1-flash/max',
    last: 'deepseek-official/deepseek-v4-pro/max',
  },
  probe: {
    free: 'qodercn/qfmodel/medium',
    paid: 'workbuddy/deepseek-v4.1-flash/high',
    backup: 'raccoon/sn-deepseek-v4-1-flash-1017/on',
    last: 'workbuddy/deepseek-v4-pro/high',
  },
  vision: {
    free: 'raccoon/sn-sensenova-6-8-flash-lite/on',
    // 2026-11-21 P2：vision 域首选 image 专精通道（modlens 视觉桥），不复用主力
    paid: 'modlens-workbuddy/mimo-v2.6-pro/high',
    backup: 'raccoon/sn-deepseek-v4-1-flash-1017/on',
    last: 'deepseek-official/deepseek-flash/high',
  },
  quick: {
    free: 'raccoon/sn-sensenova-6-8-flash-lite/on',
    paid: 'workbuddy/deepseek-v4.1-flash/high',
    backup: 'raccoon/sn-deepseek-v4-1-flash-1017/on',
    last: 'qodercn/qfmodel/medium',
  },
}

/* ── 1. 链结构与五域四档三元组 ─────────────────────────────────── */
console.log('\n[1] 链结构：五域 × 四档，三元组逐个对死（docs\\108 §4.2）')
t('目录覆盖 5 个域', R.routeCatalog().length === 5, R.routeCatalog().map((c) => c.domain).join('、'))
// 2026-11-21 用户新四级：主力(paid)→免费(free)→省钱(backup)→视觉兜底(last)，取代旧「免费优先」
t('TIER_PRIORITY 导出且四级语义齐全', Array.isArray(R.TIER_PRIORITY) && R.TIER_PRIORITY.length === 4
  && R.TIER_PRIORITY.map((x) => x.tier).join(',') === 'paid,free,backup,last'
  && R.TIER_PRIORITY.every((x) => x.name && x.rule))
t('TIER_ORDER 由 TIER_PRIORITY 派生 = paid→free→backup→last（主力优先）',
  R.TIER_ORDER.join(',') === 'paid,free,backup,last' && R.TIER_ORDER.join(',') === R.TIER_PRIORITY.map((x) => x.tier).join(','),
  R.TIER_ORDER.join(','))
for (const [domain, tiers] of Object.entries(EXPECT)) {
  const chain = R.routeChain(domain)
  t(`${domain} 四档齐全`, chain.length === 4, chain.map((c) => c.tier).join('→'))
  t(`  ${domain} 档位顺序正确（主力→免费→省钱→视觉）`, chain.map((c) => c.tier).join(',') === 'paid,free,backup,last')
  for (const [tier, want] of Object.entries(tiers)) {
    const hit = chain.find((c) => c.tier === tier)
    const got = hit ? `${hit.key}/${hit.reasoningEffort === undefined ? '∅' : hit.reasoningEffort}` : '（缺档）'
    t(`  ${domain}.${tier} = ${want}`, got === want, got)
  }
  // 四档不重复：重复说明有人复制粘贴改漏了
  t(`  ${domain} 四档 route 不重复`, new Set(chain.map((c) => c.key)).size === 4, chain.map((c) => c.key).join('→'))
}

/* ── 2. 付费纪律：V4.1 优先，dsv4-pro 只许 last ────────────────── */
console.log('\n[2] 付费纪律：V4.1 系（x0.11）在 pro（x0.51）之前，pro 只许 last 档')
const isPro = (x) => /deepseek-v4-pro/.test(String(x || ''))
const isV41 = (x) => /deepseek-v4-1|deepseek-v4\.1|deepseek-flash/.test(String(x || ''))
for (const domain of Object.keys(EXPECT)) {
  const chain = R.routeChain(domain)
  const paid = chain.find((c) => c.tier === 'paid')
  const backup = chain.find((c) => c.tier === 'backup')
  const last = chain.find((c) => c.tier === 'last')
  t(`${domain} paid 档不是 v4-pro`, !isPro(paid.key), paid.key)
  t(`  ${domain} last 档是大窗口兜底（不重复 paid）`, last.key !== paid.key, `${last.key} vs ${paid.key}`)
  // pro 若出现在链里，必须在 last
  const proPositions = chain.filter((c) => isPro(c.key)).map((c) => c.tier)
  t(`  ${domain} 若含 v4-pro 则只在 last`, proPositions.length === 0 || (proPositions.length === 1 && proPositions[0] === 'last'),
    proPositions.join(','))
  t(`  ${domain} paid/backup 至少一档是 V4.1 系`, isV41(paid.key) || isV41(backup.key), `${paid.key} / ${backup.key}`)
}
// 具体：audit 的 paid 从 pro 换成了 V4.1（deepseek-flash），这是本次重排的关键点
const auditPaid = R.routeChain('audit').find((c) => c.tier === 'paid')
t('audit.paid = deepseek-official/deepseek-flash（V4.1，不再直上 pro）',
  auditPaid.key === 'deepseek-official/deepseek-flash', auditPaid.key)
t('audit.last 才是 v4-pro', isPro(R.routeChain('audit').find((c) => c.tier === 'last').key))
// effort 白名单：V4.1 支持 max（audit 用它顶推理强度）
t('workbuddy/deepseek-v4.1-flash 允许 max', (R.EFFORTS['workbuddy/deepseek-v4.1-flash'] || []).includes('max'))
t('deepseek-official/deepseek-flash 允许 max', (R.EFFORTS['deepseek-official/deepseek-flash'] || []).includes('max'))

/* ── 3. 免费池口径 ─────────────────────────────────────────────── */
console.log('\n[3] 免费池 = 实测可用清单，不是路由列表的免费项（docs\\103 §2）')
const keys = R.freePoolKeys()
t('免费池 7 项（原 4 条 + 3 条 our-free-model EAC 实测可用）', keys.length === 7, keys.join('、'))
for (const k of ['raccoon/sn-sensenova-6-8-flash', 'raccoon/sn-sensenova-6-8-flash-lite', 'workbuddy/hy4flash-free', 'qodercn/qfmodel']) {
  t(`  含 ${k}`, keys.includes(k), keys.join('、'))
}
// 3 条 our-free-model 实测可用（2026-11-21 派发接入，relay 全名）
const OFM_OK = [
  'our-free-model/moonshotai/kimi-k3.1-pro',
  'our-free-model/opencode/deepseek-v4.1-flash-free',
  'our-free-model/stepfun-ai/step-5-preview',
]
for (const k of OFM_OK) {
  t(`  含 ${k}（实测可用）`, keys.includes(k), keys.join('、'))
}
t('our-free-model 只进实测可用的 3 条（EOL 两条不进池）',
  keys.filter((k) => k.startsWith('our-free-model/')).length === 3, keys.join('、'))
t('qoder/qfmodel 不进池（主区未登录）', !keys.includes('qoder/qfmodel'), keys.join('、'))
t('每项都带实测 note', R.FREE_POOL.every((r) => typeof r.note === 'string' && r.note.length > 0))
t('每项都声明 modalities', R.FREE_POOL.every((r) => Array.isArray(r.modalities) && r.modalities.length > 0))
// 2026-11-21 Lead 三组实测定稿：stability 两档，hy4flash-free 主力第一、flakey 三条补位垫底
t('每项都声明 stability', R.FREE_POOL.every((r) => r.stability === 'stable' || r.stability === 'flakey'))
t('hy4flash-free 标 stable 且是 FREE_POOL 第一项',
  R.stabilityOf('workbuddy/hy4flash-free') === 'stable' && keys[0] === 'workbuddy/hy4flash-free', keys[0])
t('3 条 our-free-model 标 flakey（波动可用，补位）', OFM_OK.every((k) => R.stabilityOf(k) === 'flakey' && R.isFlakey(k)))
t('4 条原稳定项标 stable', keys.slice(0, 4).every((k) => R.stabilityOf(k) === 'stable'), keys.slice(0, 4).join('、'))
t('3 条 flakey 排在全部 stable 之后（垫底，不当主力）',
  (() => { const ofmIdxs = OFM_OK.map((k) => keys.indexOf(k)); const maxStable = Math.max(...keys.filter((k) => R.stabilityOf(k) === 'stable').map((k) => keys.indexOf(k))); return ofmIdxs.every((i) => i > maxStable) })(), keys.map((k) => `${k}:${R.stabilityOf(k)}`).join(' | '))
// candidatePool 排序：stable 一律在 flakey 前（防 our-free-model providerRank=0 顶主力）
const cp = R.candidatePool({})
// 只比 allowed 的行：被 gate 挡住的 stable 按现有纪律沉底（能用的在前），不该算进「补位排序」
const cpOk = cp.filter((x) => x.allowed)
const firstFlakeyOk = cpOk.findIndex((x) => x.stability === 'flakey')
const lastStableOk = cpOk.map((x) => x.stability).lastIndexOf('stable')
t('candidatePool：可用项里所有 stable 排在 flakey 之前（补位不当主力）',
  firstFlakeyOk === -1 || lastStableOk < firstFlakeyOk, `lastStableOk=${lastStableOk} firstFlakeyOk=${firstFlakeyOk}`)
t('candidatePool 行带 stability 字段', cp.every((x) => x.stability === 'stable' || x.stability === 'flakey'))
// selectRoute 默认首选必须是 stable；flakey 只在显式点名时才被选中（Lead 验收③）
for (const domain of Object.keys(R.ROUTE)) {
  const s = R.selectRoute(domain, {})
  t(`${domain} 默认首选是 stable（不是 flakey 补位）`,
    !R.isFlakey(s.provider + '/' + s.model), `${s.provider}/${s.model}/${s.tier}`)
}
t('白名单只放 flakey 时 selectRoute 也不硬选它（链 free 无 flakey，降到 stable/paid）',
  (() => { const s = R.selectRoute('code', { available: OFM_OK }); return !R.isFlakey(s.provider + '/' + s.model) })())
t('显式指定 flakey 通道 → resolveChatRoute 放行（补位只在点名时上）',
  (() => { const r = R.resolveChatRoute({ explicit: { provider: 'our-free-model', model: 'opencode/deepseek-v4.1-flash-free' } }); return r.source === 'explicit' && r.route && r.route.provider === 'our-free-model' })())

/* ── 3.5 第四档视觉兜底：默认不参与四域、vision 与显式指定放行（Lead 15:20 修订）── */
console.log('\n[3.5] 视觉兜底档：非指定任务不主动选，但功能完整可用（不写死禁止）')
t('isPrimaryModel：模型名含 deepseek-v4.1-flash 才算主力（任意 provider）',
  R.isPrimaryModel('deepseek-v4.1-flash') && R.isPrimaryModel('workbuddy/deepseek-v4.1-flash')
  && R.isPrimaryModel('our-free-model/opencode/deepseek-v4.1-flash-free') && !R.isPrimaryModel('qfmodel'))
t('isVisionRoute：带 image 模态才算视觉通道',
  R.isVisionRoute('workbuddy/deepseek-v4.1-flash') && R.isVisionRoute('workbuddy/glm-5.3-flash')
  && !R.isVisionRoute('workbuddy/hy4flash-free'))
// 关键守卫：显式指定视觉/生成类 route 必须放行成功（防将来有人写死拦截）
const VISION_LOOSE = R.resolveConfig({ maxMultiplier: 10, providerMultiplierCap: { workbuddy: 10 }, disabledProviders: [], disabledRoutes: [] })
for (const [p, m] of [['workbuddy', 'deepseek-v4.1-flash'], ['workbuddy', 'glm-5.3-flash']]) {
  const g = R.gateRoute({ provider: p, model: m }, VISION_LOOSE)
  const e = R.resolveChatRoute({ config: VISION_LOOSE, explicit: { provider: p, model: m } })
  t(`${p}/${m} 显式指定视觉/生成类 → gate 放行`, g.allowed === true, JSON.stringify(g))
  t(`  → resolveChatRoute explicit 成功且无 blocked`, e.source === 'explicit' && e.route && R.routeKey(e.route) === `${p}/${m}` && !e.explicitBlocked,
    `${e.source} ${e.route && R.routeKey(e.route)}`)
}
// 源码不得存在任何写死的生成类拦截规则
const { readFileSync: _readR } = await import('node:fs')
const SRC_R = _readR(new URL('../lib/orchestrator/routes.mjs', import.meta.url), 'utf8')
t('routes.mjs 不含 forbidImageGen/blockGeneration/禁止文生图 之类的硬拦规则',
  !/forbidImageGen|blockGeneration|禁止文生[图视]频|denyGeneration/.test(SRC_R))
// 视觉兜底档仅 vision 域参与：构造只留 last 视觉可用，vision 域能选、四域自动跳过 last 视觉
const ONLY_LAST = R.resolveConfig({
  maxMultiplier: 10, providerMultiplierCap: {}, disabledProviders: [], disabledRoutes: [
    'workbuddy/hy4flash-free', 'workbuddy/deepseek-v4.1-flash', 'workbuddy/deepseek-v4-pro',
    'raccoon/sn-sensenova-6-8-flash', 'raccoon/sn-sensenova-6-8-flash-lite', 'raccoon/sn-deepseek-v4-1-flash-1017',
    'qodercn/qfmodel', 'modlens-workbuddy/mimo-v2.6-pro',
  ],
})
t('vision 域可选中 last 档视觉通道（功能完整）',
  (() => { const s = R.selectRoute('vision', { config: ONLY_LAST }); return s.tier === 'last' && !s.contextExhausted })())
t('code 域在只剩 last 视觉可用时判 exhausted（不硬选视觉兜底）',
  (() => { const s = R.selectRoute('code', { config: ONLY_LAST, available: ['deepseek-official/deepseek-flash'] }); return s.contextExhausted === true })())

/* ── 3.6 P2 三问题回归锁（Lead 独立验证发现）───────────────────── */
console.log('\n[3.6] P2 回归锁：视觉倍率豁免 / 专精优先 / isPrimaryModel 对象入参')
// 断言①：显式指定 x0.69 视觉通道必须放行（不受 maxMultiplier 0.13 限制）
const TIGHT_CFG = R.resolveConfig({ maxMultiplier: 0.13, providerMultiplierCap: { 'modlens-workbuddy': 0.13 }, disabledProviders: [], disabledRoutes: [] })
const x069 = R.gateRoute({ provider: 'modlens-workbuddy', model: 'glm-5.3' }, TIGHT_CFG)
t('x0.69 视觉通道在非生成意图下被 cap 挡（前提成立）', x069.allowed === false && x069.blockedBy !== null, JSON.stringify(x069))
const x069gen = R.gateRoute({ provider: 'modlens-workbuddy', model: 'glm-5.3' }, TIGHT_CFG, { explicit: { provider: 'modlens-workbuddy', model: 'glm-5.3' } })
t('断言①：显式指定 x0.69 visual route → 放行（不受 maxMultiplier）', x069gen.allowed === true, JSON.stringify(x069gen))
t('  → 标 exemptedBy=generation-intent（审计看得到豁免）', x069gen.exemptedBy === 'generation-intent', String(x069gen.exemptedBy))
// 硬禁用不能被生成意图绕过
const x069disabled = R.gateRoute({ provider: 'modlens-workbuddy', model: 'glm-5.3' },
  R.resolveConfig({ maxMultiplier: 0.13, disabledProviders: ['modlens-workbuddy'] }), { explicit: { provider: 'modlens-workbuddy', model: 'glm-5.3' } })
t('  → 但 disabledProviders 硬禁用仍生效（生成意图不绕过）', x069disabled.allowed === false && x069disabled.blockedBy === 'provider-disabled', JSON.stringify(x069disabled))
// 倍率未知的视觉桥通道在生成意图下也放行
const xUnk = R.gateRoute({ provider: 'modlens-zcode', model: 'GLM-5.3' }, TIGHT_CFG, { domain: 'vision' })
t('倍率未知的 modlens 视觉桥在 vision 域也放行', xUnk.allowed === true, JSON.stringify(xUnk))
// 断言②：vision 域优先选 image 专精通道（modlens-*），不复用 deepseek-v4.1-flash 主力
const visSel = R.selectRoute('vision', {})
t('断言②：vision 域首选 image 专精通道', R.isVisionSpecialist(visSel.provider + '/' + visSel.model),
  `${visSel.provider}/${visSel.model} specialist=${R.isVisionSpecialist(visSel.provider + '/' + visSel.model)}`)
t('  → 不是复用主力 deepseek-v4.1-flash', !R.isPrimaryModel(visSel.model), visSel.model)
t('isVisionSpecialist 认 modlens 视觉桥、不认 text+image 主力',
  R.isVisionSpecialist('modlens-workbuddy/glm-5.3') && !R.isVisionSpecialist('workbuddy/deepseek-v4.1-flash'))
// 断言③：isPrimaryModel 对象入参也返回 true
t('断言③：isPrimaryModel(对象) = true', R.isPrimaryModel({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }) === true)
t('  → 字符串两种写法仍为 true', R.isPrimaryModel('workbuddy/deepseek-v4.1-flash') && R.isPrimaryModel('deepseek-v4.1-flash'))
t('  → 非主力仍为 false', !R.isPrimaryModel({ provider: 'qodercn', model: 'qfmodel' }))
// genIntent 判定本身
t('isGenerationIntent：vision域/allowVision/显式视觉route 命中，普通不命中',
  R.isGenerationIntent({ domain: 'vision' }) && R.isGenerationIntent({ allowVision: true })
  && R.isGenerationIntent({ explicit: { provider: 'modlens-workbuddy', model: 'glm-5.3' } })
  && !R.isGenerationIntent({ domain: 'code' }))

/* ── 4. 免费不可用 → 逐档降级 ────────────────────────────────────
 * 注意：这一组要测的是**链的档位顺序**，不是倍率门槛，所以显式给一份
 * 「不设 workbuddy cap」的宽松配置（PERMISSIVE）。用默认配置会正确地
 * 把 workbuddy 的 x0.11 挡掉——那是第 16 组的事，别把两件事混在一起测。
 */
console.log('\n[4] 免费不可用 → 逐档降级到 paid（不许假免费）')
// resolveConfig 会把默认 providerCap（workbuddy:0）浅合并进来，所以「不设限」配置
// 必须显式把 workbuddy 的 cap 抬到足够高，否则默认的 0 仍然生效。
const PERMISSIVE = { maxMultiplier: 10, providerMultiplierCap: { workbuddy: 10 } }
for (const domain of Object.keys(EXPECT)) {
  const want = EXPECT[domain].paid
  const a = R.selectRoute(domain, { freeDisabled: true, config: PERMISSIVE })
  t(`${domain} freeDisabled → ${want}`, triple(a) === want, triple(a))
  t(`  ${domain} 标 tier=paid / degraded=true`, a.tier === 'paid' && a.degraded === true, `${a.tier}/${a.degraded}`)
  t(`  ${domain} reason 说明降级原因`, /禁用|为空/.test(a.reason), a.reason)
  const b = R.selectRoute(domain, { freePool: [], config: PERMISSIVE })
  t(`${domain} freePool=[] → 同样降级`, triple(b) === want, triple(b))
}
// 免费池里没有该域首选项（模拟 sensenova 挂了）
const onlyHy4 = R.selectRoute('vision', { freePool: ['workbuddy/hy4flash-free'], config: PERMISSIVE })
t('免费池不含 vision 首选 → 降级 paid', onlyHy4.tier === 'paid' && triple(onlyHy4) === EXPECT.vision.paid, `${onlyHy4.tier} ${triple(onlyHy4)}`)
t('  被跳过的首选项留在 tried 里', onlyHy4.tried.some((x) => /sensenova-6-8-flash-lite/.test(x)), onlyHy4.tried.join(' '))
// available 白名单只给 last 档 → 必须落到 last
const onlyLast = R.selectRoute('code', { available: ['workbuddy/deepseek-v4-pro'], config: PERMISSIVE })
t('available 只留 last → 落到 last 档', onlyLast.tier === 'last' && triple(onlyLast) === EXPECT.code.last, `${onlyLast.tier} ${triple(onlyLast)}`)

/* ── 5. 未知能力域 → 回落默认域 ────────────────────────────────── */
console.log('\n[5] 未知能力域 → 回落默认域（不抛、不乱猜贵模型）')
const DEFAULT_WANT = EXPECT[R.DEFAULT_DOMAIN].free
for (const bad of ['kaleidoscope', '', '   ', null, undefined, 'unknown-domain']) {
  let got
  let threw = null
  try { got = R.selectRoute(bad) } catch (e) { threw = e }
  t(`未知域 ${JSON.stringify(bad)} 不抛异常`, threw === null, threw && threw.message)
  if (!got) continue
  t(`  回落 domain=${R.DEFAULT_DOMAIN}`, got.domain === R.DEFAULT_DOMAIN, got.domain)
  t('  标 fellBackDomain=true', got.fellBackDomain === true)
  t('  三元组 = 默认域免费首选', triple(got) === DEFAULT_WANT, triple(got))
  t('  reason 说明回落', /回落/.test(got.reason), got.reason)
}
t('别名 forensics → probe（不是回落）', R.selectRoute('forensics').domain === 'probe' && R.selectRoute('forensics').fellBackDomain === false)
t('别名 fast → quick', R.selectRoute('fast').domain === 'quick')
t('成员域 maker → code', R.selectRoute('maker').domain === 'code')
t('成员域 auditor → audit', R.selectRoute('auditor').domain === 'audit')
t('成员域 architect → audit', R.selectRoute('architect').domain === 'audit')
t('大小写/空白归一（" CODE " → code）', R.selectRoute('  CODE  ').domain === 'code')

/* ── 6. effort 白名单夹取 ─────────────────────────────────────── */
console.log('\n[6] effort 白名单夹取（宿主要求，非法值会被 dsh-team-control 拒）')
t('raccoon 传 high → 夹成 on', R.clampEffort({ provider: 'raccoon', model: 'sn-sensenova-6-8-flash', reasoningEffort: 'high' }) === 'on')
t('raccoon 不传 → 默认 on', R.clampEffort({ provider: 'raccoon', model: 'sn-sensenova-6-8-flash' }) === 'on')
t('qodercn/qfmodel 传 xhigh 合法', R.clampEffort({ provider: 'qodercn', model: 'qfmodel', reasoningEffort: 'xhigh' }) === 'xhigh')
t('qodercn/qfmodel 传 high（非法）→ 回落 medium', R.clampEffort({ provider: 'qodercn', model: 'qfmodel', reasoningEffort: 'high' }) === 'medium')
t('无白名单 route 不强加 effort', R.clampEffort({ provider: 'cline', model: 'meta/muse-ember', reasoningEffort: 'high' }) === 'high')
// 新优先级下 audit 首选变成主力 deepseek-v4.1-flash（effort 白名单 low/high/max），不再是 qfmodel
t('入口传非法/合法 effort 都被夹进取选模型的白名单', (() => {
  const s = R.selectRoute('audit', { reasoningEffort: 'high' })
  const allow = R.EFFORTS[`${s.provider}/${s.model}`]
  return !allow || allow.length === 0 || allow.includes(s.reasoningEffort)
})(), (() => { const s = R.selectRoute('audit', { reasoningEffort: 'high' }); return `${s.provider}/${s.model}/${s.reasoningEffort}` })())

/* ── 7. 窗口表：有依据大值，未标注 128K 保守 ───────────────────── */
console.log('\n[7] 窗口表：官方/description 才用大值，未标注一律 128K 保守（docs\\108 §1）')
t('DEFAULT_WINDOW = 128000', R.DEFAULT_WINDOW === 128000, R.DEFAULT_WINDOW)
t('windowOf(v4.1-flash) = 1M（官方）', R.windowOf('workbuddy/deepseek-v4.1-flash') === 1000000, R.windowOf('workbuddy/deepseek-v4.1-flash'))
t('windowOf(sn-deepseek-v4-1-flash-1017) = 1M（官方）', R.windowOf('raccoon/sn-deepseek-v4-1-flash-1017') === 1000000)
t('windowOf(deepseek-flash) = 1M（官方）', R.windowOf('deepseek-official/deepseek-flash') === 1000000)
t('windowOf(v4-pro) = 1M（官方）', R.windowOf('deepseek-official/deepseek-v4-pro') === 1000000)
t('windowOf(未标注 sn-glm-5-3) = 128K（无实测、不套官方，回落保守）', R.windowOf('raccoon/sn-glm-5-3') === 128000)
// docs\109 实测：sensenova-flash 从保守 128K 上调为实测下限 469000（不再是 128K）
t('windowOf(sensenova-flash) = 469000（docs\\109 §2.3 实测下限，不再保守 128K）', R.windowOf('raccoon/sn-sensenova-6-8-flash') === 469000)
// docs\109 实测：qfmodel 从保守 128K 上调为实测下限 971000
t('windowOf(qodercn/qfmodel) = 971000（docs\\109 §2.1 实测下限，转发商不套官方）', R.windowOf('qodercn/qfmodel') === 971000)
// lite 证据不足，维持 128K 不动（不能因兄弟模型 469K 就跟着上调）
t('windowOf(lite) = 128000（docs\\109 §2.4 仅证实 29,987，维持保守不动）', R.windowOf('raccoon/sn-sensenova-6-8-flash-lite') === 128000)
t('windowOf(完全未知 route) = 128K（不返回 null）', R.windowOf({ provider: 'x', model: 'y' }) === 128000)
t('windowOf 支持 override', R.windowOf('workbuddy/deepseek-v4.1-flash', { 'workbuddy/deepseek-v4.1-flash': 200000 }) === 200000)
t('windowSourceOf(v4.1-flash) = official', R.windowSourceOf('workbuddy/deepseek-v4.1-flash') === 'official')
// docs\109 三条改成 measured 来源；未标注样本换成仍未实测的 sn-glm-5-3 验证 conservative 回落
t('windowSourceOf(sn-glm-5-3 未标注) = conservative', R.windowSourceOf('raccoon/sn-glm-5-3') === 'conservative')
t('窗口表里没有 null（null 会让调用方误判为"无法判定"而放行）',
  Object.values(R.CONTEXT_WINDOW).every((v) => typeof v === 'number' && v > 0))

/* ── 8. fitCheck 三态边界（docs\108 §6 判据 1 的三个具体数字）──── */
console.log('\n[8] fitCheck 三态边界（1M 窗口：700K safe / 750K compress-first / 900K reject）')
const V41 = 'workbuddy/deepseek-v4.1-flash'
t('700000 → safe（700K×1.1=770K ≤ 800K）', R.fitCheck(V41, 700000).state === 'safe', JSON.stringify(R.fitCheck(V41, 700000)))
t('750000 → compress-first（750K≤800K 但 825K>800K）', R.fitCheck(V41, 750000).state === 'compress-first', JSON.stringify(R.fitCheck(V41, 750000)))
t('900000 → reject（900K > 800K）', R.fitCheck(V41, 900000).state === 'reject', JSON.stringify(R.fitCheck(V41, 900000)))
t('state 与 level 双写（旧名 compress 仍可用）', R.fitCheck(V41, 750000).level === 'compress')
t('返回带 ok/required/window/ratio/reason 五件套',
  ['ok', 'required', 'window', 'ratio', 'reason'].every((k) => k in R.fitCheck(V41, 700000)))
t('safe 时 ok=true', R.fitCheck(V41, 700000).ok === true)
t('reject 时 ok=false', R.fitCheck(V41, 900000).ok === false)
t('返回 required = needed×1.1', Math.abs(R.fitCheck(V41, 700000).required - 770000) < 1, R.fitCheck(V41, 700000).required)
t('返回 allowed = window×0.8', Math.abs(R.fitCheck(V41, 700000).allowed - 800000) < 1, R.fitCheck(V41, 700000).allowed)
t('接受 route 对象与 key 字符串两种入参', R.fitCheck({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, 700000).state === 'safe')
// 样本换成仍维持 128K 的 lite（sensenova-flash 已按 docs\109 上调到 469K，装 200K 变 safe，不能当 128K 反例）
t('128K(lite) 模型装 200K → reject', R.fitCheck('raccoon/sn-sensenova-6-8-flash-lite', 200000).state === 'reject')
t('128K(lite) 模型装 50K → safe', R.fitCheck('raccoon/sn-sensenova-6-8-flash-lite', 50000).state === 'safe')
t('FIT 常量是 docs\\108 §3 的三个数',
  R.FIT.SAFETY_HEADROOM === 1.1 && R.FIT.WINDOW_USAGE === 0.8 && R.FIT.COMPRESS_THRESHOLD === 0.6,
  JSON.stringify(R.FIT))

/* ── 9. selectRoute 按窗口过滤（拒绝硬切）─────────────────────────
 * 同 [4]：这一组测窗口维度，用 PERMISSIVE 配置避免倍率门槛提前把 workbuddy 挡掉。
 */
console.log('\n[9] selectRoute 窗口感知：不足的候选被跳过，而不是选后失败')
const SEL = (domain, opts) => R.selectRoute(domain, { config: PERMISSIVE, ...opts })
// ① 500K：免费项（128K）装不下 → 必须跳 paid（V4.1 1M）
const r500 = SEL('code', { neededTokens: 500000 })
t('code@500K → 跳过免费项落到 paid', r500.tier === 'paid' && /deepseek-v4\.1-flash/.test(r500.model), `${r500.tier} ${r500.provider}/${r500.model}`)
t('  → fit.state=safe（装得下才选它）', r500.fit.state === 'safe', JSON.stringify(r500.fit))
t('  → contextRejected 记录被跳过的免费项', r500.contextRejected.includes('raccoon/sn-sensenova-6-8-flash'), JSON.stringify(r500.contextRejected))
// 新优先级主力先命中即返回：被窗口淘汰的免费项记在 contextRejected（不是 tried），二者至少一处给得出审计线索
t('  → 窗口不足有审计线索（contextRejected 或 tried）',
  (r500.contextRejected || []).length > 0 || (r500.tried || []).some((x) => /窗口不足|window/.test(x)),
  `rejected=${JSON.stringify(r500.contextRejected)} tried=${r500.tried.join(' | ')}`)
t('  → 未耗尽时 contextExhausted=false', r500.contextExhausted === false)
// ② 小上下文：免费项装得下 → 仍选免费（不能一律跳付费）
const r50 = SEL('code', { neededTokens: 50000 })
// 新四级：主力优先，小上下文也先选主力（不再"先免费"）；装不下才降档
t('code@50K → 首选主力档（paid · deepseek-v4.1-flash）', r50.tier === 'paid' && R.isPrimaryModel(r50.model), `${r50.tier} ${r50.model}`)
t('  → fit.state=safe', r50.fit.state === 'safe')
// ③ 750K：免费 reject、paid 进 compress-first → 返回 paid（档位顺序，不越档）
const r750 = SEL('code', { neededTokens: 750000 })
t('code@750K → 仍是 paid（档位顺序，不越到 backup）', r750.tier === 'paid', `${r750.tier} ${r750.fit.state}`)
// ④ 950K：paid 的 V4.1（1M）在 950K×1.1=1045K > 800K → 全 reject
const r950 = SEL('code', { neededTokens: 950000 })
t('code@950K → 全链 reject（1M 也装不下）', r950.fit.state === 'reject', r950.fit.state)
t('  → contextExhausted=true', r950.contextExhausted === true)
t('  → fit.ok 必须是 false（不许装成功）', r950.fit.ok === false, String(r950.fit.ok))
t('  → reason 说清是窗口不足', /装不下|窗口/.test(r950.reason), r950.reason)
t('  → contextRejected 列出全部四档', r950.contextRejected.length === 4, JSON.stringify(r950.contextRejected))
// ⑤ 不传 neededTokens → state=unknown 且行为与旧版一致（仍选免费首选）
const rNone = R.selectRoute('code')
t('不传 neededTokens → state=unknown（不假装安全）', rNone.state === 'unknown', rNone.state)
t('  → 仍选免费首选（向后兼容）', rNone.tier === 'free' && rNone.model === 'sn-sensenova-6-8-flash', `${rNone.tier}/${rNone.model}`)
// ⑥ contextWindows 注入覆盖生效
const rOv = SEL('code', { neededTokens: 500000, contextWindows: { 'workbuddy/deepseek-v4.1-flash': 400000, 'raccoon/sn-deepseek-v4-1-flash-1017': 2000000 } })
t('contextWindows 覆盖：V4.1 被压到 400K 装不下 → 落到 backup', rOv.tier === 'backup', `${rOv.tier} ${rOv.windowSource}`)
t('  → windowSource=override', rOv.windowSource === 'override', rOv.windowSource)
// ⑦ 返回体字段齐全
t('返回体带 windowSource / state / fit / contextWindow',
  ['windowSource', 'state', 'fit', 'contextWindow'].every((k) => k in r500))
// ⑧ tiers 限档（audit.last 是 official 的 pro，不受 workbuddy cap 影响）
const tLast = R.selectRoute('audit', { tiers: ['last'] })
t('opts.tiers 限档生效（audit 只许 last）', tLast.tier === 'last' && /deepseek-v4-pro/.test(tLast.model), `${tLast.tier}/${tLast.model}`)

/* ── 10. estimateNeeded ───────────────────────────────────────── */
console.log('\n[10] estimateNeeded：当前占用 + brief + 域余量（docs\\108 §2.3）')
const est = R.estimateNeeded('code', 400000, { subject: '做一个活', plan: [{ detail: '读文件' }], acceptance: '全绿' })
t('neededTokens = current + brief + overhead', est.neededTokens === 400000 + est.breakdown.briefTokens + 8192, JSON.stringify(est))
t('code 域 overhead = 8192', est.breakdown.overhead === 8192)
t('audit 域 overhead = 16384', R.estimateNeeded('audit', 0, {}).breakdown.overhead === 16384)
t('中文按 1 字 1 token（"做一个活" = 4）', R.estimateNeeded('quick', 0, { subject: '做一个活' }).breakdown.briefTokens === 4)
t('currentTokens 缺省按 0', R.estimateNeeded('quick', null, { subject: '' }).breakdown.currentTokens === 0)

/* ── 11. 能力基线 role 文本 ───────────────────────────────────── */
console.log('\n[11] 能力基线 role（docs\\102 §3.1，写进成员 role）')
const makerRoute = R.selectRoute('maker')
const roleText = R.capabilityRole('maker', '干活', makerRoute)
t('role 含域名 maker（domainOwned 要能认）', /maker/.test(roleText), roleText)
t('role 含任务域 code', /\|code\|/.test(roleText), roleText)
t('role 含擅长清单', /擅长：/.test(roleText) && /改代码/.test(roleText))
t('role 含模态', /模态：text\+image/.test(roleText), roleText)
t('role 含模型 key', /模型：raccoon\/sn-sensenova-6-8-flash/.test(roleText), roleText)
const parsed = R.parseCapabilityRole(roleText)
t('parse 回读 memberDomain=maker', parsed.memberDomain === 'maker')
t('parse 回读 taskDomain=code', parsed.taskDomain === 'code')
t('parse 回读 skills', parsed.skills.includes('改代码'), parsed.skills.join(','))
t('parse 回读 model', parsed.model === 'raccoon/sn-sensenova-6-8-flash', parsed.model)
t('未知成员域不抛且记录实际任务域', (() => {
  try {
    const p = R.parseCapabilityRole(R.capabilityRole('mystery', '杂活', R.selectRoute('quick')))
    return p.memberDomain === 'mystery' && p.taskDomain === R.DEFAULT_DOMAIN
  } catch { return false }
})())

/* ── 12. S2_5 集成：真用 selectRoute，不硬编码 ─────────────────── */
console.log('\n[12] 集成：S2_5 补齐成员时用 selectRoute 自动选路')

function stubFetch(routes) {
  const orig = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = String(url && url.url ? url.url : url)
    const parsed = new URL(u, 'http://x')
    const method = (init && init.method) || 'GET'
    const key = `${method} ${parsed.pathname}`
    let body = null
    if (init && init.body) { try { body = JSON.parse(init.body) } catch { body = init.body } }
    calls.push({ key, body, path: parsed.pathname })
    const hit = routes[key] !== undefined ? routes[key] : routes[parsed.pathname]
    if (hit === undefined) {
      const errBody = JSON.stringify({ error: `not stubbed: ${key}` })
      return { ok: false, status: 404, json: async () => JSON.parse(errBody), text: async () => errBody }
    }
    const out = typeof hit === 'function' ? hit({ method, body, path: parsed.pathname }) : hit
    const bodyText = JSON.stringify(out)
    return { ok: true, status: 200, json: async () => JSON.parse(bodyText), text: async () => bodyText }
  }
  return { restore: () => { globalThis.fetch = orig }, calls }
}

async function runS25({ members = [], created = true, freeDisabled = false, config = null }) {
  const Reg = await import('../lib/orchestrator/registry.mjs')
  const P = await import('../lib/orchestrator/pipeline.mjs')
  const sceneId = 'verify-routes-s25-' + Math.random().toString(36).slice(2, 8)
  const added = await Reg.addScenario({
    id: sceneId, name: 'S2_5 选路验证', kind: 'general',
    workspace: 'D:\\软件\\DSH\\用户数据', presetId: 'ai-team',
  })
  if (!added.ok) throw new Error('临时场景注册失败：' + JSON.stringify(added.errors))
  await Reg.updateScenario(sceneId, { teamId: 'team_route_stub' })
  const store = { items: members.slice() }
  const { restore, calls } = stubFetch({
    'GET /api/teams/team_route_stub/members': () => ({ items: store.items }),
    'GET /api/teams': { items: [{ id: 'team_route_stub', maxMembers: 8 }] },
    'POST /api/teams/team_route_stub/members': ({ body }) => {
      if (!created) return { error: 'stub 拒绝建成员' }
      const m = {
        id: 'm_' + String(body.name).toLowerCase(), teamId: 'team_route_stub',
        name: body.name, role: body.role, status: 'idle', agentSessionId: null,
        agentProvider: body.agentProvider ?? null, model: body.model ?? null,
        reasoningEffort: body.reasoningEffort ?? null, blockers: [],
      }
      store.items.push(m)
      return { member: m }
    },
    'PATCH /api/members/m_existing': ({ body }) => ({ ok: true, patch: body }),
  })
  try {
    const out = await P.runPipeline(sceneId, { from: 'S2_5', to: 'S2_5', freeDisabled, ...(config ? { routeConfig: config } : {}) })
    const step = out.steps.find((s) => s.step === 'S2_5') || null
    return { out, step, calls }
  } finally {
    restore()
    await Reg.removeScenario(sceneId).catch(() => null)
  }
}

{
  const { step, calls } = await runS25({ members: [] })
  t('S2_5 跑到 ok（三人建齐）', Boolean(step) && step.ok === true, step && step.detail)
  const posts = calls.filter((c) => c.key === 'POST /api/teams/team_route_stub/members').map((c) => c.body)
  t('建了 3 条成员记录', posts.length === 3, posts.length)
  const byName = Object.fromEntries(posts.map((b) => [b.name, b]))
  // 新四级：主力(paid)优先，成员选路不再锁死具体 provider/model（qodercn 已被禁）
  t('maker 用 code 链选到过 gate 的主力/可用通道', byName.maker
    && byName.maker.agentProvider && byName.maker.model
    && R.gateRoute({ provider: byName.maker.agentProvider, model: byName.maker.model }, R.resolveConfig({})).allowed,
    byName.maker && `${byName.maker.agentProvider}/${byName.maker.model}/${byName.maker.reasoningEffort}`)
  t('architect 用 audit 链选到过 gate 的通道（不再是写死的 qodercn）', byName.architect
    && byName.architect.agentProvider && byName.architect.model
    && R.gateRoute({ provider: byName.architect.agentProvider, model: byName.architect.model }, R.resolveConfig({})).allowed,
    byName.architect && `${byName.architect.agentProvider}/${byName.architect.model}`)
  t('三条记录都给 provider/model/effort 三元组', posts.every((b) => b.agentProvider && b.model && b.reasoningEffort))
  t('role 带能力基线（擅长：）', posts.every((b) => /擅长：/.test(String(b.role))))
  t('step.detail 说清选了哪个模型', /选路/.test((step && step.detail) || ''), step && step.detail)
}
{
  const { calls } = await runS25({ members: [], freeDisabled: true, config: PERMISSIVE })
  const posts = calls.filter((c) => c.key === 'POST /api/teams/team_route_stub/members').map((c) => c.body)
  const byName = Object.fromEntries(posts.map((b) => [b.name, b]))
  t('freeDisabled（无 workbuddy cap）：maker 走 paid 的 V4.1',
    byName.maker && byName.maker.agentProvider === 'workbuddy' && byName.maker.model === 'deepseek-v4.1-flash',
    byName.maker && `${byName.maker.agentProvider}/${byName.maker.model}`)
  t('freeDisabled：architect 走 audit paid（deepseek-flash，V4.1）',
    byName.architect && byName.architect.model === 'deepseek-flash',
    byName.architect && `${byName.architect.agentProvider}/${byName.architect.model}`)
}
{
  const existing = [
    { id: 'm_existing', teamId: 'team_route_stub', name: 'maker', role: '干活', status: 'idle', agentSessionId: 'sid-x', blockers: [] },
    { id: 'm_arch', teamId: 'team_route_stub', name: 'architect', role: '造规则', status: 'idle', agentSessionId: 'sid-y', blockers: [] },
    { id: 'm_aud', teamId: 'team_route_stub', name: 'auditor', role: '验活', status: 'idle', agentSessionId: 'sid-z', blockers: [] },
  ]
  const { step, calls } = await runS25({ members: existing })
  t('编制齐全 → S2_5 ok', Boolean(step) && step.ok === true, step && step.detail)
  const patches = calls.filter((c) => c.key.startsWith('PATCH /api/members/'))
  t('对缺能力基线的已有成员发 PATCH role', patches.length >= 1, patches.map((c) => c.key).join('、'))
  t('PATCH 只改 role（不重建会话）', patches.every((c) => Object.keys(c.body || {}).join(',') === 'role'))
  t('已有成员不重复建记录', calls.filter((c) => c.key === 'POST /api/teams/team_route_stub/members').length === 0)
}

/* ── 13. 变异反证：neededTokens 判定不能被架空 ───────────────────
 * 这一组由 verify-mut-routes 之外的口径兜底：如果 selectRoute 无视
 * neededTokens（恒判 safe / 恒判通过），下面三条会同时倒。
 * 写法刻意不依赖任何内部函数，只依赖对外返回的 state。
 */
console.log('\n[13] 变异反证：neededTokens 必须真的改变结果')
{
  const huge = R.selectRoute('code', { neededTokens: 9000000 })
  const small = R.selectRoute('code', { neededTokens: 1000 })
  t('超大上下文 → reject', huge.state === 'reject', huge.state)
  t('小上下文 → safe 且选免费', small.state === 'safe' && small.tier === 'free', `${small.state}/${small.tier}`)
  t('同一域两种需求给出不同 state（判定不是恒值）', huge.state !== small.state, `${huge.state} vs ${small.state}`)
  t('同一域两种需求给出不同 tier', huge.tier !== small.tier || huge.state === 'reject', `${huge.tier} vs ${small.tier}`)
  // 逐档推进：需求从 50K 涨到 900K，tier 必须单调不升（不会从 paid 回免费）
  const ladder = [50000, 500000, 900000].map((n) => R.selectRoute('code', { neededTokens: n }))
  t('需求变大时档位不会倒退回更便宜的档',
    ladder.every((r, i) => i === 0 || r.tier !== 'free' || ladder[i - 1].tier === 'free'),
    ladder.map((r) => `${r.tier}:${r.state}`).join(' → '))
  // fitCheck 直测：同一 route 不同需求必须给出不同态
  const fitLadder = [100000, 750000, 900000].map((n) => R.fitCheck(V41, n).state)
  t('fitCheck 三档需求 → 三种态', new Set(fitLadder).size === 3, fitLadder.join(','))
}

/* ── 输出 ─────────────────────────────────────────────────────── */
/* ── 14. latestUsage：当前占用的取值口径（docs\108 §2.1/§2.2）────── */
console.log('\n[14] latestUsage：当前占用要取 totalTokens，不是 inputTokens')
const { latestUsage } = await import('../lib/orchestrator/transcript.mjs')
{
  // 真实形状（本团队 architect 会话实测）：inputTokens 2224 但 totalTokens 182207
  const msgs = [
    { seq: 1, role: 'user', text: 'hi', usage: null },
    { seq: 2, role: 'assistant', text: 'a', usage: { inputTokens: 8171, outputTokens: 900, totalTokens: 150298, cacheReadTokens: 141000 } },
    { seq: 3, role: 'user', text: 'again', usage: null },
    { seq: 4, role: 'assistant', text: 'b', usage: { inputTokens: 2224, outputTokens: 527, totalTokens: 182207, cacheReadTokens: 179456 } },
  ]
  const u = latestUsage(msgs)
  t('取最近一条非空 usage（不是第一条）', u && u.seq === 4, u && u.seq)
  t('contextTokens 用 totalTokens（182207），不是 inputTokens（2224）', u && u.contextTokens === 182207, u && u.contextTokens)
  t('usedAs 标明口径', u && u.usedAs === 'totalTokens', u && u.usedAs)
  t('原样带回四个原始字段', u && u.inputTokens === 2224 && u.cacheReadTokens === 179456 && u.outputTokens === 527)
  t('totalTokens 缺失时用 input+cacheRead 近似', (() => {
    const x = latestUsage([{ seq: 1, usage: { inputTokens: 1000, cacheReadTokens: 5000 } }])
    return x && x.contextTokens === 6000 && x.usedAs === 'inputTokens+cacheReadTokens'
  })())
  t('没有 usage → 返回 null（会话太新）', latestUsage([{ seq: 1, usage: null }]) === null)
  t('空数组 → null', latestUsage([]) === null)
  t('usage 是空壳对象时继续往前找', (() => {
    const x = latestUsage([
      { seq: 1, usage: { inputTokens: 10, totalTokens: 100 } },
      { seq: 2, usage: {} },
    ])
    return x && x.seq === 1 && x.contextTokens === 100
  })())
  t('非数组入参不抛', (() => { try { return latestUsage(null) === null } catch { return false } })())
}

/* ── 15. op=route-fit 的占用口径：三路优先（docs\109）─────────────
 * 为什么加这一节：Lead（主会话）在 session 日志里**没有 usage**——以前一律「拿不到占用」，
 * 于是面板上整条链没有窗口结论（明明 GUI 圆环里就有 39 万）。现在顺序改为：
 *   ① token-meter 投影 pressureTokens/projectedTokens（口径同 tools\lead-context.mjs）
 *   ② 会话日志 usage.totalTokens（成员会话）
 *   ③ 都没有 → note，**不填 0**（0 会让所有候选判 safe，正好最危险）
 */
console.log('\n[15] op=route-fit 占用口径：投影缓存 → 会话日志 → 明说无数据（不填 0）')
{
  const { readFileSync } = await import('node:fs')
  const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const SESSRC = readFileSync(new URL('../lib/orchestrator/sessionUsage.mjs', import.meta.url), 'utf8')
  const PRESRC = readFileSync(new URL('../lib/orchestrator/pressure.mjs', import.meta.url), 'utf8')

  t('index.js 有 op === \'route-fit\' 分支', /op === 'route-fit'/.test(SRC))
  t('route-fit 走 SessionUsage.resolveUsage（唯一取数入口，不另造一套）', /SessionUsage\.resolveUsage/.test(SRC))
  t('resolveUsage 先读投影缓存（Pressure.readPressure）', /Pressure\.readPressure/.test(SESSRC))
  t('resolveUsage 再退会话日志（readTranscript + latestUsage）', /Transcript\.readTranscript/.test(SESSRC) && /Transcript\.latestUsage/.test(SESSRC))
  t('resolveUsage 回传 usedField 与 windowSource', /usedField/.test(SESSRC) && /windowSource/.test(SESSRC))
  t('pressure.mjs 口径照搬 lead-context：pressure + surface - sampled', /pressureTokens \+ surfaceTokens - sampled/.test(PRESRC))
  t('pressure.mjs 的 usedTokens 用 projected 优先', /projectedTokens \?\? pressureTokens/.test(PRESRC))
  t('该分支用 Routes.routeChain 算每档 fit', /Routes\.routeChain/.test(SRC))
  t('实测 contextWindow 通过 contextWindows 覆盖注入', /contextWindows: winOv/.test(SRC))
  t('拿不到占用时写 note、不填 0', /不填 0/.test(SRC) && /currentTokens != null/.test(SRC))
  t('op=routes 也透传 neededTokens', /neededTokens/.test(SRC))

  // —— 真实 Lead 会话实测（只读本机投影缓存；读不到就退化成「不崩」断言，不假报红）——
  const { resolveUsage } = await import('../lib/orchestrator/sessionUsage.mjs')
  const LEAD = process.env.LEAD_SESSION_ID || 'session-6e33f884-2cb3-4fe3-9e26-d86cf97af24d'
  const ALLOWED_FIELDS = new Set(['projectedTokens', 'pressureTokens', 'totalTokens', 'inputTokens+cacheReadTokens'])
  const lead = await resolveUsage(LEAD)
  if (lead.ok) {
    t('Lead 会话拿到非空占用数值', typeof lead.currentTokens === 'number' && lead.currentTokens > 0, lead.currentTokens)
    t('Lead 占用是 10 万以上量级（实测 39 万级，不是 inputTokens 级别）', lead.currentTokens > 100000, lead.currentTokens)
    t('usedField 在允许集合内', ALLOWED_FIELDS.has(String(lead.usedField)), lead.usedField)
    t('windowSource 标明来源（session-projcache / session-log）', lead.windowSource === 'session-projcache' || lead.windowSource === 'session-log', lead.windowSource)
    t('Lead 走的是投影缓存这一路', lead.source === 'projcache', lead.source)
    t('实测窗口随行带回（用于覆盖路由表默认值）', typeof lead.contextWindow === 'number' && lead.contextWindow > 0, lead.contextWindow)
  } else {
    console.log(`  （本机读不到 ${LEAD} 的投影缓存：${lead.reason} → 只断言「取不到时不崩、不填 0」）`)
    t('Lead 会话取不到时是 reason + null，不是 0', lead.currentTokens === null && typeof lead.reason === 'string', JSON.stringify({ reason: lead.reason, v: lead.currentTokens }))
    t('取不到时不编造 usedField', lead.usedField === null)
  }

  // —— 反向：必然不存在的会话必须 null + reason，而不是 0 ——
  const none = await resolveUsage('session-does-not-exist-for-verify')
  t('不存在的会话：ok=false 且 currentTokens=null（绝不填 0）', none.ok === false && none.currentTokens === null, JSON.stringify({ ok: none.ok, v: none.currentTokens }))
  t('不存在的会话：不编造 usedField/windowSource', none.usedField === null && none.windowSource === null)
  t('不存在的会话：带 reason 说明为什么没有', typeof none.reason === 'string' && none.reason.length > 0, none.reason)
}

/* ══ 16. 倍率门槛：workbuddy cap=0 养号，但绝不能误伤别的 provider ══
 * 用户口径（2026-11-21）：**别烧 WorkBuddy 积分、要养号**，不是「一分钱不花」。
 * 所以停用粒度是 route 不是 provider：hy4flash-free（x0.00）必须留，
 * deepseek-v4.1-flash（x0.11）必须挡；deepseek-official 不许被全局 cap 误伤。
 */
console.log('\n[16] 倍率/provider 门槛：workbuddy 只留 x0.00，别的 provider 不受误伤')

// ① 默认配置的形状
t('默认 providerMultiplierCap 里 workbuddy = 0', R.DEFAULT_CONFIG.providerMultiplierCap.workbuddy === 0, JSON.stringify(R.DEFAULT_CONFIG.providerMultiplierCap))
t('默认 maxMultiplier 是宽松值 0.6（不做全局一刀切）', R.DEFAULT_CONFIG.maxMultiplier === 0.6, R.DEFAULT_CONFIG.maxMultiplier)
t('默认 disabledProviders 为空（不再整条通道停用）', Array.isArray(R.DEFAULT_CONFIG.disabledProviders) && R.DEFAULT_CONFIG.disabledProviders.length === 0)
t('默认 disabledRoutes 含 2 条已 EOL 路由（不是靠倍率未知被动排除）',
  Array.isArray(R.DEFAULT_CONFIG.disabledRoutes)
  && R.DEFAULT_CONFIG.disabledRoutes.includes('our-free-model/deepseek-ai/deepseek-v4.1-flash')
  && R.DEFAULT_CONFIG.disabledRoutes.includes('our-free-model/openai/gpt-oss-20b'),
  JSON.stringify(R.DEFAULT_CONFIG.disabledRoutes))

// ② 倍率解析：从 name 原文解析，解析不到 = null（保守排除）
t('parseMultiplier("Hy4 flash · x0.00") = 0', R.parseMultiplier('Hy4 flash · x0.00') === 0)
t('parseMultiplier("GLM-5.3-Flash · x0.08") = 0.08', R.parseMultiplier('GLM-5.3-Flash · x0.08') === 0.08)
t('parseMultiplier("DeepSeek-V4-Pro · x0.51") = 0.51', R.parseMultiplier('DeepSeek-V4-Pro · x0.51') === 0.51)
t('parseMultiplier("DeepSeek-V4.1-Flash · 宽裕") = null（无 x 数字）', R.parseMultiplier('DeepSeek-V4.1-Flash') === null)
t('parseMultiplier(空/undefined) = null', R.parseMultiplier(null) === null && R.parseMultiplier('') === null)
t('倍率未知的 route：multiplierOf 返回 null', R.multiplierOf({ provider: 'nope', model: 'nope' }) === null)
// **关键守卫**：倍率未知 —— 非免费 provider 仍必须被排除；已知免费 provider 则推断按 0 放行。
// 少这两组断言，「未知一律当 0 放行」和「免费 provider 仍被误杀」两种变异都抓不到。
const unknownGate = R.gateRoute({ provider: 'nope', model: 'nope' }, R.resolveConfig({}))
t('倍率未知 + 非免费 provider → gateRoute allowed=false（保守排除）', unknownGate.allowed === false, JSON.stringify(unknownGate))
t('  → blockedBy=multiplier-unknown', unknownGate.blockedBy === 'multiplier-unknown', unknownGate.blockedBy)
t('  → reason 点明不许当 0 放行', /未知|保守/.test(unknownGate.reason || ''), unknownGate.reason)
// 2026-11-21 规则修正：已知免费 provider 的未登记项 → 推断 0，放行并标 inferred
t('KNOWN_FREE_PROVIDERS 含 our-free-model/raccoon/qodercn/workbuddy',
  ['our-free-model', 'raccoon', 'qodercn', 'workbuddy'].every((p) => R.isKnownFreeProvider(p)))
t('isKnownFreeProvider 对非免费 provider 返回 false',
  R.isKnownFreeProvider('nope') === false && R.isKnownFreeProvider('deepseek-official') === false)
const inferredGate = R.gateRoute({ provider: 'raccoon', model: 'some-unlisted-free-model' }, R.resolveConfig({}))
t('倍率未知 + 已知免费 provider(raccoon) → allowed=true（不再误杀）', inferredGate.allowed === true, JSON.stringify(inferredGate))
t('  → multiplier=0 且 multiplierInferred=true', inferredGate.multiplier === 0 && inferredGate.multiplierInferred === true, JSON.stringify(inferredGate))
const inferredOfm = R.gateRoute({ provider: 'our-free-model', model: 'unlisted-eac-model' }, R.resolveConfig({}))
t('倍率未知 + our-free-model → allowed=true 且 inferred', inferredOfm.allowed === true && inferredOfm.multiplier === 0 && inferredOfm.multiplierInferred === true, JSON.stringify(inferredOfm))
// 反证：若把未知一律当 0（含非免费 provider），第一条会倒；若免费 provider 仍保守排除，后几条会倒

// ③ 守卫断言：hy4flash-free（x0.00）必须在默认配置下可选
const hy4 = R.gateRoute({ provider: 'workbuddy', model: 'hy4flash-free' }, R.resolveConfig({}))
t('守卫：workbuddy/hy4flash-free 在默认 cap=0 下 allowed=true（x0.00 不被挡）', hy4.allowed === true, JSON.stringify(hy4))
t('  → 它的倍率是 0', hy4.multiplier === 0, String(hy4.multiplier))
t('  → capSource=provider（被 provider 级 cap 管）', hy4.capSource === 'provider', hy4.capSource)

// ④ 变异靶子：workbuddy/deepseek-v4.1-flash（x0.11）在 cap=0 下必须被排除
const v41wb = R.gateRoute({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, R.resolveConfig({}))
t('workbuddy/deepseek-v4.1-flash 在 cap=0 下 allowed=false', v41wb.allowed === false, JSON.stringify(v41wb))
t('  → blockedBy=provider-cap', v41wb.blockedBy === 'provider-cap', v41wb.blockedBy)
t('  → reason 说清是倍率超上限', /超过.*上限|上限/.test(v41wb.reason || ''), v41wb.reason)
// workbuddy 其余付费项同样被挡
for (const m of ['deepseek-v4-pro', 'glm-5.3-flash', 'glm-5.3', 'kimi-k3-1']) {
  t(`  workbuddy/${m} 同样被 cap=0 挡`, R.gateRoute({ provider: 'workbuddy', model: m }, R.resolveConfig({})).allowed === false)
}

// ⑤ 守卫断言：deepseek-official 不许被全局 cap 误伤（这是上一版方案的坑）
const dsFlash = R.gateRoute({ provider: 'deepseek-official', model: 'deepseek-flash' }, R.resolveConfig({}))
t('守卫：deepseek-official/deepseek-flash 不被排除（防全局 cap 误伤）', dsFlash.allowed === true, JSON.stringify(dsFlash))
t('  → 它走全局 cap 而非 provider cap', dsFlash.capSource === 'global', dsFlash.capSource)
t('守卫：deepseek-official/deepseek-v4-pro 也不被误伤', R.gateRoute({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, R.resolveConfig({})).allowed === true)
t('守卫：qodercn/qfmodel 不被误伤', R.gateRoute({ provider: 'qodercn', model: 'qfmodel' }, R.resolveConfig({})).allowed === true)
t('守卫：raccoon/sn-sensenova-6-8-flash 不被误伤', R.gateRoute({ provider: 'raccoon', model: 'sn-sensenova-6-8-flash' }, R.resolveConfig({})).allowed === true)

// ⑥ 全局 cap 真生效：调低到 0 时，x0.11 的 raccoon 项也被挡
const tight = R.resolveConfig({ maxMultiplier: 0 })
t('全局 maxMultiplier=0 → raccoon/sn-deepseek-v4-1-flash-1017（x0.25）被挡',
  R.gateRoute({ provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017' }, tight).allowed === false)
t('  → blockedBy=global-cap', R.gateRoute({ provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017' }, tight).blockedBy === 'global-cap')
t('全局 maxMultiplier=0 时 deepseek-official（x0 记无加价）仍可用',
  R.gateRoute({ provider: 'deepseek-official', model: 'deepseek-flash' }, tight).allowed === true)
// provider cap 优先于全局：workbuddy cap 抬到 0.2 后 x0.11 可过，即使全局是 0.6
const lifted = R.resolveConfig({ providerMultiplierCap: { workbuddy: 0.2 } })
t('provider cap 抬到 0.2 → workbuddy/deepseek-v4.1-flash（x0.11）可过',
  R.gateRoute({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, lifted).allowed === true)

// ⑦ disabledProviders / disabledRoutes 仍可用（手动拉黑）
t('disabledProviders 生效', R.gateRoute({ provider: 'workbuddy', model: 'hy4flash-free' },
  R.resolveConfig({ disabledProviders: ['workbuddy'] })).blockedBy === 'provider-disabled')
t('disabledRoutes 精确禁用单条', R.gateRoute({ provider: 'workbuddy', model: 'hy4flash-free' },
  R.resolveConfig({ disabledRoutes: ['workbuddy/hy4flash-free'] })).blockedBy === 'route-disabled')

// ⑦b our-free-model EAC：3 条实测可用过 gate、2 条 EOL 被 disabledRoutes 挡（2026-11-21）
const OFM_WIN = {
  'our-free-model/moonshotai/kimi-k3.1-pro': 1048576,
  'our-free-model/opencode/deepseek-v4.1-flash-free': 1048576,
  'our-free-model/stepfun-ai/step-5-preview': 131072,
}
for (const [key, win] of Object.entries(OFM_WIN)) {
  const [provider, ...rest] = key.split('/')
  const g = R.gateRoute({ provider, model: rest.join('/') }, R.resolveConfig({}))
  t(`${key} 过 gate（默认配置）`, g.allowed === true, JSON.stringify(g))
  t(`  → multiplier=0 且非 inferred（MULTIPLIER 已登记）`, g.multiplier === 0 && g.multiplierInferred === false, JSON.stringify(g))
  t(`  → 窗口=${win}`, R.windowOf({ provider, model: rest.join('/') }) === win, R.windowOf({ provider, model: rest.join('/') }))
  t(`  → 在 FREE_POOL 里`, keys.includes(key))
}
for (const eol of ['our-free-model/deepseek-ai/deepseek-v4.1-flash', 'our-free-model/openai/gpt-oss-20b']) {
  const [provider, ...rest] = eol.split('/')
  const g = R.gateRoute({ provider, model: rest.join('/') }, R.resolveConfig({}))
  t(`${eol} 被 disabledRoutes 挡（EOL，不是倍率未知）`, g.allowed === false && g.blockedBy === 'route-disabled', JSON.stringify(g))
}

// ⑧ selectRoute 在默认配置下的真实行为
const defSel = R.selectRoute('quick', { freeDisabled: true })
t('默认配置：quick 域 freeDisabled → 落到 raccoon（x0，workbuddy 被 cap 挡）',
  defSel.tier === 'backup' && /sn-deepseek-v4-1-flash-1017/.test(defSel.model), `${defSel.tier} ${defSel.provider}/${defSel.model}`)
t('  → gatedOut 里点明 workbuddy 被 provider-cap 挡', (defSel.gatedOut || []).some((x) => x.blockedBy === 'provider-cap'), JSON.stringify(defSel.gatedOut))
t('  → tried 里能读到被挡原因', defSel.tried.some((x) => /provider-cap|倍率/.test(x)), defSel.tried.join(' | '))
// 免费档在默认配置下仍能选（免费项倍率都是 0）
const defFree = R.selectRoute('code')
t('默认配置：免费档仍可选（倍率 0 不被挡）', defFree.tier === 'free', defFree.tier)

// ⑨ candidatePool：全盘候选 + 门槛结论（面板渲染用）
const poolRows = R.candidatePool({})
t('candidatePool 返回非空', poolRows.length > 0, poolRows.length)
t('candidatePool 里每条都带 multiplier 与 allowed', poolRows.every((r) => 'multiplier' in r && 'allowed' in r))
t('candidatePool 把可用项排在前面', (() => {
  const i = poolRows.findIndex((r) => !r.allowed)
  return i < 0 || poolRows.slice(0, i).every((r) => r.allowed)
})())
t('candidatePool 里 hy4flash-free 是 allowed', (() => {
  const h = poolRows.find((r) => r.key === 'workbuddy/hy4flash-free')
  return h && h.allowed === true
})())
t('candidatePool 里 v4.1-flash 被挡且写明原因', (() => {
  const h = poolRows.find((r) => r.key === 'workbuddy/deepseek-v4.1-flash')
  return h && h.allowed === false && h.blockedBy === 'provider-cap' && Boolean(h.gateReason)
})())

// ⑩ 配置读写往返（落盘 + 无 BOM + 坏 JSON 退默认）
{
  const os = await import('node:os')
  const nodePath = await import('node:path')
  const fs = await import('node:fs')
  const dir = nodePath.join(os.tmpdir(), 'verify-routes-cfg-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(dir, { recursive: true })
  const want = { maxMultiplier: 0.6, providerMultiplierCap: { workbuddy: 0, raccoon: 0.3 }, disabledProviders: [], disabledRoutes: ['x/y'], leadRoute: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } }
  const saved = await R.saveRouteConfig(want, dir)
  t('saveRouteConfig ok + verified', saved.ok === true && saved.verified === true, JSON.stringify(saved).slice(0, 200))
  const file = nodePath.join(dir, R.CONFIG_FILE)
  t('文件真的落盘', fs.existsSync(file))
  const bytes = fs.readFileSync(file)
  t('落盘无 BOM', !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${bytes[0]},${bytes[1]},${bytes[2]}`)
  const loaded = await R.loadRouteConfig(dir)
  t('loadRouteConfig 读回 source=file', loaded.source === 'file', loaded.source)
  t('读回 providerMultiplierCap 含 workbuddy:0 与 raccoon:0.3',
    loaded.config.providerMultiplierCap.workbuddy === 0 && loaded.config.providerMultiplierCap.raccoon === 0.3,
    JSON.stringify(loaded.config.providerMultiplierCap))
  t('读回 disabledRoutes 保留', loaded.config.disabledRoutes.includes('x/y'), JSON.stringify(loaded.config.disabledRoutes))
  // 坏 JSON → 退默认且不抛
  fs.writeFileSync(file, '{ 坏掉的 json', 'utf8')
  const bad = await R.loadRouteConfig(dir)
  t('坏 JSON → source=default-after-error（不抛）', bad.source === 'default-after-error' && bad.ok === true, bad.source)
  t('坏 JSON 时仍给可用默认（workbuddy cap=0）', bad.config.providerMultiplierCap.workbuddy === 0)
  // 带 BOM 的文件也能读
  fs.writeFileSync(file, '\ufeff' + JSON.stringify(want), 'utf8')
  const bomRes = await R.loadRouteConfig(dir)
  t('带 BOM 的配置文件能读（顺手挡 BOM）', bomRes.source === 'file' && bomRes.config.providerMultiplierCap.workbuddy === 0, bomRes.source)
  fs.rmSync(dir, { recursive: true, force: true })
  t('文件不存在 → source=default', (await R.loadRouteConfig(nodePath.join(dir, 'nope'))).source === 'default')
}

/* ── 17. op 层静态核对：route-config / provider-toggle / 面板区块 ──── */
console.log('\n[17] op 层与面板：route-config / provider-toggle / 模型配置页签（静态核对）')
{
  const { readFileSync } = await import('node:fs')
  const idx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  t('index.js 有 op=route-config 分支', /op === 'route-config'/.test(idx))
  t('route-config 支持 POST 写盘', /route-config'[\s\S]{0,400}POST/.test(idx) || /POST[\s\S]{0,40}route-config/.test(idx))
  t('route-config POST 只接受认识的键（不写任意字段）', /只接受认识的键/.test(idx))
  t('合并现有配置再写（不会只改一项就清空其它项）', /\.\.\.cur\.config/.test(idx))
  t('index.js 有 op=provider-toggle 分支', /op === 'provider-toggle'/.test(idx))
  t('provider-toggle 支持 provider + cap（推荐用法）', /provider-toggle'|cap \x3d\x3d\x3d undefined/.test(idx) && /设.*倍率上限|倍率上限设为/.test(idx))
  t('provider-toggle 支持 route 级拉黑', /body\.route/.test(idx) && /disabledRoutes/.test(idx))
  t('provider-toggle 支持 maxMultiplier', /body\.maxMultiplier/.test(idx))
  t('op=run 把盘上配置注入流水线（routeConfig）', /routeConfig: \(await routeConfig\(\)\)\.config/.test(idx))
  t('op=route-fit 用同一份配置算门槛', /cfgForFit/.test(idx))
  // v2：页签已按 docs\113 中文化精简（9→5），id=models / label=模型
  // 断言不再锁死旧标签名，改为锁「存在 TabModels 且其页签标签含『模型』」
  t('面板有模型页签（TabModels + 标签含「模型」）', /TabModels/.test(cli) && /label: '[^']*模型[^']*'/.test(cli))
  t('面板能显示倍率', /x' \+ \(r\.multiplier/.test(cli) || /multiplier/.test(cli))
  t('面板能显示被哪个 cap 挡住', /blockedBy/.test(cli) && /gateReason/.test(cli))
  // 术语中文化后「设 cap」改为「设上限」，锁语义不锁英文术语
  t('面板能按 provider 设价格上限', /设上限/.test(cli) && /provider-toggle/.test(cli))
  t('面板能改全局上限', /改全局上限/.test(cli))
  t('面板能停用/启用整条通道（层级概念修正，不再是「整厂」）', /停用整条通道/.test(cli) && /启用整条通道/.test(cli) && !/整厂停用|整厂启用/.test(cli))
  t('面板显示免费池今日可用', /免费池（实测可用/.test(cli))
  t('面板显示指挥模型推荐值（中文化后不锁英文 Lead）', /指挥模型/.test(cli) && /leadRoute/.test(cli))
}

/* ══ 18. docs\109 窗口真值 + raccoon/deepseek-official 禁用止血 ══════
 * 这一组锁的是本轮改动，每条都对应验收里的一个数字或一条硬约束：
 *   ① needed=394290（Lead 实测占用）下 qfmodel/hy4flash 判 safe、lite 判 reject
 *   ② windowSource=measured（与 official/conservative 区分）
 *   ③ 表值 = 实测最大成功 prompt_tokens − 300 向下取整到 K（证据自洽）
 *   ④ 贴边折扣 ×0.95（conservativeWindow 显式 opt-in，不改 fitCheck 基数）
 *   ⑤ disabledProviders 含 raccoon/deepseek-official → 这两个 provider 的任何
 *      route 都不可入选；变异靶：把 gateRoute 的 provider-disabled 判定改成
 *      恒 false（等于「谁都能过」），下面 18-④/⑤ 会同时报红。
 * 全程只用纯函数 + 读盘配置，不对任何 provider 发真实请求。
 */
console.log('\n[18] docs\\109 窗口真值（measured/证据/×0.95）+ raccoon/deepseek-official 禁用过滤')

const QF = 'qodercn/qfmodel'
const HY = 'workbuddy/hy4flash-free'
const SEN = 'raccoon/sn-sensenova-6-8-flash'
const LITE = 'raccoon/sn-sensenova-6-8-flash-lite'
const NEEDED = 394290 // Lead 实测占用（docs\109 §15 量级）

// —— 18-① needed=394290 的三态判定 ——
const fitQF = R.fitCheck(QF, NEEDED)
const fitHY = R.fitCheck(HY, NEEDED)
const fitLite = R.fitCheck(LITE, NEEDED)
t(`qfmodel@${NEEDED} → safe（×1.1=${Math.round(NEEDED * 1.1)} ≤ 可用 ${Math.round(fitQF.allowed)}）`, fitQF.state === 'safe', JSON.stringify(fitQF))
t(`hy4flash-free@${NEEDED} → safe`, fitHY.state === 'safe', JSON.stringify(fitHY))
t(`lite@${NEEDED} → reject（128K 装不下）`, fitLite.state === 'reject', JSON.stringify(fitLite))
t('  → 三态判定差异真实存在（不是恒值）', fitQF.state === 'safe' && fitLite.state === 'reject')

// —— 18-② windowSource=measured，与 official / conservative 区分 ——
for (const k of [QF, HY, SEN]) t(`  windowSourceOf(${k}) = measured`, R.windowSourceOf(k) === 'measured', R.windowSourceOf(k))
t('  official 与 measured 不同源（v4.1-flash 仍 official）', R.windowSourceOf('workbuddy/deepseek-v4.1-flash') === 'official')
t('  conservative 与 measured 不同源（sn-glm-5-3 未实测仍 conservative）', R.windowSourceOf('raccoon/sn-glm-5-3') === 'conservative')
t('  fitCheck 也带回 windowSource=measured', fitQF.windowSource === 'measured', fitQF.windowSource)

// —— 18-③ 证据自洽：表值 = prompt_tokens−300 向下取整到 K；且 lite 未被偷偷上调 ——
for (const [k, ev] of Object.entries(R.CONTEXT_WINDOW_EVIDENCE)) {
  if (ev.derivedWindow == null) {
    t(`  ${k} derivedWindow=null（证据不足，不落表）`, !(k in R.CONTEXT_WINDOW), '在表里=' + (k in R.CONTEXT_WINDOW))
    continue
  }
  const expect = Math.floor((ev.measuredPromptTokens - 300) / 1000) * 1000
  t(`  ${k} 证据自洽：${ev.measuredPromptTokens}−300↓K=${expect}`, ev.derivedWindow === expect, `${ev.derivedWindow} vs ${expect}`)
  t(`  ${k} 表值 = 证据 derivedWindow`, R.CONTEXT_WINDOW[k] === ev.derivedWindow, `${R.CONTEXT_WINDOW[k]} vs ${ev.derivedWindow}`)
  t(`  ${k} 带 docs\\109 出处`, /109/.test(String(ev.doc)), ev.doc)
}
t('qfmodel/hy4flash/sensenova 三条实测下限都 ≥448K（108 保守 128K 的 3.5×以上）',
  R.CONTEXT_WINDOW[QF] >= 448000 && R.CONTEXT_WINDOW[HY] >= 448000 && R.CONTEXT_WINDOW[SEN] >= 448000,
  `${R.CONTEXT_WINDOW[QF]}/${R.CONTEXT_WINDOW[HY]}/${R.CONTEXT_WINDOW[SEN]}`)
t('lite 维持 128K，未被兄弟模型的 469K 带上去', R.windowOf(LITE) === 128000, R.windowOf(LITE))

// —— 18-④ 贴边折扣 ×0.95：只有 measured 打折，official/conservative 原样 ——
t('MEASURED_DISCOUNT = 0.95', R.MEASURED_DISCOUNT === 0.95, R.MEASURED_DISCOUNT)
for (const [k, want] of [[QF, 922000], [HY, 888000], [SEN, 445000]]) {
  t(`  conservativeWindow(${k}) = ${want}（表值×0.95↓K）`, R.conservativeWindow(k) === want, R.conservativeWindow(k))
  t(`  折扣后仍 < 表值（真打折不是抄一遍）`, R.conservativeWindow(k) < R.windowOf(k))
}
t('official 不打折（v4.1-flash 原样 1M）', R.conservativeWindow('workbuddy/deepseek-v4.1-flash') === 1000000)
t('conservative 不打折（lite 原样 128K）', R.conservativeWindow(LITE) === 128000)
t('折扣是显式 opt-in：fitCheck 仍用表值，不用打折值（两口径不混）', R.fitCheck(QF, NEEDED).window === 971000, R.fitCheck(QF, NEEDED).window)

// —— 18-⑤ disabledProviders 过滤（读盘配置；变异靶在这里）——
const { fileURLToPath } = await import('node:url')
const nodePath = await import('node:path')
const ROOT_DIR = nodePath.dirname(nodePath.dirname(fileURLToPath(import.meta.url)))
const disk = await R.loadRouteConfig(ROOT_DIR)
const DISABLED = disk.config.disabledProviders.map((x) => String(x).toLowerCase())
t('route-config.json 读盘成功（source=file）', disk.source === 'file', disk.source)
t('disabledProviders 含 raccoon', DISABLED.includes('raccoon'), JSON.stringify(disk.config.disabledProviders))
t('disabledProviders 含 deepseek-official', DISABLED.includes('deepseek-official'), JSON.stringify(disk.config.disabledProviders))
t('两个 provider 各带 disabledReason（面板要显示为什么停用）',
  Boolean(disk.config.disabledReason.raccoon) && Boolean(disk.config.disabledReason['deepseek-official']),
  JSON.stringify(disk.config.disabledReason))

// —— 硬编码期望（**不看盘上配置内容**）：这两个 provider 必须被禁，且它们的路由必须被挡 ——
// 上一版这里的 gateRoute 循环是按 disk.disabledProviders 过滤的：
// 有人把 raccoon 从配置里摘掉时，循环根本不会遍历到 raccoon → 断言「跳过」而不是「失败」，
// 变异检验（摘掉 deepseek-official）只被 1 条断言抓到。改成硬编码名单后，摘掉任何一项都会
// 让对应的 blockedBy=provider-disabled 断言直接变红，这才叫锁住。
const EXPECT_DISABLED = ['raccoon', 'deepseek-official']
const EXPECT_DISABLED_ROUTES = {
  raccoon: ['sn-sensenova-6-8-flash', 'sn-sensenova-6-8-flash-lite', 'sn-deepseek-v4-1-flash-1017'],
  'deepseek-official': ['deepseek-flash', 'deepseek-v4-pro'],
}
for (const p of EXPECT_DISABLED) {
  t(`[hard] disabledProviders 必须含 ${p}（摘掉即红）`, DISABLED.includes(p), JSON.stringify(disk.config.disabledProviders))
  t(`[hard] ${p} 必须带 disabledReason`, typeof disk.config.disabledReason[p] === 'string' && disk.config.disabledReason[p].length > 0, String(disk.config.disabledReason[p]))
  for (const m of EXPECT_DISABLED_ROUTES[p]) {
    const g = R.gateRoute({ provider: p, model: m }, disk.config)
    t(`[hard] gateRoute 必须挡下 ${p}/${m}`, g.allowed === false, JSON.stringify(g).slice(0, 140))
    t(`[hard]   ${p}/${m} → blockedBy=provider-disabled`, g.blockedBy === 'provider-disabled', g.blockedBy)
    t(`[hard]   ${p}/${m} → disabledReason 非空`, typeof g.disabledReason === 'string' && g.disabledReason.length > 0, String(g.disabledReason))
  }
  // 该 provider 若还出现在任何链的档位上，selectRoute 绝不能把它当「选中项」返回
  for (const domain of Object.keys(R.ROUTE)) {
    for (const { route } of orderTiersFor(R.ROUTE[domain])) {
      if (String(route.provider).toLowerCase() !== p) continue
      const g = R.gateRoute(route, disk.config)
      t(`[hard] 链上 ${domain} 的 ${R.routeKey(route)} 被挡`, g.allowed === false && g.blockedBy === 'provider-disabled', `${g.allowed}/${g.blockedBy}`)
    }
  }
}

// gateRoute 层（按链遍历，与上一段互补）：这两个 provider 的每条链上 route 都必须 blockedBy=provider-disabled
const disabledRoutesSample = []
for (const domain of Object.keys(R.ROUTE)) {
  for (const { route } of orderTiersFor(R.ROUTE[domain])) {
    if (!DISABLED.includes(String(route.provider).toLowerCase())) continue
    disabledRoutesSample.push(`${domain}→${R.routeKey(route)}`)
    const g = R.gateRoute(route, disk.config)
    t(`  gateRoute 挡下 ${R.routeKey(route)}（${domain}）`, g.allowed === false, JSON.stringify(g).slice(0, 160))
    t(`    → blockedBy=provider-disabled`, g.blockedBy === 'provider-disabled', g.blockedBy)
    t(`    → 带 disabledReason`, typeof g.disabledReason === 'string' && g.disabledReason.length > 0, String(g.disabledReason))
  }
}
t('被禁 provider 的 route 至少覆盖到 free/paid/backup/last 各档（样本非空）', disabledRoutesSample.length >= 4, disabledRoutesSample.join('、'))

// selectRoute 层：真正「入选」的结果绝不能是被禁 provider；全档被挡时必须是 exhausted 而非假成功
for (const domain of Object.keys(R.ROUTE)) {
  const sel = R.selectRoute(domain, { config: disk.config })
  if (sel.contextExhausted) {
    t(`  ${domain}：全链无可选项 → contextExhausted=true（不是假装选中）`, sel.fit && (sel.fit.ok === false || sel.state === 'reject' || sel.state === 'unknown'), `${sel.tier}/${sel.provider} state=${sel.state}`)
  } else {
    t(`  ${domain}：选中项 provider 不在禁用表`, !DISABLED.includes(String(sel.provider).toLowerCase()), `${sel.provider}/${sel.model} tier=${sel.tier}`)
  }
}
// 变异反证：过滤若被改恒 false（provider-disabled 判定失效），code/vision 会把 raccoon 当可选返回 → 下面必红
// 语义判断（不锁具体 provider）：盘上 qodercn 已禁，新优先级下主力 workbuddy/deepseek-v4.1-flash 命中
const auditSel = R.selectRoute('audit', { config: disk.config })
t('audit 在禁用 raccoon/deepseek-official/qodercn 后选中的不是被禁通道',
  !DISABLED.includes(String(auditSel.provider).toLowerCase()) && !auditSel.contextExhausted,
  `${auditSel.provider}/${auditSel.model} tier=${auditSel.tier} ex=${auditSel.contextExhausted}`)
const probeSel = R.selectRoute('probe', { config: disk.config })
t('probe 同理选中的不是被禁通道（主力优先）',
  !DISABLED.includes(String(probeSel.provider).toLowerCase()) && !probeSel.contextExhausted,
  `${probeSel.provider}/${probeSel.model}`)
// v2：盘上 workbuddy cap 已被用户授权调到 0.13，全挡场景须显式构造 cap=0 的配置
const allBlockedCfg = R.resolveConfig({
  ...disk.config,
  providerMultiplierCap: { ...(disk.config.providerMultiplierCap || {}), workbuddy: 0 },
})
t('code 在 raccoon+workbuddy(显式 cap=0)+official 全挡下判 exhausted（拒绝硬选，不假成功）',
  R.selectRoute('code', { config: allBlockedCfg }).contextExhausted === true,
  JSON.stringify({ p: R.selectRoute('code', { config: allBlockedCfg }).provider, ex: R.selectRoute('code', { config: allBlockedCfg }).contextExhausted }))
t('  → 且该 exhausted 结论里 raccoon 记在 gatedOut（blockedBy=provider-disabled）',
  (R.selectRoute('code', { config: disk.config }).gatedOut || []).some((x) => x.provider === 'raccoon' && x.blockedBy === 'provider-disabled'),
  JSON.stringify(R.selectRoute('code', { config: disk.config }).gatedOut))

/** 复用 orderTiers 语义：把一条链摊成 [{tier,route}]（verify 内部私有，不改 routes.mjs 导出） */
function orderTiersFor(chain) {
  const seen = new Set(); const out = []
  for (const tt of R.TIER_ORDER) { if (chain[tt]) { out.push({ tier: tt, route: chain[tt] }); seen.add(tt) } }
  for (const [tt, r] of Object.entries(chain)) { if (!seen.has(tt) && r) out.push({ tier: tt, route: r }) }
  return out
}

/* ══ 19. chat-open 路由回落（task_mwpxoswsco7y3f 验收③④）═══════════
 * 锁死四件事：
 *   ① disabledProviders 含 raccoon 时，回落结果**绝不能**是 raccoon 系；
 *   ② workbuddy cap=0 时，回落绝不选 x>0 的 workbuddy 项；
 *   ③ routeSource 三态（explicit / config-chain / host-default），回落必带 warning；
 *   ④ 配置链尽而宿主快照也被挡 → source=null（宁可不建会话，不偷偷用禁用通道）。
 * 纯函数 + 读盘配置，不发任何真实模型请求。
 */
console.log('\n[19] chat-open 回落：resolveChatRoute 不许落到被禁用/被 cap 挡的通道')
{
  const CR = disk.config // 盘上配置：disabledProviders=[deepseek-official, raccoon]，workbuddy cap=0
  const RACOON_ROUTES = []
  for (const domain of Object.keys(R.ROUTE)) {
    for (const { route } of orderTiersFor(R.ROUTE[domain])) {
      if (String(route.provider).toLowerCase() === 'raccoon') RACOON_ROUTES.push(R.routeKey(route))
    }
  }
  t('样本非空：链上确实有 raccoon 系 route（否则这组断言无意义）', RACOON_ROUTES.length >= 3, RACOON_ROUTES.join('、'))

  // ① 不带任何参数 → 配置链，且绝不是 raccoon
  const noArg = R.resolveChatRoute({ config: CR })
  t('① 无 provider/model → 有可用回落', noArg.source === 'config-chain' && !!noArg.route, `${noArg.source} ${noArg.route && R.routeKey(noArg.route)}`)
  t('  → 回落结果不是 raccoon 系', String(noArg.route?.provider).toLowerCase() !== 'raccoon', noArg.route && R.routeKey(noArg.route))
  t('  → 选中项本身必过 gate（leadRoute 首档即命中，不假装扫全链）',
    R.gateRoute(noArg.route, R.resolveConfig(CR)).allowed === true, R.routeKey(noArg.route || {}))
  // 链遍历路径：leadRoute 缺失/不可用时才逐档过 gate，被禁的 raccoon 必须被点名
  const WALK_CFG = { ...R.resolveConfig(CR), leadRoute: { provider: 'none-here', model: 'none' } }
  const chainWalk = R.resolveChatRoute({ config: WALK_CFG })
  const walkGated = []
  R.resolveChatRoute({ config: WALK_CFG, gatedOut: walkGated })
  t('  → leadRoute 不可用时走链遍历，仍不选 raccoon',
    chainWalk.route && String(chainWalk.route.provider).toLowerCase() !== 'raccoon',
    `${chainWalk.source} ${R.routeKey(chainWalk.route || {})}`)
  // 与遍历命中顺序无关的严格证明：链上**每一条** raccoon route 单独过 gate 都必须被挡
  for (const k of new Set(RACOON_ROUTES)) {
    const [p, ...rest] = k.split('/')
    const g = R.gateRoute({ provider: p, model: rest.join('/') }, R.resolveConfig(CR))
    t(`  → 链上 raccoon 项 ${k} 单独过 gate 必被挡（provider-disabled）`,
      g.allowed === false && g.blockedBy === 'provider-disabled', `${g.allowed}/${g.blockedBy}`)
  }
  // 新优先级主力(paid)先命中即返回：可能根本遍历不到被禁的 raccoon（gatedOut 空是合法的）。
  // 语义判断：chainWalk 选中项必过 gate；gatedOut 里若出现 raccoon 必是 provider-disabled。
  t('  → 链遍历选中项过 gate；gatedOut 里的 raccoon 一律是 provider-disabled',
    R.gateRoute(chainWalk.route, R.resolveConfig(CR)).allowed === true
      && walkGated.every((x) => String(x.provider).toLowerCase() !== 'raccoon' || x.blockedBy === 'provider-disabled'),
    walkGated.map((x) => `${x.provider}/${x.model}<-${x.blockedBy}`).join('、') || '(gatedOut 空=主力先命中)')

  // ①b 宿主快照是 raccoon（修复前的真实 bug 路径）→ 不得采用宿主快照
  const bugPath = R.resolveChatRoute({
    config: CR,
    hostRoute: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017', reasoningEffort: 'on' },
  })
  t('①b 宿主快照=被禁用 raccoon → 不选它（修复前正是这条命中）',
    bugPath.route && String(bugPath.route.provider).toLowerCase() !== 'raccoon',
    bugPath.route && `${bugPath.source} ${R.routeKey(bugPath.route)}`)
  t('  → source 不是 host-default', bugPath.source !== 'host-default', String(bugPath.source))

  // ② workbuddy cap=0：任何 x>0 的 workbuddy 项都不得成为回落结果
  const wbPaid = ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3-flash']
  const capCase = R.resolveChatRoute({
    config: { maxMultiplier: 0.6, providerMultiplierCap: { workbuddy: 0 }, disabledProviders: [], disabledRoutes: [], leadRoute: { provider: 'none', model: 'none' } },
  })
  t('② workbuddy cap=0 且全链放开 → 回落可用', !!capCase.route, capCase.route && R.routeKey(capCase.route))
  for (const m of wbPaid) {
    t(`  → 不选 workbuddy/${m}（x${R.MULTIPLIER[`workbuddy/${m}`]} > cap 0）`,
      !(capCase.route?.provider === 'workbuddy' && capCase.route?.model === m), R.routeKey(capCase.route || {}))
  }
  t('  → 若真选到 workbuddy，只能是 x0.00 的 hy4flash-free',
    capCase.route?.provider !== 'workbuddy' || R.multiplierOf(capCase.route, null) === 0,
    `${R.routeKey(capCase.route || {})} mult=${capCase.route ? R.multiplierOf(capCase.route, null) : '-'}`)
  t('  → 选中项倍率 ≤ 其生效 cap', (() => {
    const g = R.gateRoute(capCase.route, R.resolveConfig({ maxMultiplier: 0.6, providerMultiplierCap: { workbuddy: 0 } }))
    return g.allowed === true
  })(), JSON.stringify(R.gateRoute(capCase.route || {}, R.resolveConfig({ providerMultiplierCap: { workbuddy: 0 } }))).slice(0, 160))

  // ③ routeSource 三态
  // 用例从 qodercn 换成盘上未被整厂禁的 workbuddy/hy4flash-free（qodercn 已禁用，不再是"合规通道"样本）
  const ex = R.resolveChatRoute({ config: CR, explicit: { provider: 'workbuddy', model: 'hy4flash-free', reasoningEffort: 'high' } })
  t('③ 显式传 → source=explicit', ex.source === 'explicit' && R.routeKey(ex.route) === 'workbuddy/hy4flash-free', ex.source)
  t('  → 显式且合规时不带 warning', !ex.warning, String(ex.warning))
  t('  → 回落（非显式）必带 warning 说明来源', Boolean(noArg.warning) && /回落/.test(noArg.warning), String(noArg.warning))
  t('  → ROUTE_SOURCE 三常量齐备',
    R.ROUTE_SOURCE.EXPLICIT === 'explicit' && R.ROUTE_SOURCE.CONFIG_CHAIN === 'config-chain' && R.ROUTE_SOURCE.HOST_DEFAULT === 'host-default',
    JSON.stringify(R.ROUTE_SOURCE))
  const hostOnly = R.resolveChatRoute({
    config: { maxMultiplier: 0.6, providerMultiplierCap: {}, disabledProviders: ['qodercn', 'raccoon', 'workbuddy', 'deepseek-official', 'modlens-workbuddy', 'modlens-zcode', 'modlens-our-free-model', 'deepseek-modlens'], leadRoute: { provider: 'none', model: 'none' } },
    hostRoute: { provider: 'qoder', model: 'efficient', reasoningEffort: 'high' },
  })
  t('  → 配置链全挡 + 宿主合规 → host-default 且带 warning',
    hostOnly.source === 'host-default' && Boolean(hostOnly.warning) && /宿主/.test(hostOnly.warning),
    `${hostOnly.source} ${R.routeKey(hostOnly.route || {})}`)
  // ③b 显式传被禁用的通道：P18 用户拍板改硬拦（此前是「采纳 + warning」，被 docs\112 §G2 实测否掉）
  const exDisabled = R.resolveChatRoute({ config: CR, explicit: { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017' } })
  t('  → 显式传被禁用项：route=null + explicitBlocked=true（硬拦，不再采纳）',
    exDisabled.source === 'explicit' && exDisabled.route === null && exDisabled.explicitBlocked === true,
    JSON.stringify({ s: exDisabled.source, r: exDisabled.route, eb: exDisabled.explicitBlocked }))
  t('  → blocked.blockedBy=provider-disabled 且带人话 blockedLabel',
    exDisabled.blocked?.blockedBy === 'provider-disabled' && /停用/.test(String(exDisabled.blocked?.blockedLabel)),
    JSON.stringify({ b: exDisabled.blocked?.blockedBy, l: exDisabled.blocked?.blockedLabel }))
  t('  → hint 点明「被什么挡住」+ 给出「可用替代」',
    /挡住/.test(String(exDisabled.hint)) && /可用替代/.test(String(exDisabled.hint)),
    String(exDisabled.hint).slice(0, 200))
  t('  → alternatives 非空且每条都过 gate（给的替代不能同样被禁）',
    Array.isArray(exDisabled.alternatives) && exDisabled.alternatives.length > 0
      && exDisabled.alternatives.every((a) => { const [p, ...m] = String(a.key).split('/'); return R.gateRoute({ provider: p, model: m.join('/') }, R.resolveConfig(CR)).allowed }),
    JSON.stringify(exDisabled.alternatives))
  t('  → alternatives 里不含被禁 provider（防自相矛盾）',
    (exDisabled.alternatives || []).every((a) => !CR.disabledProviders.map((x) => String(x).toLowerCase()).includes(String(a.key).split('/')[0].toLowerCase())),
    JSON.stringify((exDisabled.alternatives || []).map((a) => a.key)))
  // 被 cap 挡住的显式指定同样硬拦（workbuddy cap=0，x0.51 > 0）
  const exCap = R.resolveChatRoute({ config: CR, explicit: { provider: 'workbuddy', model: 'deepseek-v4-pro' } })
  t('  → 显式传不被允许的 workbuddy/deepseek-v4-pro（x0.51）同样硬拦',
    exCap.route === null && exCap.explicitBlocked === true
      && ['provider-cap', 'route-disabled'].includes(exCap.blocked?.blockedBy),
    JSON.stringify({ r: exCap.route, b: exCap.blocked?.blockedBy, mult: exCap.blocked?.multiplier, cap: exCap.blocked?.cap }))
  t('  → hint 里说清是倍率/cap（不是含糊的「不可用」）',
    /倍率|cap/.test(String(exCap.hint)), String(exCap.hint).slice(0, 160))
  // 全局 maxMultiplier 也要拦得下来。注意：resolveConfig 恒并 DEFAULT 的
  // {workbuddy:0}，拿 workbuddy 测全局 cap 只会命中 provider-cap，所以用
  // 没有 provider 级 cap 的 qoder/gmodel（x0.8）对全局 0.1 测。
  const exGlob = R.resolveChatRoute({
    config: { maxMultiplier: 0.1, providerMultiplierCap: {}, disabledProviders: [], disabledRoutes: [], leadRoute: { provider: 'qodercn', model: 'qfmodel' } },
    explicit: { provider: 'qoder', model: 'gmodel' },
  })
  t('  → 显式传超全局 maxMultiplier 的项 → blockedBy=global-cap',
    exGlob.explicitBlocked === true && exGlob.blocked?.blockedBy === 'global-cap',
    JSON.stringify({ b: exGlob.blocked?.blockedBy, mult: exGlob.blocked?.multiplier, cap: exGlob.blocked?.cap, src: exGlob.blocked?.capSource }))
  // disabledRoutes 精确拉黑也拦（provider 未禁、单条被拉黑）
  // workbuddy 未被整厂禁，才能干净地测"单条拉黑"（用 qodercn 会先命中 provider-disabled）
  const exRoute = R.resolveChatRoute({
    config: { ...R.resolveConfig(CR), disabledRoutes: ['workbuddy/hy4flash-free'] },
    explicit: { provider: 'workbuddy', model: 'hy4flash-free' },
  })
  t('  → 显式传 disabledRoutes 精确拉黑的单条 → route-disabled',
    exRoute.explicitBlocked === true && exRoute.blocked?.blockedBy === 'route-disabled',
    String(exRoute.blocked?.blockedBy))
  // 验收③：合法通道必须放行，不许误伤
  const hy4Key = 'workbuddy/hy4flash-free'
  const t0hy4 = R.gateRoute({ provider: 'workbuddy', model: 'hy4flash-free' }, R.resolveConfig(CR))
  const exHy4 = R.resolveChatRoute({ config: CR, explicit: { provider: 'workbuddy', model: 'hy4flash-free', reasoningEffort: 'high' } })
  t(`③b 未禁用的 ${hy4Key}（x0.00 ≤ cap 0）显式传必须放行（不误伤）`,
    t0hy4.allowed === true && exHy4.route !== null && exHy4.explicitBlocked === undefined,
    JSON.stringify({ gate: t0hy4.allowed, r: exHy4.route && R.routeKey(exHy4.route), eb: exHy4.explicitBlocked }))
  t('  → 合规显式指定不带 blocked/hint（干净通过）',
    exHy4.blocked === null && !exHy4.hint, JSON.stringify({ b: exHy4.blocked, h: String(exHy4.hint).slice(0, 40) }))
  const exLead = R.resolveChatRoute({ config: CR, explicit: { provider: 'workbuddy', model: 'hy4flash-free', reasoningEffort: 'high' } })
  t('  → 合规 leadRoute 同款显式传也放行', exLead.route !== null && exLead.source === 'explicit', String(exLead.source))

  // ④ 链尽 + 宿主快照也超标 → 明确 no-route，不硬选
  const dead = R.resolveChatRoute({
    config: { maxMultiplier: 0.6, providerMultiplierCap: {}, disabledProviders: ['qodercn', 'raccoon', 'workbuddy', 'deepseek-official', 'modlens-workbuddy', 'modlens-zcode', 'modlens-our-free-model', 'deepseek-modlens'], leadRoute: { provider: 'none', model: 'none' } },
    hostRoute: { provider: 'qoder', model: 'ultimate' },
  })
  t('④ 链尽 + 宿主快照超全局 cap → source=null（宁可不建会话）',
    dead.source === null && dead.route === null, `${dead.source} ${R.routeKey(dead.route || {})}`)
  t('  → blocked 点明被什么挡住', Boolean(dead.blocked && dead.blocked.blockedBy), JSON.stringify(dead.blocked))

  // ⑤ 集成面：openThread 用 resolveChatRouteOpt（不再直接读宿主快照），index.js 注入盘上配置
  const { readFileSync } = await import('node:fs')
  const chatSrc = readFileSync(new URL('../lib/orchestrator/chat.mjs', import.meta.url), 'utf8')
  const idxSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  t('⑤ chat.mjs 导出 resolveChatRouteOpt（回落唯一入口）', /export async function resolveChatRouteOpt/.test(chatSrc))
  t('  → openThread 走 resolveChatRouteOpt，不再调旧的 resolveRoute',
    /await resolveChatRouteOpt\(/.test(chatSrc) && !/await resolveRoute\(/.test(chatSrc))
  t('  → 旧的两档回落（宿主快照优先）已移除', !/来源优先级：显式传 opt\.provider\/model > Lead 会话的选项/.test(chatSrc))
  t('  → 返回体带 routeSource（成功与失败两条路都带）',
    (chatSrc.match(/routeSource/g) || []).length >= 5, (chatSrc.match(/routeSource/g) || []).length)
  t('  → no-route 时带 blocked/tried/hint，说清宿主当时挂的是什么',
    /reason: 'no-route'/.test(chatSrc) && /hostRoute: resolved\.hostRoute/.test(chatSrc) && /routeTried|tried: resolved\.tried/.test(chatSrc))
  t('  → index.js 的 chat-open 注入盘上 routeConfig',
    /op === 'chat-open'[\s\S]{0,600}routeConfig: chatRouteCfg/.test(idxSrc), '见 index.js chat-open 分支')
  t('  → chat-open 回传 routeConfigSource（配置来源可读）', /opened\.routeConfigSource = chatCfgSource/.test(idxSrc))

  // ⑥ P18 硬拦的接线核对：chat.mjs 必须在 registry.create **之前**返回
  t('⑥ chat.mjs 有 explicit-blocked 分支', /reason: 'explicit-blocked'/.test(chatSrc))
  t('  → 该分支由 resolved.explicitBlocked 触发', /if \(resolved\.explicitBlocked\)/.test(chatSrc))
  t('  → 分支里带 blocked/alternatives/hint（面板要能直接渲染）',
    /blocked: resolved\.blocked/.test(chatSrc) && /alternatives: resolved\.alternatives/.test(chatSrc) && /hint: resolved\.hint/.test(chatSrc),
    '见 openThread explicit-blocked 分支')
  // 顺序硬约束：explicitBlocked 的 return 必须出现在 registry.create( 之前，否则等于没拦
  const iBlock = chatSrc.indexOf("reason: 'explicit-blocked'")
  const iCreate = chatSrc.indexOf('registry.create(')
  t('  → explicit-blocked 的 return 在 registry.create 之前（真的不建会话）',
    iBlock > 0 && iCreate > 0 && iBlock < iCreate, `block@${iBlock} create@${iCreate}`)
  t('  → 旧的「按显式语义仍然采用」文案已从 routes.mjs 移除',
    !/按显式语义仍然采用/.test(readFileSync(new URL('../lib/orchestrator/routes.mjs', import.meta.url), 'utf8')))

  // ⑦ 运行时集成（不是静态读码）：真调 openThread，桩 registry 盯 create 是否被调。
  // 验收④点名的两条都在这一组：deepseek-official → create 未调用；hy4flash-free → 正常过。
  const ChatI = await import('../lib/orchestrator/chat.mjs')
  const mkCtx = (hostOpts) => {
    const seen = { create: null }
    const agent = {
      followup: async () => ({ text: 'x' }), inject: () => {},
      inbox: { clear: () => {} }, ctx: {}, options: hostOpts,
      session: { id: 'h1', header: { id: 'h1', origin: 'user' } },
    }
    const registry = {
      create: async (arg) => { seen.create = arg; return { agent, sessionId: arg.sessionId } },
      list: () => [agent], resume: async () => agent,
    }
    return { ctx: { get: (n) => (n === 'agents' || n === 'agentRegistry' ? registry : n === 'sessions' ? { get: async () => null } : undefined) }, seen }
  }
  {
    const { ctx, seen } = mkCtx({ provider: 'qodercn', model: 'qfmodel' })
    const r = await ChatI.openThread(ctx, {
      sceneId: 'verify-hardblock-1',
      provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high',
      routeConfig: disk.config,
    })
    t('⑦ 运行时：显式传 deepseek-official → ok=false reason=explicit-blocked',
      r.ok === false && r.reason === 'explicit-blocked', `${r.ok}/${r.reason}`)
    t('  → registry.create 从未被调用（桩实测，不是读码推断）', seen.create === null, JSON.stringify(seen.create))
    t('  → 返回带 blocked + hint（替代方案在 hint 里）',
      r.blocked?.blockedBy === 'provider-disabled' && /可用替代/.test(String(r.hint)), String(r.hint).slice(0, 120))
    t('  → thread 未建（无 sessionId 泄漏进响应）', !r.thread?.sessionId, JSON.stringify(r.thread || null))
  }
  {
    const { ctx, seen } = mkCtx({ provider: 'qodercn', model: 'qfmodel' })
    const r = await ChatI.openThread(ctx, {
      sceneId: 'verify-hardblock-2',
      provider: 'workbuddy', model: 'hy4flash-free', reasoningEffort: 'high',
      routeConfig: disk.config,
    })
    t('⑦ 运行时：显式传未禁用的 workbuddy/hy4flash-free → 正常建会话',
      r.ok === true && r.routeSource === 'explicit', `${r.ok}/${r.routeSource}`)
    t('  → create 收到的就是显式三元组', seen.create && seen.create.agentOptions.model === 'hy4flash-free', JSON.stringify(seen.create && seen.create.agentOptions))
  }
  {
    const { ctx, seen } = mkCtx({ provider: 'qodercn', model: 'qfmodel' })
    const r = await ChatI.openThread(ctx, {
      sceneId: 'verify-hardblock-3',
      provider: 'workbuddy', model: 'deepseek-v4-pro', routeConfig: disk.config,
    })
    t('⑦ 运行时：显式传超 cap 的 workbuddy/deepseek-v4-pro → 硬拦且 create 未调用',
      r.ok === false && r.reason === 'explicit-blocked' && seen.create === null, `${r.ok}/${r.reason}`)
  }
  {
    // 同一 sceneId 被拦后不留残骸，补合规请求可建（拦的是通道不是场景）
    const { ctx } = mkCtx({ provider: 'qodercn', model: 'qfmodel' })
    const scene = 'verify-hardblock-4'
    const a = await ChatI.openThread(ctx, { sceneId: scene, provider: 'raccoon', model: 'sn-sensenova-6-8-flash', routeConfig: disk.config })
    const b = await ChatI.openThread(ctx, { sceneId: scene, routeConfig: disk.config })
    t('⑦ 运行时：被拦的 sceneId 无线程残骸，同 scene 合规请求照常建',
      a.ok === false && !a.thread && b.ok === true && b.routeSource === 'config-chain',
      `${a.ok}/${b.ok}/${b.routeSource}`)
  }
}

/* ══ 20. 层级概念（task_mwq2cmoj4wgyf6）：14 前缀 = 一个插件内的 14 条上游通道 ══
 * 命名/界面层级修正，不改选路逻辑。锁三件事：
 *   ① routes.mjs 导出 PLUGIN_ID / RELAY_ENDPOINT / LANE_OF / LANE_COUNT；
 *   ② LANE_COUNT === 14，且 14 个 key 与 dsh_team_models 实测的 provider 前缀一致；
 *   ③ route-config.json 的 disabledReason 文案点明「插件的一条通道 + 背后上游 + 个人余额」。
 */
console.log('\n[20] 层级概念：14 个前缀是 our-free-model 插件内的 14 条上游通道')
{
  t('PLUGIN_ID = our-free-model', R.PLUGIN_ID === 'our-free-model', String(R.PLUGIN_ID))
  t('RELAY_ENDPOINT 指向 127.0.0.1:18326', /127\.0\.0\.1:18326/.test(String(R.RELAY_ENDPOINT)), String(R.RELAY_ENDPOINT))
  t('LANE_OF 是对象且导出', R.LANE_OF && typeof R.LANE_OF === 'object' && !Array.isArray(R.LANE_OF))
  t('LANE_COUNT = 14（dsh_team_models 去重的 provider 前缀数）', R.LANE_COUNT === 14, `${R.LANE_COUNT} / ${Object.keys(R.LANE_OF || {}).join(',')}`)
  // 14 个前缀必须是面板实际会展示的那些（与 PROVIDER_PRIORITY 对照，允许 LANE_OF 多含 ollama-local 等）
  const LANE_KEYS = Object.keys(R.LANE_OF || {})
  t('LANE_OF 恰含 14 个 key', LANE_KEYS.length === 14, LANE_KEYS.join(','))
  for (const p of ['our-free-model', 'deepseek-official', 'workbuddy', 'raccoon', 'qoder', 'qodercn', 'zcode', 'loomy', 'cline', 'ollama-local',
    'modlens-our-free-model', 'modlens-workbuddy', 'modlens-zcode', 'deepseek-modlens']) {
    t(`  LANE_OF 含 ${p}`, LANE_KEYS.includes(p), LANE_KEYS.join(','))
  }
  t('每条通道都有人读说明（上游服务）', LANE_KEYS.every((k) => typeof R.LANE_OF[k] === 'string' && R.LANE_OF[k].length > 0))
  // 盘上配置文案：deepseek-official 要点明「插件的一条通道 + 官方 API + 个人余额」
  const whyDs = String(disk.config.disabledReason['deepseek-official'] || '')
  t('route-config deepseek-official 文案点明是插件的一条通道', /our-free-model 插件/.test(whyDs) && /第.*条通道|一条.*通道/.test(whyDs), whyDs)
  t('  → 点明背后接 DeepSeek 官方 API', /DeepSeek 官方 API/.test(whyDs), whyDs)
  t('  → 点明消耗个人余额', /个人余额/.test(whyDs), whyDs)
  const whyRc = String(disk.config.disabledReason.raccoon || '')
  t('route-config raccoon 文案也已改为「插件的一条通道」语义', /our-free-model 插件/.test(whyRc) && /通道/.test(whyRc), whyRc)
}

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：成员模型路由符合 docs\\103 决策矩阵 + docs\\108 上下文感知切换。\n')
else console.log('有断言失败 —— 路由链/窗口表/三态判定偏离规格，先修这些。\n')
process.exit(fail === 0 ? 0 : 1)
