# dsh-ai-team-console · AI 团队控制台

DSH 侧边栏常驻面板：把「AI 团队管理 7 条方法论」里该被看见的东西，全部摆到一屏里。
不用再靠对话翻聊天记录判断团队状态。

## 它解决什么

方法论落成一套文件之后，日常真正会出问题的是这三件事：

1. **团队里到底有谁、谁在干什么** —— 会话里问一句才看得到，还不一定是最新的
2. **缺什么员工看不出来** —— 现有成员能不能覆盖「造规则 / 干活 / 验活」，没人算过
3. **交付了没、验收过没** —— handbook 六件齐不齐、有没有审计报告，全靠人记

面板把这三件事变成可点开的数字。

## 九个页签

| 页签 | 内容 | 交互 |
|---|---|---|
| **总览** | 验收自检逐条打勾 + 通道告警 | ✅ 可重跑自检 |
| **选文件夹** | 输入/点选任意文件夹 → 自动探测项目类型 → 就地开团 | ✅ **可执行 + 一键开团跑首轮** |
| **对话** | 每个场景一个独立线程，跟这支团队聊 | ✅ **可执行（能读回 AI 的回答）** |
| **场景 / 编排** | 场景列表、9 步流水线、逐步 trace | ✅ **可执行** |
| **成员 / 缺口** | 成员卡片 + 能力域矩阵 | ✅ **可招募** |
| **handbook** | 六件文件状态、审计报告 | ✅ 可重建骨架 |
| **preset** | 插件清单、persona 原文 | ✅ 可重建坏 preset |
| **任务 / 消息** | 任务状态、消息送达、记忆 | ✅ 可中断卡住任务 |

（8 个页签全部都至少有一个会触发服务端动作的按钮；selfcheck 第 8 项会静态核对「客户端调的 op 服务端都认得」。）

## 设计修正：不再写死项目

**v0.2 的错误**：把某个具体项目硬编码进 `_registry.json`（workspace / presetId / handbookDir 全写死），
等于把「会话栏能选任意文件夹」退化成「只能开预设好的那一个」。

**v0.3 的做法**：`选文件夹` 页签 → 传任意路径 → `detect.mjs` 自动探测：

| 探测到 | 判据 | 推出的约束 |
|---|---|---|
| `dotnet-script` | 根目录有 `编译.ps1` | C# 7.3、禁新 NuGet、编译入口 = `编译.ps1` |
| `dotnet` | `.csproj` / `.sln` | 编译入口 = `dotnet build` |
| `node` | `package.json` | 编译入口 = `scripts.build` |
| `python` | `pyproject.toml` / `requirements.txt` | pytest |
| `rust` / `go` | `Cargo.toml` / `go.mod` | cargo / go build |
| `docs` | 大量 .md/.txt 且无代码标记 | 无编译约束 |
| **`container`** | 子目录里有 .git 或构建标记 | **拒绝开团，列出子项目让你选** |

**容器目录判断是关键修正**：像「代码根目录」这种子项目集合目录，根下有成百个 .md（都在子项目里），
最初被误判成「小说」。现在会识别为容器并提示「请选具体项目」。

临时开团**不写注册表**（`persisted: false`），用完即走。要留存才点保存。

## 对话：自建聊天框

不依赖官方 Agent Team，走宿主公开 seam（与 `dsh-better-sidebar` 的 Side Chat 同一套）：

| 环节 | 用的东西 |
|---|---|
| 建线程 | `ctx.get('agents').create({origin:'subagent', meta:{cwd,title}})` |
| 发消息 | `agent.followup(createUserMessage({content:[{type:'text',text}], source:{kind:'user'}}))` |
| 中断 | `agent.abort()` / `agent.interrupt()` |

**为什么每个场景一个线程**：跨场景不串上下文。`sceneId → thread` 在内存表里，重启即失（历史在 DSH session log 里）。

**AI 的回答从哪来**：`agent.followup()` 是「投递并启动回合」的异步语义，返回通常是 `result:null`——它不给你回答。所以面板**不指望 followup 回话**，发完去读会话日志：

```
<DSH>/sessions/<cwdTag>/<sessionId>/session.v4.jsonl.zstd
   ↓ 按帧魔数 28 B5 2F FD 切开逐帧 zstd 解压（整文件解只出第一帧，会误判「日志只有一行」）
   ↓ 抽 user/message + assistant/message（两种事件形状都要认：assistant 在 data.message，user 直接 data）
   ↓ 过滤宿主注入噪音（当前运行时上下文 / [memsearch] / 插件边界消息）
面板 2 秒轮询 op=chat-read → 渲染气泡
```

