// dsh-pet-mic-lite 冒烟测试：不起 DSH，伪造 cordis 上下文跑完整链路
//   环境音 2 秒 → 摸 4 下 → 停手 → 结算 → count=1 落盘 → /reset 清零
// 用法：node test-count.mjs
import { apply } from './index.js'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 测试目录放系统临时目录，任何机器都能跑
const LOG_DIR = join(tmpdir(), 'dsh-pet-mic-lite-test-' + process.pid)
rmSync(LOG_DIR, { recursive: true, force: true })

// ── 伪造 cordis 上下文 ───────────────────────────────────────
const routes = new Map()
const logs = []
const ctx = {
  logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN ' + m), error: (m) => logs.push('ERR ' + m) },
  inject(_, fn) {
    // 模拟 webServer：把注册的 handler 收进来
    const httpCtx = {
      webServer: { register: ({ path, handler }) => routes.set(path, handler) },
      effect: (factory) => factory(),
    }
    fn(httpCtx)
  },
  effect: (factory) => factory(),
}

apply(ctx, {
  logDir: LOG_DIR,
  noiseFile: '',            // 测试不复用真实校准
  thDb: 9,
  sessionIdleMs: 3000,
})

function makeReq(body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method: payload ? 'POST' : 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload, 'utf8')
    },
  }
}
function makeRes() {
  let captured = null
  return {
    writeHead(status, headers) { captured = { status } },
    end(text) { captured.body = JSON.parse(text) },
    get result() { return captured },
  }
}
async function call(path, body) {
  const handler = routes.get(BASE + path)
  if (!handler) throw new Error('route missing: ' + path)
  const res = makeRes()
  await handler(makeReq(body), res)
  return res.result.body
}

const BASE = '/plugins/dsh-pet-mic-lite'

// ── 造帧：环境音 / 抚摸 ──────────────────────────────────────
let t = performance.now()
const frames = []
const amb = (ms) => { for (let m = 0; m < ms; m += 10) { frames.push([-60 + (Math.random() - 0.5), Math.round(t)]); t += 10 } }
const stroke = (ms = 300) => { for (let m = 0; m < ms; m += 10) { frames.push([-40 + (Math.random() - 0.5) * 2, Math.round(t)]); t += 10 } }
const gap = (ms = 500) => { for (let m = 0; m < ms; m += 10) { frames.push([-60 + (Math.random() - 0.5), Math.round(t)]); t += 10 } }

amb(2500)               // 基线（覆盖 1.5s warmup + 20 帧基准）
for (let i = 0; i < 4; i++) { stroke(); gap() }   // 摸 4 下
amb(3600)               // 停手超过 sessionIdleMs，触发结算

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')) }
}

console.log('== 1. 推 8000 帧过 /frame ==')
const r1 = await call('/frame', { levels: frames })
check('/frame 返回 ok', r1.ok === true)

console.log('== 2. 结算与计数 ==')
check('今日 count = 1', r1.count === 1, '实际 ' + r1.count)
check('strokes = 4', r1.strokes === 4, '实际 ' + r1.strokes)
check('日期是今天', /^\d{4}-\d{2}-\d{2}$/.test(r1.date), r1.date)

const countFile = JSON.parse(readFileSync(LOG_DIR + '/count.json', 'utf8'))
check('count.json 落盘 count=1', countFile.count === 1, JSON.stringify(countFile))
check('count.json 带 note 说明', typeof countFile.note === 'string' && countFile.note.includes('count'))

console.log('== 3. GET /state ==')
const r3 = await call('/state')
check('/state count=1', r3.count === 1)
check('/state 带文件路径', r3.countFile.includes('count.json'))

console.log('== 4. 再摸一段 → count=2 ==')
const frames2 = []
t += 2000               // 与第一批同一时间轴：隔 2 秒再来一段（时间倒流会撞 warmup）
const push2 = (db) => { frames2.push([db, Math.round(t)]); t += 10 }
const amb2 = (ms) => { for (let m = 0; m < ms; m += 10) push2(-60) }
const stroke2 = (ms) => { for (let m = 0; m < ms; m += 10) push2(-40 + (Math.random() - 0.5) * 2) }
const gap2 = (ms) => { for (let m = 0; m < ms; m += 10) push2(-60 + (Math.random() - 0.5)) }
amb2(600)
for (let i = 0; i < 3; i++) { stroke2(250); gap2(400) }
amb2(3600)
const r4 = await call('/frame', { levels: frames2 })
check('第二段后 count = 2', r4.count === 2, '实际 ' + r4.count)
check('累计 strokes = 7', r4.strokes === 7, '实际 ' + r4.strokes)

console.log('== 5. POST /reset 清零 ==')
const r5 = await call('/reset', {})
check('/reset 后 count = 0', r5.count === 0 && r5.strokes === 0)
const countFile2 = JSON.parse(readFileSync(LOG_DIR + '/count.json', 'utf8'))
check('清零后落盘 count=0', countFile2.count === 0)

console.log('== 6. 非本机请求被拒 ==')
const res6 = makeRes()
await routes.get(BASE + '/state')({ socket: { remoteAddress: '10.0.0.9' }, method: 'GET' }, res6)
check('外网 403', res6.result.status === 403)

console.log('\n服务端日志（最近 5 条）：')
for (const line of logs.slice(-5)) console.log('  ' + line)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
