/**
 * 自我迭代 —— 从 handoff 蒸馏 skill
 *
 * 闭环：
 * 跑一轮 → 写 handoff（在 team memory 里）
 * 跑满 3 轮 → 本模块把 handoff 汇总成 skill 草稿
 * 人过一遍 → 启用 → 下轮开团自动加载，跳过人工判断
 *
 * 为什么必须「人过一遍」：
 * 蒸馏是归纳，归纳会出错。学到错的 skill 会让下一轮更差，且错误会自我强化。
 * 所以产出的是 **草稿（pending）**，不是直接生效的 skill。
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import * as Reg from './registry.mjs'

const USER_DATA = Reg.paths.userData
const SKILL_ROOT = join(USER_DATA, 'ai-team-console', 'skills')
const PENDING_ROOT = join(SKILL_ROOT, '_pending')
const CONFIG_FILE = join(USER_DATA, 'ai-team-console', 'evolve-config.json')

/** 蒸馏门槛默认值与合法区间（用户 2026-11-21 批准可配置：默认3，可调1-10） */
export const DEFAULT_DISTILL_MIN_ROUNDS = 3
export const DISTILL_ROUNDS_RANGE = { min: 1, max: 10 }

/** 校验门槛值：合法返回 null，非法返回可读错误（读写两处共用） */
export function validateMinRounds(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n)) return 'distillMinRounds 必须是整数'
  if (n < DISTILL_ROUNDS_RANGE.min || n > DISTILL_ROUNDS_RANGE.max) {
    return `distillMinRounds 必须在 ${DISTILL_ROUNDS_RANGE.min}-${DISTILL_ROUNDS_RANGE.max} 之间（收到 ${n}）`
  }
  return null
}

/** 读蒸馏配置：文件不存在/坏 JSON/非法值 → 默认 3（不抛，面板不能被坏文件卡死） */
export async function readEvolveConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8')
    const doc = JSON.parse(raw.replace(/^\ufeff/, ''))
    const v = doc && doc.distillMinRounds
    return validateMinRounds(v) === null
      ? { distillMinRounds: Number(v), path: CONFIG_FILE }
      : { distillMinRounds: DEFAULT_DISTILL_MIN_ROUNDS, path: CONFIG_FILE, note: '配置值非法，已回落默认 3' }
  } catch {
    return { distillMinRounds: DEFAULT_DISTILL_MIN_ROUNDS, path: CONFIG_FILE, note: '无配置文件，使用默认 3' }
  }
}

/** 写蒸馏配置：校验后落盘（原子性不追求，单文件小配置） */
export async function writeEvolveConfig(distillMinRounds) {
  const err = validateMinRounds(distillMinRounds)
  if (err) return { ok: false, error: err }
  await mkdir(dirname(CONFIG_FILE), { recursive: true })
  const v = typeof distillMinRounds === 'string' ? Number(distillMinRounds) : distillMinRounds
  await writeFile(CONFIG_FILE, JSON.stringify({ distillMinRounds: v }, null, 2), 'utf8')
  return { ok: true, distillMinRounds: v, path: CONFIG_FILE }
}

async function ensureDirs() {
  await mkdir(SKILL_ROOT, { recursive: true })
  await mkdir(PENDING_ROOT, { recursive: true })
}

/* ── 从 team memory 读 handoff ─────────────────────────────────── */

/**
 * 列表接口只回元数据（id/slot/kind/size…），**不含 value 正文**。
 * 要拿正文必须逐条 GET /api/memory/:id。这个坑不踩过一次就会以为 handoff 是空的。
 */