副作用红利：**重启后也能把历史读回来**——内存线程表会丢，但 `localStorage` 记了 `sceneId + sessionId`，点「载入历史对话」即可恢复整段对话。

**降级行为**：宿主没暴露 `agents` / `sessions` 服务时，`chat-capability` 返回 `usable:false`，
面板显示「聊天通道当前不可用」并列出缺什么，**不假装能用**。读不到转录时返回 `reason:no-session` / `no-log`
并把原因显示在页面上，**不返回空数组糊过去**（空数组会让「真没消息」和「读不到」长得一模一样）。其它页签不受影响。

## 团队上限：不写死人头

v0.2 把「少而精」写成了「3 人封顶」，这是把方法论当硬约束。

**v0.3**：上限由团队的 `maxMembers` 决定（默认已调到 8），`team-cap` 接口可改（1-64）。
编排层 S3 从 teams 列表读真实上限，不再写死。「少而精」约束的是**能力域别重叠**，不是人头数。

## 编排层

「调用整套机制」的核心：不再靠 Lead 会话临场发挥，而是按固定步骤走。v0.8 起每步都带**门类型**标注（继续门 / 终止门 / 人工门 / 首件门，先进编排迭代 3），并在 S6 后插入 S6b 首件检查门。

| 步 | 动作 | 门 | 停下来的条件 |
|---|---|---|---|
| S0 | 场景路由（查注册表拿 preset/handbook/约束） | 继续门 | 场景未注册 |
| S1 | 前置检查（preset / handbook / workspace / skill） | 终止门 | 任一硬项缺 |
| S2 | 建队或复用 | 终止门 | sidecar 不可达 |
| **S2_5** | **补齐成员编制（缺谁就建谁的成员记录；按能力域自动选模型路由，能力基线写进 role）** | 终止门 | 名额满 / sidecar 拒绝建记录 |
| S3 | 成员编制核对（能力域 + 会话可用性） | 终止门 | 缺能力域 |
| S4 | 领域知识注入（constraints → 硬约束文本） | 继续门 | — |
| S5 | 派首轮任务（按场景类型给默认任务） | 终止门 | 场景类型无默认任务 |
| S6 | 唤醒派发（**dispatch + 把 brief 真投进成员会话**） | 终止门 | 投不进去即失败，不给假通过 |
| **S6b** | **首件检查门：maker 首份产物交 auditor 快速核对方向（97-首件核对-*.md）** | 首件门 | 没有核对记录 / 方向错被**打回**（只损失一步而非一轮）；单产物任务不设门 |
| S7 | 等审计（读最新报告，不自己判对错；产物≥3 支持 96-分段审计-* 增量审） | 人工门 | 没有审计报告 |
| S8 | 收口（记一轮 + **成本记账** + 检查是否该蒸馏） | 继续门 | — |

**两处关键改动**：

1. **S2_5 补齐成员编制**：以前 S2 建完队、S3 只核对不补人，于是「核心能力域缺 maker」只能等用户手点招募。
   现在 S2_5 按三个核心能力域（architect / maker / auditor）查活成员，缺谁就调
   `POST /api/teams/:id/members` 建谁的记录。**它只建记录、不建会话**——宿主会话要
   `dsh_team_spawn` 拉起，这一步的 detail 会把「已绑定会话 N/M」一并说清，不混着报成功。
2. **S6 真投递**：以前只调 `POST /api/agents/dispatch` 就报通过，可 dispatch 只代表
   「调度器认领了任务」，**不代表任务进了成员会话**——这正是「看着在跑、其实没人收到活」的来源。
   现在 dispatch 之后必须 `subagents.sendMessage(lead, member.agentSessionId, brief)` 投进去；
   投不进去（无会话 / 无 subagents / 无 live Lead 句柄 / `belongs to another parent session`）
   一律 `ok:false` 并给可执行的下一步。

**设计原则**：每步都能单独重跑；失败必须给「下一步做什么」，不是只报错；读不到就说读不到，不拿默认值糊过去。

## 自我迭代

```
跑一轮 → handoff 写进 team memory
跑满 3 轮 → distill 模块归纳成 skill 草稿（_pending/）
人工确认 → approve 移到 skills/ 根目录 → 下轮 preflight 自动检测到
```

**为什么必须人工过一遍**：归纳会出错，学到错的 skill 会让下一轮更差且自我强化。所以产出的是草稿，不是直接生效的 skill。

