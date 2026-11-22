#!/usr/bin/env node
/**
 * verify-skills.mjs —— op=skills 元数据行为锁
 * 临时 userDataRoot + 动态 import，隔离真实 skill 库。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + extra : ''}`) }
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-meta-'))
process.env.DSH_USER_DATA_ROOT = tmpRoot
const stamp = Date.now()
const Evolve = await import(`../lib/orchestrator/evolve.mjs?t=${stamp}`)

console.log('\n[1] 纯函数 roughChars / previewOf')
t('roughChars 去 markdown 标记后计数', Evolve.roughChars('# 标题\n**粗体** `code`\n正文一二三') === 13, Evolve.roughChars('# 标题\n**粗体** `code`\n正文一二三'))
t('roughChars 空值不炸', Evolve.roughChars(null) === 0)
const long = '甲'.repeat(500)
const pv = Evolve.previewOf(long, 300)
t('previewOf 截断到 300 + 省略号', pv.length === 301 && pv.endsWith('…'), String(pv.length))
t('previewOf 短文本原样', Evolve.previewOf('短文本') === '短文本')
t('previewOf 压缩空白', Evolve.previewOf('a  b\nc') === 'a b c')

console.log('\n[2] listSkills 元数据（临时目录假 md）')
const skillDir = join(tmpRoot, 'ai-team-console', 'skills')
const pendingDir = join(skillDir, '_pending')
mkdirSync(pendingDir, { recursive: true })
const mdContent = '# 测试技能\n\n> 状态：**pending（待人工确认）**\n> 来源：7 轮 handoff 归纳，生成于 2026-11-22\n> 场景：`team-l9lagp` · 类型 `software`\n\n## 这个 skill 管什么\n\n跑 team-l9lagp 场景时按经验走。\n\n## 以往各轮做过什么\n\n- 第一条操作记录\n- 第二条操作记录\n- 第三条操作记录\n- 第四条操作记录\n\n## 产物都落在哪\n\n- 产物在 skills 目录\n\n## 最容易错的（重点）\n\n- 坑一：mock handler 要走 Host 适配层\n- 坑二：withKey 会补回括号\n- 坑三：redteam 的 disabled 在 id 与 name 之间\n\n## 下一步建议\n\n- 稳定口径应注入空数组\n\n## 启用方式\n\n人工确认后移到 skills 根目录。\n'
writeFileSync(join(skillDir, 'active-test.md'), mdContent, 'utf8')
writeFileSync(join(pendingDir, 'pending-test.md'), mdContent + '待批内容。', 'utf8')
const res = await Evolve.listSkills()
t('返回含 active/pending/errors/root/pendingRoot', Array.isArray(res.active) && Array.isArray(res.pending) && Array.isArray(res.errors) && res.root && res.pendingRoot)
t('active 1 项、pending 1 项', res.active.length === 1 && res.pending.length === 1, JSON.stringify({ a: res.active.length, p: res.pending.length }))
const a = res.active[0]
t('保留 file/path 不变', a.file === 'active-test.md' && a.path === join(skillDir, 'active-test.md'), JSON.stringify(a))
t('bytes>0 且等于文件真实字节数', a.bytes > 0 && a.bytes === readFileSync(a.path).length, String(a.bytes))
t('chars>0', a.chars > 0, String(a.chars))
t('preview 是正文前缀', typeof a.preview === 'string' && mdContent.replace(/\s+/g, ' ').trim().startsWith(a.preview.replace(/…$/, '')), a.preview)
t('preview 长度≤300（+省略号最多301）', typeof a.preview === 'string' && a.preview.length <= 301, String(a.preview && a.preview.length))
t('mtime 是正数时间戳', typeof a.mtime === 'number' && a.mtime > 0, String(a.mtime))
const p = res.pending[0]
t('pending 项同样有元数据', p.bytes > 0 && p.chars > 0 && typeof p.mtime === 'number' && typeof p.preview === 'string' && p.preview.length <= 301, JSON.stringify({ file: p.file, bytes: p.bytes, chars: p.chars, previewLen: p.preview && p.preview.length }))
t('正常情况 errors 为空数组', res.errors.length === 0, JSON.stringify(res.errors))

console.log('\n[3] 单文件读失败不拖垮接口（errors 记录）')
// 造一个 dangling symlink（stat 失败）→ 应跳过并记录 error，不影响另一正常项
let linkOk = false
try {
  const { symlinkSync } = await import('node:fs')
  symlinkSync(join(skillDir, 'nonexistent-target.md'), join(skillDir, 'broken-link.md'))
  linkOk = true
} catch { /* Windows 无权限建链接则跳过本子测试 */ }
if (linkOk) {
  const res2 = await Evolve.listSkills()
  t('坏链接被跳过、正常项仍在', res2.active.some((x) => x.file === 'active-test.md') && !res2.active.some((x) => x.file === 'broken-link.md'), JSON.stringify(res2.active.map((x) => x.file)))
  t('  → errors 记一条 broken-link', res2.errors.some((e) => e.file === 'broken-link.md'), JSON.stringify(res2.errors))
} else {
  t('（跳过 symlink 子测试：当前环境无建链接权限）', true)
}

