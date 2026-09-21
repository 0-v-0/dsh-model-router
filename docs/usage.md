# dsh-model-router 使用文档（Usage）

> 这是 README 门面的完整细节页：快速开始、配置表、模型能力写回、面板 API 与故障排查。功能总览看 [README](../README.md)。

## 快速开始

1. 安装：`dsh plugin --profile web add @welsione/dsh-model-router`（卸载 `… remove …`）。
2. 打开 设置 → 模型路由，添加统一 ModelID（如 `deepseek-v4-flash`），为 tier1/2/3 各配候选（`provider + model` + 可选 `reasoningEffort`）。
   - **一键按模型名分组添加**：点击路由卡片标题旁的「按模型名分组」按钮，展开候选模型列表（按供应商数量降序排列）；点击任一模型名即可一键创建路由——将该模型的所有供应商作为 tier2 候选链；也可点「全部添加多供应商模型」批量创建。
3. **修改自动保存、即时生效**：任何改动去抖 600ms 后自动写入配置，无需点保存按钮；右下角显示保存状态，失败时红色提示。
4. 或在对话窗口的套餐选择器里选中已配置好的套餐；选中后路由按候选链自动故障转移。

最小配置示例（settings 的 `model-router` 段）：

```yaml
model-router:
  enabled: true
  cooldownMs: 300000        # 基础冷却；按失败类型分级 + 连续失败指数退避，封顶 cooldownMaxMs
  cooldownMaxMs: 1800000    # 冷却退避封顶（默认 30 分钟）
  cooldownBackoff: 2        # 连续失败冷却退避倍数
  maxSwitchesPerStep: 3
  healthRanking: true      # 健康度择优（稳定成功的候选优先）
  sessionLoadWeight: 1     # 会话负载权重（least-connections：运行中会话少的候选优先；0=禁用）
  routes:
    deepseek-v4-flash:      # 统一逻辑 ModelID
      tierNames: { tier3: 旗舰 }   # 可选：该套餐的自定义档位显示名
      tier1:                # 轻量：压缩 / 标题
        - { provider: opencode-go, model: mimo-v2.5, reasoningEffort: low }
      tier2:                # 标准：主对话
        - { provider: volcengine, model: deepseek-v4-flash }
        - { provider: opencode-go, model: deepseek-v4-flash }
      tier3:                # 强大：重任务
        - { provider: opencode-go, model: deepseek-v4-pro, reasoningEffort: high }
  # 兼容旧字段：simple → tier1, complex → tier2
```

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| enabled | true | 总开关；false 时全部放行原路径 |
| cooldownMs | 300000 | 冷却基础时长（ms）。按失败类型分级：AUTH/未知模型等「硬失败」用满额；服务端/超时/传输（SERVER/TIMEOUT/TRANSPORT/5xx）按 0.5 倍；限流/配额/空响应（RATE_LIMIT/QUOTA/429/EMPTY_RESPONSE）按 0.2 倍 |
| cooldownMaxMs | 1800000 | 冷却退避封顶（ms）。连续失败的冷却时长按 `cooldownBackoff ^ (连续失败次数)` 增长，超过此值封顶（默认 30 分钟） |
| cooldownBackoff | 2 | 连续失败冷却退避倍数（1-16）。设为 1 即关闭退避（恒为基础分级时长） |
| retryOnThrottle | true | 瞬时错误（限流/配额/服务端/超时/传输/空响应）先重试当前候选再切换；AUTH/未知模型等配置类错误不重试（重试无意义） |
| maxRetriesPerCandidate | 2 | 瞬时错误最多重试次数（0-5）。重试耗尽才进冷却并切换候选 |
| retryBackoffMs | 1000 | 重试间隔（ms），线性退避：第 n 次等待 n×此值 |
| maxSwitchesPerStep | 3 | 每个 step 最多切换候选次数（1-10） |
| healthRanking | true | 健康度择优：按滑动窗口内成功/失败重排候选链（稳定成功提前、频繁失败后移） |
| healthWindowSize | 8 | 每个候选健康度统计的滑动窗口大小（3-30） |
| sessionLoadWeight | 1 | 会话负载权重（least-connections 负载均衡）：运行中会话数越多的候选分数越低 → 排越后，新会话优先路由到空闲候选。设 0 禁用（退化为纯健康度排序）；推荐 1-3。仅 `healthRanking` 开启时生效。排除当前会话自身的负载，避免自己惩罚自己 |
| reasoningEffortsFallback | ["low","medium","high"] | 目录未标注推理能力的候选，允许手动选择的思考级别候选集。保存/面板时用实际请求预检 `resolveCallConfig` 过滤，只保留宿主真正接受的档位。默认取 models.dev 最常见档位，可自定义如 ["none","minimal","low","medium","high","xhigh","max"]，设 [] 关闭兜底 |
| routes | {} | 统一 ModelID → { tier1/2/3: [候选] } |
| routes.<id>.tierNames | {} | 该套餐的自定义档位显示名：tier1/tier2/tier3 → 显示名（如 `{tier3: 旗舰}`）；缺省回退 pro / normal / lite。同名档位只展示一次；设置面板彩色胶囊点击即改名（Enter 提交 / Esc 取消 / 清空恢复默认） |
| manualTiers | {} | sessionId → 手动档位（面板写入，跨重启保留） |
| taskRouting | 见下 | 任务属性 × 模型属性自动路由（**默认关闭**，开启后按任务画像匹配模型属性排序/过滤候选） |
| taskRouting.enabled | false | 任务路由总开关；false 时全部新逻辑短路，路由行为与旧版完全一致 |
| taskRouting.defaults | 见下 | 全局默认任务画像（分层：会话级 override > `routes.<id>.taskDefaults` > 此处） |
| taskRouting.defaults.importance | normal | 重要性：normal / important（important 任务对能力不足再罚） |
| taskRouting.defaults.urgency | not-urgent | 紧急性：not-urgent / urgent（urgent 任务对高延迟罚、低延迟加分） |
| taskRouting.defaults.idempotent | true | 幂等：false = 非幂等任务，任何失败不重试不切换（防重复副作用） |
| taskRouting.defaults.complexity | unknown | 复杂度：unknown / low / medium / high（对照候选 capability） |
| taskRouting.defaults.tokenBudget | 0 | token 预算：0 = 不限；>0 时按 `price × token/1e6` 估算成本，超预算候选跳过 |
| taskRouting.autoComplexity | true | complexity 未显式标注时按请求体量（token 估算）推断复杂度 |
| taskRouting.complexityThresholds | {low:16384, high:65536} | 自动复杂度阈值：> low = medium，>= high = high |
| taskRouting.weights | 见下 | 任务匹配排序权重（设 0 禁用对应维度） |
| taskRouting.weights.capability | 1 | 能力差罚权重（对照任务复杂度） |
| taskRouting.weights.latency | 1 | 延迟权重（紧急任务：高延迟罚、低延迟加分） |
| taskRouting.weights.speed | 0.5 | 速度权重（紧急/重要任务：低速度罚、高速度加分） |
| taskRouting.weights.price | 0.5 | 价格权重（同链内相对价差归一化，便宜优先） |
| taskRouting.weights.importance | 1 | 重要性权重（重要任务：能力不足再罚） |
| taskOverrides | {} | sessionId → 会话级任务画像（`/api/model-router/task` 维护，跨重启保留） |
| routes.<id>.taskDefaults | {} | 该套餐的任务画像默认值（结构同 `taskRouting.defaults`） |
每个候选：`provider`（必填）、`model`（必填）、`reasoningEffort`（可选，保存时校验模型支持）；任务路由开启后可用模型属性：`location`（internal/external，外部模型需配合脱敏插件如 dsh-redact）、`trust`（trusted/untrusted，不可信候选只在只读环境工作）、`speed`（unknown/low/medium/high）、`latency`（unknown/low/medium/high）、`capability`（low/medium/high）、`price`（每百万 token 成本，0 = 未知/免费）。
### 模型能力（写回宿主 llm-pi-ai · 仅自定义供应商）