**抽取器的一个诚实说明**：它按关键词就近归类（pitfalls 优先），不做语义理解。实测从 2 条真实 handoff 里抽到 `done:1 / artifacts:2 / pitfalls:3 / next:2`，其中「审了 19 项」这种叙述会被误归到 pitfalls。**草稿要人看，不要直接信。**

## 「缺什么员工」怎么招

面板**只展示缺口并给出招募提案**。点「招募 X」按钮后：

1. 先查名额（`maxMembers`，当前 3）
2. 满员 → 明确告诉你「3/3 满了，新成员只会排队」，并给三个选项：retire 一个 / 提上限 / 不招人派给现有成员
3. 有位置 → 调 `POST /api/teams/:id/members` 建成员记录

**不做的事**：不自动 spawn、不自动扩编。成员能不能真干活还需要宿主侧拉起会话（`dsh_team_spawn` 那一步），面板只建记录并告诉你这一点。

## 安装与生效

插件实体：插件所在目录（本仓库根，安装位置的绝对路径因机器而异）

**DSH 加载一个本地插件需要 4 条件同时成立**，缺一个都会表现为「侧边栏入口整片消失」：

| # | 条件 | 位置 |
|---|---|---|
| 1 | 插件自己的 `package.json` **无 UTF-8 BOM** | `ai-team-console\package.json` |
| 2 | profile 的 `dependencies` 里声明（用 `link:` 协议） | `profiles\web\package.json` |
| 3 | profile 的 `dsh.profile.bundles` 里登记 | `profiles\web\package.json` |
| 4 | `cordis.patch.yml` 有 insert 块 + `node_modules` 有 junction | `profiles\web\` |

**装完/改完必须跑自检**：

```powershell
node scripts/selfcheck.mjs        # 在仓库根目录执行
```

8 项全过再重启。`dsh-m` 不支持重启 Desktop，必须完全退出进程重开（关窗口可能只是隐藏）。

### 标准安装（bundle 方式）

本插件符合 DSH 插件开发教程 `09-publish` 的 **bundle 规范**，除上面的本地 junction 方式外，也可用 `dsh plugin` 标准安装：

```bash
# 从本地目录安装
dsh plugin --profile web add "<本仓库的绝对路径>"

# 从 git 仓库安装
dsh plugin --profile web add "git+file:///<本仓库的绝对路径>"

# 从远程 git 仓库安装
dsh plugin --profile web add "git+https://github.com/<owner>/<repo>.git"
```

首次安装会把本包追加进 profile 的 `dsh.profile.bundles` 并在 `node_modules` 建链接。
安装后同样要跑自检 + 完全退出重开 DSH。

**bundle 三件套**（本仓库已具备）：

| 文件 | 作用 |
|---|---|
| `package.json` | 声明 `dsh.bundle.patch`（指向 patch 层）与 `dsh.client`（客户端插件入口） |
| `dsh/cordis.patch.yml` | 插入插件行的 patch 层 |
| `lib/index.js` / `lib/client.js` | 服务端 HTTP 桥 / 浏览器端面板 |

**配置层生效顺序**（后应用者按 `id` 胜出，整行 `config` 替换而非深合并）：

```
profile 的 dsh.profile.bundles（按列表顺序）
  → profile 自己的 cordis.patch.yml
    → $DSH_HOME/cordis.patch.yml（机器级）
      → 每个 --patch overlay（按 argv 顺序）
```

### 更新与升级

```bash
# 检查是否有新版（只读，不改任何文件）
node scripts/check-update.mjs

# 机器可读 JSON
node scripts/check-update.mjs --json

