/**
 * artifacts.mjs —— 结构化工件 schema（先进编排迭代 2）
 *
 * 来源：_AI团队手册\先进自动化团队管理模式调研与迭代方案.md 迭代 2
 * （对齐 MetaGPT「agent 间只传结构化工件，不传自由对话」）。
 *
 * 三类核心工件的强制字段与可判定校验：
 * brief    任务简报   architect → maker
 * delivery 交付报告   maker → auditor/Lead（report_task summary 之外的落盘版）
 * audit    审计报告   auditor → Lead/用户
 *
 * 校验是「字段覆盖率」级别的（标题段存在 + 必填键出现），不做语义判断——
 * 语义对不对由 auditor 看，字段缺没缺由代码判。这与本插件「读不到就说读不到，
 * 不拿默认值糊过去」的纪律一致：validate 只回答「字段齐不齐」，不回答「写得好不好」。
 *
 * 纯函数模块：不 import fs、不读盘，op 层与脚本都能原样调用自证。
 */

/** 工件 schema 定义：fields 的 rule 是可判定的存在性判据 */
export const ARTIFACT_SCHEMAS = {
  brief: {
    id: 'brief',
    name: '任务简报',
    from: 'architect',
    to: 'maker',
    fields: [
      { key: '目标', required: true, rule: '一段话说清这一轮要产出什么', example: '给 UI 层做 GDI 泄漏全量扫描，只出报告不改码' },
      { key: '输入材料', required: true, rule: '上游材料的路径列表（不许贴正文）', example: 'knowledge/gdi_patterns.md；源码\\UI\\HomeWorkspacePanel.cs' },
      { key: '产出物', required: true, rule: '产物路径 + 格式', example: 'handbook\\97-体检报告.md（Markdown，含三列表）' },
      { key: '验收标准', required: true, rule: '可判定条目，每条能回答是/否', example: '报告含文件/行号/类型三列；git status 零新增改动' },
      { key: '边界', required: false, rule: '不许做的事', example: '不许修改任何 .cs 文件；禁新 NuGet' },
      { key: '依赖', required: false, rule: '上游 task id', example: 'task_xxx（无则省略）' },
    ],
  },
  delivery: {
    id: 'delivery',
    name: '交付报告',
    from: 'maker',
    to: 'auditor / Lead',
    fields: [
      { key: '产物路径列表', required: true, rule: '每个产物一行绝对或相对路径', example: 'handbook\\97-体检报告.md' },
      { key: '内容摘要', required: true, rule: '每个产物 ≤100 字，说清里面有什么', example: '97-体检报告：37 处泄漏点清单，按文件分节，含行号与对象类型' },
      { key: '自检结论', required: true, rule: '对照验收标准逐条 是/否 + 证据', example: '①三列表齐——是；②零新增改动——是（git status 输出见附录）' },
      { key: '已知风险', required: true, rule: '没把握的地方明说，不许漏', example: 'Program.cs 片段只抽了含 GDI 的方法，未含处可能有漏报' },
      { key: '建议复核点', required: false, rule: '希望 auditor 重点看哪里', example: '抽查 20% 行号是否与源码一致' },
    ],
  },
  audit: {
    id: 'audit',
    name: '审计报告',
    from: 'auditor',
    to: 'Lead / 用户',
    fields: [
      { key: '逐项核对表', required: true, rule: '条目 | 证据路径:行号 | 是/否', example: '三列表齐 | 97-体检报告.md:12 | 是' },
      { key: '问题清单', required: true, rule: '编号 | 位置 | 问题 | 建议改法', example: 'P1 | 报告§3 | 两处行号对不上源码 | 按 20% 抽查重核' },
      { key: '三态结论', required: true, rule: '通过 / 整改后通过 / 不通过，三选一', example: '整改后通过' },
    ],
  },
}

/** 三档 schema 目录（op=artifact-schema 的返回体） */
export function listSchemas() {
  return Object.values(ARTIFACT_SCHEMAS).map((s) => ({
    id: s.id,
    name: s.name,
    from: s.from,
    to: s.to,
    requiredFields: s.fields.filter((f) => f.required).map((f) => f.key),
    optionalFields: s.fields.filter((f) => !f.required).map((f) => f.key),
  }))
}

/**
 * 渲染某类工件的 Markdown 填写模板（成员照抄照填）。
 * @param {string} id brief|delivery|audit
 */
export function renderTemplate(id) {
  const s = ARTIFACT_SCHEMAS[id]
  if (!s) return null
  const lines = ['# ' + s.name + '（' + s.id + ' · ' + s.from + ' → ' + s.to + '）', '']
  for (const f of s.fields) {
    lines.push('## ' + f.key + (f.required ? '' : '（可选）'))
    lines.push('- 要求：' + f.rule + (f.required ? '' : '（可整段省略）'))
    if (f.example) lines.push('- 示例：' + f.example)
    lines.push('')
  }
  lines.push("> 本模板由 artifacts.mjs 生成；字段校验用 validateArtifact('" + id + "', text)。")
  return lines.join('\n')
}

/**
 * 校验一份工件文本的字段覆盖率。
 * 判据：必填字段的键名以「## <键>」或「<键>：」出现在文本里即算命中——
 * 模板渲染出来的标题与「键：值」行写法都能命中。
 *
 * @returns {{ok:boolean, missing:string[], coverage:number, present:string[], total:number}}
 * ok = 必填全命中；coverage = 命中必填数 / 必填总数（0-1）。
 */
export function validateArtifact(id, text) {
  const s = ARTIFACT_SCHEMAS[id]
  if (!s) return { ok: false, missing: [], coverage: 0, present: [], total: 0, error: '未知工件类型：' + id }
  const src = String(text || '')
  const required = s.fields.filter((f) => f.required)
  const present = []
  const missing = []
  for (const f of required) {
    const heading = new RegExp('^#{1,6}\\s*' + f.key + '\\s*$', 'm')
    const colon = new RegExp('^\\s*[\\*\\-\\s]*' + f.key + '\\s*[：:]', 'm')
    if (heading.test(src) || colon.test(src)) present.push(f.key)
    else missing.push(f.key)
  }
  const coverage = required.length ? present.length / required.length : 1
  return { ok: missing.length === 0, missing, coverage, present, total: required.length }
}