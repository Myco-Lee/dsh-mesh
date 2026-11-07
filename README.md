# dsh-mesh

把局域网里的多台 DeepSeek Harness 组成一条**可掉线的分布式任务流水线**：任务在一台机器上提交，按节点负载自动拆派给所有机器并行执行；任何一台中途挂掉，它手上的步骤会在租约过期后被别的节点接手，已完成的步骤绝不会重跑。

不需要数据库、不需要中心服务器：协调、派单、进度、产物全部落在一个共享目录里（SMB / 本机盘都行），靠「单写者 + 租约 + 幂等 commit」保证一致性。

## 它解决的问题

| 场景 | 单机 | dsh-mesh |
| --- | --- | --- |
| 写 30 万字小说 | 一条线跑几十小时 | 章节切开，多机并行；挂一台不影响进度 |
| 剪 20 集短剧 | 素材串行生成 | 分镜级并行，产物按内容寻址落盘 |
| 做程序/游戏 | 单 agent 改全部文件 | 按文件所有权切模块并行，最后串行集成 |
| 深度调研 | 一个模型跑到底 | 检索/抓取/成稿分段并行，交叉校验 |

## 工作原理

```
提交端 (任意 DSH)            共享目录 (\\host\dsh-mesh)                执行端 (每台 DSH)
  mesh_submit  ──写 plan──►  tasks/<id>/plan.json
                                   │
                          协调器 (租约选主) ──派单──► tasks/<id>/steps/<s>/assign.json
                                                              │
                                                       worker 抢租约 lease.json
                                                              │
                                                       dsh --profile mesh-worker headless
                                                              │
                                                       写 commit.json (wx 独占创建)
```

- **Task → Plan(DAG) → Step → Artifact → Ledger**：每步是 5–20 分钟可重试的单元，产物按 `sha256` 内容寻址落盘。
- **租约**：worker 抢到 `lease.json` 才有权执行，每 10s 续期；45s 不续期即视为死亡，协调器回收并重新派给别的节点（优先避开上次失败的那个节点）。
- **幂等**：提交用 `commit.json` 的 `wx` 独占创建，同一步骤重复执行只会产生一个 commit，后来的写者自动认输。
- **账本**：每个节点写自己的 `ledger/<node>/events.jsonl`（追加写，不抢锁），协调器合并读取。
- **重试上限** 3 次，超限标记 `blocked` 并在账本里留证据，不会无限重派。

## 安装

```powershell
# 源码放哪都行；用 link: 装进 profile
dsh plugin --profile desktop add "link:D:\99-DP-D\01-代码项目\dsh-mesh"
```

如果目标机器的 Electron 独占 profile（`error: profile "desktop" is managed exclusively by the Electron application`），手工装：

1. 把仓库复制到 `C:\Users\<you>\dsh-plugins\dsh-mesh`，同时复制一份到 `<profile>\node_modules\dsh-mesh`（实目录，不是符号链接）；
2. profile 的 `package.json` 里 `dependencies["dsh-mesh"] = "file:C:/Users/<you>/dsh-plugins/dsh-mesh"`，并把 `"dsh-mesh"` 加进 `dsh.profile.bundles`；
3. 在 profile 的 `cordis.patch.yml` 末尾加配置（见下）；
4. 重启桌面应用（只有新建 bundle 才必须重启；之后改 config 会热重载）。

### 每台机器都要做的两件事

```powershell
# 1) 一个纯执行用 profile（不要带桌面 UI 插件）
dsh --profile mesh-worker --from-default-profile headless headless "只回复 ok"
```

```yaml
# 2) profile 的 cordis.patch.yml 末尾
- id: dsh-mesh
  config:
    root: '\\192.168.8.164\dsh-mesh'   # 共享目录；本机就是 D:\dsh-mesh
    node: LMM-1                        # 唯一节点名（默认主机名）
    role: auto                         # auto | coordinator | worker | client
    workerProfile: mesh-worker
    apiKeyFile: 'C:/Users/Administrator/.dsh/.credentials.yaml'
    maxConcurrent: 2
    pollMs: 2000
```

节点名必须是唯一标识：两台机器同名会互相抢租约。

## 工具

| 工具 | 作用 |
| --- | --- |
| `mesh_plan` | 用内置模板（`research` / `novel` / `drama` / `code`）生成计划；`submit=true` 才真正提交 |
| `mesh_submit` | 提交 DAG 计划：`{ goal, steps:[{id,title,instruction,dependsOn?,caps?,serial?,priority?}] }` |
| `mesh_tasks` | 列任务 / 查单个任务的分步状态、执行节点、重试次数 |
| `mesh_status` | 集群视角：协调器、存活节点与能力/槽位、队列与背压、本机按通道占用 |
| `mesh_cancel` | 取消任务（已在跑的步骤会跑完，不再派新步骤） |

