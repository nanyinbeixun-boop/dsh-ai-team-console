#!/usr/bin/env node
/**
 * verify-model-tab.mjs —— 模型页重构（task_mwq67zvd9hcl6v）行为锁
 * 不联网、不渲染 DOM：静态核对 TabModels 源码结构 + 真跑新增的纯函数。
 * 用法：node scripts/verify-model-tab.mjs   退出码 0=全过 1=有失败
 */
import { readFileSync } from 'node:fs'
let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}
const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// 抽出 TabModels 函数体。
// 2026-11-22 修复：原先用注释锚点 '/* ── P20' 定位结束，但该注释块被移除后
// indexOf 返回 -1，cli.slice(s, -1) 把整个后半文件扫进来，导致函数体外的
// 中文标签表(provider-disabled 等)与 ONBOARD_STEPS 的 atc-grid 被误判为
// 「模型页渲染文案」。改为花括号配对算函数真正的结束，不依赖会过期的注释。
const s = cli.indexOf('function TabModels(p) {')
function braceEnd(src, startIdx) {
  const open = src.indexOf('{', startIdx)
  if (open < 0) return -1
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i + 1 }
  }
  return -1
}
const e = braceEnd(cli, s)
if (s < 0 || e < 0) { console.error('找不到 TabModels 函数边界，无法校验'); process.exit(1) }
const tab = cli.slice(s, e)
// 抽出新加的四个纯函数（TabModels 之前）
const helpers = cli.slice(Math.max(0, s - 1800), s)

console.log('\n[1] 开发者术语不在模型页渲染文案里')
// task_mwq7xz2z2dg4bm：原 banned 表漏掉路径/relay/内网地址/配置来源字段，
// 42 条全绿却放过 L1749 的绝对路径泄漏。这里补齐并检查 TabModels 全部渲染文案
// （不再只切某一段——包括高级设置折叠区在内，整段函数体都扫）。
const banned = [
  'provider-disabled', 'provider-cap', 'route-disabled', 'audit.paid', 'code.last', 'check-free-routes.mjs', "our-free-model/*'",
  'D:\\', '/route-config.json', 'relay', '127.0.0.1', 'configSource.file', 'configSource.source',
]
for (const b of banned) {
  // 注释里可以提（排查用），这里只看字符串字面量（被 h(...) 渲染的）
  const rendered = tab.split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && l.includes(b))
  t(`渲染文案不含「${b}」`, rendered.length === 0, rendered.slice(0, 2).join(' | '))
}
t('不含独立厂商术语「整厂」在渲染文本', !/'[^']*整厂[^']*'/.test(tab.replace(/\/\/[^\n]*/g, '')))