# 给 CI / 脚本用：有更新时 exit 1
node scripts/check-update.mjs --strict
```

检测源按可用性**自动选择**，两个都试，取能用的那个：

| 源 | 触发条件 | 判断方式 |
|---|---|---|
| **git 远程**（优先） | 仓库配置了 `origin` | `git fetch` 后比较本地 HEAD 与 `origin/<branch>`，报「上游领先 N 个提交」 |
| **npm registry** | 包已发布到 npm | 查 `registry.npmjs.org/<name>/latest`，semver 比较 |

**检测只读不写**：不会自动拉取、不修改工作区。检测到更新后由用户手动执行：

```bash
git pull --ff-only                 # git 源
npm i -g dsh-ai-team-console@latest # npm 源
```

**维护者推送更新**：

```bash
git tag v0.7.0
git push origin main --tags
```

版本变更记录见 [`CHANGELOG.md`](./CHANGELOG.md)，`check-update` 会配合它说明「新版本带来了什么」。

### 图标与品牌资源

`assets/` 提供三套图标方案，均为矢量 SVG + 四档 PNG（512 / 256 / 128 / 64，透明底）：

| 方案 | 意象 | 文件 |
|---|---|---|
| **A · 节点拓扑** | 中心指挥 + 三成员节点，同心圆环 | `icon-A.svg` / `icon-A-{512,256,128,64}.png` |
| B · 层叠面板 | 三张堆叠卡片，控制台意象 | `icon-B.svg` / `icon-B-{...}.png` |
| C · 环形协作 | 渐变环 + AI 字标 + 四节点 | `icon-C.svg` / `icon-C-{...}.png` |

配色取自深色主题（`#0d0e11` 底 / `#3b82f6` 强调 / `#7dd3fc` 高光）。
预览对比图：`assets/icon-compare.png`。包内只随附 `assets/icon-*`（见 `package.json` 的 `files`）。

**自检覆盖什么**：BOM 全库扫描 / package.json 可解析 / 入口文件存在 / client inject 声明 / **lib 下模块真解析（node --check，不是只看文件非空）** / **client 调的 op 服务端都有分支** / cordis 挂载块 / node_modules junction。运行时语义（流水线真的派发了吗、聊天真的回话了吗）自检管不到。

### ⚠️ 2026-11-21 事故：入口整片消失

**现象**：侧边栏所有入口消失。日志：

```
dsh: disabling profile plugin row "dsh-ai-team-console":
     its declared dsh requirements cannot be validated:
     Unexpected token '﻿', "﻿{"
profile inconsistency: the patch layer inserts dsh-ai-team-console, which is not installed
```

**根因**（两个叠在一起）：

1. **`package.json` 被写入 UTF-8 BOM** —— PowerShell 的 `Set-Content -Encoding UTF8` / `ConvertTo-Json | Set-Content` 会自动加 BOM，`JSON.parse` 零容忍，DSH 直接禁用该插件行
2. **profile 只在 patch 里插了行，但没在 `dependencies` / `bundles` 登记** —— DSH 判定「not installed」跳过

**修法**：

```powershell
# 写 JSON 一律用这个，不走 Set-Content
$json = $obj | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
```

**这条坑本轮踩了两次**（另一次是 `_registry.json`），所以自检脚本第一项就是全库 BOM 扫描。

## 服务端半侧

`lib/index.js` 注册 `GET/POST /ai-team/api`，共 43 个 op（`selfcheck` 第 8 项会核对客户端调的 op 是否都有服务端分支）：

