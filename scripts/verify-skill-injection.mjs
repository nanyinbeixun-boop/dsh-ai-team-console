#!/usr/bin/env node
/**
 * verify-skill-injection.mjs —— 技能正文/约束/领域知识真正进 brief（task_mwr5s4v72yf766）
 * 真跑 buildTaskBrief（不是静态正则），含阴性对照与接线核对。
 */
import { buildTaskBrief } from '../lib/orchestrator/pipeline.mjs'
import { readFileSync } from 'node:fs'
let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}
const TEAM = 'team_test', MEMBER = { id: 'm_test', name: 'maker' }
const TASK = { id: 'task_test', subject: '测试注入', plan: [
  { step: 'S1', action: 'read', detail: '读文件' },
  { step: 'S2', action: 'write', detail: '写产物' },
], acceptance: '产出可核对' }

console.log('\n[1] buildTaskBrief 真跑：三段注入')
const base = buildTaskBrief(TEAM, TASK, MEMBER, {})
t('基线 brief 含原有 13 行结构', /【dsh-team 任务派发】/.test(base) && /执行要求：/.test(base) && /验收标准：/.test(base))

const withSkill = buildTaskBrief(TEAM, TASK, MEMBER, { skillText: 'SKILL_MARKER_XYZ' })
t('opts.skillText → brief 含标记', withSkill.includes('SKILL_MARKER_XYZ'), withSkill.slice(0, 120))
t('  → 含「历史经验·必读」段头', /【本项目历史经验·必读】/.test(withSkill))
t('  → 标注总长（全文 N 字，已全部注入）', /全文 16 字，已全部注入/.test(withSkill))

const withCons = buildTaskBrief(TEAM, TASK, MEMBER, { constraintsText: 'C# 7.3\n禁新NuGet' })
t('opts.constraintsText → brief 含该文本', withCons.includes('C# 7.3') && withCons.includes('禁新NuGet'))
t('  → 含「硬约束（必须遵守）」段头', /本场景硬约束（必须遵守）：/.test(withCons))

const withKb = buildTaskBrief(TEAM, TASK, MEMBER, { knowledgeFiles: ['/a/b.md', 'D:\\x\\c.md'] })
t('opts.knowledgeFiles → brief 含路径', withKb.includes('/a/b.md') && withKb.includes('D:\\x\\c.md'))
t('  → 含「领域知识文件（动手前先读）」段头', /领域知识文件（动手前先读）：/.test(withKb))

const all = buildTaskBrief(TEAM, TASK, MEMBER, {
  constraintsText: 'CONSTRAINT_MARKER', knowledgeFiles: ['/kb.md'], skillText: 'SKILL_MARKER_XYZ',
})
t('三段同时给 → 全都在，且顺序 约束→知识→技能',
  all.indexOf('CONSTRAINT_MARKER') < all.indexOf('/kb.md')
  && all.indexOf('/kb.md') < all.indexOf('SKILL_MARKER_XYZ'))

console.log('\n[2] 阴性对照：不给 opts 就不出现历史经验段')
t('opts={} → brief 不含「历史经验」', !/历史经验·必读/.test(base) && !/已全部注入/.test(base))
t('  → brief 不含硬约束/知识段头', !/本场景硬约束/.test(base) && !/领域知识文件（动手前先读）/.test(base))

console.log('\n[3] 长技能不截断')
const longSkill = '甲'.repeat(9000)
const longBrief = buildTaskBrief(TEAM, TASK, MEMBER, { skillText: longSkill })
t('9000 字技能全文注入（不截断）', longBrief.includes(longSkill) && longBrief.includes('全文 9000 字'))

console.log('\n[4] 接线核对（S4 写 state / 调用点传参）')
const src = readFileSync(new URL('../lib/orchestrator/pipeline.mjs', import.meta.url), 'utf8')
t('S4 写 skillText/skillPath 到 state', /ctx\.state\.skillText = skillRes\.content/.test(src) && /ctx\.state\.skillPath = skillRes\.path/.test(src))
t('S4 复用 ctx.state.skill 且回落 findSkillFor', /ctx\.state\.skill \|\| \(await Reg\.findSkillFor/.test(src))
t('调用点传三段 opts（精确匹配 buildTaskBrief 调用块）', (() => {
  const m = src.match(/const brief = buildTaskBrief\(teamId, task, member, \{[\s\S]{0,300}?\}\)/)
  return Boolean(m) && /constraintsText: ctx\.state\.constraintsText/.test(m[0])
    && /knowledgeFiles: ctx\.state\.knowledgeFiles/.test(m[0]) && /skillText: ctx\.state\.skillText/.test(m[0])
})())
t('未改 findSkillFor（读 content 仍对）', /findSkillFor[\s\S]{0,400}content/.test(readFileSync(new URL('../lib/orchestrator/registry.mjs', import.meta.url), 'utf8')))

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：技能正文/约束/知识真正进入 brief。\n')
else console.log('有断言失败。\n')
process.exitCode = fail === 0 ? 0 : 1
