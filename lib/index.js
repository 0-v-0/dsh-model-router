// dsh-model-router — DSH 统一模型路由插件（Host 半）
//
// 能力：
//   1. 统一 ModelID：多个供应商的同名模型（如 deepseek-v4-flash 在火山和 OpenCodeGo）
//      配置成一个逻辑 ID，按候选链路由。
//   2. 自动故障转移：主候选首 token 前失败（限流/配额/认证/网络/模型不存在/空响应）
//      自动切下一候选；失败候选进入冷却期。
//   3. 三档分级（对标 Claude Haiku/Sonnet/Opus）：
//      - tier1 轻量（压缩/标题）· tier2 标准（主对话）· tier3 强大（重任务）
//      - purpose=compaction/session-title → tier1；主对话 → tier2；options.tier=3 → tier3
//      - 选中档为空 → 逐级降档
//   4. 思考级别：每个候选可配 reasoningEffort（off/minimal/low/medium/high/xhigh/max，
//      对标 Claude /effort），面板可配置，保存时校验模型支持。
//
// 面板 API（webServer，同源 fetch）：
//   GET  /api/model-router/state           -> 配置+目录+efforts+冷却+事件历史+统计
//   POST /api/model-router/save            -> 整段保存配置（settings.replace）
//   POST /api/model-router/cooldowns/clear -> 清空冷却
//   POST /api/model-router/tier            -> 设置 / 清除会话手动档位
//
// 配置（settings 的 model-router 段）：
//   model-router:
//     enabled: true
//     cooldownMs: 300000
//     maxSwitchesPerStep: 3
//     routes:
//       deepseek-v4-flash:
//         tier1: [{provider: opencode-go, model: mimo-v2.5, reasoningEffort: low}, {provider: volcengine, model: deepseek-v4-flash}]
//         tier2: [{provider: volcengine, model: deepseek-v4-flash}, {provider: opencode-go, model: deepseek-v4-flash}]
//         tier3: [{provider: opencode-go, model: deepseek-v4-pro, reasoningEffort: high}, ...]
//     # 兼容旧字段：simple → tier1, complex → tier2
//
// 纯逻辑（选档/降档/错误判定/replayState 清洗）集中在 ./core.mjs，可单元测试。

import z from '@deepseek-ai/schemastery'

// schemastery 无 z.enum：枚举用 union(const) 表达（0.1.0-rc.x 兼容）
const enumOf = (...values) => z.union(values.map((v) => z.const(v)))

// dsh-settings 0.1.2-rc.1 起移除了 installSettingsSection 自由函数导出（规范形态
// 变为 SettingsProvider.installSection 方法），具名导入会在模块求值期直接抛
// SyntaxError —— 即 0.1.2+「安装插件后报错」。改用 namespace 导入 + 运行时探测，
// 同时兼容 0.1.1-（自由函数）与 0.1.2+（服务方法）。
import * as dshSettings from '@deepseek-ai/dsh-settings'

// installSection 跨版本兼容：
//   - dsh-settings <= 0.1.1：自由函数 installSettingsSection(ctx, ns, schema, entry, hooks)
//   - dsh-settings >= 0.1.2：ctx.settings.installSection(ctx, ns, schema, entry, hooks)
//     （本插件 inject 已声明 settings，apply 时服务必然已解析）
function installSectionCompat(ctx, ns, schema, entry, hooks) {
  if (typeof dshSettings.installSettingsSection === 'function') {
    return dshSettings.installSettingsSection(ctx, ns, schema, entry, hooks)
  }
  const settings = ctx.settings
  if (!settings || typeof settings.installSection !== 'function') {
    throw new Error('dsh-model-router: 宿主 settings 服务不可用或缺少 installSection（需要 dsh >= 0.1.0）')
  }
  return settings.installSection(ctx, ns, schema, entry, hooks)
}

import {
  NS,
  TIER_SLOTS,
  RESOLVED,
  cooldownKey,
  isRetryableFailure,
  isTransientFailure,
  pickRepresentativeFailure,
  isReasoningEffortUnsupported,
  cooldownDurationMs,
  normalizeRoute,
  findByCandidate,
  selectTier as selectTierCore,
  pickChain as pickChainCore,
  rankChainByHealth,
  withSanitizedReplayState,
  estimateRequestTokens,
  filterChainByContext,
  hasImageContent,
  recommendTierByContent,
  rankChainForTask,
  filterChainByBudget,
  shouldRetryForTask,
  resolveTaskProfile,
  TASK_PROFILE_KEYS,
} from './core.mjs'
const HISTORY_CAP = 60

function json(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > limit) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

export const name = 'dsh-model-router'
// llm/webServer/settings 都是 loadable service：必须 inject 声明，
// ctx.get 拿不到（webServer undefined 会导致面板 API 静默不注册）。
export const inject = ['llm', 'webServer', 'settings']