| 分组 | op | 方法 | 作用 |
|---|---|---|---|
| 读 | `snapshot`（默认） | GET | 一次返回全部读数据：团队、成员、缺口、handbook、preset、验收自检、任务/消息/记忆 |
| 读 | `health` | GET | 只探 sidecar 可达性 |
| 读 | `scenarios` | GET | 场景注册表（`_AI团队手册\_registry.json`） |
| 读 | `steps` | GET | 9 步流水线目录 |
| 读 | `preflight` | GET | 单场景开团前置检查（preset/handbook/workspace/skill 四项） |
| 工作项 | `scenario-add` | POST | 新增场景（校验 id 格式与 kind 枚举；缺 id 按 ASCII 短哈希兜底） |
| 工作项 | `scenario-update` | POST | 改场景（id 不可改；`state` 走状态机校验） |
| 工作项 | `scenario-delete` | POST | 删场景（running/closing/awaiting 拒删） |
| 编排 | `run` | POST | 跑流水线（可指定 `from`/`to` 只跑一段；`routeAnswers` 开团前四问定档留痕；`skipFirstPieceGate` 跳过首件门） |
| 编排 | `ephemeral-run` | POST | **一键开团并跑首轮**：探测 → 临时场景 → 跑 S0–S6 → 用完删注册表记录（默认跳过 S6b） |
| 编排 | `artifact-schema` | GET | **结构化工件 schema**（先进编排迭代 2）：三类工件（brief/delivery/audit）必填字段目录；`id=xxx&template=1` 渲染填写模板 |
| 编排 | `artifact-validate` | POST | **校验工件字段覆盖率**：`{ id, text }` → 缺哪些必填字段、coverage，缺什么报什么 |
| 编排 | `complexity-route` | GET/POST | **按需复杂度定档**（迭代 4）：开团前四问答案 → L0 单干 / L1 三人流水线 / L2 扇出，判定轨迹全程留痕 |
| 编排 | `refresh-snap` | POST | 重跑验收自检（重取快照 + 新时间戳） |
| 成员 | `hire` | POST | 招募成员（先查名额，满员给选项不硬招） |
| 成员 | `team-cap` | POST | 改团队人数上限（1–64） |
| 成员 | `team-health` | POST/GET | **成员会话可用性单查**（ok / unbound / stale-lineage 三态 + 一句话结论 + 告警） |
| 成员 | `agent-probe` | POST/GET | **Lead 句柄与投递能力实测**（零副作用探针：错误目标测 sender 实例校验，判面板能否代 Lead 投递） |
| 成员 | `routes` | POST/GET | **成员模型路由查询**：免费池（实测可用清单）+ 每条能力链四档「免费首选→付费降级→备选→最后」+ 倍率门槛 + 上下文 fit；纯本地计算，不联网 |
| 成员 | `route-fit` | POST/GET | **上下文适配查询**（上下文适配）：按 sessionId 或 teamId 取成员当前 token 占用（usage.totalTokens）+ 切到各候选的 fit 三态（safe / compress-first / reject）；纯本地读日志 |
| 成员 | `route-config` | POST/GET | **模型配置读写**（`route-config.json`）：GET 读当前配置与默认值，POST 合并写入（无 BOM，写完回读校验） |
| 成员 | `provider-toggle` | POST | **按 provider 设倍率上限 / 整厂开关 / 单条 route 拉黑**（`{provider, cap}` 推荐用法；也可 `{provider, enabled}`、`{route, enabled}`、`{maxMultiplier}`） |
| 迭代 | `skills` | GET | skill 库状态（active / pending） |
| 迭代 | `distill` | POST | 尝试蒸馏 skill 草稿 |
| 迭代 | `skill-approve` | POST | 启用已生成的草稿 |
| 选文件夹 | `detect` | GET | 探测目录的项目类型与编译约束 |
| 选文件夹 | `workspace-suggest` | GET | 推荐工作区根 + 已知项目类型 |
| 选文件夹 | `ephemeral` | POST | 临时开团（内存态，不写注册表） |
| 对话 | `chat-capability` | GET | 探测宿主有没有 agents/sessions（不可用就明说） |
| 对话 | `chat-open` | POST | 开独立线程（带 provider/model，否则回合会死在 no provider/model） |
| 对话 | `chat-send` | POST | 发消息（只回报「已投递」，回答走 chat-read） |
| 对话 | `chat-read` | POST/GET | **读真实转录**（帧解压 session log → 消息数组；无会话时明确 no-session） |
| 对话 | `chat-probe` | GET | 排查：列出 sessions 根候选与各自是否存在 |
| 对话 | `chat-cancel` | POST | 中断当前回合 |
| 对话 | `chat-threads` | GET | 列出内存里的线程 |
| 修 | `task-abort` | POST | 中断卡住的任务（转发 sidecar `/api/tasks/:id/abort`） |
| 修 | `handbook-skeleton` | POST | 补 handbook 六件骨架（只补缺失/空壳，正文不动） |
| 修 | `preset-rebuild` | POST | 重建坏 preset（解析失败/缺必需插件才重建；健康拒绝覆盖；覆盖前备份） |

数据来源（全部真实，无 mock）：
- 团队/成员/任务/消息/记忆 → dsh-team sidecar `http://127.0.0.1:4317`
- handbook 六件 → `$DSH_HOME/用户数据/_AI团队手册/<场景>/`
- preset 真身 → `$DSH_HOME/用户数据/.dsh/team/presets/*.json`
- 场景注册表 → `$DSH_HOME/用户数据/_AI团队手册/_registry.json`

来源校验：回环地址一律放行（官方桌面端 Origin 常是 `app://` / `file://`），非回环才要求 Origin 与 Host 同源。

## 模块结构