面板「自定义供应商模型能力」卡片列出宿主 `llm-pi-ai` 中**自定义（hand-declared）供应商**的模型，可逐模型编辑 `reasoningEfforts`（思考级别档位 + wire 值）、`contextWindow`、`maxTokens` 并保存。插件用全局 `ctx.settings` 深合并写回 `llm-pi-ai` 命名空间（只改目标 provider/model，其余配置保留），llm-pi-ai 的 onChange 热重载 adapter，**无需重启即生效**。

- **仅自定义供应商可写**：只对 `ctx.llm.listConfigurableProviders()` 中 `declared === true`（pi-ai 不内置的 gateway/self-hosted）开放；内置目录供应商被过滤 / 拒绝，其能力由宿主模型目录管理。
- 典型用途：`volcengine-mian/deepseek-v4-flash` 这类 hand-declared 模型（settings 里只有 `id/name`）不声明 `reasoningEfforts` 时，宿主 pi-ai 判定其不支持推理，任何思考级别都会被拒。在卡片声明档位（如 `off`/`low`/`medium`/`high`）写回后，该模型立即可配思考级别。

### 面板 API（同源 `webServer`）

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/model-router/state` | 配置 + 模型目录 + 思考级别 + 冷却 + 事件历史 + 统计 + 每候选健康度 |
| POST | `/api/model-router/save` | 整段保存（校验模型存在性与思考级别；面板自动保存即调此接口） |
| POST | `/api/model-router/cooldowns/clear` | 清空全部冷却 |
| POST | `/api/model-router/tier` | 设置 / 清除会话手动档位 |
| GET | `/api/model-router/model-capabilities` | 读宿主 `llm-pi-ai` 的 provider/models 能力（reasoningEfforts/contextWindow/maxTokens） |
| POST | `/api/model-router/model-capabilities` | 写回某 provider/model 的能力（深合并，热重载生效） |
| GET | `/api/model-router/task` | 读会话级任务画像（`?session=<id>` 单个，否则全量） |
| POST | `/api/model-router/task` | 设置 / 清除会话级任务画像（`body.task` 空对象 = 清除） |

## 故障排查

- **设置页没有「模型路由」卡片** → 确认 `dsh` 版本 ≥ 0.1.0-rc.6，且插件已作为 bundle 安装（`dsh --profile web --dump-config | grep model-router` 应有该行）。
- **面板报「候选不存在于当前模型目录」** → 先在该 provider 下确认模型 id 拼写，或重新保存让目录刷新。
- **面板提示「自动保存失败：…」** → 多为思考级别校验未过（候选不支持该档位），按提示换档位或留空；修复后下一次修改会自动重试保存。
- **全部候选失败 / 一直切换** → 查 `GET /api/model-router/state` 的 `cooldowns` 与 `history`；多为限流/配额，等冷却或「全部清除」。
- **会话打不开 / 一直失败在第 1 步** → 可能是历史里已有跨 provider 的旧 `replayState` 污染；本插件在下次请求时自动清洗，新请求自愈。
- **想手动切档** → 对话窗口「套餐」下拉里点 pro / normal / lite（或该套餐的自定义档位名），持久化到 settings，重启保留。

## 已知限制

- 冷却期为内存态，重启丢失（可接受：主要防同机会话内反复打失败 provider）。
- 手动档位持久化上限 500 条会话，超出自动淘汰最早条目。
- 思考档位支持矩阵依赖各 provider 实际行为，保存时按模型目录校验。
- 自动保存为去抖（600ms）后写入：连续修改会在停止输入后一次性落盘，不会每个按键都写一次。