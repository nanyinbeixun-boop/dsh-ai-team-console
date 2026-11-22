#!/usr/bin/env node
/**
 * verify-chat-feedback.mjs —— 面板 chat-open「被禁通道」反馈的行为锁
 *
 * 对应任务
 * 规格来源：Lead 验收 ①②③④⑤
 *
 * 为什么单独一个脚本：verify-routes.mjs 是**路由判定**的锁，且基线被钉在 476 条
 * 并有其它成员在并发追加（[19] chat-open 后端回落组）。面板反馈属于前端渲染层，
 * 判定逻辑全在 client.js 的纯视图模型里（sourceLabel / splitRouteKey /
 * chatRouteOptions / chatOpenVM —— 见 client.js 末尾的 exports.__vm）。
 * 这里**真跑那些函数**（不是读源码正则），所以测的就是面板实际会显示的内容。
 *
 * 用法：node scripts\verify-chat-feedback.mjs
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/* ── 把 client.js（window.__ModuleLoader__ 包装）在 node 里加载出 exports ──
 * client.js 顶层只有一个 window.__ModuleLoader__.load({id, factory}) 调用，
 * factory(require) 里 `var module={exports:{}}`…最后 return module.exports。
 * 所以只要接住 load，在沙箱里调用 factory，返回值就是面板模块的 exports。
 * 不 stub 的东西一律给最小形状：本脚本只测 __vm 里的四个纯函数，不碰 DOM。
 */
function loadClient() {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const reactStub = {
    createElement: (type, props, ...kids) => ({ type, props: props || {}, children: kids.flat(Infinity) }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (f) => f,
    useMemo: (f) => f(),
  }
  let captured = null
  const sandbox = {
    console,
    setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, Buffer, process, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Set, Map, isFinite, isNaN, parseInt, parseFloat,
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }),
      getElementById: () => null,
      head: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
    },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.reject(new Error('no network in verify')),
  }
  sandbox.window = {
    confirm: () => true,
    __ModuleLoader__: {
      load: (def) => {
        const req = (id) => (id === 'react' ? reactStub : {})
        captured = def.factory(req)
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'client.js' })
  return captured
}

const client = loadClient()

/** 在 'use strict' 下再加载一次：抓「误删 var 声明 → 隐式全局」这类静默缺陷 */
function loadClientStrict() {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const reactStub = {
    createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {},
    useCallback: (f) => f, useMemo: (f) => f(),
  }
  let captured = null
  const sb = {
    console, setTimeout, clearTimeout, URL, Buffer, process, JSON, Math, Date, Object, Array,
    String, Number, Boolean, RegExp, Error, Promise, Set, Map, isFinite, isNaN, parseInt, parseFloat,
    document: { createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }), getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} } },
    navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.reject(new Error('no network')),
  }
  sb.window = { confirm: () => true, __ModuleLoader__: { load: (def) => { captured = def.factory((id) => (id === 'react' ? reactStub : {})) } } }
  vm.createContext(sb)
 // strict 下给未声明变量赋值会抛 ReferenceError —— 正是我们要的探针
  vm.runInContext('"use strict";\n' + src, sb, { filename: 'client.js(strict)' })
  return captured
}