```
lib/
├── index.js                  服务端：HTTP 桥 + 43 个 op + preset 重建
├── client.js                 客户端：页签 + 2 个 slot 注册（含开团前四问定档 UI）
└── orchestrator/
    ├── registry.mjs          场景注册表 + 状态机 + 一致性校验 + 预检
    ├── pipeline.mjs          10 步流水线（S0–S8，含 S2_5 与 S6b 首件门）+ 门类型列 + 成本记账
    ├── artifacts.mjs          结构化工件 schema（brief/delivery/audit + 模板渲染 + 字段校验）
    ├── complexity.mjs         按需复杂度路由（开团前四问 → L0/L1/L2 定档）
    ├── routes.mjs             成员模型路由（免费池 + 五条能力链 + selectRoute + 能力基线）
    ├── teamHealth.mjs         成员会话健康（ok / unbound / stale-lineage 三态）
    ├── leadProbe.mjs          Lead 句柄与投递能力实测（零副作用探针）
    ├── transcript.mjs         会话转录读取（zstd 帧解压 → 消息数组）
    ├── chat.mjs               自建聊天框（建线程/发消息/中断 + provider-model 路由）
    ├── detect.mjs             项目类型探测（选文件夹页）
    └── evolve.mjs             skill 蒸馏（handoff → 草稿）
skills/
├── <id>-onboarding.md        已启用的 skill（开团时自动加载）
└── _pending/<id>-onboarding.md  待人工确认的草稿
```

## 客户端半侧

`lib/client.js` 走宿主的「全局面板」机制（与 `dsh-client-ui-plugin-manager` 同一条路径）：

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: 'ai-team', order: 60,
}, PanelIcon))

ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: 'ai-team',
}, Panel))
```

入口在**左侧栏的全局面板列表**里，图标是「人 + 肩」的团队符号。

## 卸载

1. 删掉 `profiles\web\cordis.patch.yml` 末尾那块 `dsh-ai-team-console` 配置
2. 删掉 `profiles\web\node_modules\dsh-ai-team-console` 这个 junction
3. 重启 Desktop（本目录可保留，不影响运行）

## 已知边界

- 成员 session 调 `dsh_team_memory_*` 会 `403 E_DENIED`（只有 lead 能读写），面板读记忆走的是 lead 侧 sidecar API，所以能看到
- 任务 `failed` 可能是 `sendMessage` 回执故障导致的误判，面板照实显示 status，不替它圆
- 自动刷新 15 秒；手动模式下点「刷新」才拉数据
- **`chat-send` 不返回 AI 的回答**（`followup` 是异步投递，返回 `result:null`）：回答由 `chat-read` 从会话日志读，面板 2 秒轮询。所以「发送成功」只代表投递成功，不代表回合跑完
- **转录读取依赖 Node 的 zstd 能力**（`node:zlib.zstdDecompressSync`，Node ≥ 22.15 / 23.8）。宿主运行时若没有，`chat-read` 返回 `reason:no-zstd` 并说明原因，不会静默返回空对话
- **sessions 根目录是探测出来的**（`DSH_SESSIONS_DIR` → `<DSH_HOME>/appdata/harness/sessions` 等默认位置）。换安装方式后若读不到日志，先跑 `op=chat-probe` 看候选列表与各自的存在状态
- **自检管不到运行时语义**：它能挡住 BOM / 语法 / op 拼错 / 挂载缺项，挡不住「流水线假通过」「聊天真的回话了吗」——那类结论必须靠实测输出

### 团队模式边界（三条实测事实）

1. **成员「有记录」≠「能干活」**。面板（`op=hire` / S2_5）只能建 sidecar 的成员**记录**；
   真正能接活的 sub-agent 会话由宿主 `dsh_team_spawn`（内部 `subagents.startActivation`）拉起。
   面板从不自动 spawn 会话——**这是边界，不是缺陷**。`teamHealth` / `op=team-health` 会把
   `unbound`（有记录无会话）单独标出来，不让它表现为「idle 待命」。

2. **成员会话绑死在 spawn 时的 Lead 会话上**。宿主 `dsh-subagent` 的 `authorizeLineage` 要求
   sender 是**精确的 live 父 agent**，Lead 换会话 / 重启后再投递会抛
   `subagent "…" belongs to another parent session`。
   插件侧**不能**重建宿主会话（那要改 `dsh-subagent`），只能把成员标成 `stale-lineage`
   并在 snapshot 告警里给下一步：**retire 该成员 → 由当前 Lead 重新 `dsh_team_spawn`**。

3. **成员会话的落盘 cwd 不等于团队 workspace**（根因在宿主，不在本插件）。
   `dsh_team_spawn` 传的 `cwd` 只进了运行时工作目录，没进 session header；header.cwd 由
   `childSessionMeta` 用**父会话** cwd 生成，于是成员 cwdTag 全部落在 Lead 的 harness 路径下。
   该缺陷的修法涉及宿主 `node_modules`，属于本地开发范围，不在本插件仓库内。
   在它落地前，`scripts\verify-team-paths.mjs` **必然 exit 1**，这是已知且预期的，
   **不要拿它当本插件修复的失败判据**——修复 B 的判据是「跑一次流水线后成员状态 idle→running、
   任务挂上 currentTaskId」。

## 验证

三条命令覆盖从「能不能加载」到「行为对不对」：

```bash
npm run verify        # 可加载性自检（8 项，秒级）
npm test              # 全部验证脚本（10 个套件，约 3 秒）
npm run test:fast     # 跳过慢套件
node scripts/verify-all.mjs routes   # 只跑名字含 routes 的
node scripts/verify-all.mjs --json   # 机器可读，接 CI
```

### 可加载性自检（`npm run verify`）

挡住「改完之后侧边栏入口整片消失」这类事故——8 项全过再重启：

| # | 检查项 |
|---|---|
| 1 | 全库无 UTF-8 BOM（BOM 会让 `JSON.parse` 直接失败，插件被宿主禁用） |
| 2 | `package.json` 是合法 JSON |
| 3 | `main` / `exports` / `dsh.bundle.patch` 指向的文件都存在 |
| 4 | `dsh.client.inject` 与 client 半侧实际依赖一致 |
| 5 | `lib/` 下每个模块真解析（`node --check`，不是只看文件非空） |
| 6 | client 调用的每个 op 在服务端都有分支 |
| 7 | profile 的 `cordis.patch.yml` 里有挂载块 |
| 8 | profile 的 `node_modules` 里有本插件 |

profile 目录可覆盖：`DSH_PROFILE_DIR` 或 `DSH_HOME`。

### 行为验证（11 个套件）

| 套件 | 覆盖 |
|---|---|
| `verify-routes` | 四级选路 / 上下文窗口适配 / 倍率门槛 / 降级链 |
| `verify-chat-feedback` | 被禁通道可见且标注原因 + 可点替代 |
| `verify-p16-team-mode` | 团队健康三态 / 投递必判真假 / 兜底指令 |
| `verify-capability-domains` | 六个能力域单一命中 / 无跨域误判 |
| `verify-presets` | 会话预设读取 / 启停 / 调序，真实配置零副作用 |
| `verify-team-sync` | 会话建的团队同步为工作项 / 幂等 |
| `verify-dir-list` | 目录浏览 / 盘符发现 / source 标记 |
| `verify-skills` | 技能元数据完整 / 读失败隔离 |
| `verify-evolve-config` | 蒸馏门槛可配置 / 非法值回落 |
| `verify-model-tab` | 模型页信息架构 / 无开发者术语泄漏 |
| `verify-host` | 宿主适配层：空 ctx 降级 / 调用契约稳定 / 失败分支 |

`verify-all.mjs` 汇总输出：

```
[PASS] verify-capability-domains.mjs    142ms  全部通过：6 个真实岗位…
[PASS] verify-routes.mjs                198ms  全部通过：成员模型路由…
--------------------------------------------------------------
  11/11 通过   总耗时 2.9s