console.log('\n[4] 静态接线与失败隔离（防"读失败抛穿整个接口"回归）')
const idx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
t("op === 'skills' 仍调用 Evolve.listSkills", /op === 'skills'/.test(idx) && /Evolve\.listSkills\(\)/.test(idx))
const evSrc = readFileSync(new URL('../lib/orchestrator/evolve.mjs', import.meta.url), 'utf8')
t('listSkills 单文件读失败走 errors.push 而非 throw',
  /errors\.push\(\{ kind, file: f, path: full, error:/.test(evSrc)
  && !/errors\.push[\s\S]{0,80}throw e/.test(evSrc))
t('两个目录都经过 enrich（active/pending 同逻辑）',
  /await enrich\(SKILL_ROOT, active, 'active'\)/.test(evSrc) && /await enrich\(PENDING_ROOT, pending, 'pending'\)/.test(evSrc))

console.log('\n[5] 前端：门槛读配置 + 调节 UI + 空状态进度（静态源码锁）')
const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
t('前端读 op=evolve-config', /op=evolve-config/.test(cli))
t('任务页门槛来自 distillMinRounds（不写死3）',
  /distillMinRounds/.test(cli) && /setMinRounds\(n >= 1 && n <= 10 \? n : 3\)/.test(cli))
// 硬编码消除：蒸馏按钮判断处不得再有 < 3 / >= 3 / 3 - 这种写死
const distBtn = (cli.match(/蒸馏技能[\s\S]{0,600}/) || [''])[0]
t('蒸馏按钮无硬编码 <3 / >=3 / 3-', !/< 3\b/.test(distBtn) && !/>= 3\b/.test(distBtn) && !/\(3 - \(sc\.rounds/.test(distBtn))
t('门槛调节 UI：保存调 evolve-config POST',
  /mut\.send\('evolve-config', \{ distillMinRounds: Number\(cfgEdit\) \}\)/.test(cli))
t('门槛输入 1-10 校验', /Number\(cfgEdit\) >= 1 && Number\(cfgEdit\) <= 10/.test(cli))
t('门槛来源显示（自定义/默认）', /'自定义'/.test(cli) && /'默认'/.test(cli) && /cfg\.note/.test(cli))
t('空状态列工作项进度与还差轮数', /'还差 ' \+ gap \+ ' 轮'/.test(cli) && /'已跑 ' \+ r \+ ' 轮'/.test(cli))
t('空状态指名蒸馏入口在任务页', /蒸馏入口在【任务】页每个工作项卡片的「蒸馏技能」按钮/.test(cli))
t('去任务页按钮切页签', /p\.setTab === 'function'\) p\.setTab\('tasks'\)/.test(cli))
t('门槛=1且有0轮工作项时给专门提示', /门槛已是 1 轮，但仍有工作项 0 轮/.test(cli))
t('待批准预览优先用服务端 preview', /it\.preview \|\|/.test(cli))

console.log('\n[6] round-done：rounds 语义文案 + 两步状态机 + op 接线')
// rounds 语义澄清（技能页 + 任务页 ⓘ）
t('技能页说明 rounds=已完成轮次、运行中不计入',
  /轮次（rounds）统计的是已完成的轮次，不是会话正在跑的次数/.test(cli)
  && /会话开着的这段时间不计入/.test(cli))
t('任务页 rounds 旁有 ⓘ 悬停说明', /会话运行中不计入，需要在卡片上点「标记本轮完成」/.test(cli) && /轮 ⓘ/.test(cli))
t('「标记本轮完成」按钮存在且 idle 禁用', /标记本轮完成/.test(cli) && /sc\.state !== 'running' && sc\.state !== 'awaiting'/.test(cli) && /先跑流水线开出会话/.test(cli))
t('成功显示第 N 轮、失败显示卡在哪步', /已完成第 ' \+ roundDoneRes\.rounds \+ ' 轮/.test(cli) && /卡在步骤：' \+ roundDoneRes\.step/.test(cli))
// op=round-done 接线与两步调用
t("op=round-done 接线且两步都调 Reg.setState", /op === 'round-done'/.test(idx)
  && /Reg\.setState\(String\(id\), 'closing'\)/.test(idx) && /Reg\.setState\(String\(id\), 'done'\)/.test(idx))
t('失败如实报 step（closing/done）且不停在假成功', /step: 'closing'/.test(idx) && /step: 'done'/.test(idx) && /state: 'closing'/.test(idx))
t('不绕过状态机直接改 rounds（index.js 零 rounds 赋值）', !/\.rounds\s*=/.test(idx), (idx.match(/\.rounds\s*=[^\n]*/g) || []).join(' | '))
// 真跑两步状态机（临时注册表，不碰真实数据）
{
  const Reg = await import(`../lib/orchestrator/registry.mjs?rd=${Date.now()}`)
  const now = new Date().toISOString()
  const regFile = join(tmpRoot, '_AI团队手册', '_registry.json')
  const { mkdirSync: mk } = await import('node:fs')
  mk(join(tmpRoot, '_AI团队手册'), { recursive: true })
  writeFileSync(regFile, JSON.stringify({ version: 1, updatedAt: now, scenarios: [{
    id: 'rd-test', name: '轮次测试', kind: 'general', workspace: tmpRoot, presetId: 'ai-team',
    handbookDir: join(tmpRoot, '_AI团队手册', 'rd-test'), teamId: 'team_rdtest01',
    leadSessionId: '6e33f884-2cb3-4fe3-9e26-d86cf97af24d', state: 'running', rounds: 0, createdAt: now,
  }] }), 'utf8')
  const s1 = await Reg.setState('rd-test', 'closing')
  t('第一步 running→closing 成功', s1.ok === true && s1.to === 'closing', JSON.stringify(s1))
  const s2 = await Reg.setState('rd-test', 'done')
  t('第二步 closing→done 成功且 rounds=1', s2.ok === true && s2.scenario.state === 'done' && s2.scenario.rounds === 1, JSON.stringify(s2 && s2.scenario && { state: s2.scenario.state, rounds: s2.scenario.rounds }))
  const again = await Reg.setState('rd-test', 'done')
  t('再点一次（done→done）被状态机拒绝', again.ok === false && /非法状态转换/.test((again.errors || []).join('')), JSON.stringify(again))
  // running 直接 → done 必须被拒（证明不能跳步）
  writeFileSync(regFile, JSON.stringify({ version: 1, updatedAt: now, scenarios: [{
    id: 'rd-direct', name: '跳步测试', kind: 'general', workspace: tmpRoot, presetId: 'ai-team',
    handbookDir: join(tmpRoot, '_AI团队手册', 'rd-direct'), teamId: 'team_rdtest02',
    leadSessionId: '6e33f884-2cb3-4fe3-9e26-d86cf97af24d', state: 'running', rounds: 0, createdAt: now,
  }] }), 'utf8')
  const direct = await Reg.setState('rd-direct', 'done')
  t('running 直接→done 被拒（必须两步）', direct.ok === false && /非法状态转换 running → done/.test((direct.errors || []).join('')), JSON.stringify(direct))
}

console.log('\n[7] 结构化解构 summary（管什么/内容概览/最容易错的）')
const sum = a.summary
t('listSkills 项含 summary 对象', sum && typeof sum === 'object', JSON.stringify(sum))
t('purpose 抽到「这个 skill 管什么」正文', sum && /跑 team-l9lagp 场景时按经验走/.test(sum.purpose || ''), sum && sum.purpose)
t('scene.id / kind 从 > 场景 行解析', sum && sum.scene && sum.scene.id === 'team-l9lagp' && sum.scene.kind === 'software', sum && JSON.stringify(sum.scene))
t('generatedAt / handoffRounds 从 > 来源 行解析', sum && sum.generatedAt === '2026-11-22' && sum.handoffRounds === 7, sum && sum.generatedAt + '/' + sum.handoffRounds)
t('sections 4 条（排除 purpose 与启用方式）', sum && sum.sections.length === 4, sum && JSON.stringify(sum.sections.map((s) => s.title)))
t('count 为实际条目数（4/1/3/1）', sum && JSON.stringify(sum.sections.map((s) => s.count)) === JSON.stringify([4, 1, 3, 1]), sum && JSON.stringify(sum.sections.map((s) => s.count)))
t('items 只给前 3 条', sum && sum.sections.every((s) => s.items.length <= 3), sum && JSON.stringify(sum.sections.map((s) => s.items.length)))
t('最容易错的前 3 条含坑一', sum && (sum.sections.find((s) => s.title.indexOf('最容易错') >= 0) || { items: [] }).items.some((x) => /坑一/.test(x)))
t('fullPreview 返回全文（不再截 1500）', typeof a.fullPreview === 'string' && a.fullPreview.length > 300, a.fullPreview && String(a.fullPreview.length))
t('解析失败返回 null（无 ## 节）', Evolve.parseSkillSummary('纯文本没有标题') === null)
t('解析失败返回 null（空值）', Evolve.parseSkillSummary(null) === null)
// 方案B（task_mwr5w5z541f05i）：卡面改「中文场景名 + 用途 + 两行制踩坑 + 折叠技术层」。
// 断言跟着新结构走，并加锁 humanItems 消费与诚实截断提示——比原来只查文案更有意义。
t('前端卡面用中文场景名（不再直接摆文件名）',
  /sceneName/.test(cli) && /sm\.scene/.test(cli) && /\.replace\(\/-onboarding/.test(cli))
t('前端消费 humanItems（两行制 do/why）',
  /humanItems/.test(cli) && /x\.do/.test(cli) && /x\.why/.test(cli))
t('前端 humanItems 为 null 时退化并标「工程记录」',
  /工程记录/.test(cli) && /dangerHuman \|\|/.test(cli))
t('前端技术层折叠且标「给 AI 看的技术细节」',
  /给 AI 看的技术细节/.test(cli) && /'details'/.test(cli) && /atc-mini atc-code/.test(cli))
t('前端消费 fullPreviewTruncated（不假装完整）',
  /fullPreviewTruncated/.test(cli) && /截断版/.test(cli))
t('前端 summary 缺失退化为预览', /it && it\.summary/.test(cli) && /full\.slice\(0, 300\)/.test(cli))

console.log('\n[8] fullPreview 全文覆盖（task_mwr5w56n3zbo5y）')
const tailMark = 'END_MARKER_末尾标记_abcdef'
const bigMd = '# 大技能\n\n' + '甲'.repeat(5000) + '\n\n' + tailMark + '\n'
writeFileSync(join(skillDir, 'big-skill.md'), bigMd, 'utf8')
const bigRes = await Evolve.listSkills()
const big = (bigRes.active || []).find((x) => x.file === 'big-skill.md')
t('fullPreview 覆盖率 ≥98%（5000字源文件）', big && big.fullPreview.length >= 4900, big && String(big.fullPreview.length))
t('fullPreview 含末尾标记（真读全非中间截断）', big && big.fullPreview.indexOf(tailMark) >= 0)
t('fullPreviewTruncated=false（未超200KB）', big && big.fullPreviewTruncated === false)
t('阴性对照：preview 仍约300字（没被误改）', big && big.preview.length >= 290 && big.preview.length <= 301, big && String(big.preview.length))
t('preview 不含末尾标记（确认preview仍只取开头）', big && big.preview.indexOf(tailMark) < 0)
t('FULL_PREVIEW_MAX=200KB 已导出', Evolve.FULL_PREVIEW_MAX === 200 * 1024, String(Evolve.FULL_PREVIEW_MAX))

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail === 0) console.log('全部通过：op=skills 元数据齐全、读失败隔离、结构化摘要与前端展示一致。\n')
else console.log('有断言失败。\n')
process.exitCode = fail === 0 ? 0 : 1
