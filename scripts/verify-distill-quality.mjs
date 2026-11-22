#!/usr/bin/env node
/**
 * verify-distill-quality.mjs —— 蒸馏分桶召回率（task_mwr6312b639gf9）
 * 固定 fixture（不依赖运行环境），真跑 distill()，四指标 + 阴性对照 + 变异锚点。
 */
import { distill } from '../lib/orchestrator/evolve.mjs'
import { readFileSync } from 'node:fs'
let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}

// ── 固定 fixture ──
// 8 条短坑 + 7 条长坑（程序化补足到 >300 字，确保测到「长条二次切」能力）
const SHORT_PITS = [
  '不要用 Get-Content 读 UTF-8 中文会变閳，必须改用 node fs 字节级读取，不要在 PowerShell 里做文本往返',
  '改配置前必须先备份否则改坏回不去，因为 junction 容易误判真实路径，务必先确认实体目录位置',
  '遇到 FS_STALE_VERSION 要重新 read 再改不要硬写，否则会覆盖别人的并发修改，得改流程',
  'subagent 传对象给 isPrimaryModel 会返回 false，要传字符串或加对象兼容，别猜正则坏了',
  '倍率未知不能一律排除，our-free-model 免费 provider 要按 inferred=0 处理，否则误杀免费项',
  '生成类 route 不要加 forbid 规则硬拦，用户显式点名时必须放行，否则功能被封死',
  '状态推进要走 setState 两步 running→closing→done，不要直接改 rounds，否则留脏数据',
  '变异检验不要用行尾注释吞括号导致语法崩，要改用改值方式，否则假阴性',
]
const LONG_SEEDS = [
  '选路 TIER_ORDER 不能硬编码，要派生，否则主力被顶',
  '面板文案不能写厂商字样，残留检查会抓注释，务必逐个词核对',
  '注册表被旧快照周期回写会冲掉 setState，要加乐观锁定位回写源',
  '测试用模拟函数留盲点，必须另加静态断言锁真实实现才不漏',
  'npm 不在 PATH 要用 node 跑 verify-all，别直接 npm test 误判失败',
  '!!js 自定义标签 js-yaml 不认，解析前要把 !!js 包成字符串占位',
  'dangling symlink 在 Windows 无权限建，失败隔离要靠静态断言兜底',
]
// 确定性补足到每条 >300 字（中文 stack 重复，带动作词，保证进 pitfalls 且触发二次切）
const LONG_PITS = LONG_SEEDS.map((seed, i) => {
  const body = `${seed}，下次务必先按结构核对再动手避免重复踩坑，因为这类问题排查一次要花两轮，所以这里记下完整经验：`
  return body + `（要点${i + 1}）`.repeat(20) + '。' + `补充${i + 1}细节`.repeat(10)
})
const ALL_TRUE_PITS = [...SHORT_PITS, ...LONG_PITS]
const md = [
  '# 开团 skill（草稿）', '> 状态：**active**', '',
  '## 这个 skill 管什么', '', '跑 team-l9lagp 场景时按下面的经验走，不重复踩坑。', '',
  '## 做了什么', '- 完成四级选路重构并通过 567 条断言', '- 产物 routes.mjs 落盘', '',
  '## 最容易错的（重点）', ...ALL_TRUE_PITS.map((p) => `- ${p}`), '',
  '## 下一步', '- 到任务页标记本轮完成', '- 建议下次先跑 selfcheck', '',
].join('\n')
const r = distill('fixture', [{ value: md }])
const all = [...r.done, ...r.artifacts, ...r.pitfalls, ...r.next]