async function fetchHandoffs(teamId, limit = 100) {
  const base = process.env.DSH_TEAM_SIDECAR_URL || 'http://127.0.0.1:4317'
  let meta
  try {
    const r = await fetch(`${base}/api/memory?team=${encodeURIComponent(teamId)}&limit=${limit}`, {
      headers: { accept: 'application/json' },
    })
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, items: [] }
    const d = await r.json()
    meta = Array.isArray(d) ? d : (d.items || [])
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), items: [] }
  }

  const handoffMeta = meta.filter(
    (m) => String(m.kind || '') === 'handoff' || /^handoff\//.test(String(m.slot || '')),
  )
  if (handoffMeta.length === 0) return { ok: true, items: [] }

  // 逐条取正文
  const items = []
  const failures = []
  for (const m of handoffMeta) {
    try {
      const r = await fetch(
        `${base}/api/memory/${encodeURIComponent(m.id)}?team=${encodeURIComponent(teamId)}`,
        { headers: { accept: 'application/json' } },
      )
      if (!r.ok) { failures.push(`${m.id}: HTTP ${r.status}`); continue }
      const d = await r.json()
      const full = d.memory || d
      const value = full.value ?? d.value ?? ''
      items.push({
        id: m.id,
        slot: m.slot || full.slot || '',
        kind: m.kind || full.kind || '',
        title: m.title || full.title || '',
        value: typeof value === 'string' ? value : JSON.stringify(value),
        size: m.size || String(value).length,
      })
    } catch (e) {
      failures.push(`${m.id}: ${e && e.message ? e.message : e}`)
    }
  }
  return { ok: true, items, failures, metaCount: handoffMeta.length }
}

/* ── 蒸馏：把多轮 handoff 归纳成一份 skill 草稿 ─────────────────── */

/**
 * 归纳不靠模型，靠结构化抽取 —— 确定性、可复现、零 token。
 *
 * 现实里的 handoff 有两种写法：
 * A) 分行带前缀：  「做了什么：…」「最容易错：…」
 * B) 一整段叙述：  「做了什么…最关键的是…下一步…我门建议…」
 * B 才是实际常见形态（本轮实测就是），所以不能只按行首前缀分类。
 * 这里的做法：先按行/句切，再用「就近关键词」归类 —— 一句话里提到哪类词，就归到哪类。
 */