```

## 宿主适配层

DSH 的 `ctx.slots` / `ctx.agents` / `subagents` / `agent.followup` 都不是公开
稳定 API。宿主升级时签名或行为会变——如果 30 多处调用点散在各模块里，每次
升级都要全库排查。

`lib/orchestrator/host.mjs` 把它们收成一处：

| 导出 | 作用 | 宿主缺失时 |
|---|---|---|
| `capabilities(ctx)` | 一次性探测所有能力 | 返回全 false |
| `healthReport(ctx)` | 人可读的能力报告 | 标出缺哪几项 |
| `listAgents` / `getAgent` / `createAgent` | 会话注册表 | 返回空数组 / null / `{ok:false}` |
| `followup(agent, msg, timeout)` | 投递一条消息 | `{ok:false, error}` |
| `clearInbox(agent)` | 清 inbox 残留 | false |
| `sendToMember(ctx, lead, sid, content, opts)` | 团队投递（S6 落点） | `{ok:false, reason:'no-api'\|'threw'}` |
| `registerSlot` / `registerEffect` / `registerWebRoute` | UI 与 HTTP 挂载 | false（跳过挂载不崩） |
| `modelSelection(ctx)` | 自动开 Lead 会话用 | null |

**设计原则**：每个能力先探测再调用；失败返回结构化结果而非抛裸异常；
只做形状适配，不做业务判断。

**升级时只改这一个文件**——其余模块通过稳定签名调用。

> 例外：`leadProbe.mjs` 刻意直连宿主。它的职责就是验证 `agents.get(id) !== sender`
> 这类内部校验的真实行为，包一层就测不准了。

## 健康巡检

一条命令回答「这个插件现在还能正常工作吗」：

```bash
npm run health          # 人类可读
npm run health:json     # 机器可读，接 CI 或监控
node scripts/health-check.mjs --offline   # 跳过联网检查
```

四类检查：

| 类别 | 检查项 |
|---|---|
| **宿主适配层** | 导出完整性 / 空 ctx 降级 / 有没有绕过适配层的直连 |
| **本地完整性** | profile 文件 / 数据目录 / 内置预设位置 |
| **上游版本** | 本地 HEAD 与远程是否一致 |
| **sidecar** | 可达性（含耗时） / 数据结构字段漂移 |

输出示例：

```
[宿主适配层]
  OK   导出完整性         12 个能力函数齐全
  OK   空 ctx 降级        空 ctx 下全部能力返回 false（不抛错）
  OK   绕过检查          0 处直连
