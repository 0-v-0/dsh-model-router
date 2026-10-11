# 任务：基于 welsione/dsh-model-router 扩展"按运行中会话数最少选模型"的负载均衡功能

## 背景与目标

用户需要一个 DeepSeek Harness (DSH) 插件功能：在配置的候选模型列表中，**自动选择当前运行中会话数量最少的模型**，实现 least-connections 负载均衡。

经穷尽检索（gh search repos/code、GitHub topic、awesome 清单、web 搜索），**GitHub 上没有现成实现此功能的插件**。现有的 dsh-model-router 类插件选路维度各不相同（成本/健康度/峰谷价/角色/任务档位），都不按会话数。

**决策：不写独立插件，而是 fork `welsione/dsh-model-router` 做本地补丁扩展。** 理由：它的 `rankChainByHealth` 已经是多维度候选重排的纯函数架构，"会话数最少"只是正交地再加一个评分维度，改动局部（约 3 处），且它已解决冷却/退避/窗口过滤/replayState 清洗/双路由一致性/设置 UI 等所有通用难题。

## 基座仓库

- 仓库：`welsione/dsh-model-router` (https://github.com/welsione/dsh-model-router)
- npm 包：`@welsione/dsh-model-router@0.0.8`
- 许可证：MIT
- 核心文件：`lib/core.mjs`（17KB，纯函数路由核心）、`lib/index.js`（51KB，宿主挂载+钩子）、`lib/client.js`（设置面板 UI）
- 测试：`tests/core.test.mjs`（用 node --test，纯函数单测）

## 已确认的 DSH 接缝事实（读源码核实，非推测）

1. **`agent/request` 是 waterfall 钩子**，签名 `next() => Promise<LlmCallConfig>`，返回替换后的 `LlmCallConfig`（含 `provider` / `model` / `reasoningEffort`）。所有路由插件都在此改写 model。
   - 源码位置：`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:254-259`
   - 注释明确："Replace the frozen call configuration... return a replacement to switch."

2. **`SessionSummary`（会话列表条目）没有 `model` 字段**——只有 `running: boolean`、`agentPreset`、`cwd` 等。模型是 per-step 的 `LlmCallConfig`，会话可中途换。
   - 源码位置：`@deepseek-ai/dsh-host-apiproxy/lib/types/api/sessions.d.ts:174-224`（`SessionSummary` 接口）
   - 含义："每个模型有几个运行中会话"没有现成列表字段可读，需从会话日志的 `request/header` 投影取每个会话当前用的 model，再按 running 状态过滤统计。

3. **`welsione/dsh-model-router` 已在 `agent/request` 里拿到 `payload.agent.session.id`**（`lib/index.js:583`），且已维护 `health` 这个 `Map<cooldownKey, {...}>` 运行态字典。用同样机制维护 `runningByModel` Map 是顺水推舟。

4. **`ModelSelection` 接口**：`{ provider: string, model: string, reasoningEffort?: ReasoningEffortId }`
   - 源码位置：`@deepseek-ai/dsh-agent/lib/types/model-selection.d.ts:7-13`

5. **DSH plugin 安装**：`dsh plugin --profile web add <路径>` 改的是 bundle 层，**不会热加载到运行中的 dsh web**，需要重启 dsh web + 刷新页面才生效。

## 具体改造点（3 处）

### 改造 1：`lib/core.mjs` — `rankChainByHealth` 加会话数维度

当前实现（`lib/core.mjs:160-167`）：

```js
export function rankChainByHealth(chain, healthByKey) {
  if (!Array.isArray(chain) || chain.length < 2) return chain
  return chain
    .map((c, i) => ({ c, i, score: candidateHealthScore(healthByKey?.get(cooldownKey(c))) }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((x) => x.c)
}
```

改后（加 `sessionLoadByKey` 和 `sessionLoadWeight` 参数）：

```js
export function rankChainByHealth(chain, healthByKey, sessionLoadByKey, sessionLoadWeight = 1) {
  if (!Array.isArray(chain) || chain.length < 2) return chain
  return chain
    .map((c, i) => {
      const healthScore = candidateHealthScore(healthByKey?.get(cooldownKey(c)))
      const runningCount = sessionLoadByKey?.get(cooldownKey(c)) ?? 0
      // 会话数越多 → 分数越低 → 排越后。权重控制会话数 vs 健康度的权衡。
      const loadPenalty = runningCount * sessionLoadWeight
      return { c, i, score: healthScore - loadPenalty }
    })
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((x) => x.c)
}
```

注意：保持纯函数、确定性、可单测。`sessionLoadWeight` 默认 1，设 0 则退化为纯健康度（向后兼容）。

### 改造 2：`lib/index.js` — 维护 `runningByModel` Map

需要在 `lib/index.js` 中：
- 声明 `const runningByModel = new Map()`（类似已有的 `health` Map）
- 在会话生命周期钩子（`agent/session-start`、`agent/turn-stopping` 或已有的事件）上增量更新：会话开始时，根据该会话当前 model 给对应 `cooldownKey` 计数 +1；会话结束/turn 停止时 -1。
- 在调用 `rankChainByHealth` 的两处（`lib/index.js:503` 的 llm/stream 选路 和 `lib/index.js:587` 的 agent/request 信封解析）传入 `runningByModel` 和 `cfg.sessionLoadWeight`。

获取"每个会话当前用的 model"的方法：从 `request/header` 事件投影取该会话最后一次请求的 `source.model`（welsione 已有 `sessionProjections` 机制可参考）。

### 改造 3：配置项 + 设置面板

- `cordis.patch.yml` 或配置默认值里加 `sessionLoadWeight`（number，默认 1，0=禁用会话数维度）。
- `lib/client.js` 设置面板加一个 slider/input 控制 `sessionLoadWeight`。
- `tests/core.test.mjs` 加单测：构造候选链 + 不同 runningCount，验证排序符合"最少会话优先"。

## 执行步骤

1. **Clone 仓库（已完成）

2. **读取并确认源码**：`lib/core.mjs`（重点 `rankChainByHealth` 行 160-167）、`lib/index.js`（重点 agent/request waterfall 行 558-600、llm/stream 选路 行 490-544、health Map 维护 行 243）、`tests/core.test.mjs`。

3. **做改造 1-3**（用 edit 工具精确编辑）。

4. **运行单测**：
   ```pwsh
   node --test "tests/**/*.test.mjs"
   ```
   注意：DSH sandbox 下 node --test 应该可跑（不是 vitest，无 EPERM 问题）。

5. **本地安装到 web profile**：
   ```pwsh
   dsh plugin --profile web add D:\dev\test\dsh-model-router
   ```
   然后重启 dsh web + 刷新页面。

6. **验证**：配置一个 Route Group（套餐）含 2-3 个等价候选模型，开多个会话分别用不同模型，新会话应自动路由到会话数最少的模型。在设置面板查看候选的 running count 统计是否正确。

## 注意事项

- **不要同时安装其他 dsh-model-router 类插件**（tianji-qingtian、zhuzhujunandy、Oops668、whg20001 等）——它们都在 `agent/request` 改写 model，write-write 冲突。
- **尊重用户手动 selectModel**：如果用户在 picker 里显式选了 model，路由不应覆盖（welsione 的 `findByCandidate` 逻辑已部分处理这点，确认改造后仍兼容）。
- **性能**：`runningByModel` Map 用增量更新（会话事件钩子），不要每次 `agent/request` 都全量扫会话列表。
- **向后兼容**：`sessionLoadWeight=0` 时必须退化为原行为（纯健康度排序），保证不破坏现有用户。
- **rebase 上游**：改动局部，上游更新时 rebase 冲突应很小（主要在 `rankChainByHealth` 签名和两处调用点）。

## DSH 源码参考位置（本机 checkout）

- DSH checkout：`D:\Baulk-6.1.0-win-x64\packages\nodejs\node_modules\@deepseek-ai\dsh\`
- agent/request 钩子定义：`node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:254-259`
- SessionSummary（无 model 字段）：`node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/sessions.d.ts:174-224`
- ModelSelection 接口：`node_modules/@deepseek-ai/dsh-agent/lib/types/model-selection.d.ts:7-13`
- 会话 running 状态：`node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/events.d.ts:177`（`running: boolean`）