console.log('\n[1] 四指标')
console.log(`  pits=${r.pitfalls.length} done=${r.done.length} artifacts=${r.artifacts.length} next=${r.next.length} total=${all.length}`)
// 召回：每条真坑的前16字（clean 剥前缀后仍保留）能在某条 pits 里找到
const anchor = (s) => s.slice(0, 16)
const recalled = ALL_TRUE_PITS.filter((p) => r.pitfalls.some((x) => x.includes(anchor(p)) || p.includes(anchor(x)))).length
const recall = recalled / ALL_TRUE_PITS.length
console.log(`  recall=${recalled}/${ALL_TRUE_PITS.length}=${(recall * 100).toFixed(1)}%`)
t('pitfalls 召回 ≥80%', recall >= 0.8, `${(recall * 100).toFixed(1)}%`)
// 精确率：每条 pits 都要能对上一条真坑（用前16字双向匹配）
const noise = r.pitfalls.filter((x) => !ALL_TRUE_PITS.some((p) => p.includes(x.slice(0, 16)) || x.includes(anchor(p))))
t('pitfalls 精确率 100%（0 噪音）', noise.length === 0, `noise=${noise.length}: ${noise.map((x) => x.slice(0, 30)).join(' | ')}`)
// 长条：>300 字的种子应以多片形式出现（每片仍带锚点），至少 6/7 个种子有片落桶
const longHit = LONG_PITS.filter((p) => r.pitfalls.some((x) => x.includes(anchor(p)) || p.includes(anchor(x)))).length
t('长条切分 ≥6/7', longHit >= 6, `${longHit}/7`)
t('总落桶率 ≥90%（15坑+2done+2next=19，artifacts本fixture无）', all.length >= 18, `${all.length}/19`)
// 噪音排除
t('purpose 句不进任何桶', !all.some((x) => x.includes('按下面的经验走')))
t('小节标题不进任何桶', !all.some((x) => /最容易错的|这个 skill 管什么/.test(x)))
t('文档标题/引用不进桶', !all.some((x) => /开团 skill|状态：/.test(x)))

console.log('\n[2] 阴性对照：无 ## 结构纯文本走兼容路径不崩')
let legacy = null, threw = false
try { legacy = distill('legacy', [{ value: '做了什么：跑了三轮。最容易错：不要用 Get-Content 读中文会乱码，必须改 node fs。下一步：标记完成。' }]) } catch (e) { threw = true }
t('无结构文本不抛', !threw && Boolean(legacy))
t('  → 返回四个桶数组', Boolean(legacy) && ['done', 'artifacts', 'pitfalls', 'next'].every((k) => Array.isArray(legacy[k])))
// 动作性判据专测：无节标题时，只有「注意」字眼但无动作/因果的句子不该被误收进 pitfalls
// 说明：句子只含 pitfalls 关键词（注意/不一致/静默/失效），不碰 next/artifacts/done 规则，
// 且无任何动作词/因果词——这样"去动作性判据"的变异才会让它误进 pitfalls 而被抓。
const NOISE_SENTENCE = '注意：这里有静默失效与不一致的现象，纯属观察记录，供参考。'
const noiseCase = distill('noise', [{ value: NOISE_SENTENCE }])
// 校验这句只命中 pitfalls 关键词、不碰别的规则、且无动作/因果词（保证变异能隔离出动作性判据的作用）
t('  → 噪音用例本身不含动作/因果词与其他桶关键词', (() => {
  const s = NOISE_SENTENCE
  return !/不要|必须|改用|避免|别|得改|要改|应该|需要|务必|因为|所以|否则|导致|原因|一旦|造成/.test(s)
    && !/下一步|建议|下次|后续|待办|产物|落盘|路径|文件|字节|写到|生成|做了什么|完成|通过|跑通/.test(s)
})())
t('只有「注意」无动作性 → 不误进 pitfalls', (noiseCase.pitfalls || []).length === 0, JSON.stringify(noiseCase.pitfalls))

console.log('\n[3] 变异锚点（供变异检验定位）')
const src = readFileSync(new URL('../lib/orchestrator/evolve.mjs', import.meta.url), 'utf8')
t('Markdown 结构切分代码在（##/列表项/300 兜底）', /hasStructure/.test(src) && /item\.length > 300/.test(src) && /SECTION_BUCKET/.test(src))
t('动作性判据在', /isActionable/.test(src) && /ACTION_RE/.test(src) && /CAUSE_RE/.test(src))

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：蒸馏四指标达标。\n')
else console.log('有断言失败。\n')
process.exitCode = fail === 0 ? 0 : 1