[sidecar]
  OK   可达性            HTTP 200（56ms）@ http://127.0.0.1:4317
  OK   数据结构          teams 数组，3 条
  OK   字段漂移          依赖字段齐全
----------------------------------------------------------------
  8 正常   2 警告   0 错误
```

**退出码**：全正常 0 / 有警告 1 / 有错误 2——可以直接接进 CI。

**字段漂移检测**是重点：sidecar 返回的 `teams` 里如果缺了 `id`/`name`
这类必填字段，巡检会报 error；缺可选字段报 warn。宿主或 sidecar 升级后
改字段名，这里第一时间能看出来，而不是等到面板白屏。

### 安全与更新

| 脚本 | 用途 |
|---|---|
| `scripts/scan-secrets.mjs` | 13 类敏感模式扫描；`--staged` 供 pre-commit 用，命中 exit 1 |
| `scripts/check-update.mjs` | git 远程 / npm registry 双源查新版，只读不改文件 |

启用提交前扫描：

```bash
git config core.hooksPath .githooks
```


## 版本记录

| 版本 | 要点 |
|---|---|
| 0.2 | 侧边栏面板 + 9 步流水线 + skill 蒸馏 |
| 0.3 | 任意文件夹开团（项目探测 + 容器目录识别）、自建聊天框、团队人数上限可配 |
| 0.4 | 对话能看见 AI 回答并可载入历史、preset 重建、自检改为真语法校验 + op 对表 |
| 0.5 | 团队模式修复（成员编制补齐 / 投递必判真假 / 健康三态）、投递失败给出可粘贴的兜底指令 |
| 0.6 | 上下文感知选路 + 倍率门槛（取代整厂停用）、新增「模型配置」页签 |
| 0.7 | 四级优先选路、工作区浏览任意文件夹、团队模式 preset、技能蒸馏可配置、双主题跟随 DSH、模型页信息架构重构 |
| 0.8 | **先进编排落地**：结构化工件 schema、S6b 首件检查门 + 门类型列 + 分段审计、开团前四问复杂度路由 L0-L2、四要素压缩回传 + 成本记账 |

各版本完整变更见 [`CHANGELOG.md`](./CHANGELOG.md)。


## 依赖与宿主版本（2026-11-21 实测，package.json 版本约束由此定）

本包是仓库内私有 bundle（private/type:module/main:lib/index.js），依赖由 DSH 宿主提供，声明口径按插件开发手册（09-publish + 仓库内包规范）：

| 包 | 声明位置 | 实测宿主版本 | package.json 约束 | 用途 |
|---|---|---|---|---|
| `@deepseek-ai/cordis` | peerDependencies **+ devDependencies**（手册强制两处都在） | 4.0.5 | `>=4.0.5` | 插件运行时框架，宿主注入 |
| `@deepseek-ai/dsh-client-ui-slots` | peerDependencies | 0.2.1-rc.2 | `>=0.2.1-rc.2` | client 侧 `inject` 依赖（见 dsh.client.inject） |
| `@deepseek-ai/schemastery` | dependencies | 3.18.5 | `>=3.18.5` | 配置 schema |

实测方法：读 DSH 安装目录下 `resources/app/node_modules/@deepseek-ai/<包>/package.json` 的 `version` 字段；实测时 Node 为 v24（engines 声明 `>=20`，留足向下兼容）。`repository.url` 暂为占位 `<LOCAL_REPO_PATH_OR_URL>`，git 安装导入时替换成真实仓库地址即可。不改 `dsh` 字段（bundle+client 配置正确）与 exports/files。
