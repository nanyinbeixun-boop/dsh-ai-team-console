# 变更记录

本文件记录每个版本的实质变更。`scripts/check-update.mjs` 会读取它，
在检测到更新时展示「新版本带来了什么」，而不只是一句「有新版本」。

版本号遵循 semver；DSH 插件在宿主内运行，`minor` 位对应功能新增，
`patch` 位对应缺陷修复。

---

## 0.8.0

**先进编排落地**（方案：`_AI团队手册\先进自动化团队管理模式调研与迭代方案.md` 的「面板/流水线代码迭代」相关项——迭代 2/3/4/5 全部实现；迭代 1/6 是方法论文件层，不在本仓库范围）

**结构化工件（迭代 2 · 对齐 MetaGPT）**

- 新增 `lib/orchestrator/artifacts.mjs`：三类核心工件（任务简报 brief / 交付报告 delivery / 审计报告 audit）的强制字段 schema、Markdown 填写模板渲染、字段覆盖率校验（缺什么报什么，不糊）
- 新增 op=`artifact-schema`（schema 目录 + 模板渲染）、op=`artifact-validate`（校验字段覆盖率）
- 任务 brief 要求 maker 落盘交付报告到 handbook `99-交付报告-<轮次>.md`，字段口径对齐 delivery schema

**步骤间检查门（迭代 3 · 对齐 Anthropic prompt chaining gate）**

- 流水线从 9 步扩为 10 步：S6 后插入 **S6b 首件检查门**——maker 做完首份产物暂停，auditor 在 handbook 写 `97-首件核对-*.md` 快速核对方向；方向错（打回）停在 S6b 不流入 S7，只损失一步而非一轮；单产物任务（<2 件）不设门并说明原因
- 每步新增 **门类型列**（gate：continue 继续门 / halt 终止门 / human 人工门 / first 首件门），`op=steps` 目录与面板步骤列表、run trace 都展示
- S7 支持**分段审计**：产物 ≥3 时每完成一个即可增量审（`96-分段审计-*.md` 计段），S7 detail 汇总各段结论；分段被打回时明示「整轮结论大概率不通过」
- `op=run` 支持 `skipFirstPieceGate`（临时场景 `ephemeral-run` 默认跳过——一次性活不设门）

**按需复杂度路由（迭代 4 · 对齐 Anthropic「从最简单开始」）**

- 新增 `lib/orchestrator/complexity.mjs`：开团前四问（产物几个 / 步骤可预判吗 / 需独立验收吗 / 路线独立吗）→ L0 单干 / L1 三人流水线 / L2 扇出 三档判定，规则全部可判定（无「视情况而定」），判定轨迹 trail 全程留痕
- 新增 op=`complexity-route`：无参数返回四问目录；带答案定档并给判定轨迹
- 面板「工作项 / 编排」页新增**开团前四问**交互区：点「定档」出档位 + 判定轨迹 + 形态说明；L0 时提示「单干更划算」但不拦
- `op=run` 透传 `routeAnswers`：定了档就写进 trace 首行（ROUTE 步），L0 如实报该档而非拒跑

**压缩回传与成本记账（迭代 5 · 对齐 Anthropic 研究系统）**

- 任务 brief 的回执要求升级为**四要素**：产物路径 / 内容摘要（≤80 字/件）/ 可信度（自检过没过）/ 下游须知（用产物前必须知道的一件事）；明令禁止把产物正文贴进 summary
- S8 收口组装**成本记账行**（`costLedgerLine`）：任务数 / 成员数 / 模型路由（真实选路）/ 估算 token（取不到记 null 不填 0）/ 是否值得；`op=run` 返回体带出，面板展示

**验证**