指令里可以写 `{{step:s1}}`：依赖步骤的产物会自动内联（超长时改为落 `inputs/s1.md` 让执行端自己读）。

### 能力与模板（M3）

- **能力标签**：步骤可声明 `caps: ['image']`，只有心跳里报告了该能力的节点才接。没能力的节点不会被派到。
- **通道槽位**：`capSlots: { image: 1 }` 表示本机同时只跑 1 个 image 步骤；`maxConcurrent` 仍是总闸。
- **背压**：未完成步骤总数超过 `maxQueuedSteps` 时暂停派单，已派出的照常跑完。
- **优先级**：`priority` 数字越小越先派（默认 50）。
- **模板**：`mesh_plan` 把「提纲→并行分节→核验→去 AI 腔→拼装」这类套路固化下来，省掉手写 20 步计划。

```jsonc
// 调研/论文：sections 决定并行度，material 可指向本地语料目录
{ "template": "research", "goal": "国际制裁的反制", "sections": ["问题的提出", "规范基础", "比较法"], "target": "30000 字", "submit": true }
```

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `root` | 空 | 共享目录（空则插件不启动，只记日志） |
| `node` | 主机名 | 节点标识，必须唯一 |
| `role` | `auto` | `auto` 谁先抢到协调器谁当；`worker` 只干活；`client` 只提交 |
| `workerProfile` | `mesh-worker` | 执行步骤用的 profile |
| `maxConcurrent` | 2 | 本机同时跑几步 |
| `leaseMs` / `leaseRenewMs` | 45000 / 10000 | 步骤租约时长与续期间隔 |
| `coordLeaseMs` | 15000 | 协调器租约（15s 一续） |
| `maxAttempts` | 3 | 单步重试上限，超过标记 blocked |
| `stepTimeoutMs` | 900000 | 单步硬超时（超时 kill 进程树并按失败处理） |
| `maxContextChars` | 6000 | 依赖产物内联进指令的上限 |
| `apiKeyFile` | 空 | 执行端 API key 文件（YAML/JSON 里有 `DEEPSEEK_API_KEY` 即可） |
| `dshExe` / `dshCli` | 自动 | 桌面端自动推导 Electron + cli.js；CLI 端需要显式传 |
| `caps` | `['text']` | 本机能接的通道，如 `['text','image','code']` |
| `capSlots` | `{}` | 每通道并发上限，如 `{ image: 1 }`；未列出的通道只受 `maxConcurrent` 约束 |
| `maxQueuedSteps` | 200 | 未完成步骤总数上限，超过则暂停派单（背压） |
| `heartbeatMs` | 30000 | 节点心跳间隔（写 `nodes/<node>.json`） |
| `nodeTtlMs` | 90000 | 心跳超时即视为离线，不再派单给它 |
| `address` / `httpPort` | 空 / 0 | 广播自己的控制面地址（可选，供后续远程调用） |

## 运行期文件

```
<root>/
  coord/lease.json                 协调器租约
  nodes/<node>.json                节点心跳（能力 caps、槽位 capSlots、并发、角色）
  ledger/<node>/events.jsonl       每节点事件账本（dispatch/commit/fail/lease）
  tasks/<taskId>/plan.json         计划
  tasks/<taskId>/task.json         元信息与状态
  tasks/<taskId>/result.json       全部步骤完成后的汇总（wx 一次性）
  tasks/<taskId>/steps/<id>/assign.json    派单
  tasks/<taskId>/steps/<id>/lease.json     租约
  tasks/<taskId>/steps/<id>/commit.json    提交记录（含 sha256、bytes、node）
  tasks/<taskId>/steps/<id>/state.json     失败/重试状态
  tasks/<taskId>/steps/<id>/attempts/<n>/  每次尝试的 step.log / result.md / error.json / inputs/
```

本机日志：`~/.dsh/mesh/mesh.log`。

## 无桌面宿主时跑一个节点

```powershell
node bin/mesh-node.mjs --root "\\192.168.8.164\dsh-mesh" --node LMM-3 `
  --exe "D:\99-DP\DeepSeek Harness.exe" `
  --cli "D:\99-DP\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
```

## 测试

```powershell
node test/mesh-core.test.mjs    # 假执行器：DAG、重试、租约接管、幂等、环检测
node test/mesh-m3.test.mjs      # 模板、能力路由、通道槽位、优先级、背压
```

## 已知限制

- 只做局域网 / 同源可达的共享目录；跨公网请配 `dsh-wan-peers` 做发现 + Tailscale/隧道做数据面。
- 协调器单点：协调器所在机器挂掉后，其余节点在 `coordLeaseMs` 内重新选主（约 15 秒），期间不派新单，已跑的步骤不受影响。
- 步骤产物目前是纯文本；图片/视频等二进制产物建议让执行端写共享目录再在 commit 里记录路径。
- 没有跨节点带宽优化：大产物走共享盘，天然受 SMB 带宽限制。

## License

MIT