export function apply(ctx) {
  // ------------------------------------------------------------------
  // 配置 schema（schemastery）
  // ------------------------------------------------------------------
  const Candidate = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(), // 思考级别：可选（schemastery 中 z.string() 默认可空）
    // 上下文窗口覆盖：缺省从宿主模型目录（resolveModelInfo）解析，再兜底 256K。
    // 显式声明可免一次目录解析（自网关/聚合站的模型常无目录标注）。
    contextWindow: z.number().step(1).min(1),
    // 任务路由模型属性（feature: task-aware routing）：
    //   location   internal/external —— 外部模型需配合脱敏插件（如 dsh-redact）
    //   trust      trusted/untrusted —— 不可信候选只在只读环境工作
    //   speed      unknown/low/medium/high —— 生成速度
    //   latency    unknown/low/medium/high —— 首 token 延迟（紧急任务选低延迟）
    //   capability low/medium/high —— 能力档位（对照任务复杂度）
    //   price      每百万 token 成本（0 = 未知/免费，不参与预算过滤）
    location: enumOf('internal', 'external').default('external'),
    trust: enumOf('trusted', 'untrusted').default('trusted'),
    speed: enumOf('unknown', 'low', 'medium', 'high').default('unknown'),
    latency: enumOf('unknown', 'low', 'medium', 'high').default('unknown'),
    capability: enumOf('low', 'medium', 'high').default('medium'),
    price: z.number().min(0).default(0),
  })
  const Route = z.object({
    tier1: z.array(Candidate).default([]),
    tier2: z.array(Candidate).default([]),
    tier3: z.array(Candidate).default([]),
    simple: z.array(Candidate).default([]),  // 兼容旧字段 → tier1（schemastery 无 .optional()，字段默认可选；用 .default([]) 兜底）
    complex: z.array(Candidate).default([]), // 兼容旧字段 → tier2（同上）
    // 该套餐的档位显示名：tier1/tier2/tier3 → 自定义名（缺省用默认 lite/normal/pro）。
    // 只影响展示（对话窗口套餐选择器 / 设置面板徽章），内部逻辑仍按 tier 标识路由。
    tierNames: z.dict(z.string(), z.string()).default({}),
    // 该套餐的任务画像默认值（feature: task-aware routing）：
    // 会话级 override > route.taskDefaults > taskRouting.defaults。
    taskDefaults: z.object({
      importance: enumOf('normal', 'important').default('normal'),
      urgency: enumOf('not-urgent', 'urgent').default('not-urgent'),
      idempotent: z.boolean().default(true),
      complexity: enumOf('unknown', 'low', 'medium', 'high').default('unknown'),
      tokenBudget: z.natural().default(0),
    }).default({}),
  })
  const Config = z.object({
    enabled: z.boolean().default(true),
    // 冷却基础时长（AUTH/未知模型等「硬」失败用满额；限流/配额/空响应按 0.2 系数、
    // 服务端/超时/传输按 0.5 系数缩短），连续失败指数退避，封顶 cooldownMaxMs。
    cooldownMs: z.natural().default(300000),
    cooldownMaxMs: z.natural().default(1800000), // 冷却退避封顶（默认 30 分钟）
    cooldownBackoff: z.natural().min(1).max(16).default(2), // 连续失败的退避倍数
    maxSwitchesPerStep: z.natural().min(1).max(10).default(3),
    // 瞬时错误（限流/配额/服务端/超时/传输/空响应）重试：同一候选短暂等待后
    // 重试（最多 maxRetriesPerCandidate 次），全失败才进冷却并切换候选。
    // 避免「限流一下就立刻冷却」——限流常是瞬时的，等 1-2 秒再试可能成功。
    // AUTH/UNKNOWN_MODEL 等配置类错误不重试（重试无意义），直接切换。
    retryOnThrottle: z.boolean().default(true),
    maxRetriesPerCandidate: z.natural().min(0).max(5).default(2),
    retryBackoffMs: z.natural().default(1000), // 重试间隔，线性退避（1x,2x,...）
    // 健康度感知择优：候选链按滑动窗口内的成功/失败重排（稳定成功提前、频繁失败后移）。
    // 默认开启，可在面板关闭恢复「纯配置顺序」语义。
    healthRanking: z.boolean().default(true),
    healthWindowSize: z.natural().min(3).max(30).default(8), // 每个候选保留的滑动窗口大小
    // 思考级别兜底：目录未标注推理能力的候选，也允许手动选择思考级别（值未经验证，透传供应商）。
    // 默认参考 models.dev 最常见档位（low/medium/high），可自定义为完整集或供应商支持的具体档位。
    reasoningEffortsFallback: z.array(z.string()).default(['low', 'medium', 'high']),
    // 上下文窗口感知：按请求 messages 的启发式 token 估算（与宿主 token-meter
    // 同一标尺：chars/4），跳过「肯定装不下」的候选——避免大会话每次先打小窗口
    // 候选失败一次再 failover（浪费请求+延迟，且溢出错误污染其冷却/健康档案）。
    contextAware: z.boolean().default(true),
    // 窗口可用比例：need > window × contextMargin 即跳过（留 10% 给输出/系统提示）。
    contextMargin: z.number().min(0.5).max(1).default(0.9),
    // 输出预留 token：候选未声明 maxTokens 时的固定预留（叠加在输入估算之上）。
    contextReserveTokens: z.natural().default(8192),
    // 会话负载感知（least-connections 负载均衡）：rankChainByHealth 排序时，
    // 运行中会话数越多的候选分数越低 → 排越后，新会话优先路由到空闲候选。
    // 权重控制负载 vs 健康度的权衡；设 0 禁用会话数维度（退化为纯健康度排序）。
    sessionLoadWeight: z.number().min(0).default(1),
    // 内容感知选档：当用户未手动选档时，根据请求内容自动选档：
    //   - 图片 → 跨所有档找支持图片输入的候选，选运行中会话数最少的候选所在档
    //   - 长文本 → 跨所有档找上下文窗口足够的候选，选运行中会话数最少的候选所在档
    //   - 无合适候选 → 保持默认档 tier2
    contentAwareTier: z.boolean().default(true),
    // 长文本阈值（token）：估算 token 数超过此值才触发上下文窗口选档。
    // 设 0 则任何文本都触发；默认 32768（≈128K 字符），短消息不触发选档切换。
    contentAwareTierTextThreshold: z.natural().default(32768),
    routes: z.dict(Route).default({}),
    // 手动档位持久化：sessionId -> tier1|tier2|tier3
    // 存进 settings，重启/刷新后仍记住用户手动选的档位。
    manualTiers: z.dict(z.string(), z.string()).default({}),
    // 任务属性 × 模型属性自动路由（feature: task-aware routing）。
    // 默认关闭：enabled=false 时全部新逻辑短路，路由行为与旧版完全一致。
    taskRouting: z.object({
      enabled: z.boolean().default(false),
      // 全局默认任务画像。分层：会话级 override > route.taskDefaults > 此处。
      defaults: z.object({
        importance: enumOf('normal', 'important').default('normal'),
        urgency: enumOf('not-urgent', 'urgent').default('not-urgent'),
        idempotent: z.boolean().default(true),
        complexity: enumOf('unknown', 'low', 'medium', 'high').default('unknown'),
        tokenBudget: z.natural().default(0),
      }).default({}),
      // 自动复杂度：complexity 未显式标注时按请求体量（token 估算）推断。
      autoComplexity: z.boolean().default(true),
      complexityThresholds: z.object({
        low: z.natural().default(16384),
        high: z.natural().default(65536),
      }).default({}),
      // 任务匹配排序权重（rankChainForTask）：设 0 禁用对应维度。
      weights: z.object({
        capability: z.number().min(0).default(1),
        latency: z.number().min(0).default(1),
        speed: z.number().min(0).default(0.5),
        price: z.number().min(0).default(0.5),
        importance: z.number().min(0).default(1),
      }).default({}),
    }).default({}),
    // 会话级任务画像 override：sessionId -> TaskProfile（/api/model-router/task 维护）
    taskOverrides: z.dict(z.object({
      importance: enumOf('normal', 'important').default('normal'),
      urgency: enumOf('not-urgent', 'urgent').default('not-urgent'),
      idempotent: z.boolean().default(true),
      complexity: enumOf('unknown', 'low', 'medium', 'high').default('unknown'),
      tokenBudget: z.natural().default(0),
    })).default({}),
  })
  // 当前配置快照 getter：installSection 前用 schema 默认值实例（可调用），
  // installSection 后由宿主 scope.get 接管（setSource 替换）。
  let current = Config()

  // ------------------------------------------------------------------
  // 运行时状态：冷却 + 事件历史 + 计数
  // （声明在 installSettingsSection 之前：其 onChange 首次调用会访问 manualTiers）
  // ------------------------------------------------------------------
  const cooldowns = new Map() // `provider/model` -> until timestamp
  const history = []          // {ts, type, model, tier?, purpose, from?, by?, code?}
  const stats = new Map()     // unifiedId -> {requests, failovers}
  // 候选健康度（feature: health-ranking）：key(`provider/model`) -> {ok, fail}
  // 滑动窗口计数（窗口大小 = healthWindowSize），用于择优排序与面板展示。
  const health = new Map()
  // 会话负载感知（feature: least-connections load balancing）：
  // sessionModel 记录每个会话当前使用的候选（`provider/model`），
  // runningSessions 记录当前处于 running 状态的会话集合。
  // buildSessionLoad(excludeSid) 从这两者惰性计算各候选的运行中会话计数，
  // 供 rankChainByHealth 排序——新会话优先路由到空闲候选。
  const sessionModel = new Map()   // sessionId -> cooldownKey
  const runningSessions = new Set() // sessionId 集合（agent/status='running'）
  const SESSION_MODEL_CAP = 500
  // 手动档位：sessionId -> 'tier1'|'tier2'|'tier3'（用户在下拉里显式选档，覆盖默认 purpose 规则）
  const manualTiers = new Map()
  const MANUAL_TIERS_CAP = 500
  const getManualTier = (sid) => manualTiers.get(sid)
  // 会话级任务画像 override（feature: task-aware routing）：sessionId -> TaskProfile
  // 存进 settings（taskOverrides），重启/刷新后仍记住；内存 Map 供热路径读取。
  const taskOverrides = new Map()
  const TASK_OVERRIDES_CAP = 500


  // 思考级别自动剥离（feature: auto-strip reasoning effort）：
  // 当候选配了 reasoningEffort 但模型/供应商实际不支持时，请求会失败。
  // 检测到此类错误后，路由层在插件内重试（不触发宿主层 dsh-llm-retry），
  // 同时把该候选的 cooldownKey 加入此集合——后续请求不再发送 reasoningEffort。
  // 配置变更（onChange）时清空，让用户重新配置的档位有机会被尝试。
  const effortStrippedKeys = new Set()

  // 持久化移除某候选的 reasoningEffort 配置（best-effort，非阻塞）。
  // 内存集合已保证当前进程不再发送 reasoningEffort；此函数把变更写回 settings，
  // 让配置在重启后也保持正确。失败不影响重试（内存集合已兜底）。
  async function stripReasoningEffortFromConfig(candidate) {
    const key = cooldownKey(candidate)
    effortStrippedKeys.add(key)
    const settings = ctx.settings
    if (!settings || typeof settings.update !== 'function') return
    try {
      const cfg = current()
      for (const [routeId, route] of Object.entries(cfg.routes)) {
        const normalized = normalizeRoute(route)
        for (const slot of TIER_SLOTS) {
          const chain = normalized[slot]
          if (!Array.isArray(chain)) continue
          const idx = chain.findIndex((c) => cooldownKey(c) === key)
          if (idx >= 0 && chain[idx].reasoningEffort !== undefined) {
            // 构造新数组：目标候选删除 reasoningEffort 字段，其余不变
            const newChain = chain.map((c, i) => {
              if (i !== idx) return c
              const stripped = { ...c }
              delete stripped.reasoningEffort
              return stripped
            })
            // 深合并写回：只替换该路由该档的候选数组
            await settings.update(NS, { routes: { [routeId]: { [slot]: newChain } } })
            ctx.logger.info(`dsh-model-router: 已自动移除候选 ${key} 的 reasoningEffort 配置（持久化）`)
            return
          }
        }
      }
    } catch (e) {
      ctx.logger.debug?.('dsh-model-router: strip reasoningEffort from config failed: ' + String((e && e.message) || e))
    }
  }
  installSectionCompat(ctx, NS, Config, Config(), {
    setSource(source) { current = source },
    onChange() {
      // 从持久化配置恢复手动档位到内存 Map（首次加载/配置变更时）
      try {
        const persisted = current().manualTiers ?? {}
        manualTiers.clear()
        for (const [sid, tier] of Object.entries(persisted)) {
          if (sid && TIER_SLOTS.includes(tier)) manualTiers.set(sid, tier)
        }
      } catch (e) {
        // 恢复失败不影响路由（退回自动档）
      }
      // 从持久化配置恢复会话级任务画像（首次加载/配置变更时）
      try {
        const persistedT = current().taskOverrides ?? {}
        taskOverrides.clear()
        for (const [sid, profile] of Object.entries(persistedT)) {
          if (sid && profile && typeof profile === 'object') taskOverrides.set(sid, profile)
        }
      } catch (e) {
        // 恢复失败不影响路由（退回全局/route 默认画像）
      }
      // 配置变更时清空自动剥离集合：让用户重新配置的档位有机会被尝试。
      // （自动剥离写回 settings.update 也会触发 onChange，但此时配置已不含
      // reasoningEffort，清空无副作用；若写回失败则不清空，内存集合继续兜底）
      effortStrippedKeys.clear()
      ctx.logger.info(`dsh-model-router: 配置已更新，${Object.keys(current().routes).length} 个统一模型路由`)
    },
  })

  function setManualTier(sessionId, tier) {
    if (!sessionId) return Promise.resolve()
    if (tier === 'auto' || tier === undefined || tier === null) {
      manualTiers.delete(sessionId)
      return persistManualTier(sessionId, '')
    } else {
      manualTiers.set(sessionId, tier)
      if (manualTiers.size > MANUAL_TIERS_CAP) {
        const oldest = manualTiers.keys().next().value
        if (oldest !== undefined) manualTiers.delete(oldest)
      }
      return persistManualTier(sessionId, tier)
    }
  }

  // 把一条手动档位写回 settings（持久化，跨重启记住）。
  // 用 mutate 路径级 set/unset，避免重写整个配置段。
  // tier 为空字符串 → unset（清除）；否则 set。
  async function persistManualTier(sessionId, tier) {
    const settings = ctx.settings
    if (!settings || typeof settings.mutate !== 'function') return
    try {
      await settings.mutate(NS, tier === ''
        ? [{ op: 'unset', path: ['manualTiers', sessionId] }]
        : [{ op: 'set', path: ['manualTiers', sessionId], value: tier }])
    } catch (e) {
      // 只读 provider / 冲突等：持久化失败不影响内存路由
      ctx.logger.debug?.('dsh-model-router: persist manualTier failed: ' + String((e && e.message) || e))
    }
  }

  // 会话级任务画像写入（feature: task-aware routing）。profile 为空/全空键 =
  // 清除该会话覆盖。只取 TASK_PROFILE_KEYS 内的键（schema 外的键不持久化）。
  function setTaskOverride(sessionId, profile) {
    if (!sessionId) return Promise.resolve()
    const clean = {}
    if (profile && typeof profile === 'object') {
      for (const key of TASK_PROFILE_KEYS) {
        const v = profile[key]
        if (v !== undefined && v !== null && v !== '') clean[key] = v
      }
    }
    if (Object.keys(clean).length === 0) {
      taskOverrides.delete(sessionId)
      return persistTaskOverride(sessionId, '')
    }
    taskOverrides.set(sessionId, clean)
    if (taskOverrides.size > TASK_OVERRIDES_CAP) {
      const oldest = taskOverrides.keys().next().value
      if (oldest !== undefined) taskOverrides.delete(oldest)
    }
    return persistTaskOverride(sessionId, clean)
  }

  // 把一条会话级任务画像写回 settings（持久化，跨重启记住）。
  // 用 mutate 路径级 set/unset，避免重写整个配置段。空值 = unset（清除）。
  async function persistTaskOverride(sessionId, value) {
    const settingsSvc = ctx.settings
    if (!settingsSvc || typeof settingsSvc.mutate !== 'function') return
    try {
      await settingsSvc.mutate(NS, value === ''
        ? [{ op: 'unset', path: ['taskOverrides', sessionId] }]
        : [{ op: 'set', path: ['taskOverrides', sessionId], value }])
    } catch (e) {
      // 只读 provider / 冲突等：持久化失败不影响内存路由
      ctx.logger.debug?.('dsh-model-router: persist taskOverride failed: ' + String((e && e.message) || e))
    }
  }

  // 不可信候选只读联动（feature: task-aware routing）：路由到 trust=untrusted
  // 候选前，把会话 sandbox 模式设为 read-only。宿主 sandboxPolicy 服务不存在或
  // 设置失败时返回 false —— 调用方跳过该候选（不可信模型只在只读环境工作，
  // 确保不了只读就路由不到它）。方法名按宿主版本探测（setSessionMode/setMode）。
  function ensureReadOnlyForSession(sessionId) {
    if (!sessionId) return false
    try {
      const sp = ctx.sandboxPolicy
      if (sp && typeof sp.setSessionMode === 'function') {
        sp.setSessionMode(sessionId, 'read-only')
        return true
      }
      if (sp && typeof sp.setMode === 'function') {
        sp.setMode(sessionId, 'read-only')
        return true
      }
    } catch (e) {
      ctx.logger.debug?.('dsh-model-router: 设置会话只读失败: ' + String((e && e.message) || e))
      return false
    }
    ctx.logger.warn('dsh-model-router: 路由到不可信候选但宿主 sandboxPolicy 不可用或缺少会话模式 API，已跳过该候选（无法确保只读）')
    return false
  }

  function record(entry) {
    history.push({ ts: Date.now(), ...entry })
    if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP)
  }

  function bump(modelId, field) {
    const s = stats.get(modelId) ?? { requests: 0, failovers: 0 }
    s[field] += 1
    stats.set(modelId, s)
  }

  // 分级冷却 + 指数退避：按失败类型算基础时长（限流 0.2x / 服务端 0.5x / 硬失败 1x），
  // 再乘 退避倍数^(连续失败次数)，封顶 cooldownMaxMs。
  // 记录 {until, code, status, streak}：面板「冷却中的候选」展示失败原因与退避进度。
  function markCooldown(candidate, failure) {
    const cfg = current()
    const base = cfg.cooldownMs
    if (base <= 0) return
    const key = cooldownKey(candidate)
    const rec = health.get(key)
    const streak = rec ? (rec.streak || 0) : 0
    const dur = cooldownDurationMs(failure, base, cfg.cooldownMaxMs, cfg.cooldownBackoff, streak)
    cooldowns.set(key, {
      until: Date.now() + dur,
      durationMs: dur,
      code: failure?.code ?? null,
      status: failure?.status ?? null,
      streak,
    })
  }

  // 记录候选健康度结果（滑动窗口）。每条记录带时间戳与失败信息：
  //   - buf: [{ok, ts, code?, status?}]（时间衰减评分 + 错误码加权）
  //   - streak: 连续失败次数（成功清零），供冷却指数退避
  // 窗口按 healthWindowSize 裁剪（超出即丢弃最旧，保持有界）。
  function markHealth(candidate, ok, failure) {
    const key = cooldownKey(candidate)
    const win = Math.max(3, current().healthWindowSize)
    let rec = health.get(key)
    if (!rec) { rec = { ok: 0, fail: 0, total: 0, buf: [], streak: 0 }; health.set(key, rec) }
    const ts = Date.now()
    const entry = ok
      ? { ok: true, ts }
      : { ok: false, ts, code: failure?.code ?? null, status: failure?.status ?? null }
    rec.buf.push(entry)
    if (ok) { rec.ok += 1; rec.streak = 0 } else { rec.fail += 1; rec.streak += 1 }
    rec.total += 1
    if (rec.buf.length > win) {
      const dropped = rec.buf.shift()
      if (dropped.ok) rec.ok -= 1; else rec.fail -= 1
    }
  }

  function isCoolingDown(candidate, now = Date.now()) {
    const rec = cooldowns.get(cooldownKey(candidate))
    if (rec === undefined) return false
    const until = typeof rec === 'number' ? rec : rec.until // 兼容旧数字形态
    if (until <= now) { cooldowns.delete(cooldownKey(candidate)); return false }
    return true
  }

  // ------------------------------------------------------------------
  // 会话负载感知（feature: least-connections load balancing）
  //
  // 通过 agent/status 事件跟踪会话的 running ⇄ idle 状态，通过 agent/request
  // 记录每个会话当前使用的候选模型。buildSessionLoad 惰性计算各候选的
  // 运行中会话计数（排除当前正在路由的会话自身，避免自己被自己的负载惩罚），
  // 供 rankChainByHealth 排序使用。
  // ------------------------------------------------------------------
  function recordSessionModel(sid, candidate) {
    if (!sid || !candidate) return
    const newKey = cooldownKey(candidate)
    sessionModel.set(sid, newKey)
    if (sessionModel.size > SESSION_MODEL_CAP) {
      // 淘汰最旧条目（非 running 的优先）
      for (const k of sessionModel.keys()) {
        if (!runningSessions.has(k)) { sessionModel.delete(k); break }
      }
    }
  }

  function buildSessionLoad(excludeSid) {
    const counts = new Map()
    for (const sid of runningSessions) {
      if (sid === excludeSid) continue // 排除当前会话自身的负载
      const key = sessionModel.get(sid)
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }

  // agent/status（emit 事件）：会话 running ⇄ idle 状态变更。
  // running → 加入运行集合；idle → 移出并清理会话模型记录（下次 resume 时由
  // agent/request 重新记录）。无 next()（emit 模式）。
  const disposeAgentStatus = ctx.on('agent/status', (payload) => {
    const agent = payload?.agent
    const sid = agent?.id ?? agent?.session?.id
    if (!sid) return
    if (payload.status === 'running') {
      runningSessions.add(sid)
    } else if (payload.status === 'idle') {
      runningSessions.delete(sid)
      sessionModel.delete(sid)
    }
  })
  // agent/pre-step（waterfall）：预分析本步消息内容（图片/文本长度），
  // 缓存到 session 级别供紧随其后的 agent/request 用于内容感知选档。
  // 调用 next() 透传，不修改消息。
  const disposePreStep = ctx.on('agent/pre-step', (payload, next) => {
    try {
      const sid = payload?.agent?.session?.id ?? payload?.agent?.id
      if (sid) cacheContentAnalysis(sid, payload?.messages)
    } catch { /* 分析失败不影响 pre-step 流转 */ }
    return next()
  })

  // ------------------------------------------------------------------
  // 上下文窗口解析（context-aware filtering）：候选显式 contextWindow →
  // 宿主模型目录（resolveModelInfo，结果缓存，目录极少变）→ 256K 保守兜底。
  // ------------------------------------------------------------------
  const CONTEXT_WINDOW_FALLBACK = 262144
  const contextWindowCache = new Map() // `provider/model` -> number
  async function resolveContextWindow(candidate) {
    if (typeof candidate.contextWindow === 'number' && candidate.contextWindow > 0) {
      return candidate.contextWindow
    }
    const key = cooldownKey(candidate)
    const hit = contextWindowCache.get(key)
    if (hit !== undefined) return hit
    let win = CONTEXT_WINDOW_FALLBACK
    try {
      const info = await ctx.llm.resolveModelInfo(candidate.provider, candidate.model)
      const cw = info && (info.contextWindow ?? info.context?.contextWindow)
      if (typeof cw === 'number' && cw > 0) win = cw
    } catch { /* 目录无此模型 → 用兜底窗口 */ }
    contextWindowCache.set(key, win)
    return win
  }
  async function contextWindowsFor(chain) {
    const out = new Map()
    await Promise.all(chain.map(async (c) => { out.set(cooldownKey(c), await resolveContextWindow(c)) }))
    return out
  }

  // ------------------------------------------------------------------
  // 图片输入支持解析（content-aware tier selection）
  //
  // 与 contextWindowCache 同源：从 resolveModelInfo 的 inputModalities 解析。
  // inputModalities 含 'image' → 支持图片输入；缺省/未知 → 保守认为不支持。
  // ------------------------------------------------------------------
  const imageSupportCache = new Map() // `provider/model` -> boolean
  async function resolveImageSupport(candidate) {
    const key = cooldownKey(candidate)
    const hit = imageSupportCache.get(key)
    if (hit !== undefined) return hit
    let supported = false
    try {
      const info = await ctx.llm.resolveModelInfo(candidate.provider, candidate.model)
      const modalities = info && info.inputModalities
      if (Array.isArray(modalities)) {
        supported = modalities.includes('image')
      }
    } catch { /* 目录无此模型 → 保守不支持 */ }
    imageSupportCache.set(key, supported)
    return supported
  }
  async function imageSupportFor(chain) {
    const out = new Map()
    await Promise.all(chain.map(async (c) => { out.set(cooldownKey(c), await resolveImageSupport(c)) }))
    return out
  }

  // ------------------------------------------------------------------
  // 内容分析缓存（供 agent/request 在无 messages 时使用）
  //
  // agent/pre-step 先于 agent/request 触发，携带本步消息。这里在 pre-step
  // 预分析内容（是否含图片、估算 token 数），缓存到 session 级别，供紧随其后的
  // agent/request 用于内容感知选档。llm/stream 有完整 options.messages，
  // 直接现场分析，不依赖缓存。
  // ------------------------------------------------------------------
  const contentAnalysisCache = new Map() // sid -> { hasImages, neededTokens, ts }
  const CONTENT_CACHE_CAP = 500
  function cacheContentAnalysis(sid, messages) {
    if (!sid || !Array.isArray(messages)) return
    const opts = { messages }
    contentAnalysisCache.set(sid, {
      hasImages: hasImageContent(opts),
      neededTokens: estimateRequestTokens(opts),
      ts: Date.now(),
    })
    if (contentAnalysisCache.size > CONTENT_CACHE_CAP) {
      const oldest = contentAnalysisCache.keys().next().value
      if (oldest !== undefined) contentAnalysisCache.delete(oldest)
    }
  }
  function getContentAnalysis(sid) {
    return sid ? contentAnalysisCache.get(sid) : undefined
  }

  // 内容感知选档：根据内容（图片/长文本）在所有档中找到运行中会话数最少的
  // 合适候选所在档。返回 tier1/tier2/tier3 或 null（无合适）。仅在无手动档时调用。
  async function recommendTierForContent(route, options, sid, cfg) {
    if (!cfg.contentAwareTier) return null
    const hasImages = hasImageContent(options)
    const neededTokens = cfg.contextAware ? estimateRequestTokens(options) : 0
    const isLongText = neededTokens > (cfg.contentAwareTierTextThreshold ?? 0)
    if (!hasImages && !isLongText) return null

    // 收集所有档的所有候选（去重）
    const allCandidates = []
    const seen = new Set()
    for (const slot of TIER_SLOTS) {
      const chain = route[slot]
      if (!Array.isArray(chain)) continue
      for (const c of chain) {
        const key = cooldownKey(c)
        if (!seen.has(key)) { seen.add(key); allCandidates.push(c) }
      }
    }
    if (allCandidates.length === 0) return null

    // 批量解析上下文窗口 + 图片支持
    const [windows, imageSupport] = await Promise.all([
      contextWindowsFor(allCandidates),
      imageSupportFor(allCandidates),
    ])

    const sessionLoad = buildSessionLoad(sid)
    const tier = recommendTierByContent(
      route,
      hasImages,
      isLongText ? neededTokens : 0,
      (c) => windows.get(cooldownKey(c)) ?? null,
      (c) => imageSupport.get(cooldownKey(c)) ?? false,
      sessionLoad,
      { margin: cfg.contextMargin, reserveTokens: cfg.contextReserveTokens }
    )
    return tier
  }

  // 内容感知选档缓存：agent/request 选出的内容感知档位（per-session），
  // 供同步的 llm/stream 使用（llm/stream 无法做异步 resolveModelInfo）。
  // agent/request 先于 llm/stream 触发，缓存对当前步有效。
  const contentAwareTierCache = new Map() // sid -> tier
  const CONTENT_TIER_CACHE_CAP = 500


  // 从预分析结果选档（供 agent/request 使用：它没有 messages，
  // 但有 agent/pre-step 缓存的内容分析结果）。
  async function recommendTierFromAnalysis(route, hasImages, needTokens, sid, cfg) {
    if (!cfg.contentAwareTier) return null
    if (!hasImages && needTokens <= 0) return null

    const allCandidates = []
    const seen = new Set()
    for (const slot of TIER_SLOTS) {
      const chain = route[slot]
      if (!Array.isArray(chain)) continue
      for (const c of chain) {
        const key = cooldownKey(c)
        if (!seen.has(key)) { seen.add(key); allCandidates.push(c) }
      }
    }
    if (allCandidates.length === 0) return null

    const [windows, imageSupport] = await Promise.all([
      contextWindowsFor(allCandidates),
      imageSupportFor(allCandidates),
    ])

    const sessionLoad = buildSessionLoad(sid)
    return recommendTierByContent(
      route,
      hasImages,
      needTokens,
      (c) => windows.get(cooldownKey(c)) ?? null,
      (c) => imageSupport.get(cooldownKey(c)) ?? false,
      sessionLoad,
      { margin: cfg.contextMargin, reserveTokens: cfg.contextReserveTokens }
    )
  }
  // ------------------------------------------------------------------
  // 故障转移路由 generator
  // ------------------------------------------------------------------
  // 故障转移路由 generator
  // ------------------------------------------------------------------
  // 单个候选的尝试函数：初始请求 + 瞬时错误重试（最多 maxRetriesPerCandidate 次）。
  // 返回：
  //   'served'  —— 成功，且已把 chunk 全部 yield 给调用方（透传完成）
  //   'retried' —— 瞬时错误重试后成功（chunk 已透传）
  // 失败时：
  //   非瞬时错误 / 重试耗尽 → 抛回 failure（由 routeThrough 统一记冷却+切换）
  //   已输出内容后失败 → 抛回（不重试不切换）
  // 注：generator 内无法把「已透传部分 chunk 后又失败」回滚，所以这里用闭包捕获
  // 失败，成功时把流透传给外层。为保持简单，成功路径由外层 for-await 透传，
  // 本函数只负责「发起 + 判失败/重试」，不 yield——由 routeThrough 统一透传。
  //
  // 更直接的实现：本函数返回一个「消费器」，外层 while 循环处理透传。
  // 为最小化复杂度，我们把「单次尝试」也内联在 routeThrough 里，但用清晰标志。
  // 见下方 routeThrough 实现。

  async function* routeThrough(chain, options, cfg) {
    let lastFailure = null
    let switches = 0
    const tier = options.__mrTier
    const profile = options.__mrProfile ?? null // 任务画像（feature: task-aware routing）

    // 整链各候选的失败（all-failed 时选代表错误上报，见 pickRepresentativeFailure：
    // 优先报不可重试的持久性错误，避免误导宿主层 dsh-llm-retry 整链盲目重试）
    const allFailures = []

    // 上下文窗口感知：先按请求体量过滤掉「肯定装不下」的候选（如 465K 会话
    // 打 256K 窗口的 k3-256k）。跳过不算失败、不进冷却——它对小请求仍健康。
    // 全被过滤时回退用原链继续 failover（估算失准宁可浪费一次 failover，
    // 也不能把可能可用的候选误杀）。
    let effectiveChain = chain
    if (cfg.contextAware && chain.length > 1) {
      try {
        const needed = estimateRequestTokens(options)
        if (needed > 0) {
          const windows = await contextWindowsFor(chain)
          const { chain: filtered, skipped } = filterChainByContext(chain, needed,
            (c) => windows.get(cooldownKey(c)) ?? null,
            { margin: cfg.contextMargin, reserveTokens: cfg.contextReserveTokens })
          if (skipped.length > 0) {
            ctx.logger.info(
              `dsh-model-router: 上下文过滤 请求约 ${needed} tok，` +
              `跳过装不下的候选：${skipped.map((s) => `${cooldownKey(s.candidate)}(窗口${s.window})`).join('、')}`
            )
            for (const s of skipped) {
              record({ type: 'skipped-context', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, try: cooldownKey(s.candidate), code: 'CONTEXT_OVERFLOW' })
            }
          }
          if (filtered.length > 0) effectiveChain = filtered
        }
      } catch (e) {
        ctx.logger.debug?.('dsh-model-router: 上下文过滤失败（回退原链）: ' + String((e && e.message) || e))
      }
    }

    for (const candidate of effectiveChain) {
      if (isCoolingDown(candidate)) continue

      record({
        type: 'started', model: options.model, tier,
        purpose: options.purpose ?? 'main',
        sessionId: options.sessionId ?? null,
        try: cooldownKey(candidate),
        effort: candidate.reasoningEffort ?? null,
      })

      const maxAttempts = shouldRetryForTask(profile, cfg.retryOnThrottle) ? (1 + (cfg.maxRetriesPerCandidate || 0)) : 1
      let attempt = 0
      let sawContent = false
      let candidateFailed = false
      let effortStripped = effortStrippedKeys.has(cooldownKey(candidate))

      // 单候选尝试循环：attempt=0 初始，瞬时错误未达上限则重试
      while (attempt < maxAttempts && !candidateFailed) {
        sawContent = false
        let attemptFailed = false
        let attemptFailure = null
        let normalEnd = false // 流正常结束（finish 非失败分支已透传 return，不会到这）
        let effortUnsupported = false // 思考级别不支持 → 剥离后重试（不触发宿主重试）
        try {
          const callOpts = {
            ...options,
            [RESOLVED]: true,
            provider: candidate.provider,
            model: candidate.model,
          }
          // 思考级别仅在候选已配置且未被自动剥离时发送
          if (candidate.reasoningEffort !== undefined && !effortStripped) {
            callOpts.reasoningEffort = candidate.reasoningEffort
          } else {
            delete callOpts.reasoningEffort // 确保被剥离的不从 options 泄漏
          }
          const stream = ctx.llm.stream(withSanitizedReplayState(callOpts, candidate.provider, candidate.model))
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
              sawContent = true
            }
            if (chunk.type === 'finish') {
              const reason = chunk.reason
              const failed = reason.kind === 'error' || reason.kind === 'aborted'
              // 思考级别不支持 → 剥离 reasoningEffort 后在插件内重试（不触发宿主层重试）
              if (failed && !sawContent && reason.failure && isReasoningEffortUnsupported(reason.failure) && !effortStripped) {
                effortUnsupported = true
                effortStripped = true
                effortStrippedKeys.add(cooldownKey(candidate))
                stripReasoningEffortFromConfig(candidate)
                ctx.logger.warn(
                  `dsh-model-router: ${tier} 候选 ${cooldownKey(candidate)} 不支持思考级别 ${candidate.reasoningEffort}，` +
                  `已自动剥离 reasoningEffort 并在插件内重试`
                )
                record({ type: 'effort-stripped', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, try: cooldownKey(candidate), effort: candidate.reasoningEffort ?? null })
                break // 跳出 for-await，不 yield finish → 不触发宿主层重试
              }
              if (failed && !sawContent && reason.failure && isRetryableFailure(reason.failure)) {
                attemptFailed = true
                attemptFailure = reason.failure
                break // 跳出 for-await
              }
              // 正常终态（或已输出后失败/不可转移失败）→ 透传
              if (!candidateFailed) {
                markHealth(candidate, true)
                record({ type: 'served', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, by: cooldownKey(candidate), effort: effortStripped ? null : (candidate.reasoningEffort ?? null) })
              }
              yield chunk
              return
            }
            yield chunk
          }
          // for-await 自然结束：仅当本次尝试未被判失败（finish 失败 break 会跳过）
          // 且未抛错 → 视为成功透传（罕见：流无 finish 直接结束）
          if (!attemptFailed && !effortUnsupported) normalEnd = true
        } catch (error) {
          if (!sawContent) {
            // 思考级别不支持 → 剥离 reasoningEffort 后在插件内重试
            if (isReasoningEffortUnsupported(error) && !effortStripped) {
              effortUnsupported = true
              effortStripped = true
              effortStrippedKeys.add(cooldownKey(candidate))
              stripReasoningEffortFromConfig(candidate)
              ctx.logger.warn(
                `dsh-model-router: ${tier} 候选 ${cooldownKey(candidate)} 不支持思考级别 ${candidate.reasoningEffort}，` +
                `已自动剥离 reasoningEffort 并在插件内重试`
              )
              record({ type: 'effort-stripped', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, try: cooldownKey(candidate), effort: candidate.reasoningEffort ?? null })
            } else {
              attemptFailed = true
              const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN'
              attemptFailure = { message: String((error && error.message) || error), code, ...(error && typeof error.status === 'number' ? { status: error.status } : {}) }
            }
          } else {
            throw error // 已输出内容后抛错 → 透传上层
          }
        }

        // 思考级别已剥离 → 跳过成功/失败判定，直接进下次尝试（不增加 attempt 计数）
        if (effortUnsupported) continue

        if (normalEnd && !attemptFailed) {
          // 流自然结束（无 finish 错误）→ 成功（内容已 yield 给调用方）。
          // 补记 served 事件 + 健康度成功，避免 OverlayStatus 卡在「请求中」
          // 高亮、健康度漏记成功。
          markHealth(candidate, true)
          record({ type: 'served', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, by: cooldownKey(candidate), effort: effortStripped ? null : (candidate.reasoningEffort ?? null) })
          return
        }

        // ---- 本次尝试失败，决策：重试 or 切换 ----
        if (attemptFailed) {
          lastFailure = attemptFailure
          const transient = isTransientFailure(attemptFailure)
          const canRetry = transient && attempt + 1 < maxAttempts
          if (canRetry) {
            const wait = cfg.retryBackoffMs * (attempt + 1)
            ctx.logger.warn(
              `dsh-model-router: ${tier} 候选 ${cooldownKey(candidate)} 首 token 前失败` +
              `（${attemptFailure.code}${attemptFailure.status ? ` HTTP ${attemptFailure.status}` : ''}），` +
              `瞬时错误，${wait}ms 后重试（第 ${attempt + 1}/${maxAttempts} 次）`
            )
            await new Promise((r) => setTimeout(r, wait))
            attempt++
            continue // 进下次尝试
          }
          // 非瞬时错误 或 重试耗尽 → 判失败，切换候选
          candidateFailed = true
          switches++
          allFailures.push(attemptFailure)
          markCooldown(candidate, attemptFailure)
          markHealth(candidate, false, attemptFailure)
          bump(options.model, 'failovers')
          record({
            type: 'failover', model: options.model, tier,
            purpose: options.purpose ?? 'main',
            sessionId: options.sessionId ?? null,
            from: cooldownKey(candidate), code: attemptFailure.code,
            status: attemptFailure.status ?? null,
          })
          ctx.logger.warn(
            `dsh-model-router: ${tier} 候选 ${cooldownKey(candidate)} 首 token 前失败` +
            `（${attemptFailure.code}${attemptFailure.status ? ` HTTP ${attemptFailure.status}` : ''}` +
            `${transient ? `，重试 ${maxAttempts} 次仍失败` : ''}），切换下一候选（第 ${switches} 次）`
          )
        }
      }

      // 尝试循环结束：若候选成功 → 已在成功分支 return；到这里 = 失败需切换
      // 尝试循环结束：若候选成功 → 已在成功分支 return；到这里 = 失败需切换。
      // 非幂等任务（idempotent=false）禁重试禁切换：一次尝试失败即全失败，
      // 防止重试/切换造成重复副作用。
      const idempotentBlocked = profile && profile.idempotent === false
      if (candidateFailed && (switches >= cfg.maxSwitchesPerStep || idempotentBlocked)) break
      if (!candidateFailed) return // 理论不可达（成功分支 return 了），保险
    }

    // all-failed：上报「代表失败」而不是最后一个失败。若链上存在不可重试的
    // 持久性错误（AUTH/INVALID_CREDENTIAL/UNKNOWN_MODEL 等），优先报它——
    // 宿主层 dsh-llm-retry 看到这些码不会整链重试（凭据/套餐/配置问题不会
    // 自愈，重试只是浪费 5 次等待）。全部都是瞬时错误时才报瞬时码。
    const repFailure = pickRepresentativeFailure(allFailures) ?? lastFailure
    record({ type: 'all-failed', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, code: repFailure?.code ?? 'NO_CANDIDATE' })
    if (profile && profile.idempotent === false) {
      record({ type: 'no-retry-idempotent', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, code: repFailure?.code ?? 'NO_CANDIDATE' })
    }
    ctx.logger.error(
      `dsh-model-router: 统一模型 ${options.model}（${tier}）所有候选失败` +
      `（${allFailures.map((f) => `${f?.code ?? 'UNKNOWN'}${f?.status ? `#${f.status}` : ''}`).join(' / ') || 'NO_CANDIDATE'}）`
    )
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: repFailure ?? { message: `dsh-model-router: ${options.model} 无可用候选`, code: 'NO_ADAPTER' } },
    }
  }

  // ------------------------------------------------------------------
  // llm/stream waterfall 拦截
  // ------------------------------------------------------------------
  const dispose = ctx.on('llm/stream', (options, next) => {
    if (options[RESOLVED]) return next()
    const cfg = current()
    if (!cfg.enabled) return next()

    const raw = cfg.routes[options.model] || findByCandidate(cfg.routes, options.model)
    if (!raw) return next()

    const route = normalizeRoute(raw)
    let tierSlot = selectTierCore(options, route, getManualTier)
    // 内容感知选档：无手动档且默认选了 tier2 时，用 agent/request 缓存的内容感知档。
    // llm/stream 是同步钩子，无法做异步 resolveModelInfo，故复用 agent/request 的结果。
    if (tierSlot === 'tier2' && cfg.contentAwareTier && !getManualTier(options.sessionId)) {
      const cachedTier = contentAwareTierCache.get(options.sessionId)
      if (cachedTier && route[cachedTier] && route[cachedTier].length > 0) {
        tierSlot = cachedTier
      }
    }
    const picked = pickChainCore(route, tierSlot)
    if (!picked) return next()

    // 健康度 + 会话负载择优：开启时按滑动窗口内成功/失败 + 运行中会话数重排候选链，
    // 稳定成功候选提前、频繁失败候选后移、空闲候选（运行中会话少）优先。
    // 排除当前会话自身的负载，避免自己被自己的负载惩罚。关闭时保持纯配置顺序。
    const sessionLoad = buildSessionLoad(options.sessionId)
    let chain = cfg.healthRanking ? rankChainByHealth(picked.chain, health, sessionLoad, cfg.sessionLoadWeight) : picked.chain

    // ---- 任务属性 × 模型属性自动路由（feature: task-aware routing）----
    // 默认关闭（taskRouting.enabled=false）时整块短路，路由行为与旧版一致。
    let taskProfile = null
    const tr = cfg.taskRouting
    if (tr && tr.enabled) {
      try {
        const needed = estimateRequestTokens(options)
        taskProfile = resolveTaskProfile({
          session: options.sessionId ? taskOverrides.get(options.sessionId) : undefined,
          route: route.taskDefaults || {},
          global: tr.defaults || {},
          autoComplexity: tr.autoComplexity !== false,
          neededTokens: needed,
          thresholds: tr.complexityThresholds || {},
        })
        // token 预算硬过滤：超预算候选跳过（全被过滤 → 回退原链，估算失准不误杀）
        if (taskProfile.tokenBudget > 0) {
          const { chain: kept, skipped } = filterChainByBudget(chain, needed, null, taskProfile.tokenBudget)
          if (skipped.length > 0) {
            for (const s of skipped) {
              record({ type: 'skipped-budget', model: options.model, tier: picked.slot, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, try: cooldownKey(s.candidate), price: s.price, cost: s.cost, budget: s.budget })
            }
          }
          if (kept.length > 0) chain = kept
        }
        // 不可信候选 → 会话只读；确保不了只读的跳过（不可信模型只在只读环境工作）
        const trusted = []
        for (const c of chain) {
          if (c.trust === 'untrusted' && !ensureReadOnlyForSession(options.sessionId)) {
            record({ type: 'untrusted-readonly', model: options.model, tier: picked.slot, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, try: cooldownKey(c) })
            continue
          }
          trusted.push(c)
        }
        if (trusted.length > 0) chain = trusted
        // 任务匹配排序（在健康度排序之后，任务维度优先）
        if (chain.length > 1) chain = rankChainForTask(chain, taskProfile, tr.weights || {}, null)
        record({ type: 'task-routed', model: options.model, tier: picked.slot, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, profile: taskProfile, chain: chain.map(cooldownKey) })
      } catch (e) {
        ctx.logger.debug?.('dsh-model-router: 任务路由失败（回退原链）: ' + String((e && e.message) || e))
      }
    }


    const available = chain.filter((c) => !isCoolingDown(c))
    if (available.length === 0) {
      // 关键判断：原始请求目标（options.provider/model）是否就是链上冷却中的
      // 某个候选——若是，放行原路径 = 直连「刚刚失败的坏候选」（如 k3 401 后
      // 冷却中），必然再次失败。此时必须【不放行】，直接 all-failed：
      // 否则宿主层 dsh-llm-retry 每轮重试都 passthrough 打到坏候选 → 死循环。
      const origKey = options.provider && options.model ? `${options.provider}/${options.model}` : null
      const coolingKeys = new Set(chain.filter((c) => isCoolingDown(c)).map((c) => cooldownKey(c)))
      const directHitsCoolingCandidate = origKey !== null && coolingKeys.has(origKey)

      if (!directHitsCoolingCandidate) {
        record({ type: 'passthrough', model: options.model, tier: picked.slot, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null })
        ctx.logger.warn(`dsh-model-router: ${options.model}（${picked.slot}）候选全部冷却中，放行原路径（原目标不在链上）`)
        // 放行原路径也要清洗历史 replayState：next() 无法携带改动后的 options
        // （waterfall 的 next 用原始参数调用下一段），若历史里已有跨 provider 的
        // 坏消息，必须先剥掉再走 RESOLVED 重入；无需清洗时保持 next() 原路径。
        const sanitized = withSanitizedReplayState(options, options.provider, options.model)
        if (sanitized === options) return next()
        return ctx.llm.stream({ ...sanitized, [RESOLVED]: true })
      }

      // 原目标就是冷却中的坏候选：直接 all-failed，不 passthrough。
      // 从冷却记录取链上失败（markCooldown 存了 {code,status}），选代表错误。
      const coolingFailures = []
      for (const c of chain) {
        const rec = cooldowns.get(cooldownKey(c))
        if (rec && typeof rec === 'object' && rec.code) {
          coolingFailures.push({ code: rec.code, status: rec.status ?? null, message: `candidate ${cooldownKey(c)} in cooldown` })
        }
      }
      const repFailure = pickRepresentativeFailure(coolingFailures) ?? { message: `dsh-model-router: ${options.model} 候选全部冷却中`, code: 'NO_CANDIDATE' }
      record({ type: 'all-failed', model: options.model, tier: picked.slot, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, code: repFailure.code })
      ctx.logger.error(
        `dsh-model-router: ${options.model}（${picked.slot}）候选全部冷却且原目标 ${origKey} 就是冷却中的坏候选，` +
        `不放行（避免宿主层重试死循环），直接 all-failed（${repFailure.code}）`
      )
      return (async function* () {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: repFailure },
        }
      })()
    }

    bump(options.model, 'requests')
    ctx.logger.info(
      `dsh-model-router: 路由 ${options.model} → ${picked.slot} (purpose=${options.purpose ?? 'main'}${options.tier !== undefined ? `, tier=${options.tier}` : ''}${cfg.healthRanking ? ', 健康排序' : ''}) → ` +
      `[${chain.map(cooldownKey).join(' → ')}]`
    )
    return routeThrough(chain, { ...options, __mrTier: picked.slot, __mrProfile: taskProfile }, cfg)
  })

  // ------------------------------------------------------------------
  // agent/request waterfall：把会话「信封模型」解析为当前档位实际首发候选。
  //
  // 背景：宿主把 agent/request 返回的 config 记进 request/header（轨迹面板 /
  // 原生模型显示的数据源），这发生在 llm/stream 中间件改写【之前】--
  // 会话默认模型是路由候选（如 kimi-coding/k3-256k）时，轨迹显示的是
  // 「配置模型」而非实际服务模型（NPC 档 deepseek-v4-flash），严重误导。
  //
  // 在 agent/request 层把统一名/候选名改写为「当前生效档位的首个可用候选」
  //（冷却过滤 + 健康排序后的第一位，与 llm/stream 的实际首发一致）：
  //   - 信封/轨迹/原生选择器显示 = 实际首发候选 ✓
  //   - prepareCall 用真实模型解析 -> request/context 的 contextWindow 正确 ✓
  //     （统一名如「穷鬼套餐」也由此获得正确的窗口跟踪，compaction 时机更准）
  //   - llm/stream 仍负责完整 failover 机制（改写后的候选同样命中路由，
  //     走同一选档逻辑，二者天然一致，无双路由冲突）
  // agent/request 只在 agent 主循环触发（compaction/session-title 等轻量
  // 请求绕过它），purpose 恒为 main -- 轻量请求的档位逻辑不受影响。
  const disposeAgentRequest = ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try {
      if (!config || !config.model) return config
      const cfg = current()
      if (!cfg.enabled) return config
      const raw = cfg.routes[config.model] || findByCandidate(cfg.routes, config.model)
      if (!raw) return config
      const route = normalizeRoute(raw)
      const sid = payload?.agent?.session?.id
      const manualTier = sid ? getManualTier(sid) : undefined
      let tierSlot = selectTierCore({ sessionId: sid, purpose: 'main' }, route, getManualTier)
      // 内容感知选档：无手动档时，根据内容（图片/长文本）自动选档。
      // agent/request 无 messages，用 agent/pre-step 预分析的缓存。
      if (!manualTier && cfg.contentAwareTier) {
        try {
          const analysis = getContentAnalysis(sid)
          if (analysis) {
            const isLongText = analysis.neededTokens > (cfg.contentAwareTierTextThreshold ?? 0)
            if (analysis.hasImages || isLongText) {
              const recommended = await recommendTierFromAnalysis(
                route, analysis.hasImages, isLongText ? analysis.neededTokens : 0, sid, cfg
              )
              if (recommended) {
                tierSlot = recommended
                ctx.logger.info(
                  `dsh-model-router: 内容感知选档 → ${recommended}` +
                  `（${analysis.hasImages ? '图片' : ''}${analysis.hasImages && isLongText ? '+' : ''}${isLongText ? `长文本~${analysis.neededTokens}tok` : ''}，会话 ${sid ?? '未知'}）`
                )
              }
            }
          }
        } catch { /* 内容感知选档失败 → 保持默认档 */ }
      }
      // 缓存内容感知选档结果供同步的 llm/stream 使用
      if (sid) {
        if (tierSlot !== 'tier2' && !manualTier) {
          contentAwareTierCache.set(sid, tierSlot)
          if (contentAwareTierCache.size > CONTENT_TIER_CACHE_CAP) {
            const oldest = contentAwareTierCache.keys().next().value
            if (oldest !== undefined) contentAwareTierCache.delete(oldest)
          }
        } else {
          contentAwareTierCache.delete(sid)
        }
      }
      const picked = pickChainCore(route, tierSlot)
      if (!picked) return config
      const sessionLoad = buildSessionLoad(sid)
      let chain = cfg.healthRanking ? rankChainByHealth(picked.chain, health, sessionLoad, cfg.sessionLoadWeight) : picked.chain
      // 任务路由（与 llm/stream 同规则，保证信封/轨迹显示与实际服务候选一致）
      const tr = cfg.taskRouting
      if (tr && tr.enabled) {
        try {
          const analysis = getContentAnalysis(sid)
          const needed = analysis?.neededTokens ?? 0
          const taskProfile = resolveTaskProfile({
            session: sid ? taskOverrides.get(sid) : undefined,
            route: route.taskDefaults || {},
            global: tr.defaults || {},
            autoComplexity: tr.autoComplexity !== false,
            neededTokens: needed,
            thresholds: tr.complexityThresholds || {},
          })
          if (taskProfile.tokenBudget > 0) {
            const { chain: kept } = filterChainByBudget(chain, needed, null, taskProfile.tokenBudget)
            if (kept.length > 0) chain = kept
          }
          const trusted = []
          for (const c of chain) {
            if (c.trust === 'untrusted' && !ensureReadOnlyForSession(sid)) continue
            trusted.push(c)
          }
          if (trusted.length > 0) chain = trusted
          if (chain.length > 1) chain = rankChainForTask(chain, taskProfile, tr.weights || {}, null)
        } catch (e) {
          ctx.logger.debug?.('dsh-model-router: agent/request 任务路由失败（保持原链）: ' + String((e && e.message) || e))
        }
      }
      const first = chain.find((c) => !isCoolingDown(c))
      if (!first) return config // 全冷却：不改写，交给 llm/stream 的全冷却判定
      // 记录该会话当前使用的候选模型（供 least-connections 负载均衡统计）
      recordSessionModel(sid, first)
      if (first.provider === config.provider && first.model === config.model) return config
      ctx.logger.debug?.(
        `dsh-model-router: 信封解析 ${config.provider ?? ''}/${config.model} -> ${cooldownKey(first)}（${picked.slot}，会话 ${sid ?? '未知'}）`
      )
      const out = { ...config, provider: first.provider, model: first.model }
      // 候选声明的思考级别优先（与 llm/stream 的 routeThrough 语义一致）；
      // 候选未声明时保留会话原有配置。
      if (first.reasoningEffort !== undefined && !effortStrippedKeys.has(cooldownKey(first))) out.reasoningEffort = first.reasoningEffort
      return out
    } catch (e) {
      ctx.logger.debug?.('dsh-model-router: agent/request 信封解析失败（保持原配置）: ' + String((e && e.message) || e))
      return config
    }
  })

  // ------------------------------------------------------------------
  // 面板 API
  // ------------------------------------------------------------------
  async function buildCatalog() {
    const providers = ctx.llm.listProviders().map((p) => p.id)
    const catalog = {}
    await Promise.all(providers.map(async (pid) => {
      try {
        const models = await ctx.llm.listModels(pid)
        catalog[pid] = models.map((m) => m.id).sort()
      } catch {
        catalog[pid] = []
      }
    }))
    return catalog
  }

  // 单个候选可用的思考级别档位（目录标注 verified=true；未标注则用兜底档位
  // 逐个实际请求预检，只保留宿主真正接受的，verified=false）。null = 不可用/未知。
  async function resolveEffortsFor(provider, model, fallback) {
    let list = null
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      const reasoning = info && info.reasoning
      if (reasoning && Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0) {
        list = reasoning.efforts.map((e) => ({ id: e.id, name: e.name, verified: true }))
      }
    } catch {
      list = null
    }
    if (list === null && Array.isArray(fallback) && fallback.length > 0) {
      list = []
      const results = await Promise.all(fallback.map(async (id) => {
        try {
          await ctx.llm.resolveCallConfig({ provider, model, reasoningEffort: id })
          return { ok: true, id }
        } catch {
          return { ok: false, id }
        }
      }))
      for (const r of results) if (r.ok) list.push({ id: r.id, name: r.id, verified: false })
    }
    // 合并用户显式配置的档位：宿主认可 ∪ 用户配置。用户配置的档位即使被宿主
    // resolveModelInfo 裁剪（如 anthropic 只认 off/low/medium/high），也保留在下拉。
    const configured = configuredEffortsFor(provider, model)
    if (configured && configured.length > 0) {
      const seen = new Set((list || []).map((e) => e.id))
      const merged = (list || []).slice()
      for (const e of configured) {
        if (!seen.has(e.id)) {
          merged.push({ id: e.id, name: e.name, verified: true })
          seen.add(e.id)
        }
      }
      list = merged
    }
    return list
  }

  // 仅对当前配置引用的候选模型解析思考级别（有界、快速）
  async function buildEfforts(routes) {
    const efforts = {}
    const seen = new Set()
    const fallback = current().reasoningEffortsFallback || ['low', 'medium', 'high']
    for (const route of Object.values(routes)) {
      for (const slot of TIER_SLOTS) {
        for (const c of route[slot] || []) {
          const key = `${c.provider}/${c.model}`
          if (seen.has(key)) continue
          seen.add(key)
          const list = await resolveEffortsFor(c.provider, c.model, fallback)
          if (list !== null && list.length > 0) efforts[key] = list
        }
      }
    }
    return efforts
  }

  // 校验并规范化一份提交的 section；返回 {section} 或抛错
  async function validateSection(input) {
    if (input === null || typeof input !== 'object') throw new Error('body 必须是对象')
    const section = Config(input) // schema 规范化+默认值；非法直接抛
    // 面板保存的 body 不携带 manualTiers（会话手动档位由 /api/model-router/tier
    // 的 mutate 路径维护）。Config 对缺失字段填 default({})，若不兜底，
    // settings.replace 整段替换会把用户手动选的档位清空——表现为
    // 「明明选了夯(tier3)，改一次面板配置后自动变回 NPC(tier2 默认档)」。
    // 这里在 body 未显式提供 manualTiers 时保留现有持久化值。
    if (input.manualTiers === undefined) {
      section.manualTiers = current().manualTiers ?? {}
    }
    // taskOverrides 同理：会话级任务画像由 /api/model-router/task 的 mutate 路径
    // 维护，面板保存 body 不携带它；缺失时保留现有持久化值，避免整段替换清空。
    if (input.taskOverrides === undefined) {
      section.taskOverrides = current().taskOverrides ?? {}
    }
    // reasoningEffortsFallback 同理：面板目前没有编辑入口，若 body 未携带，
    // 保留现有持久化值（否则 settings.replace 会把用户自定义的兜底档位集
    // 重置回默认 ['low','medium','high']）。
    if (input.reasoningEffortsFallback === undefined) {
      const existing = current().reasoningEffortsFallback
      if (Array.isArray(existing)) section.reasoningEffortsFallback = existing
    }
    // 各套餐的档位名称校验：key 只能是 tier1/tier2/tier3，值为非空字符串
    for (const [routeId, route] of Object.entries(section.routes)) {
      if (route.tierNames) {
        for (const [k, v] of Object.entries(route.tierNames)) {
          if (!TIER_SLOTS.includes(k)) throw new Error(`套餐 ${routeId} 档位名称的 key "${k}" 非法，只能是 tier1/tier2/tier3`)
          if (typeof v !== 'string' || v.trim() === '') throw new Error(`套餐 ${routeId} 档位 ${k} 的名称不能为空`)
        }
      }
    }
    const catalog = await buildCatalog()
    for (const [id, route] of Object.entries(section.routes)) {
      for (const slot of TIER_SLOTS) {
        for (const c of route[slot]) {
          if (!(catalog[c.provider] ?? []).includes(c.model)) {
            throw new Error(`路由 ${id} 的 ${slot} 候选 ${c.provider}/${c.model} 不存在于当前模型目录`)
          }
          if (c.reasoningEffort !== undefined) {
            // 实际请求预检：resolveCallConfig 会对该 provider/model 的显式 effort
            // 做 capability 校验（宿主在 provider I/O 之前拒绝不支持的 effort，
            // 抛 UNSUPPORTED_REASONING_EFFORT）。通过才允许保存，失败在保存时即报错。
            try {
              await ctx.llm.resolveCallConfig({
                provider: c.provider,
                model: c.model,
                reasoningEffort: c.reasoningEffort,
              })
            } catch (e) {
              const code = e && typeof e.code === 'string' ? e.code : ''
              if (code === 'UNSUPPORTED_REASONING_EFFORT') {
                throw new Error(`路由 ${id} 的 ${slot} 候选 ${c.provider}/${c.model} 不支持思考级别 ${c.reasoningEffort}（已用实际请求预检确认），请换一个档位`)
              }
              throw new Error(`路由 ${id} 的 ${slot} 候选 ${c.provider}/${c.model} 思考级别预检失败：${String((e && e.message) || e)}`)
            }
          }
        }
      }
    }
    // 归一：去掉兼容旧字段，只保留 tier1/tier2/tier3 + 套餐级 tierNames
    const normalized = {}
    for (const [id, route] of Object.entries(section.routes)) {
      normalized[id] = {
        tier1: route.tier1,
        tier2: route.tier2,
        tier3: route.tier3,
        ...(route.tierNames && Object.keys(route.tierNames).length > 0 ? { tierNames: route.tierNames } : {}),
        ...(route.taskDefaults && Object.keys(route.taskDefaults).length > 0 ? { taskDefaults: route.taskDefaults } : {}),
      }
    }
    return { ...section, routes: normalized }
  }

  const webServer = ctx.webServer
  const settings = ctx.settings

  // ------------------------------------------------------------------
  // 模型能力（写回宿主 llm-pi-ai 配置）
  //
  // llm-pi-ai 通过 installSettingsSection 注册了同名的 settings 命名空间，
  // 且 onChange 会重新注册 adapter（热重载，live 生效）。插件用全局
  // ctx.settings（SettingsProvider）读写该命名空间：get/describe 读，
  // update 深合并写（只改目标 provider/model 的字段，其余配置保留）。
  // ------------------------------------------------------------------
  const LLM_PI_AI_NS = 'llm-pi-ai'
  const llmRawConfig = () => {
    if (!settings || typeof settings.describe !== 'function') return undefined
    try {
      const desc = settings.describe().find((d) => String(d.ns) === LLM_PI_AI_NS)
      return desc ? (desc.user ?? desc.value) : undefined
    } catch {
      return undefined
    }
  }

  // 自定义（hand-declared）供应商集合：pi-ai 不内置、完全由配置声明的 provider。
  // 模型能力编辑只对这类 provider 开放（内置目录的能力不该由本插件改写）。
  const declaredProviders = () => {
    try {
      const llm = ctx.llm
      if (!llm || typeof llm.listConfigurableProviders !== 'function') return new Set()
      return new Set(llm.listConfigurableProviders().filter((p) => p.declared === true).map((p) => p.provider))
    } catch {
      return new Set()
    }
  }

  // 从 llm-pi-ai 原始配置里取 provider/models 能力（reasoningEfforts/contextWindow/maxTokens）
  // 只返回自定义（declared）供应商的模型能力。
  function llmModelCapabilities() {
    const raw = llmRawConfig()
    const providers = (raw && raw.providers) || {}
    const declared = declaredProviders()
    const out = {}
    for (const [pid, p] of Object.entries(providers)) {
      if (!declared.has(pid)) continue
      const models = (p && Array.isArray(p.models) ? p.models : []).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
        ...(m.reasoningEfforts !== undefined ? { reasoningEfforts: m.reasoningEfforts } : {}),
      }))
      out[pid] = models
    }
    return out
  }

  // 读取某 provider/model 在 llm-pi-ai 配置里显式声明的思考级别档位（任意供应商，
  // 不只自定义）。用户在模型能力卡片配置的档位，即使宿主 resolveModelInfo 裁剪
  // 掉（如 anthropic-messages 只认 off/low/medium/high），也应出现在路由下拉里。
  function configuredEffortsFor(provider, model) {
    try {
      const raw = llmRawConfig()
      if (!raw) return null
      const p = raw.providers && raw.providers[provider]
      if (!p || !Array.isArray(p.models)) return null
      const m = p.models.find((x) => x && x.id === model)
      const re = m && m.reasoningEfforts
      if (!re || typeof re !== 'object') return null
      // 键存在即声明了该档位（off 值为 null 也算声明）
      const ids = Object.keys(re)
      if (ids.length === 0) return null
      return ids.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), verified: true }))
    } catch {
      return null
    }
  }

  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/model-router/state',
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const now = Date.now()
          const cfg = current()
          const routes = {}
          for (const [id, raw] of Object.entries(cfg.routes)) routes[id] = normalizeRoute(raw)
          const [catalog, efforts] = await Promise.all([buildCatalog(), buildEfforts(routes)])
          json(res, 200, {
            ok: true,
            config: { ...cfg, routes },
            writable: settings !== undefined,
            catalog,
            efforts,
            cooldowns: [...cooldowns.entries()].map(([key, rec]) => {
              const until = typeof rec === 'number' ? rec : rec.until // 兼容旧数字形态
              const detail = typeof rec === 'object' ? rec : {}
              return {
                key, until, remainingMs: Math.max(0, until - now),
                durationMs: detail.durationMs ?? null,
                code: detail.code ?? null,
                status: detail.status ?? null,
                streak: detail.streak ?? 0,
              }
            }),
            manualTiers: Object.fromEntries(manualTiers),
            history: history.slice().reverse(),
            stats: Object.fromEntries(stats),
            health: Object.fromEntries([...health.entries()].map(([k, h]) => [k, { ok: h.ok, fail: h.fail, streak: h.streak ?? 0 }])),
            // 会话负载：各候选的运行中会话计数 + 正在运行的会话总数（面板展示用）
            sessionLoad: Object.fromEntries(buildSessionLoad()),
            runningSessions: runningSessions.size,
            // 图片支持能力（各候选是否支持图片输入，面板展示用）
            imageSupport: Object.fromEntries(imageSupportCache),
          })
        } catch (e) {
          json(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }), 'dsh-model-router: state route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/model-router/save',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        try {
          if (settings === undefined) return json(res, 503, { ok: false, error: 'settings 服务不可用' })
          const body = await readBody(req)
          const section = await validateSection(body)
          await settings.replace(NS, section)
          json(res, 200, { ok: true, config: current() })
        } catch (e) {
          json(res, 400, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }), 'dsh-model-router: save route')

    // 模型能力：读取/写回 llm-pi-ai 的 provider/models 能力配置（reasoningEfforts/contextWindow/maxTokens）。
    // 同一 path 由 webServer 按 exact 去重，GET/POST 在此分发。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/model-router/model-capabilities',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          try {
            json(res, 200, {
              ok: true,
              writable: settings !== undefined && llmRawConfig() !== undefined,
              capabilities: llmModelCapabilities(),
            })
          } catch (e) {
            json(res, 500, { ok: false, error: String((e && e.message) || e) })
          }
          return
        }
        if (req.method === 'POST') {
          try {
            if (settings === undefined) return json(res, 503, { ok: false, error: 'settings 服务不可用' })
            const raw = llmRawConfig()
            if (raw === undefined) return json(res, 404, { ok: false, error: `未找到 ${LLM_PI_AI_NS} 配置，无法写回宿主模型能力` })
            const body = await readBody(req)
            const provider = String(body.provider ?? '')
            const model = String(body.model ?? '')
            const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
            if (!provider || !model) return json(res, 400, { ok: false, error: 'provider/model 必填' })
            // 只允许更新能力相关字段
            const allowed = new Set(['contextWindow', 'maxTokens', 'reasoningEfforts'])
            const cleanPatch = {}
            for (const [k, v] of Object.entries(patch)) {
              if (allowed.has(k)) cleanPatch[k] = v
            }
            if (Object.keys(cleanPatch).length === 0) return json(res, 400, { ok: false, error: 'patch 必须包含 contextWindow/maxTokens/reasoningEfforts 之一' })
            // 只允许修改自定义（hand-declared）供应商的能力；内置目录供应商由宿主目录管理
            if (!declaredProviders().has(provider)) {
              return json(res, 403, { ok: false, error: `provider ${provider} 是内置目录供应商，模型能力由宿主目录管理；只允许修改自定义供应商（如 ${[...declaredProviders()].join('、')}）` })
            }
            const providers = (raw.providers && typeof raw.providers === 'object') ? raw.providers : {}
            const p = providers[provider]
            if (!p || !Array.isArray(p.models)) return json(res, 404, { ok: false, error: `provider ${provider} 不存在或没有 models 列表` })
            const idx = p.models.findIndex((m) => m && m.id === model)
            if (idx < 0) return json(res, 404, { ok: false, error: `model ${provider}/${model} 不在 provider 配置中` })
            // 构造新的 models 数组（该 provider 的完整列表，只改目标项）
            const nextModels = p.models.map((m, i) => (i === idx ? { ...m, ...cleanPatch } : m))
            // 深合并写回：只替换 providers.<pid>.models，其余字段保留
            await settings.update(LLM_PI_AI_NS, { providers: { [provider]: { models: nextModels } } })
            ctx.logger.info(`dsh-model-router: 已写回宿主模型能力 ${provider}/${model} ${Object.keys(cleanPatch).join(',')}`)
            json(res, 200, { ok: true, capabilities: llmModelCapabilities() })
          } catch (e) {
            json(res, 400, { ok: false, error: String((e && e.message) || e) })
          }
          return
        }
        json(res, 405, { ok: false, error: 'method not allowed' })
      },
    }), 'dsh-model-router: model-capabilities')

    // 单个候选的可用思考级别档位：面板对新加（未保存）候选实时查询真实能力，
    // 避免误显示「不支持思考级别」（buildEfforts 只覆盖已保存候选）。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/model-router/efforts',
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        try {
          // 手动解析 query（避免 URL base 字面量触发静态扫描的明文 http 规则）
          const q = (req.url || '').split('?')[1] || ''
          const params = new URLSearchParams(q)
          const provider = params.get('provider') || ''
          const model = params.get('model') || ''
          if (!provider || !model) return json(res, 400, { ok: false, error: 'provider/model 必填' })
          const fallback = current().reasoningEffortsFallback || ['low', 'medium', 'high']
          const list = await resolveEffortsFor(provider, model, fallback)
          json(res, 200, { ok: true, key: `${provider}/${model}`, efforts: list || [] })
        } catch (e) {
          json(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }), 'dsh-model-router: efforts single')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/model-router/cooldowns/clear',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        cooldowns.clear()
        record({ type: 'cooldowns-cleared' })
        json(res, 200, { ok: true })
      },
    }), 'dsh-model-router: cooldowns route')

    // 手动档位：client 在下拉里显式选档时调用；tier=auto 清除回默认规则
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/model-router/tier',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const sessionId = String(body.sessionId ?? '')
          const tier = String(body.tier ?? 'auto')
          if (!sessionId) return json(res, 400, { ok: false, error: 'sessionId 必填' })
          if (tier !== 'auto' && !TIER_SLOTS.includes(tier)) {
            return json(res, 400, { ok: false, error: `tier 必须是 ${TIER_SLOTS.join('/')} 或 auto` })
          }
          await setManualTier(sessionId, tier)
          record({ type: 'manual-tier', model: sessionId, tier: manualTiers.get(sessionId) ?? 'auto', purpose: 'manual' })
          json(res, 200, { ok: true, manual: manualTiers.get(sessionId) ?? 'auto' })
        } catch (e) {
          json(res, 400, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }), 'dsh-model-router: tier route')

    // 会话级任务画像（feature: task-aware routing）：GET 读当前画像，POST 设置/清除。
    // 清除 = body.task 为空对象或全部键为空（与手动档位同款 mutate 路径持久化）。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/model-router/task',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const u = String(req.url ?? '')
          const sid = u.includes('?') ? new URLSearchParams(u.slice(u.indexOf('?') + 1)).get('session') ?? '' : ''
          const raw = taskOverrides.get(sid)
          // 补齐默认值返回（与 resolveTaskProfile 兜底一致），前端展示完整画像
          json(res, 200, { ok: true, task: raw ? resolveTaskProfile({ session: raw }) : null })
          return
        }
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const sessionId = String(body.sessionId ?? '')
          if (!sessionId) return json(res, 400, { ok: false, error: 'sessionId 必填' })
          await setTaskOverride(sessionId, body.task)
          // 补齐默认值返回：持久化的是用户键（缺省键由 schema 兜底），这里补全
          json(res, 200, { ok: true, task: resolveTaskProfile({ session: taskOverrides.get(sessionId) }) ?? null })
        } catch (e) {
          json(res, 400, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }), 'dsh-model-router: task route')
  }

  ctx.effect(() => () => {
    dispose()
    disposeAgentRequest()
    disposeAgentStatus()
    disposePreStep()
    cooldowns.clear()
    history.length = 0
    stats.clear()
    health.clear()
    sessionModel.clear()
    runningSessions.clear()
    manualTiers.clear()
    taskOverrides.clear()
    imageSupportCache.clear()
    contentAnalysisCache.clear()
    contentAwareTierCache.clear()
    contextWindowCache.clear()
    effortStrippedKeys.clear()
  }, 'dsh-model-router: cleanup')

  console.log('[dsh-model-router] plugin ready') // 启动标记：运行级测试断言 apply 真实执行
  ctx.logger.info('dsh-model-router: 已加载（统一 ModelID 三档路由 + 故障转移 + 健康度择优 + 思考级别 + 会话负载均衡 + 内容感知选档 + 任务属性×模型属性自动路由 + 管理面板 API）')
}
