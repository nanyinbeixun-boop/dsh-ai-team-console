#!/usr/bin/env node
/**
 * verify-evolve-config.mjs —— 蒸馏门槛可配置（task_mwqf09kbh4lag）行为锁
 * 用临时 DSH_USER_DATA_ROOT 隔离真实配置；子进程式 env 注入 + 动态 import。
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}

// 临时用户数据根（隔离真实 evolve-config.json / 注册表 / skills）
const tmpRoot = mkdtempSync(join(tmpdir(), 'evolve-cfg-'))
process.env.DSH_USER_DATA_ROOT = tmpRoot
const stamp = Date.now()
const Evolve = await import(`../lib/orchestrator/evolve.mjs?t=${stamp}`)
const Reg = await import(`../lib/orchestrator/registry.mjs?t=${stamp}`)

console.log('\n[1] 默认值与校验')
t('默认 distillMinRounds=3', Evolve.DEFAULT_DISTILL_MIN_ROUNDS === 3)
t('合法区间 1-10', Evolve.DISTILL_ROUNDS_RANGE.min === 1 && Evolve.DISTILL_ROUNDS_RANGE.max === 10)
const def = await Evolve.readEvolveConfig()
t('文件不存在 → 读到默认 3', def.distillMinRounds === 3, JSON.stringify(def))
t('  → note 说明用了默认', /默认/.test(def.note || ''))
t('validate(1) 合法', Evolve.validateMinRounds(1) === null)
t('validate(10) 合法', Evolve.validateMinRounds(10) === null)
t('validate(0) 拒绝', /1-10|之间/.test(Evolve.validateMinRounds(0) || ''))
t('validate(11) 拒绝', /1-10|之间/.test(Evolve.validateMinRounds(11) || ''))
t('validate(2.5) 拒绝（非整数）', /整数/.test(Evolve.validateMinRounds(2.5) || ''))
t('validate("abc") 拒绝', /整数|数字/.test(Evolve.validateMinRounds('abc') || ''))

console.log('\n[2] 写入-读回往返')
const w1 = await Evolve.writeEvolveConfig(1)
t('写 1 成功', w1.ok === true && w1.distillMinRounds === 1, JSON.stringify(w1))
const r1 = await Evolve.readEvolveConfig()
t('读回 1', r1.distillMinRounds === 1, JSON.stringify(r1))
t('配置文件真落盘且无 BOM', (() => {
  const f = join(tmpRoot, 'ai-team-console', 'evolve-config.json')
  if (!existsSync(f)) return false
  const b = readFileSync(f)
  return !(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
})())
const bad0 = await Evolve.writeEvolveConfig(0)
const bad11 = await Evolve.writeEvolveConfig(11)
t('写 0 被拒（不改文件）', bad0.ok === false && (await Evolve.readEvolveConfig()).distillMinRounds === 1, JSON.stringify(bad0))
t('写 11 被拒（不改文件）', bad11.ok === false && (await Evolve.readEvolveConfig()).distillMinRounds === 1, JSON.stringify(bad11))

console.log('\n[3] maybeDistill 读门槛（rounds=1 假场景）')
// 造一个临时注册表场景：rounds=1、teamId 绑定当前有 handoff 的真实团队 → 门槛=1 时应能走到 due:true
const now = new Date().toISOString()
const regFile = join(tmpRoot, '_AI团队手册', '_registry.json')
const { mkdirSync } = await import('node:fs')
mkdirSync(join(tmpRoot, '_AI团队手册'), { recursive: true })
writeFileSync(regFile, JSON.stringify({ version: 1, updatedAt: now, scenarios: [{
  id: 'test-distill', name: '蒸馏测试', kind: 'general', workspace: tmpRoot, presetId: 'ai-team',
  handbookDir: join(tmpRoot, '_AI团队手册', 'test-distill'), teamId: 'team_mwpsxeul9lagp',
  leadSessionId: '6e33f884-2cb3-4fe3-9e26-d86cf97af24d', state: 'running', rounds: 1, createdAt: now,
}] }), 'utf8')
// 门槛=3（默认）时 rounds=1 被挡，reason 带数字
await Evolve.writeEvolveConfig(3)
const gated = await Evolve.maybeDistill('test-distill')
t('门槛=3、rounds=1 → due:false', gated.due === false, JSON.stringify(gated))
t('  → reason 带「需满 3 轮」', /需满 3 轮/.test(gated.reason || ''), gated.reason)
t('  → reason 带「可在技能页把门槛调低」', /门槛调低/.test(gated.reason || ''), gated.reason)
// 门槛=1 时不再被轮数拦住：要么 due:true，要么因 handoff 等后续原因挡（但不能再是"需满N轮"）
await Evolve.writeEvolveConfig(1)
const opened = await Evolve.maybeDistill('test-distill')
t('门槛=1、rounds=1 → 不再因轮数被挡', !/需满 \d+ 轮/.test(opened.reason || ''), JSON.stringify(opened))
t('  → 真跑通时 due:true（有 handoff 素材则生成草稿）', opened.due === true || /handoff|没有绑定团队|抽出/.test(opened.reason || ''), JSON.stringify(opened))

console.log('\n[4] index.js op=evolve-config 接线（静态）')
const idx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
t("有 op === 'evolve-config' 分支", /op === 'evolve-config'/.test(idx))
t('GET 读配置', /method === 'GET'/.test(idx) && /Evolve\.readEvolveConfig\(\)/.test(idx))
t('POST 校验 + 写入', /Evolve\.validateMinRounds\(body\.distillMinRounds\)/.test(idx) && /Evolve\.writeEvolveConfig/.test(idx))
t('非法值 400', /json\(res, 400, \{ ok: false, error: err \}\)/.test(idx))

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：蒸馏门槛可配置符合验收。\n')
else console.log('有断言失败。\n')
process.exitCode = fail === 0 ? 0 : 1