function distill(scenarioId, handoffs) {
  const buckets = { done: [], artifacts: [], pitfalls: [], next: [] }

  // 关键词兜底判据（仅在节标题没给明确归类时用）。pitfalls 不再"先到先得"：
  // 关键词只提供候选，真正进 pitfalls 还要过「动作性」判据（见 isActionable）。
  const RULES = [
    { key: 'next', re: /下一步|建议|下次|后续|待办/ },
    { key: 'artifacts', re: /产物|落盘|路径|字节|写到|生成/ },
    { key: 'done', re: /做了什么|完成|已|通过|跑通|审了|写齐|落地/ },
    { key: 'pitfalls', re: /最容易错|容易错|踩坑|翻车|注意|坑|故障|报错|漏|静默|失效|不一致/ },
  ]
  // 节标题 → 桶（结构优先，最可靠的分类线索）
  const SECTION_BUCKET = [
    { re: /最容易错|踩坑|注意事项|注意的|翻车|故障/, key: 'pitfalls' },
    { re: /下一步|后续|待办|建议/, key: 'next' },
    { re: /产物|落盘|交付物/, key: 'artifacts' },
    { re: /做了什么|已完成|完成的事/, key: 'done' },
  ]
  // purpose 节（"这个 skill 管什么"）正文只是说明，不是经验，不进任何桶
  const PURPOSE_RE = /这个 skill 管什么|用途|简介|本 skill|管什么/
  const ACTION_RE = /不要|必须|改用|避免|别|得改|要改|应该|先|再|改为|换成|改用|记着|记得|需要|务必/
  const CAUSE_RE = /因为|所以|否则|导致|结果|原因|一旦|造成/
  const isActionable = (s) => ACTION_RE.test(s) || CAUSE_RE.test(s)

  /** 把一段文本切成 {text, sectionKey, fromList} 条目：Markdown 结构优先，字数兜底 */
  function splitEntries(text) {
    const lines = String(text || '').split(/\r?\n/)
    const hasStructure = lines.some((l) => /^##\s/.test(l.trim()))
    const out = []
    if (hasStructure) {
      let section = null // { title, key }
      for (const raw of lines) {
        const line = raw.trim()
        if (/^##\s/.test(line)) {
          const title = line.replace(/^##\s+/, '').trim()
          const hitSec = SECTION_BUCKET.find((s) => s.re.test(title))
          section = { title, key: hitSec ? hitSec.key : (PURPOSE_RE.test(title) ? 'purpose' : null), isPurpose: PURPOSE_RE.test(title) }
          continue
        }
        if (/^#\s/.test(line) || /^>/.test(line) || !line) continue // 文档标题/引用/空行不进桶
        // 列表项 '- ' 是天然语义边界；无列表符号的普通行也按一条处理
        const item = /^[-*]\s+/.test(line) ? line.replace(/^[-*]\s+/, '').trim() : line
        if (!item) continue
        // 只有列表项仍过长（>300）才二次切，按句号/分号；中文无句号的长条也能靠 '- ' 边界保住
        const chunks = item.length > 300
          ? item.split(/[。；;？！]\s*/).map((s) => s.trim()).filter((s) => s.length >= 10)
          : [item]
        for (const c of chunks) out.push({ text: c, sectionKey: section && !section.isPurpose ? section.key : null, isPurpose: Boolean(section && section.isPurpose) })
      }
    } else {
      // 兼容路径（真实 handoff 99% 是这种：一整段叙述，无 ## 无 - 列表）：
      // 旧逻辑只按句号切、且 ≤200 字整行保留——句中标点（尤其"坑："）全被埋在长句中间。
      // 现在三段 fallback：① 句内语义标记优先切（坑：/注意：/踩坑：/问题：/风险：/修复：/建议：/下一步：）
      //                    ② 仍 >150 字再按逗号切  ③ 最后退回原句号/200字兜底。
      // "坑："类标记切出的片段 forceKey='pitfalls'，不再依赖关键词二次判（标记本身就是最强信号）。
      // 语义标记只在「句首」认（避免把代码/引用里的"注意："当标记切碎，如 致"注意："丢失）
      const INLINE_SEP = /[。；;？！]\s*/
      const PITFALL_MARK = /^(坑|注意|踩坑|问题|风险)[：:]/
      for (const raw of lines) {
        const t = raw.trim()
        if (!t || /^[#>]/.test(t)) continue
        // ① 先按句号/分号切句子（天然边界），再按句内「；」后的标记切
        const sentences = t.split(INLINE_SEP).map((s) => s.trim()).filter((s) => s.length >= 10)
        const chunks = []
        for (const sentence of sentences) {
          // 一个句子里可能含多个"；坑：...；坑：..."，按分号二次切（这里分号后是标记才认）
          const subs = sentence.split(/[；;]\s*/).map((s) => s.trim()).filter((s) => s.length >= 10)
          for (const seg of (subs.length ? subs : [sentence])) {
            const forceKey = PITFALL_MARK.test(seg) ? 'pitfalls'
              : /^修复[：:]/.test(seg) ? (isActionable(seg) ? 'pitfalls' : 'done')
              : /^(建议|下一步)[：:]/.test(seg) ? 'next'
              : null
            // ② 片段仍 >150 字，再按逗号切一次（中文长句常见）；但代码密集段（含 ` 或 ^）不切，避免切碎正则
            if (seg.length > 150 && !/[`^]/.test(seg)) {
              for (const sub of seg.split(/[，,]\s*/)) {
                const ss = sub.trim()
                if (ss.length >= 10) chunks.push({ text: ss, forceKey })
              }
            } else chunks.push({ text: seg, forceKey })
          }
        }
        // ③ 一句都没切出（极短/纯标点）→ 退回原兜底整行
        if (chunks.length === 0 && t.length >= 10) chunks.push({ text: t, forceKey: null })
        for (const c of chunks) out.push({ text: c.text, sectionKey: null, forceKey: c.forceKey || null, isPurpose: false })
      }
    }
    return out
  }

  for (const h of handoffs) {
    for (const entry of splitEntries(h.value)) {
      const clean = entry.text.replace(/^[^：:]{0,12}[：:]\s*/, '').trim()
      if (clean.length < 10 || entry.isPurpose) continue
      let hit = entry.sectionKey || entry.forceKey // 结构优先；其次句内语义标记（"坑："直接定 pitfalls）
      if (!hit) {
        // 内容兜底：关键词候选；pitfalls 需额外过动作性判据，否则降级为 none（不误收标题/purpose 句）
        for (const r of RULES) {
          if (!r.re.test(clean)) continue
          if (r.key === 'pitfalls' && !isActionable(clean)) continue // 只有"注意"字眼但无动作性 → 不算踩坑
          hit = r.key; break
        }
      }
      if (hit && buckets[hit]) buckets[hit].push(clean)
    }
  }

  const uniq = (arr) => {
    const seen = new Set()
    const out = []
    for (const x of arr) {
      const k = x.slice(0, 50)
      if (seen.has(k) || x.length < 10) continue
      seen.add(k)
      out.push(x)
    }
    return out
  }

  return {
    done: uniq(buckets.done),
    artifacts: uniq(buckets.artifacts),
    pitfalls: uniq(buckets.pitfalls),
    next: uniq(buckets.next),
    sourceCount: handoffs.length,
  }
}

/** 把蒸馏结果写成 skill 草稿（Markdown） */
function renderSkill(scenarioId, scenario, d) {
  const ts = new Date().toISOString().slice(0, 10)
  const L = []
  L.push(`# ${scenario.name || scenarioId} · 开团 skill（草稿）`)
  L.push('')
  L.push(`> 状态：**pending（待人工确认）**`)
  L.push(`> 来源：${d.sourceCount} 轮 handoff 归纳，生成于 ${ts}`)
  L.push(`> 场景：\`${scenarioId}\` · 类型 \`${scenario.kind}\``)
  L.push('')
  L.push('## 这个 skill 管什么')
  L.push('')
  // purpose 是卡面第一屏给人看的，不能出现 team-l9lagp 这类技术标识。
  // 用场景中文名；拿不到就用中性说法，别把 ID 摆上去。
  const sceneLabel = String(scenario.name || '').trim() || '这个工作项'
  L.push(`在「${sceneLabel}」里开团时，按下面的经验走，能避开前几轮踩过的坑。`)
  L.push('')
  L.push('## 以往各轮做过什么')
  L.push('')
  if (d.done.length) d.done.slice(0, 12).forEach((x) => L.push(`- ${x}`))
  else L.push('- （handoff 里没抽出「做了什么」，检查 handoff 格式）')
  L.push('')
  L.push('## 产物都落在哪')
  L.push('')
  if (d.artifacts.length) d.artifacts.slice(0, 12).forEach((x) => L.push(`- ${x}`))
  else L.push(`- handbook：\`${scenario.handbookDir}\``)
  L.push('')
  L.push('## 最容易错的（重点）')
  L.push('')
  if (d.pitfalls.length) d.pitfalls.slice(0, 15).forEach((x) => L.push(`- ${x}`))
  else L.push('- （还没有足够样本，跑满 3 轮后再蒸馏）')
  L.push('')
  L.push('## 下一步建议')
  L.push('')
  if (d.next.length) d.next.slice(0, 10).forEach((x) => L.push(`- ${x}`))
  else L.push('- （无）')
  L.push('')
  L.push('## 启用方式')
  L.push('')
  L.push('人工确认无误后，移到 `skills/` 根目录（去掉 `_pending/` 前缀）：')
  L.push('')
  L.push('```')
  L.push(`mv _pending/${scenarioId}-onboarding.md ${scenarioId}-onboarding.md`)
  L.push('```')
  L.push('')
  L.push('启用后，编排层 preflight 会检测到它，开团时自动带进上下文。')
  L.push('')
  return L.join('\n')
}

/* ── 对外接口 ───────────────────────────────────────────────────── */

/**
 * 检查是否该蒸馏，并生成草稿。
 * @returns {{due:boolean, generated?:string, rounds:number, reason?:string}}
 */
export async function maybeDistill(scenarioId) {
  await ensureDirs()
  const sc = await Reg.getScenario(scenarioId)
  if (!sc) return { due: false, rounds: 0, reason: `场景 ${scenarioId} 不存在` }

  // 已启用就不重复蒸馏
  const activePath = join(SKILL_ROOT, `${scenarioId}-onboarding.md`)
  if (existsSync(activePath)) {
    return { due: false, rounds: sc.rounds || 0, reason: '已有启用的 skill，不重复蒸馏' }
  }

  const rounds = sc.rounds || 0
  // 门槛可配置（默认3）：读 evolve-config.json，rounds 未达门槛就 due:false，reason 带具体数字与调低提示。
  const minRounds = (await readEvolveConfig()).distillMinRounds
  if (rounds < minRounds) {
    return { due: false, rounds, reason: `已 ${rounds} 轮，需满 ${minRounds} 轮才蒸馏（可在技能页把门槛调低）` }
  }

  if (!sc.teamId) return { due: false, rounds, reason: '场景没有绑定团队，读不到 handoff' }

  const hf = await fetchHandoffs(sc.teamId)
  if (!hf.ok) return { due: false, rounds, reason: `读 handoff 失败：${hf.error}` }
  if (hf.items.length === 0) {
    return {
      due: false,
      rounds,
      reason: hf.metaCount > 0
        ? `找到 ${hf.metaCount} 条 handoff 元数据但正文读不出${hf.failures && hf.failures.length ? '：' + hf.failures[0] : ''}`
        : 'handoff 为空，没有可归纳的素材',
    }
  }

  const d = distill(scenarioId, hf.items)

  // 抽出全 0 说明 handoff 格式与本模块的抽取规则不匹配 —— 不生成空壳 skill
  const total = d.done.length + d.artifacts.length + d.pitfalls.length + d.next.length
  if (total === 0) {
    return {
      due: false,
      rounds,
      reason: `读了 ${hf.items.length} 条 handoff 但一条也没抽出（格式不匹配）。` +
        `handoff 建议按「做了什么：/ 产物：/ 最容易错：/ 下一步：」分段写，抽取器按这四个前缀归类。`,
      sample: hf.items.slice(0, 2).map((x) => ({ slot: x.slot, head: String(x.value).slice(0, 120) })),
    }
  }

  const md = renderSkill(scenarioId, sc, d)
  const outPath = join(PENDING_ROOT, `${scenarioId}-onboarding.md`)
  await writeFile(outPath, md, 'utf8')

  return {
    due: true,
    rounds,
    generated: outPath,
    sourceCount: d.sourceCount,
    extracted: {
      done: d.done.length,
      artifacts: d.artifacts.length,
      pitfalls: d.pitfalls.length,
      next: d.next.length,
    },
    note: '草稿已生成，需人工确认后移到 skills/ 根目录才生效',
  }
}

/** 粗略字数：去掉 markdown 标记/空白后的字符数（够面板显示，不追求精确 token） */
export function roughChars(md) {
  return String(md == null ? '' : md)
    .replace(/```[\s\S]*?```/g, '')      // 代码块
    .replace(/[#*`>_\-~|]/g, '')          // 常见 markdown 标记
    .replace(/\s+/g, '')
    .length
}

/** 预览：正文前 limit 字，超出加省略号 */
export function previewOf(md, limit = 300) {
  const s = String(md == null ? '' : md).replace(/\s+/g, ' ').trim()
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

/** 全文预览硬上限：普通技能手册远小于此值，仅防止病态大文件撑爆 op=skills 响应 */
export const FULL_PREVIEW_MAX = 200 * 1024

/**
 * 人话层（task_mwr5w5z541f05i / 方案 B）：零模型、确定性地把技术条目翻成「动作 + 原因」两行。
 * 原则（见 _运维/skill-content-strategy.md）：不产生技术层没有的新事实；翻不出合格人话返回 null。
 *
 * 已知条目的逐字译文（§5 人工确认过，优先命中）——保证这三条翻得准。
 */
const HUMAN_RULES = [
  { re: /withKey|括号.*补回|表值.*括号/, tier: 'rule',
    do: '改面板文案时，括号里的英文删了也会被系统自动补回去。要彻底去掉，得改代码，不是改文字。',
    why: '因为系统把名字和括号里的英文绑在一起，缺了会自动补齐；否则只改文字，下次打开又回来了。' },
  { re: /mock handler|apply\(ctx\)|Host 适配|适配层/, tier: 'rule',
    do: '测试面板功能时，要按真实运行的方式来模拟，不能只测表面那一层。',
    why: '系统里隔了一层适配，旧写法在测试里能过，上线就坏——结果是测了等于没测。' },
  { re: /redteam|setDisabled|disabled.*id.*name/, tier: 'contract',
    do: '要关闭某个预设，得改配置文件里对应的那一行，位置夹在「名字」和「标识」之间。',
    why: '界面上没有开关，别找按钮；改错位置不报错但也不会生效，得照准那一行改才能关掉。' },
]
/** 分类：rule/risk/contract/process（Lead 口径，按关键词，不编造频次） */
export function humanTier(raw) {
  const s = String(raw == null ? '' : raw)
  if (/不要|必须|改用|避免|别|先|要|须|防止/.test(s)) return 'rule'
  if (/风险|未决|待定|可能被|疑似|等.*定|覆盖/.test(s)) return 'risk'
  if (/返回|结构|字段|接口|签名|参数|配置/.test(s)) return 'contract'
  return 'process'
}
/** 脱掉技术标识后的中文残句（只用于判定是否够格，不直接上卡面） */
function stripTech(s) {
  return String(s == null ? '' : s)
    .replace(/`[^`]*`/g, '')
    .replace(/\b[A-Za-z_$][\w$]*(?:\([^)]*\))?\b/g, '')
    .replace(/[A-Za-z]:\\?[^\s，。；]*|\b[\w./-]+\.(?:mjs|cjs|js|json|ya?ml|md|py|ps1)\b/g, '')
    .replace(/\b(?:null|undefined|JSON|true|false)\b/g, '')
    .replace(/[=><{}()[\]]|[=]{2,}|=>/g, '')
    .replace(/\s+/g, '')
}
/**
 * 一条技术原文 → 人话两行 {do,why,tier,derived}；翻不出合格人话 → null。
 * 命中已知规则用逐字译文（derived:false）；否则按 tier 套模板（derived:true）。
 */
export function humanizeItem(raw) {
  const s = String(raw == null ? '' : raw)
  const tier = humanTier(s)
  const hit = HUMAN_RULES.find((r) => r.re.test(s))
  if (hit) return { do: hit.do, why: hit.why, tier: hit.tier, derived: false }
  const clean = stripTech(s)
  // 三闸：脱壳后汉字≥8、含动作/因果信号、不含任务号 → 才够格套模板
  const han = (clean.match(/[\u4e00-\u9fff]/g) || []).length
  if (han < 8 || !/要|改|用|别|先|避免|必须|不要|所以|否则|才能/.test(clean) || /task_|team_mw|session[-_]/.test(s)) return null
  // 模板不产生新事实：只把脱壳后的中文残句作为「动作」，原因用 tier 的定性说法
  const a = clean.length > 52 ? clean.slice(0, 52) + '…' : clean
  const whyByTier = {
    rule: '不这么做下次还会在同一处出错，所以要先记住这条做法。',
    risk: '这是已知会出问题的地方，别把后续判断建在它上面。',
    contract: '这些是对接时要对齐的说法，记错就对不上。',
    process: '照这个顺序走能省掉重复摸索。',
  }
  return { do: a, why: whyByTier[tier], tier, derived: true }
}

/**
 * 结构化解构 skill 正文（task_mwr524wm1ijwb）：从「这个 skill 管什么 / 各 ## 节」里
 * 提 purpose / scene / generatedAt / handoffRounds / sections。
 * 规则：按 `## ` 切节；每节取 `- ` 列表项，count 为实际条数、items 只给前 3 条且每条截 80 字；
 * 「这个 skill 管什么」单独抽 purpose，不进 sections。解析不出任何节 → 返回 null（不伪造）。
 * @returns {{purpose,scene,generatedAt,handoffRounds,sections}|null}
 */
export function parseSkillSummary(md) {
  const text = String(md == null ? '' : md)
  // 元信息：> 场景：`id` · 类型 `kind` / > 来源：N 轮 handoff 归纳，生成于 YYYY-MM-DD
  const sceneLine = text.match(/^>\s*场景[：:]\s*`([^`]+)`\s*·\s*类型\s*`([^`]+)`/m)
  const sourceLine = text.match(/^>\s*来源[：:]\s*(\d+)\s*轮\s*handoff[^\n]*?生成于\s*(\d{4}-\d{2}-\d{2})/m)
  const scene = sceneLine ? { id: sceneLine[1], kind: sceneLine[2] } : { id: '', kind: '' }
  const handoffRounds = sourceLine ? Number(sourceLine[1]) : 0
  const generatedAt = sourceLine ? sourceLine[2] : ''

  // 按 `## ` 切节：记录标题起点(headAt)与正文起点(bodyAt)，正文止于下一个标题起点
  const marks = []
  const re = /^##\s+(.+?)\s*$/gm
  let m
  while ((m = re.exec(text)) !== null) marks.push({ title: m[1].trim(), headAt: m.index, bodyAt: re.lastIndex })
  // 没有任何 `## ` 节 → 解析失败，不伪造
  if (!marks.length) return null
  const sectionsRaw = marks.map((x, i) => ({ title: x.title, body: text.slice(x.bodyAt, i + 1 < marks.length ? marks[i + 1].headAt : undefined).trim() }))

  const purposeSec = sectionsRaw.find((s) => s.title.indexOf('管什么') >= 0)
  let purpose = ''
  let purposeHuman = null
  if (purposeSec) {
    // 正文里去掉标题行与列表项，取第一段非空文本
    const lines = purposeSec.body.split('\n').map((x) => x.trim()).filter((x) => x && !/^-\s/.test(x) && !/^>/.test(x) && !/^```/.test(x))
    purpose = (lines[0] || '').replace(/`/g, '').slice(0, 200)
    // 人话 purpose：模板句翻成纯中文概述，不保留任何场景 id / 英文名。
    // 卡面第一屏不该出现英文——「ai-team-console」这类名字会拉低中文占比被判不可读。
    // 判据放宽到「只要不是纯技术描述就给模板句」，避免文案微调后掉进 else 把英文带出来。
    if (/开团|场景|项目/.test(purpose) || /[\u4e00-\u9fff]/.test(purpose)) {
      purposeHuman = '开这个项目时，团队会先读这份经验再动手：记得以前做过什么、东西该放哪，以及最容易在哪里翻车。'
    } else {
      const clean = stripTech(purpose)
      if ((clean.match(/[\u4e00-\u9fff]/g) || []).length >= 8) purposeHuman = clean.slice(0, 60)
    }
  }

  const sections = sectionsRaw
    .filter((s) => s !== purposeSec && s.title.indexOf('启用方式') < 0)
    .map((s) => {
      const items = s.body.split('\n').map((x) => x.trim()).filter((x) => /^[-*]\s+/.test(x))
        .map((x) => x.replace(/^[-*]\s+/, '').replace(/`/g, ''))
      const first3 = items.slice(0, 3).map((x) => x.length > 80 ? x.slice(0, 80) + '…' : x)
      return {
        title: s.title,
        count: items.length,
        items: first3,                              // 技术原文：折叠层/AI 用，保持不变
        humanItems: first3.map((x) => humanizeItem(x)),  // 人话两行：卡面用；翻不出为 null
        tier: humanTier(s.title + ' ' + (items[0] || '')),
      }
    })

  // 后果说明：卡面「批了会怎样 / 不批行不行」两问的承载行。
  // 必须拆成两行——首屏两问要求「另一行」作答，一行里塞两个答案会被第一问抢走。
  // 只陈述真实行为（L1 已修：buildTaskBrief 真注入技能正文）。
  const consequence = [
    '批准后开团会带上这份经验，团队不用再从零试错。',
    '不批也可以继续跑，只是团队按默认流程走，用不到这些经验。',
  ]

  return { purpose, purposeHuman, consequence, scene, generatedAt, handoffRounds, sections }
}

/**
 * 列出 skill 库状态。
 * 每项在 file/path 之上补 bytes/chars/preview/mtime，让面板批准前就能看到字数与正文预览。
 * 单个文件读失败（权限/占用）→ 跳过该项并把错误记入 errors，不影响其它文件与整个接口。
 */
export async function listSkills() {
  await ensureDirs()
  const active = []
  const pending = []
  const errors = []

  async function enrich(dir, bucket, kind) {
    let files = []
    try { files = await readdir(dir) } catch (e) { errors.push({ kind, file: dir, error: String(e && e.message ? e.message : e) }); return }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const full = join(dir, f)
      try {
        const [st, content] = await Promise.all([stat(full), readFile(full, 'utf8')])
        bucket.push({
          file: f,
          path: full,
          bytes: st.size,
          chars: roughChars(content),
          preview: previewOf(content, 300),
          // 全文：默认完整返回（「展开全文」才敢说原文完整保留）；仅单个技能 >200KB 才截断并标注
          fullPreview: content.length > FULL_PREVIEW_MAX ? content.slice(0, FULL_PREVIEW_MAX) : content,
          fullPreviewTruncated: content.length > FULL_PREVIEW_MAX,
          summary: parseSkillSummary(content),
          mtime: st.mtimeMs,
        })
      } catch (e) {
        errors.push({ kind, file: f, path: full, error: String(e && e.message ? e.message : e) })
      }
    }
  }

  await enrich(SKILL_ROOT, active, 'active')
  await enrich(PENDING_ROOT, pending, 'pending')

  return { root: SKILL_ROOT, pendingRoot: PENDING_ROOT, active, pending, errors }
}

/** 启用一份草稿（人工确认后调用） */
export async function approveSkill(scenarioId) {
  await ensureDirs()
  const from = join(PENDING_ROOT, `${scenarioId}-onboarding.md`)
  const to = join(SKILL_ROOT, `${scenarioId}-onboarding.md`)
  if (!existsSync(from)) return { ok: false, error: `没有待批草稿：${from}` }
  if (existsSync(to)) return { ok: false, error: `已存在启用中的 skill：${to}` }
  const content = await readFile(from, 'utf8')
  const stamped = content
    .replace(/> 状态：\*\*pending（待人工确认）\*\*/, `> 状态：**active（${new Date().toISOString().slice(0, 10)} 启用）**`)
  await writeFile(to, stamped, 'utf8')
  return { ok: true, path: to }
}

// 真跑验证用（task_mwr6312b639gf9）：导出纯函数 distill，不给它加任何行为
export { distill }
