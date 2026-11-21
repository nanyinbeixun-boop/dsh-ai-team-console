# 安全与敏感信息规范

本仓库会公开分发（git 远程 / npm），因此**任何真实凭据、网络拓扑、账号标识都不得进入版本历史**。
本文说明：仓库刻意排除了什么、为什么某些内容可以保留、以及贡献者提交前必须做什么。

---

## 一、绝不入库的内容

| 类别 | 具体项 | 排除方式 |
|---|---|---|
| **凭据** | API Key、Access Token、Refresh Token、Bearer JWT、私钥（`*.pem` / `*.key` / `*.p12` / `*.pfx`）、密码、Cookie | `.gitignore` + 提交前扫描 |
| **网络拓扑** | 真实公网 IP、代理/VPN 节点域名与出口地址、订阅链接及其 token、内网网段、DNS 服务器地址 | 同上 |
| **账号标识** | 手机号（**含 `138****1234` 这类掩码形式**）、邮箱、平台账号 ID、主机名 | 同上 |
| **本地配置** | `route-config.json`、`*.local.json`、`.env*`、`config.local.*` | `.gitignore` |
| **运维记录** | 含上述任一内容的调查/实测文档（如注册通道调研、账号余额盘点） | 按文件名规则排除 |

**为什么掩码手机号也要排除**：`138****1234` 仍能唯一定位到具体账号——
结合公开的号段信息可以缩小到极小范围。掩码不是脱敏，是弱化。

**运维记录单独存放**：含真实网络与账号数据的调查/盘点类文档
（注册通道调研、账号余额盘点等）保持在本地 `_运维/sensitive-docs/`，**只在本机保留，不入库**。
它们的技术结论已提炼进不带原始数据的规格文档。

---

## 二、刻意保留的内容（不是泄露）

### `127.0.0.1:<port>` 形式的回环地址

代码与文档中出现的 `127.0.0.1:4317`、`127.0.0.1:43129`、`127.0.0.1:18326` 等：

- `127.0.0.1` 是 **IPv4 回环地址**，任何主机上都指向本机，不携带任何拓扑信息
- 这些是 DSH 各组件的**默认本地端口**（sidecar / web / 插件 relay），属于公开的接口约定
- 它们**不是**公网地址，也不含凭据

**真正需要保护的是默认值被覆盖后的实际值**——那部分从环境变量读取，不写进仓库。

### 可被环境变量覆盖的默认值

服务端读取外部地址时遵循「环境变量优先，回环地址兜底」：

```js
const SIDECAR_DEFAULT = 'http://127.0.0.1:4317'
function sidecarBase() {
  const env = process.env.DSH_TEAM_SIDECAR_URL || process.env.DSH_TEAM_SIDECAR
  if (env && /^https?:\/\//.test(env)) return env.replace(/\/+$/, '')
  return SIDECAR_DEFAULT
}
```

部署到非默认环境时**不要改源码**，改环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_TEAM_SIDECAR_URL` | sidecar 地址 | `http://127.0.0.1:4317` |
| `DSH_TEAM_SIDECAR` | 同上（别名） | — |

---

## 三、提交前必做：敏感信息扫描

仓库自带扫描脚本，**提交前必须跑一次**：

```bash
node scripts/scan-secrets.mjs
```

扫描范围：全部 git 已跟踪文件。检测 13 类模式：

```
API Key(sk-) / Bearer Token / JWT / password 赋值 / secret 赋值 / token 赋值
Authorization 头 / 公网 IPv4 / 代理节点域名 / 订阅 token / 回环端口 / 代理地址
邮箱 / 手机号(含掩码) / 长 16 进制账号 ID
```

**退出码**：有命中返回 1（可接进 CI / pre-commit）。

```bash
node scripts/scan-secrets.mjs --staged   # 只扫暂存区（pre-commit 用）
```

### 已启用 pre-commit 钩子

仓库提供 `.githooks/pre-commit`，安装一次即可：

```bash
git config core.hooksPath .githooks
```

启用后每次 `git commit` 都会先扫暂存区，有命中直接拒绝提交。

---

## 四、如果不慎已提交

**只删文件不够**——内容仍在历史里，`git clone` 能取回。按严重程度处理：

### 情形 A：还没 push 到远程

```bash
# 撤回最近 N 个提交但保留工作区改动
git reset --soft HEAD~N

# 从暂存区移除敏感文件并加入 .gitignore，然后重新提交
git restore --staged <file>
```

### 情形 B：已 push 到远程

必须**重写历史**并强制推送（会改写所有协作者的克隆）：

```bash
# 方式一：git-filter-repo（推荐，需另装）
git filter-repo --path <敏感文件路径> --invert-paths

# 方式二：核选项——清空历史重新开始（仅当历史很短且无协作者）
rm -rf .git && git init && git add -A && git commit -m "init"

git push --force-with-lease origin main
```

### 情形 C：凭据已经泄露

**先作废凭据，再清历史**。顺序不能反：

1. 到对应平台撤销 / 轮换该 Key、Token、密码
2. 检查是否有异常调用记录
3. 再执行上面的历史清理

清历史只是止损，泄露过的凭据必须视为已失效。

---

## 五、本仓库的当前状态

| 项 | 状态 | 说明 |
|---|---|---|
| 凭据 / 密钥 | ✅ 无 | 扫描 13 类模式，零命中 |
| 公网 IP / 代理节点 | ✅ 无 | 含真实 IP 的运维记录已排除 |
| 手机号 / 邮箱 | ✅ 无 | 含账号标识的盘点文档已排除 |
| 回环端口 | ⚠️ 保留 | `127.0.0.1:<port>` 属公开接口约定，见第二节 |
| pre-commit 检查 | ✅ 已提供 | `.githooks/pre-commit` |
| git 历史 | ✅ 干净 | 已重写历史，敏感内容不在任何提交中 |

---

## 六、报告安全问题

发现本仓库泄露了敏感信息，请**不要开 public issue**。
通过私下渠道通知维护者（仓库 `repository.url` 中的联系方式），并说明：

1. 受影响的文件与提交范围
2. 泄露内容类型（凭据 / 网络 / 账号）
3. 是否已经 push 到远程

维护者会按第四节流程处理并在修复后致谢。