- 新增 `scripts/verify-advanced-orchestration.mjs`（npm run verify-advanced）：42 条断言覆盖迭代 2/3/4/5 的代码侧验收点，全过 exit 0
- selfcheck 8/8 通过；op 40→43 只增不删；既有 op 路由零改动
- 对抗性验证三项过：阴性对照（改坏 L1 判定 → 2 条断言报红）、变异检验（改坏 S6b id → B1/B2 报红）、回滚验证（G1 还原 → verify 报红 + selfcheck 仍 8/8；G4 恢复 → 全绿）

---

## 0.8.0

**插件规范化（按 DSH 插件开发教程 09-publish）**

- `package.json` 补齐 `peerDependencies` / `devDependencies` / `dependencies` / `engines` / `repository` / `scripts`
- 宿主依赖版本实测对齐：`@deepseek-ai/cordis` 4.0.5、`@deepseek-ai/dsh-client-ui-slots` 0.2.1-rc.2、`@deepseek-ai/schemastery` 3.18.5
- 打包清单 `files` 纳入 `assets/`（图标）与 `README.md`
- 初始化 git 仓库 + `.gitignore`（排除运行时数据、备份、本地配置）
- 新增 `scripts/check-update.mjs`：git 远程 / npm registry 双源更新检测，只读不改文件
- 新增插件图标：3 套方案 × 4 尺寸（SVG 矢量 + PNG 512/256/128/64）

**技能体系（self-evolution）**

- 新增「技能」页签：分「已启用 / 待批准」两块，批准前可预览正文前 300 字与字数
- 任务页工作项卡新增「蒸馏技能」按钮，未达门槛显示「还差 N 轮」而非隐藏
- 蒸馏轮数门槛从硬编码 3 改为可配置（`evolve-config.json`，默认 3，范围 1-10）
- `op=skills` 每项补充 `bytes` / `chars` / `preview` / `mtime`；单文件读失败隔离到 `errors[]`

**团队模式**

- 新增 `team` agent preset（「团队模式」）：standard 全量 22 项插件 + `agent-team` + `tool-agent-team`
- 会话栏顶部在团队模式下显示「团队模式」而非「标准模式」

**工作项与工作区**

- 会话内建的团队自动同步为面板工作项（`reconcileTeams`，幂等）
- `leadSessionId` 格式统一（去 `session-` 前缀），不一致时以 sidecar 为准修正并返回 `repaired`
- 工作区支持浏览任意文件夹：新增 `op=dir-list`（面包屑导航数据源）
- 空路径打开目录浏览器不再报「路径无效」，改为返回盘符根列表
- 根目录去掉硬编码：内置默认 + 盘符自动发现 + 用户自定义，三者带 `source` 标记
- 「×」删除按钮只对用户自加目录显示（`source==='user'`）
- 开团时可填「这次要做什么」（工作项名），空值时显示「未命名工作项 · 项目名」

**视觉与交互**

- 深色主题采用三级表面递进的冷色板（`#0d0e11` / `#16181d` / `#1e2127`）配单一强调色 `#3b82f6`
- 浅色主题改为同一套冷色系，深浅仅明暗不同
- 双主题跟随 DSH 外观设置（读 `body[data-ds-dark-theme]` + MutationObserver 实时切换）
- 失败态颜色统一为 `--danger`，消除「同一失败两种颜色」
- 字号收敛三级（11/12/13），间距统一 4px 网格，圆角统一 `--radius`
- 模型页高级设置整理：已停用通道折叠，通道行精简，模型行紧凑

**缺陷修复**

- `members-capped` 检查项改用**在编人数**（排除 retired/failed），修掉 11 条记录误判超 8 人上限
- `analyseGaps` 过滤 retired/failed，退休成员不再算岗位承接人
- 技能列表 `op=skills` 补齐元数据，批准前可见内容

---

## 0.6.0 及更早

历史版本无独立变更记录。主要能力：成员编制与能力域缺口分析、
handbook 验收自检、9 步流水线、模型路由四级优先（主力 / 免费 / 省钱 / 视觉兜底）、
`workbuddy_draw_image` 生图通道接入。