let pass = 0
let fail = 0
function t(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra !== undefined ? ` :: ${extra}` : ''}`) }
}

console.log('\n[0] client.js 能在 node 里加载并导出视图模型（无 DOM、无网络）')
t('loadClient 拿到 exports', client && typeof client === 'object', String(client && Object.keys(client || {})))
t('exports.name 正确', client && client.name === 'dsh-ai-team-console', client && client.name)
t('exports.__vm 存在', client && client.__vm && typeof client.__vm === 'object')
const VM = (client && client.__vm) || {}
for (const fn of ['sourceLabel', 'splitRouteKey', 'chatRouteOptions', 'chatOpenVM', 'tierLabelCn', 'blockedLabelCn']) {
  t(`  __vm.${fn} 是函数`, typeof VM[fn] === 'function', typeof VM[fn])
}
// —— strict 探针：本轮真实踩过「改回滚时删掉 var 声明 → 隐式全局」，
// sloppy 模式下静默通过、生产严格打包下才炸，所以这里在 'use strict' 里
// 把两个函数**调用一遍**（函数体继承了脚本的严格性，未声明赋值会抛 ReferenceError）。
let strictErr = null
try {
  const s = loadClientStrict()
  s.__vm.chatRouteOptions([
    { key: 'a/b', provider: 'a', model: 'b', allowed: true, multiplier: 0, providerRank: 1 },
    { key: 'c/d', provider: 'c', model: 'd', allowed: false, multiplier: 0.5, providerRank: 2, blockedBy: 'provider-cap', gateReason: 'cap' },
  ])
  s.__vm.chatOpenVM({ ok: false, reason: 'explicit-blocked', blocked: { key: 'c/d', blockedBy: 'provider-cap', multiplier: 0.5, cap: 0 }, alternatives: [{ key: 'a/b', multiplier: 0 }] })
} catch (e) { strictErr = e }
t('strict 模式加载并调用视图模型不抛（无隐式全局泄漏）',
  strictErr === null, strictErr && `${strictErr.name}: ${strictErr.message}`)
if (!VM.chatOpenVM) {
  console.log('\n视图模型没导出，后面全跑不了 —— 先看 client.js 末尾的 exports.__vm。')
  console.log(`\n结果：pass=${pass} fail=${fail}`)
  process.exit(1)
}

/* ══ 1. splitRouteKey：下拉值 → provider/model（决定 explicit 传什么）══ */
console.log('\n[1] splitRouteKey：把下拉的 provider/model 拆对（拆错就传错通道）')
const sp = VM.splitRouteKey('raccoon/sn-sensenova-6-8-flash')
t('正常拆分', sp && sp.provider === 'raccoon' && sp.model === 'sn-sensenova-6-8-flash', JSON.stringify(sp))
t('model 里带 / 时只拆第一个（ollama-local 的 :latest 型名字）', (() => {
  const x = VM.splitRouteKey('a/b/c')
  return x && x.provider === 'a' && x.model === 'b/c'
})(), JSON.stringify(VM.splitRouteKey('a/b/c')))
t('空串 → null（不猜）', VM.splitRouteKey('') === null)
t('缺 model → null', VM.splitRouteKey('raccoon/') === null)
t('缺 provider → null', VM.splitRouteKey('/model') === null)
t('无斜杠 → null', VM.splitRouteKey('raccoon') === null)
t('null/undefined 不抛', VM.splitRouteKey(null) === null && VM.splitRouteKey(undefined) === null)

/* ══ 2. sourceLabel：验收③ 让用户知道当前线程用的哪档来源 ═══════════ */
console.log('\n[2] sourceLabel：三档来源 + 未知，各自说清')
t('explicit → 含「显式指定」', /显式指定/.test(VM.sourceLabel('explicit')), VM.sourceLabel('explicit'))
t('config-chain → 含「配置链」', /配置链/.test(VM.sourceLabel('config-chain')), VM.sourceLabel('config-chain'))
t('host-default → 含「宿主快照」', /宿主快照/.test(VM.sourceLabel('host-default')), VM.sourceLabel('host-default'))
t('三种来源文案互不相同', new Set(['explicit', 'config-chain', 'host-default'].map(VM.sourceLabel)).size === 3)
t('null → 明说「无可用通道」（不冒充某档来源）', /无可用通道/.test(VM.sourceLabel(null)), VM.sourceLabel(null))
t('未知来源不崩，原样带上', /weird-src/.test(VM.sourceLabel('weird-src')), VM.sourceLabel('weird-src'))

/* ══ 2.5 术语中文化第二批：档位/被挡原因的中文主文案 + 英文键括号 ══ */
console.log('\n[2.5] tierLabelCn / blockedLabelCn：中文打头，英文键留括号供排查')
const TIER_CN_EXPECT = { free: '免费', paid: '付费', backup: '备选', last: '兜底' }
for (const [k, cn] of Object.entries(TIER_CN_EXPECT)) {
  const s = VM.tierLabelCn(k)
  t(`tier ${k} → 中文主文案「${cn}」`, typeof s === 'string' && s.indexOf(cn) === 0, s)
  t(`  → 保留英文键括号（${k}）`, s.includes('（' + k + '）'), s)
  t(`  → 无重复括号`, !/）（/.test(s) && !s.includes('））'), s)
}
const BLOCK_CN_EXPECT = {
 // 层级概念修正：这些前缀是插件内的「通道」，不是「厂商」。
 // 断言锁中文主文案以「通道」打头；不再接受「厂商」。
  'provider-disabled': '通道已停用', 'provider-cap': '通道花费上限',
  'route-disabled': '通道已禁用', 'global-cap': '全局花费上限',
  'explicit-blocked': '指定通道已禁用', 'no-route': '无可用通道',
  'stale-lineage': '会话已失效', 'unbound': '未绑定会话',
}
for (const [k, cn] of Object.entries(BLOCK_CN_EXPECT)) {
  const s = VM.blockedLabelCn(k)
  t(`blockedBy ${k} → 中文主文案「${cn}」`, typeof s === 'string' && s.indexOf(cn) === 0, s)
  t(`  → 保留英文键括号（${k}）`, s.includes('（' + k + '）'), s)
  t(`  → 无重复括号`, !/）（/.test(s) && !s.includes('））'), s)
}
t('未知档位原样带出不编造', VM.tierLabelCn('weird') === 'weird（weird）', VM.tierLabelCn('weird'))
t('未知被挡原因原样带出不编造', VM.blockedLabelCn('weird') === 'weird（weird）', VM.blockedLabelCn('weird'))
t('空值不崩', VM.tierLabelCn('') === '未分档' && VM.blockedLabelCn('') === '不可用')

/* ══ 2.7 层级概念修正：prefix 是插件内「通道」，不是「厂商」══ */
console.log('\n[2.7] 层级概念：14 条上游通道来自同一插件，面板文案不得再称「厂商」')
{
 // blockedLabelCn 的三条主文案必须以「通道」打头，绝不出现「厂商」
  for (const k of ['provider-disabled', 'provider-cap', 'route-disabled']) {
    const s = VM.blockedLabelCn(k)
    t(`blockedLabelCn(${k}) 以「通道」打头`, /^通道/.test(s), s)
    t(`  → 不含「厂商」`, !/厂商/.test(s), s)
  }
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
 // 层级说明行（2026-11-21 白话化）：同一个模型插件 + 不同上游 + 不是 N 家独立厂商（N 取后端常量）
  t('面板有白话层级说明行（同一个模型插件、不同上游）',
    /这些通道都来自同一个模型插件/.test(cli) && /背后接不同的上游服务/.test(cli)
    && /不是 ['"]?\s*\+ laneN/.test(cli),
    (cli.match(/这些通道都来自同一个模型插件[^\n]{0,120}/) || ['(缺)'])[0])
  t('  说明行的 N 取后端 laneCount（不写死 14）', /data\s*&&\s*data\.laneCount/.test(cli))
 // relay 字样与 IP 已从渲染文案移除（不再是"解释实现"）
  t('  说明行不含 relay 字样与 relayEndpoint 引用',
    !/插件（relay/.test(cli) && !/data\s*&&\s*data\.relayEndpoint/.test(cli) && !/127\.0\.0\.1:18326/.test(cli))
 // 所有用户可见文案里不再有「厂商/整厂」（注释里刻意写「不是……独立厂商」除外）
  const visible = cli.split('\n').filter((l) => /厂商|整厂/.test(l)
    && !/不是 \d+ 家独立厂商|不是 ['"]?\s*\+ laneN|不是 N 家独立厂商|层级概念|不是 14 家/.test(l))
  t('面板可见文案无「厂商/整厂」残留（说明句里作反例的除外）', visible.length === 0, visible.slice(0, 3).join(' | '))
 // 三个指定替换
  t('provider-disabled → 通道已停用', /'通道已停用（provider-disabled）'/.test(cli))
  t('厂商花费上限 → 通道花费上限', /'通道花费上限（provider-cap）'/.test(cli))
  t('整厂停用 → 停用整条通道', /'停用整条通道'/.test(cli) && !/'整厂停用'/.test(cli) && !/'整厂启用'/.test(cli))
}

/* ══ 3. chatRouteOptions：验收④ 被禁通道保留可见 + 标注原因 ══════════ */
console.log('\n[3] chatRouteOptions：被禁的通道**列出来并说明原因**，绝不藏')
const CANDS = [
  { key: 'qodercn/qfmodel', provider: 'qodercn', model: 'qfmodel', allowed: true, multiplier: 0, providerRank: 2, tier: 'free' },
  { key: 'workbuddy/hy4flash-free', provider: 'workbuddy', model: 'hy4flash-free', allowed: true, multiplier: 0, providerRank: 4, tier: 'free' },
  { key: 'raccoon/sn-sensenova-6-8-flash', provider: 'raccoon', model: 'sn-sensenova-6-8-flash', allowed: false, multiplier: 0, providerRank: 3, blockedBy: 'provider-disabled', disabledReason: '账号级限流，2026-11-21 12:47', gateReason: 'provider「raccoon」已被停用', tier: 'free' },
  { key: 'raccoon/sn-deepseek-v4-1-flash-1017', provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017', allowed: false, multiplier: 0.25, providerRank: 3, blockedBy: 'provider-disabled', disabledReason: '账号级限流，2026-11-21 12:47', tier: 'backup' },
  { key: 'deepseek-official/deepseek-v4-pro', provider: 'deepseek-official', model: 'deepseek-v4-pro', allowed: false, multiplier: 0, providerRank: 1, blockedBy: 'provider-disabled', disabledReason: 'Insufficient Balance 2026-11-21 12:54', tier: 'last' },
  { key: 'workbuddy/deepseek-v4.1-flash', provider: 'workbuddy', model: 'deepseek-v4.1-flash', allowed: false, multiplier: 0.11, providerRank: 4, blockedBy: 'provider-cap', gateReason: '倍率 x0.11 超过 provider「workbuddy」上限 x0', tier: 'paid' },
  { key: 'loomy/unknown-mult', provider: 'loomy', model: 'unknown-mult', allowed: false, multiplier: null, providerRank: 8, blockedBy: 'multiplier-unknown', tier: 'paid' },
]
const opt = VM.chatRouteOptions(CANDS)
t('返回 groups + byKey', Array.isArray(opt.groups) && opt.byKey && typeof opt.byKey === 'object')
const allOptions = opt.groups.flatMap((g) => g.options.map((o) => o.key))
// ④ 的核心：**一条都不许少**
t('候选 7 条 → 下拉 7 条（被禁的一条都没被藏）', allOptions.length === 7, allOptions.join('、'))
for (const c of CANDS) t(`  含被禁/被挡项 ${c.key}`, allOptions.includes(c.key), allOptions.join('、'))
const findOpt = (k) => opt.groups.flatMap((g) => g.options).find((o) => o.key === k)
// 禁用项：allowed=false + why 带原因 + label 有可见标记
const raccoonOpt = findOpt('raccoon/sn-sensenova-6-8-flash')
t('raccoon 项 allowed=false', raccoonOpt.allowed === false, JSON.stringify(raccoonOpt))
t('  → why 带停用原因原文（不是空）', /账号级限流/.test(raccoonOpt.why || ''), raccoonOpt.why)
t('  → label 明确写「已禁用」+原因（看得见为什么不能用）', /已禁用/.test(raccoonOpt.label) && /账号级限流/.test(raccoonOpt.label), raccoonOpt.label)
t('  → label 带可见标记符号（不跟可用项长得一样）', /[⛔×]/.test(raccoonOpt.label), raccoonOpt.label)
const off = findOpt('deepseek-official/deepseek-v4-pro')
t('deepseek-official 项标注余额原因', /Insufficient Balance/.test(off.why || ''), off.why)
const capOpt = findOpt('workbuddy/deepseek-v4.1-flash')
t('被 cap 挡的项也列出且说明是倍率上限', capOpt.allowed === false && /倍率|上限/.test(capOpt.label), capOpt.label)
const unkOpt = findOpt('loomy/unknown-mult')
t('倍率未知的项仍列出（未知≠消失）', unkOpt && unkOpt.allowed === false, JSON.stringify(unkOpt && unkOpt.label))
// 可用项不能被误标成禁用
const okOpt = findOpt('qodercn/qfmodel')
t('可用项 allowed=true 且 label 不含「已禁用」', okOpt.allowed === true && !/已禁用/.test(okOpt.label), okOpt.label)
t('  → 可用项 label 带倍率（免费的是 x0 不是「未知」）', /x0(\D|$)/.test(okOpt.label), okOpt.label)
t('multiplier=null 的可用项显示「未知」而不是 xnull', (() => {
  const o = VM.chatRouteOptions([{ key: 'a/b', provider: 'a', model: 'b', allowed: true, multiplier: null, providerRank: 1 }])
  return /未知/.test(o.groups[0].options[0].label) && !/null/.test(o.groups[0].options[0].label)
})(), VM.chatRouteOptions([{ key: 'a/b', provider: 'a', model: 'b', allowed: true, multiplier: null, providerRank: 1 }]).groups[0].options[0].label)
// 整厂停用：该 provider 一条可用都没有 → wholeOff=true
t('raccoon 整厂停用 → wholeOff=true', opt.groups.find((g) => g.provider === 'raccoon').wholeOff === true)
t('deepseek-official 整厂停用 → wholeOff=true', opt.groups.find((g) => g.provider === 'deepseek-official').wholeOff === true)
t('workbuddy 有可用项（hy4flash-free）→ wholeOff=false', opt.groups.find((g) => g.provider === 'workbuddy').wholeOff === false)
t('qodercn 可用 → wholeOff=false', opt.groups.find((g) => g.provider === 'qodercn').wholeOff === false)
t('按 provider 分组：raccoon 两条在同一个 group', opt.groups.find((g) => g.provider === 'raccoon').options.length === 2)
t('分组内按倍率升序（便宜的在前）', (() => {
  const wb = opt.groups.find((g) => g.provider === 'workbuddy').options.map((o) => o.key)
  return wb[0] === 'workbuddy/hy4flash-free'
})(), opt.groups.find((g) => g.provider === 'workbuddy').options.map((o) => o.key).join(','))
t('空输入不崩（routes 还没回来时）', (() => {
  const e = VM.chatRouteOptions([])
  return e.groups.length === 0 && Object.keys(e.byKey).length === 0
})())
t('null/脏输入不崩', (() => { const e = VM.chatRouteOptions(null); return e && e.groups.length === 0 })())
t('重复 key 只留一条', (() => {
  const e = VM.chatRouteOptions([CANDS[0], CANDS[0]])
  return e.groups.flatMap((g) => g.options).length === 1
})())
// 变异反证：若有人把「禁用项」从下拉里过滤掉，④ 立刻红
const nBlocked = CANDS.filter((c) => !c.allowed).length
t('（变异守卫）样本里确有禁用项，且它们全部出现在下拉里',
  nBlocked > 0 && allOptions.filter((k) => !findOpt(k).allowed).length === nBlocked,
  `${allOptions.filter((k) => !findOpt(k).allowed).length}/${nBlocked}`)
t('（变异守卫）可用项也全部在（既不过滤禁用也不漏可用）',
  allOptions.filter((k) => findOpt(k).allowed).length === CANDS.filter((c) => c.allowed).length)

/* ══ 4. chatOpenVM：验收①②③ —— 失败必须可读 + 给可点替代 ═══════════ */
console.log('\n[4] chatOpenVM：explicit-blocked / no-route / 成功 三态的反馈内容')

// —— 4.1 成功：显示来源档 + warning ——
const okVM = VM.chatOpenVM({ ok: true, routeSource: 'config-chain', warning: '未显式传，已按配置链回落到 qodercn/qfmodel' })
t('成功 → tone=ok，标题正面（不是「失败」）', okVM.tone === 'ok' && /已建立/.test(okVM.title), okVM.title)
t('  → sourceText 说出「配置链回落」（验收③）', /配置链/.test(okVM.sourceText), okVM.sourceText)
t('  → warning 原样带出（用户知道是回落不是指定）', /回落/.test(okVM.warning || ''), okVM.warning)

// —— 4.2 explicit-blocked（本轮主场景：点了被禁通道）——
const blockedVM = VM.chatOpenVM({
  ok: false,
  reason: 'explicit-blocked',
  error: '显式指定的 raccoon/sn-sensenova-6-8-flash 已被配置拦下，未创建会话',
  routeSource: 'explicit',
  blocked: {
    key: 'raccoon/sn-sensenova-6-8-flash',
    blockedBy: 'provider-disabled',
    blockedLabel: 'route-config 的 disabledProviders 停用清单',
    reason: 'provider「raccoon」已被停用（disabledProviders）——账号级限流，2026-11-21 12:47',
    disabledReason: '账号级限流，2026-11-21 12:47',
    multiplier: 0, cap: 0.6, capSource: 'global',
  },
  alternatives: [
    { key: 'qodercn/qfmodel', from: 'leadRoute', multiplier: 0, reasoningEffort: 'xhigh' },
    { key: 'workbuddy/hy4flash-free', from: 'chain:free', multiplier: 0 },
  ],
  hint: '显式指定的 raccoon/… 被停用清单挡住（provider-disabled）——可用替代：qodercn/qfmodel（x0，来自 leadRoute）…',
  tried: ['raccoon/sn-sensenova-6-8-flash（explicit，被 provider-disabled 挡住）'],
})
t('验收①：tone=bad 且标题说清「被禁用未创建」', blockedVM.tone === 'bad' && /禁用/.test(blockedVM.title), blockedVM.title)
t('  → 标题不是光「失败」两个字（长度与信息量）', blockedVM.title.length > 6 && !/^失败$/.test(blockedVM.title), blockedVM.title)
t('  → blockedPills 带 blockedBy=provider-disabled', blockedVM.blockedPills.includes('provider-disabled'), blockedVM.blockedPills.join(','))
t('  → blocked 原样可取（渲染层要显示 blockedLabel/reason/disabledReason）',
  blockedVM.blocked && /disabledProviders/.test(blockedVM.blocked.blockedLabel) && /账号级限流/.test(blockedVM.blocked.disabledReason),
  JSON.stringify(blockedVM.blocked && blockedVM.blocked.blockedLabel))
t('  → hint 带出（后端已写好「可用替代…」）', /可用替代/.test(blockedVM.hint || ''), String(blockedVM.hint).slice(0, 60))
t('  → errorText 带出', /已被配置拦下/.test(blockedVM.errorText || ''), blockedVM.errorText)
t('  → sourceText 说出「显式指定」（验收③）', /显式指定/.test(blockedVM.sourceText), blockedVM.sourceText)
t('  → tried 原样带回（判定过程可展开）', blockedVM.tried.length === 1 && /provider-disabled/.test(blockedVM.tried[0]), blockedVM.tried.join('|'))
// 验收②：可点替代 —— 每条按钮要能直接发起 chat-open
t('验收②：altButtons 两条（与 alternatives 等量）', blockedVM.altButtons.length === 2, blockedVM.altButtons.length)
t('  → 每条按钮带 provider/model（点了就能重开线程）', blockedVM.altButtons.every((a) => a.provider && a.model), JSON.stringify(blockedVM.altButtons[0]))
t('  → 按钮 key 与后端 alternatives.key 一致', blockedVM.altButtons[0].key === 'qodercn/qfmodel', blockedVM.altButtons[0].key)
t('  → 按钮带倍率文案（x0 而不是 null）', /^x0/.test(blockedVM.altButtons[0].multText), blockedVM.altButtons[0].multText)
t('  → 按钮带来源（leadRoute / chain:free）', blockedVM.altButtons[0].fromText === 'leadRoute' && blockedVM.altButtons[1].fromText === 'chain:free', blockedVM.altButtons.map((a) => a.fromText).join(','))
t('  → reasoningEffort 透传（重开时保持档位）', blockedVM.altButtons[0].reasoningEffort === 'xhigh', String(blockedVM.altButtons[0].reasoningEffort))
t('  → 拆分结果可直接用于 chat-open 请求体', (() => {
  const a = blockedVM.altButtons[0]
  return a.provider === 'qodercn' && a.model === 'qfmodel'
})(), JSON.stringify(blockedVM.altButtons[0]))
// 验收②兜底：至少可复制
t('  → copyKeys 含全部替代 + 被禁通道本身（至少可复制）',
  blockedVM.copyKeys.includes('qodercn/qfmodel') && blockedVM.copyKeys.includes('workbuddy/hy4flash-free') && blockedVM.copyKeys.includes('raccoon/sn-sensenova-6-8-flash'),
  blockedVM.copyKeys.join(','))
t('  → copyKeys[0] 是被点的那条（最该被复制去问人）', blockedVM.copyKeys[0] === 'raccoon/sn-sensenova-6-8-flash', blockedVM.copyKeys[0])

// —— 4.3 倍率类拦截（provider-cap）：要说清「多少 vs 上限多少」——
const capVM = VM.chatOpenVM({
  ok: false, reason: 'explicit-blocked', routeSource: 'explicit',
  blocked: { key: 'workbuddy/deepseek-v4.1-flash', blockedBy: 'provider-cap', blockedLabel: '该 provider 的 providerMultiplierCap', reason: '倍率 x0.11 超过 provider「workbuddy」上限 x0', multiplier: 0.11, cap: 0, capSource: 'provider' },
  alternatives: [], hint: null, tried: [],
})
t('cap 拦截 → rateText 说出倍率与上限（用户知道调哪里）', /0\.11/.test(capVM.rateText || '') && /x0/.test(capVM.rateText || ''), capVM.rateText)
// v2：文案已中文化；v3「厂商级」改「通道级」。断言锁语义：通道级 or 全局，不再接受「厂商」。
t('  → rateText 标明是通道级还是全局', /通道级|provider 级|全局/.test(capVM.rateText || '') && !/厂商/.test(capVM.rateText || ''), capVM.rateText)
t('  → 无替代时 nextStep 指到「模型配置」页签（不是甩给用户）', /模型配置/.test(capVM.nextStep || '') && capVM.altButtons.length === 0, capVM.nextStep)
t('  → 无替代时 copyKeys 仍有被禁通道（兜底可复制）', capVM.copyKeys.length === 1 && capVM.copyKeys[0] === 'workbuddy/deepseek-v4.1-flash', capVM.copyKeys.join(','))

// —— 4.4 no-route（全链被挡，后端只给 gatedOut）——
const noRouteVM = VM.chatOpenVM({
  ok: false, reason: 'no-route', routeSource: null,
  error: '拿不到可用的 provider/model：配置链候选全部被门槛挡住，宿主快照也不可用',
  blocked: null,
  gatedOut: [
    { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017', blockedBy: 'provider-disabled', disabledReason: '账号级限流' },
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash', blockedBy: 'provider-cap' },
  ],
  hint: '宿主当时挂着的是 raccoon/…，被「provider-disabled」挡住。到面板「模型配置」放开一条。',
  tried: ['raccoon/x（chain:free，被 provider-disabled 挡住）'],
})
t('no-route → 标题说「没有可用通道」', /没有可用通道/.test(noRouteVM.title), noRouteVM.title)
t('  → gatedRows 逐条翻译「谁被什么挡」（不只显示失败）', noRouteVM.gatedRows.length === 2 && /raccoon/.test(noRouteVM.gatedRows[0]) && /provider-disabled/.test(noRouteVM.gatedRows[0]), noRouteVM.gatedRows.join(' | '))
t('  → gatedRows 带停用原因', /账号级限流/.test(noRouteVM.gatedRows[0]), noRouteVM.gatedRows[0])
t('  → sourceText 明说「无可用通道」（不冒充 config-chain）', /无可用通道/.test(noRouteVM.sourceText), noRouteVM.sourceText)
t('  → hint 带出', /模型配置/.test(noRouteVM.hint || ''), String(noRouteVM.hint).slice(0, 40))
t('  → gatedOut 超 8 条时截断（不把面板刷屏）', (() => {
  const many = { ok: false, reason: 'no-route', gatedOut: Array.from({ length: 30 }, (_, i) => ({ provider: 'p' + i, model: 'm', blockedBy: 'provider-cap' })) }
  return VM.chatOpenVM(many).gatedRows.length === 8
})())

// —— 4.5 任何失败都必须「有话说」：通用底线 ——
const FAIL_SHAPES = [
  ['explicit-blocked 全字段', { ok: false, reason: 'explicit-blocked', blocked: { key: 'a/b', blockedBy: 'provider-disabled' }, alternatives: [{ key: 'c/d', from: 'x', multiplier: 0 }] }],
  ['no-route 全字段', { ok: false, reason: 'no-route', gatedOut: [{ provider: 'a', model: 'b', blockedBy: 'provider-cap' }] }],
  ['裸失败（后端什么额外字段都没给）', { ok: false }],
  ['只有 error 字符串', { ok: false, error: 'create 失败：boom' }],
  ['宿主没回包（openIt 造的 shape）', { ok: false, reason: null, error: '请求没走通（宿主没回包）', alternatives: [], tried: [], gatedOut: [], blocked: null }],
  ['null 入参', null],
]
for (const [label, shape] of FAIL_SHAPES) {
  const v = VM.chatOpenVM(shape)
  t(`底线：${label} → tone=bad 且 title 非空（绝不静默）`, v.tone === 'bad' && typeof v.title === 'string' && v.title.length > 0, JSON.stringify(v.title))
  const readable = (v.title || '') + (v.errorText || '') + (v.hint || '') + (v.nextStep || '') + v.gatedRows.join('') + (v.blocked ? (v.blocked.reason || '') : '')
  t(`  → ${label} 至少有一条可读说明`, readable.length >= 6, `len=${readable.length}`)
  t(`  → ${label} 的数组字段恒为数组（渲染层 .map 不炸）`,
    Array.isArray(v.altButtons) && Array.isArray(v.copyKeys) && Array.isArray(v.gatedRows) && Array.isArray(v.tried) && Array.isArray(v.blockedPills))
}
// 裸失败也要给下一步（不能只说「开启线程失败」）
const bare = VM.chatOpenVM({ ok: false })
t('底线：裸失败标题是「开启线程失败」（诚实，不编原因）', /开启线程失败/.test(bare.title), bare.title)

// —— 4.6 变异反证：把 alternatives 抹掉必须让 altButtons 变空并被断言抓到 ——
console.log('\n[5] 变异反证：反馈内容不能是硬编码常量')
const withAlt = VM.chatOpenVM({ ok: false, reason: 'explicit-blocked', alternatives: [{ key: 'q/m', from: 'f', multiplier: 1 }] })
const noAlt = VM.chatOpenVM({ ok: false, reason: 'explicit-blocked', alternatives: [] })
t('alternatives 从 1 条变 0 条 → altButtons 跟着变（判定不是恒值）', withAlt.altButtons.length === 1 && noAlt.altButtons.length === 0, `${withAlt.altButtons.length} vs ${noAlt.altButtons.length}`)
t('  → 且 0 条时 nextStep 顶上（始终给用户下一步）', noAlt.nextStep !== null && withAlt.nextStep === null, `${withAlt.nextStep} / ${noAlt.nextStep}`)
const r1 = VM.chatOpenVM({ ok: true, routeSource: 'host-default' })
const r2 = VM.chatOpenVM({ ok: true, routeSource: 'config-chain' })
t('成功态 sourceText 随 routeSource 变（不是写死一句话）', r1.sourceText !== r2.sourceText && /宿主快照/.test(r1.sourceText), `${r1.sourceText} | ${r2.sourceText}`)
const b1 = VM.chatOpenVM({ ok: false, reason: 'explicit-blocked' })
const b2 = VM.chatOpenVM({ ok: false, reason: 'no-route' })
t('两种失败原因标题不同（不是一句「失败」通吃）', b1.title !== b2.title, `${b1.title} | ${b2.title}`)

/* ══ 6. 渲染层接线：确认面板真的用这些纯函数，而不是另写一套 ═══════ */
console.log('\n[6] 渲染层接线（client.js 静态核对）')
const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
t('TabChat 用 chatOpenVM 摆卡片（不是自己重新拼一遍判定）', /= chatOpenVM\(openInfo\)/.test(SRC))
t('TabChat 用 chatRouteOptions 造下拉', /= chatRouteOptions\(candRows\)/.test(SRC))
t('下拉渲染保留 optgroup + option（被禁项照走同一条路径）', /h\('optgroup'/.test(SRC) && /h\('option'/.test(SRC))
t('替代通道按钮 onClick 走 openWithRoute（点了真重开，不是摆设）', /onClick: function \(\) \{ openWithRoute\(a\.key/.test(SRC))
t('按钮文案与倍率来自 VM（a.multText / a.fromText）', /a\.multText/.test(SRC) && /a\.fromText/.test(SRC))
t('nextStep 有渲染出口（无替代时那句话显示得出来）', /vm\.nextStep/.test(SRC))
t('rateText 有渲染出口（倍率 vs 上限显示得出来）', /vm\.rateText/.test(SRC))
t('gatedRows 有渲染出口', /vm\.gatedRows/.test(SRC))
t('blocked 的 disabledReason 显示得出来（验收①：看得到原因）', /vm\.blocked\.disabledReason/.test(SRC))
t('blocked 的 blockedLabel 显示得出来', /vm\.blocked\.blockedLabel/.test(SRC))
t('hint 显示得出来（验收①）', /vm\.hint/.test(SRC))
t('tried 折叠展示（details/summary，不抢主视觉但拿得到）', /vm\.tried/.test(SRC) && /h\('details'/.test(SRC))
t('复制走 copyRoute（有 execCommand 兜底，侧栏 http 上下文也能用）', /function copyRoute/.test(SRC) && /execCommand/.test(SRC))
t('sourceLabel 三处都用（成功卡片 / 失败卡片 / 线程行）', (SRC.match(/sourceLabel\(/g) || []).length >= 3, String((SRC.match(/sourceLabel\(/g) || []).length))
t('openInfo 失败分支把所有字段存进 state（不是只存 error）', /setOpenInfo\(/.test(SRC) && /alternatives: d\.alternatives/.test(SRC) && /gatedOut: d\.gatedOut/.test(SRC))
t('修复回归锁：openIt 不再有「只判 d.ok、失败什么都不做」的写法',
  !/if \(d && d\.ok\) \{\s*setThread\(d\.thread\)\s*remember\(sceneId, d\.thread && d\.thread\.sessionId\)\s*\}\s*\}\)/.test(SRC))
t('op=chat-open 请求体带 provider/model（显式通道真的传上去了）', /body\.provider = sp\.provider/.test(SRC) && /body\.model = sp\.model/.test(SRC))
t('候选来自只读 op=routes（不自建第二份候选源）', /op=routes/.test(SRC))

/* ══ 7. 端到端接线：真实后端输出 → 真实前端视图模型 ═════════════════
 * [4] 用的是我手写的输入形状，可能跟后端实际返回不一致。
 * 这里用真 chat.mjs（桩 ctx）+ 盘上真 route-config 打出 explicit-blocked，
 * 把那份**原样对象**灌进 client.js 的 chatOpenVM，断言面板拿得到内容。
 * 这是唯一能证明「字段名前后端接得上」的证据。全程不建真会话、不发网络请求。
 */
console.log('\n[7] 端到端：真后端 explicit-blocked → 真前端 VM（字段名接得上）')
{
  const Chat = await import('../lib/orchestrator/chat.mjs')
  const R = await import('../lib/orchestrator/routes.mjs')
  const { fileURLToPath } = await import('node:url')
  const disk = await R.loadRouteConfig(fileURLToPath(new URL('..', import.meta.url)))
  const cfg = disk.config
  const mkCtx = () => {
    const seen = { create: null }
    const registry = {
      list: () => [{ session: { id: 'parent-x', header: { id: 'parent-x', origin: 'main' } }, options: { provider: 'qodercn', model: 'qfmodel' } }],
      create: async (arg) => { seen.create = arg; return { agent: { followup: async () => {}, inbox: { clear() {} } }, sessionId: arg.sessionId } },
    }
    return {
      ctx: { get: (n) => (n === 'agents' || n === 'agentRegistry' ? registry : n === 'sessions' ? { get: async () => null } : undefined) },
      seen,
    }
  }
 // **原样 spread**：不许逐个手写字段名。上一版写成 { alternatives: be.alternatives, … }，
 // 于是把 chatOpenVM 里的取值改成 d.alts（变异检验C）时本组照样全绿——
 // 手工重排等于自己把接线错误洗掉了，那就不是端到端。spread 之后字段名对不上就必红。
  const toVM = (be) => VM.chatOpenVM({ ...be })
  const disabledList = (cfg.disabledProviders || []).map((x) => String(x).toLowerCase())
  t('盘上配置确有被禁 provider（前提成立）', disabledList.length > 0, JSON.stringify(cfg.disabledProviders))
  const { ctx, seen } = mkCtx()
 // 从真实链上挑一条「provider 确实在禁用表里」的 route（别 provider/model 错配）
  let victim = null
  for (const dm of Object.keys(R.ROUTE)) {
    for (const row of R.routeChain(dm)) {
      if (disabledList.includes(String(row.provider).toLowerCase()) && row.model) {
        victim = { provider: row.provider, model: row.model, domain: dm, tier: row.tier }
        break
      }
    }
    if (victim) break
  }
  t('链上找到一条属于被禁 provider 的真实 route（前提成立）', !!victim, JSON.stringify(victim))
  const be = await Chat.openThread(ctx, {
    sceneId: 'verify-e2e-fb-1',
    provider: victim.provider, model: victim.model,
    routeConfig: cfg,
  })
  t('后端真返回 explicit-blocked', be && be.ok === false && be.reason === 'explicit-blocked', JSON.stringify({ ok: be.ok, r: be.reason }))
  t('  → registry.create 从未被调用（真没建会话）', seen.create === null, JSON.stringify(seen.create))
  const vm = toVM(be)
  t('VM 吃到后端真实字段：title 可读（不是空、不是「失败」）',
    typeof vm.title === 'string' && vm.title.length > 4, JSON.stringify(vm.title))
  t('  → blocked.blockedBy 与后端一致（字段名没写错）',
    vm.blocked && vm.blocked.blockedBy === be.blocked.blockedBy,
    `${vm.blocked && vm.blocked.blockedBy} vs ${be.blocked && be.blocked.blockedBy}`)
  t('  → 看得到原因（disabledReason 或 reason 有实词，验收①）',
    /限流|Balance|停用|禁|cap|倍率/.test(String(vm.blocked.disabledReason || '') + String(vm.blocked.reason || '')),
    String(vm.blocked.disabledReason).slice(0, 70))
  t('  → hint 原样可达', /替代|模型配置|挡住/.test(String(vm.hint)), String(vm.hint).slice(0, 90))
  t('  → alternatives 变成可点按钮且条数一致（验收②）',
    vm.altButtons.length === (be.alternatives || []).length && vm.altButtons.length > 0,
    `${vm.altButtons.length} vs ${(be.alternatives || []).length}`)
  t('  → 每个按钮都有 provider/model（真能发第二次 chat-open）',
    vm.altButtons.every((a) => a.provider && a.model && a.key), JSON.stringify(vm.altButtons[0] || null))
  t('  → 按钮的 provider 不在禁用表（替代不能又是被禁的）',
    vm.altButtons.every((a) => !disabledList.includes(a.provider.toLowerCase())),
    vm.altButtons.map((a) => a.key).join(','))
  t('  → copyKeys 非空（至少可复制）', vm.copyKeys.length > 0, vm.copyKeys.join(','))
  t('  → sourceText 说出来源档（验收③）', /显式指定/.test(vm.sourceText), vm.sourceText)
  t('  → tried 带过来（判定过程可展开）', Array.isArray(vm.tried) && vm.tried.length > 0, JSON.stringify(vm.tried).slice(0, 90))

 // no-route 端到端：配置链全挡 + 宿主快照也挡 → 面板也不能出现空白红卡
 // 注意别用 maxMultiplier:0 + cap:{} 想当然：倍率记 0 的免费项不满足 0>0，
 // 会被合法选中并真的建会话（本脚本第一版就踩在这，断言前提直接不成立）。
  const allProviders = Array.from(new Set([
    ...Object.keys(R.ROUTE).flatMap((dm) => R.routeChain(dm).map((row) => row.provider)),
    'qodercn', // 桩 ctx 里宿主快照挂的 provider
  ].filter(Boolean)))
  const tightCfg = R.resolveConfig({
    disabledProviders: allProviders,
    disabledReason: Object.fromEntries(allProviders.map((pv) => [pv, 'verify 全禁（构造 no-route）'])),
  })
  const c2 = mkCtx()
  const be2 = await Chat.openThread(c2.ctx, { sceneId: 'verify-e2e-fb-2', routeConfig: tightCfg })
  const vm2 = toVM(be2)
  t('no-route 端到端：ok=false 且 title 非空', be2.ok === false && vm2.title.length > 4, `${be2.reason} / ${JSON.stringify(vm2.title)}`)
  t('  → gatedRows / nextStep / hint 至少一个有内容（不空白）',
    vm2.gatedRows.length > 0 || vm2.nextStep !== null || !!vm2.hint || vm2.altButtons.length > 0,
    `gated=${vm2.gatedRows.length} next=${!!vm2.nextStep} hint=${!!vm2.hint} alt=${vm2.altButtons.length}`)
  t('  → create 同样未被调用', c2.seen.create === null, JSON.stringify(c2.seen.create))

 // 底线：宿主完全没回包（一个字段都没有）
  const vmBare = VM.chatOpenVM({ ok: false })
  t('底线：后端什么字段都没给 → title 仍非空（不渲染空白红卡）', vmBare.title.length > 4, JSON.stringify(vmBare.title))
  t('底线：undefined 入参也不抛', (() => { const v = VM.chatOpenVM(undefined); return v && v.tone === 'bad' && v.title.length > 0 })())
}

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：面板对 explicit-blocked 给可读原因 + 可点替代 + 来源档，被禁通道可见但标注原因。\n')
else console.log('有断言失败 —— 面板反馈偏离验收规格，先修这些。\n')
process.exit(fail === 0 ? 0 : 1)
