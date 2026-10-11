// 校验 docs/usage.md 里的 yaml 示例可解析，且能通过真实 Config schema。
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { Config } from '../lib/index.js'

const md = readFileSync(new URL('../docs/usage.md', import.meta.url), 'utf8')
const block = md.split('```yaml')[1].split('```')[0]
const doc = parse(block)
console.log('parsed ok')

const row = doc[0]
const cfg = row.config
console.log('id:', row.id, '| name:', row.name)
console.log('config keys:', Object.keys(cfg).join(', '))

// 关键：文档示例必须能被插件自己的 schema 接受，否则用户照抄就装不上。
const v = Config['~standard'].validate(cfg)
if (v.issues) {
  console.log('SCHEMA REJECTED the doc example:')
  console.log(JSON.stringify(v.issues, null, 1))
  process.exitCode = 1
} else {
  console.log('schema accepts the doc example')
  const s = v.value.get()
  const route = s.routes['deepseek-v4-flash']
  console.log('tier2:', route.tier2.map((c) => c.provider + '/' + c.model).join(' -> '))
  console.log('tier1 trust default:', route.tier1[0].trust)
}
