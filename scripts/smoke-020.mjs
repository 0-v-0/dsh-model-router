// 0.2.0 契约冒烟：模块可加载、Config 是 volatile 且通过 Loader 的标准校验路径、
// apply(ctx, config) 拿到的是引用集合、current() 快照正确。
import assert from 'node:assert/strict'
import { Config, name, inject, apply } from '../lib/index.js'

assert.equal(name, 'dsh-model-router')
assert.deepEqual(inject, ['llm', 'webServer', 'settings', 'credentials'])

// Loader 用 Config['~standard'].validate(raw) 校验；必须成功且产出 volatile 引用。
const result = Config['~standard'].validate({})
assert.equal(result.issues, undefined, JSON.stringify(result.issues))
const parsed = result.value
assert.equal(typeof parsed.get, 'function', '整体 .volatile() → apply 收到的 config 是引用')
const keys = Object.keys(Config.dict)
for (const key of keys) {
  assert.ok(key in parsed.get(), `快照缺少字段 ${key}`)
}

// 默认快照：面板 API 依赖这些默认值。
const defaults = parsed.get()
assert.deepEqual(defaults.routes, {})
assert.equal(defaults.enabled, true)
assert.equal(defaults.cooldownMs, 300000)
assert.deepEqual(defaults.reasoningEffortsFallback, ['low', 'medium', 'high'])
assert.equal(defaults.taskRouting.enabled, false)
assert.equal(defaults.taskRouting.autoComplexity, true)

// 带路由的快照：候选默认属性由 schema 填充。
const routed = Config({ routes: { cheap: { tier1: [{ provider: 'p', model: 'm' }] } } }).get()
assert.equal(routed.routes.cheap.tier1[0].location, 'external')
assert.equal(routed.routes.cheap.tier1[0].trust, 'trusted')
assert.equal(routed.routes.cheap.tier1[0].capability, 'medium')
assert.deepEqual(routed.routes.cheap.tier2, [])

// 快照是冻结的：下游要改写的地方必须先拷贝（validateSection 走 deepCopyJson）。
assert.throws(() => { 'use strict'; defaults.enabled = false }, TypeError)

// 非法值仍然拒绝（Loader 会把 issues 转成 ValidationError）。
const bad = Config['~standard'].validate({ cooldownBackoff: 99 })
assert.ok(bad.issues, 'cooldownBackoff=99 应当被拒绝')

// apply 接线：最小 ctx，验证 current() 读到引用快照 + 事件/路由注册都挂上。
const listeners = new Map()
const routes = []
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  settings: {
    configure() { return () => {} },
    describe() { return [] },
    update: async () => {},
    replace: async () => {},
    mutate: async () => {},
  },
  webServer: { register(route) { routes.push(route.path); return () => {} } },
  llm: {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => ({}),
    resolveCallConfig: async (c) => c,
    stream: () => (async function* () {})(),
  },
  on(name_, handler) { listeners.set(name_, handler); return () => listeners.delete(name_) },
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  inject(deps, cb) { cb(ctx) },
  get: () => undefined,
  sandboxPolicy: undefined,
}
apply(ctx, parsed)
assert.ok(listeners.has('llm/stream'), 'llm/stream 监听已注册')
assert.ok(listeners.has('agent/request'), 'agent/request 监听已注册')
assert.ok(listeners.has('agent/status'), 'agent/status 监听已注册')
assert.ok(listeners.has('agent/pre-step'), 'agent/pre-step 监听已注册')
assert.ok(listeners.has('loader/volatile-update'), 'loader/volatile-update 监听已注册')
assert.ok(routes.includes('/api/model-router/state'), '/api/model-router/state 已注册')
assert.ok(routes.includes('/api/model-router/save'), '/api/model-router/save 已注册')
assert.ok(routes.includes('/api/model-router/tier'), '/api/model-router/tier 已注册')
assert.ok(routes.includes('/api/model-router/task'), '/api/model-router/task 已注册')

// 热更新：引用对象不变，Loader 只换内部快照；listener 重建派生内存态。
assert.equal(typeof listeners.get('loader/volatile-update'), 'function')
assert.doesNotThrow(() => listeners.get('loader/volatile-update')([]))
assert.doesNotThrow(() => listeners.get('llm/stream')({ model: 'nope', provider: 'p', messages: [] }, () => 'next'))

// 热更新真的可见：模拟 Loader 用新快照提交（cosmokit 的 updateVolatile 写协议），
// 同一个引用对象 .get() 必须返回新值 —— 这正是 current() 免订阅的根据。
const write = Symbol.for('cosmokit.volatile.write')
const repointed = Config({ routes: { mid: { tier2: [{ provider: 'q', model: 'n' }] } } })
parsed[write](repointed.get())
assert.equal(parsed.get().routes.mid.tier2[0].provider, 'q', '热更新后同一引用读到新快照')

console.log('smoke-020 OK')