console.log('\n[2] 顶部一句话摘要 + 当前指挥模型')
t('有「现在能用 N 条通道」摘要', /现在能用 ['"]? \+ okRows\.length/.test(tab))
t('摘要含最便宜通道与价格', /最便宜的是/.test(tab) && /priceTextOf\(cheapest\)/.test(tab))
t('摘要含当前指挥模型', /当前指挥模型：/.test(tab))

console.log('\n[3] 主列表只列可用通道，一行一条')
t('主列表遍历 okRows（可用项）', /okRows\.map\(function \(r\)/.test(tab))
t('主列表标题写可用条数', /可用通道（共 ['"]? \+ okRows\.length/.test(tab))
t('一行含 通道名/模型名/价格/用途 四列', /channelNameOf\(r, lanes\)/.test(tab) && /r\.model/.test(tab) && /priceTextOf\(r\)/.test(tab) && /purposeOf\(r\)/.test(tab))

console.log('\n[4] 免费池与列表合并（无独立 grid 卡片）')
t('免费池不再用 atc-grid 单独铺卡片', !/atc-grid/.test(tab))
// 2026-11-21 再清：删「已并入下方列表」这类解释重构动作的句子，只保留"价格列显示免费"的事实
t('免费项在主列表价格列显示「免费」，无「已并入」解释句',
  /priceTextOf\(r\)/.test(tab) && !/已并入下方列表/.test(tab) && !/价格列显示「免费」/.test(tab))
t('priceTextOf 把倍率 0 显示为「免费」', /m === 0\) return '免费'/.test(helpers))

console.log('\n[5] 停用原因只显示一处 + 已停用默认折叠')
t('原因统一走 reasonOf（单一来源）', /reasonOf\(r\)/.test(tab))
t('主列表不重复显示停用原因（okRows 分支无 reasonOf）', (() => {
  const listPart = tab.slice(tab.indexOf('主列表'), tab.indexOf('③ 已停用') >= 0 ? tab.indexOf('③ 已停用') : tab.indexOf('已停用 '))
  return !/reasonOf/.test(listPart)
})())
t('已停用区用 details 默认折叠', /h\('details'/.test(tab) && /点开看原因/.test(tab))
t('折叠标题含停用条数', /已停用 ['"]? \+ offRows\.length/.test(tab))
t('原因清洗函数去掉括号英文键', /replace\(\/（\[^）\]\*\[a-z\]/i.test(helpers) || /cleanReasonOf/.test(helpers))

console.log('\n[6] 高级设置折叠：cap 与开关收进去')
t('高级设置用 details 折叠', /高级设置 ▸/.test(tab) && /h\('details'/.test(tab))
t('设上限按钮仍在（保留能力）', /设上限/.test(tab))
t('停用/启用整条通道按钮仍在（保留能力）', /停用整条通道/.test(tab) && /启用整条通道/.test(tab))
t('设上限/开关出现在「高级设置」之后（不在主视野）', (() => {
  const hi = tab.indexOf('高级设置 ▸')
  const cap = tab.indexOf("}, '设上限')")
  return hi >= 0 && cap > hi
})())

console.log('\n[7] 硬约束：不删数据 + 显式视觉放行未破坏')
t('高级设置里仍遍历全部候选（含停用）', /g\.rows\.map/.test(tab))
t('停用项仍完整可见（offRows.map 渲染 key+原因）', /offRows\.map/.test(tab))
t('写操作回执保留', /上次操作/.test(tab) && /mut\.result/.test(tab))
// 显式视觉放行是 routes.mjs 的行为，这里确认没被 UI 改动破坏（静态确认 UI 没碰 gateRoute）
const routes = readFileSync(new URL('../lib/orchestrator/routes.mjs', import.meta.url), 'utf8')
t('routes.mjs 生成意图豁免仍在', /isGenerationIntent/.test(routes) && /exemptedBy/.test(routes))
t('client.js 未新增任何生成类硬拦', !/forbidImageGen|blockGeneration/.test(cli))

console.log('\n[8] 纯函数真实调用（不是只看源码）')
{
  const vmModule = await import('node:vm')
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const reactStub = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f() }
  let captured = null
  const sandbox = {
    console, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, Buffer, process, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Set, Map, isFinite, isNaN, parseInt, parseFloat,
    document: { createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }), getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} } },
    navigator: {}, localStorage: { getItem: () => null, setItem() {} }, fetch: () => Promise.reject(new Error('no net')),
  }
  sandbox.window = { confirm: () => true, __ModuleLoader__: { load: (def) => { captured = def.factory((id) => (id === 'react' ? reactStub : {})) } } }
  vmModule.createContext(sandbox)
  vmModule.runInContext(src, sandbox, { filename: 'client.js' })
  const V = (captured && captured.__vm) || {}
  t('__vm 导出了模型页白话纯函数（含 configSourceTextOf）', ['priceTextOf', 'purposeOf', 'cleanReasonOf', 'reasonOf', 'channelNameOf', 'configSourceTextOf'].every((k) => typeof V[k] === 'function'))
  t("priceTextOf(0) = '免费'", V.priceTextOf({ multiplier: 0 }) === '免费', V.priceTextOf && V.priceTextOf({ multiplier: 0 }))
  t("priceTextOf(0.11) = 'x0.11'", V.priceTextOf({ multiplier: 0.11 }) === 'x0.11', V.priceTextOf && V.priceTextOf({ multiplier: 0.11 }))
  t("priceTextOf(null) = '价格未标注'", V.priceTextOf({ multiplier: null }) === '价格未标注')
  t('purposeOf(主力) = 主力干活', V.purposeOf({ tier: 'paid', key: 'workbuddy/x' }) === '主力干活')
  t('purposeOf(modlens) = 看图与界面判断', V.purposeOf({ tier: 'paid', key: 'modlens-workbuddy/glm-5.3' }) === '看图与界面判断')
  t('purposeOf(免费补位) 含「补位」', /补位/.test(V.purposeOf({ tier: 'free', stability: 'flakey', key: 'our-free-model/x' })))
  t('cleanReasonOf 去掉括号里的英文键', V.cleanReasonOf('账号级限流（provider-disabled）') === '账号级限流', V.cleanReasonOf && V.cleanReasonOf('账号级限流（provider-disabled）'))
  t('reasonOf 用停用原因且不重复', V.reasonOf({ disabledReason: '账号级限流（provider-disabled）', gateReason: '另一句' }) === '账号级限流')
  t('reasonOf 空值兜底', V.reasonOf(null) === '暂时不可用')
  t('channelNameOf 优先人读名', V.channelNameOf({ provider: 'workbuddy' }, { workbuddy: { name: '工作台' } }) === '工作台')
  // 路径泄漏回归：即使后端给了绝对路径，文案也不含它，只说中文状态
  const leakedPath = 'D:\\软件\\DSH\\用户数据\\ai-team-console\\route-config.json'
  const txt = V.configSourceTextOf({ source: 'file', file: leakedPath })
  t('configSourceTextOf(file) 不泄漏绝对路径/字段名', txt === '配置来源：本地配置文件（已生效）', txt)
  t('configSourceTextOf(file) 不含反斜杠路径或 source 英文值', !/[A-Za-z]:\\/.test(txt) && !/route-config\.json|\bfile\b/.test(txt), txt)
  t("configSourceTextOf(default) = 默认配置（未找到本地文件）", V.configSourceTextOf({ source: 'default' }) === '配置来源：默认配置（未找到本地文件）')
  t('configSourceTextOf(null) 返回空串（不渲染）', V.configSourceTextOf(null) === '')
}

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：模型页重构 7 项具体问题均解决，且未删数据、未破坏视觉放行。\n')
else console.log('有断言失败 —— 模型页重构未达标。\n')
process.exitCode = fail === 0 ? 0 : 1
