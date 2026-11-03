// dsh-pet-mic-lite —— 摸摸大肥鱼 Lite（服务端）
//
// 这个插件只做一件事：麦克风识别「摸摸」，把「今天被摸摸了几次」记进本地 count.json。
//
// 组成：
//   - detector.cjs  纯逻辑判定核心（浏览器 / Node 通用），加载失败则整体停用
//   - 帧协议        POST /plugins/dsh-pet-mic-lite/frame { levels: [[db, t], ...] }
//   - webServer 注册：ctx.inject(['webServer'], ...) + httpCtx.webServer.register
//   - 可选校准      noiseFile 指向一份 { thDb, gateDb } JSON，填了就替代默认阈值
//
// 给角色的数据接口（二选一）：
//   1. 读本地文件   <logDir>/count.json —— {"date":"2026-11-02","count":12,...}
//   2. GET http://127.0.0.1:<端口>/plugins/dsh-pet-mic-lite/state
//
// 结算口径：手停下 3 秒，这一段抚摸结算成「一次摸摸」，count +1。
// 这一轮实际摸了几下记在 strokes 里，只是顺带，不是主计数。

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

export const name = 'dsh-pet-mic-lite'

const BASE = '/plugins/dsh-pet-mic-lite'

const DEFAULTS = {
  enabled: true,
  // 触发线：高出环境基准多少 dB 算「手放上去」
  thDb: 9,
  minStrokes: 3,        // 一段至少 3 下才算一次摸摸
  minTouchMs: 2000,     // 或累计接触满 2 秒（按住慢慢摸只有 1 下，也是真互动）
  sessionIdleMs: 3000,  // 手停这么久就结算
  // 计数落盘目录：用户目录下的隐藏目录，跨平台、零配置
  logDir: join(homedir(), '.dsh-pet-mic-lite'),
  // 可选的噪声校准结果：一份含 thDb / gateDb 的 JSON，填了就替代默认阈值。
  // 留空 = 不读，全用默认值
  noiseFile: '',
}

// 判定核心：加载失败就整体停用（不注册路由、不计数）
let Pet = null
try {
  Pet = require('./detector.cjs')
} catch (error) {
  console.error('[dsh-pet-mic-lite] 判定核心加载失败，插件本次停用：' + (error && error.message))
}

// ── 小工具 ──────────────────────────────────────────────────

function num(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// 本地时区的 YYYY-MM-DD。跨天瞬间（写第一笔新数据时）自动归零
function localDate(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function isLocal(req) {
  const addr = req.socket && (req.socket.remoteAddress || '')
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJson(req, limit = 262144) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx, config = {}) {
  if (!Pet) return

  const settings = {
    enabled: config.enabled !== false,
    thDb: num(config.thDb, DEFAULTS.thDb, 3, 30),
    minStrokes: num(config.minStrokes, DEFAULTS.minStrokes, 1, 50),
    minTouchMs: num(config.minTouchMs, DEFAULTS.minTouchMs, 0, 20000),
    sessionIdleMs: num(config.sessionIdleMs, DEFAULTS.sessionIdleMs, 500, 30000),
    logDir:
      typeof config.logDir === 'string' && config.logDir
        ? config.logDir
        : DEFAULTS.logDir,
    noiseFile:
      typeof config.noiseFile === 'string' ? config.noiseFile.trim() : DEFAULTS.noiseFile,
  }
  if (!settings.enabled) {
    ctx.logger?.info?.('[dsh-pet-mic-lite] is disabled')
    return
  }
  const logger = ctx.logger ?? console
  const countPath = join(settings.logDir, 'count.json')

  // ── 今日计数（唯一的落盘状态）────────────────────────────
  // count   今天被摸摸了几次（结算次数，主计数）
  // strokes 今天一共被摸了多少下（顺带记，给大肥鱼多一个可用口径）
  let today = { date: localDate(), count: 0, strokes: 0, updatedAt: 0 }

  try {
    const raw = JSON.parse(readFileSync(countPath, 'utf8'))
    if (raw && typeof raw === 'object') {
      if (raw.date === today.date) {
        today = {
          date: raw.date,
          count: Number.isFinite(raw.count) ? Math.max(0, Math.floor(raw.count)) : 0,
          strokes: Number.isFinite(raw.strokes) ? Math.max(0, Math.floor(raw.strokes)) : 0,
          updatedAt: Number(raw.updatedAt) || 0,
        }
      }
      // 日期对不上 = 昨天的数据，今天从 0 开始（不清文件，直接覆盖）
    }
  } catch {
    // 文件不存在 / 坏了：从 0 开始，写的时候自然覆盖
  }

  function persistCount() {
    try {
      mkdirSync(settings.logDir, { recursive: true })
      const body = {
        // 给大肥鱼的一句话说明：读这个文件就知道今天被摸了几次
        note: '大肥鱼读这里：date 是今天，count 是今天被摸摸的次数，strokes 是被摸的总下数。跨天自动从 0 开始。',
        date: today.date,
        count: today.count,
        strokes: today.strokes,
        updatedAt: Date.now(),
      }
      const tmp = countPath + '.tmp'
      writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8')
      renameSync(tmp, countPath)   // 原子替换，断电也不会写半个文件
    } catch (error) {
      logger.warn?.('[dsh-pet-mic-lite] count.json 写入失败：' + (error && error.message))
    }
  }

  // 每次结算（和每次查询）先对一下日期，跨天自动归零
  function rollDate() {
    const d = localDate()
    if (d !== today.date) {
      logger.info?.(`[dsh-pet-mic-lite] 跨天 ${today.date} → ${d}，今日计数归零（昨天 count=${today.count}）`)
      today = { date: d, count: 0, strokes: 0, updatedAt: 0 }
    }
  }

  // 每日结算流水（排查用，可选读）：sessions-YYYY-MM-DD.jsonl
  function persistSession(summary) {
    try {
      mkdirSync(settings.logDir, { recursive: true })
      const file = join(settings.logDir, 'sessions-' + today.date + '.jsonl')
      appendFileSync(
        file,
        JSON.stringify({ at: Date.now(), date: today.date, count: today.count, ...summary }) + '\n',
        'utf8',
      )
    } catch (error) {
      logger.warn?.('[dsh-pet-mic-lite] 结算流水写入失败：' + (error && error.message))
    }
  }

  // ── 判定器 ────────────────────────────────────────────────
  // 可选的校准结果：文件里存着量好的 thDb 和噪声闸 gateDb，
  // 填了就开箱即用，不用再调阈值。文件坏了就退回默认值，不连累主功能。
  let bootThDb = settings.thDb
  let bootGate = null
  if (settings.noiseFile && existsSync(settings.noiseFile)) {
    try {
      const noise = JSON.parse(readFileSync(settings.noiseFile, 'utf8'))
      if (Number.isFinite(noise.thDb)) bootThDb = num(noise.thDb, settings.thDb, 3, 30)
      if (Number.isFinite(noise.gateDb)) bootGate = Number(noise.gateDb)
      logger.info?.(
        `[dsh-pet-mic-lite] 复用校准 ${settings.noiseFile}：thDb=${bootThDb} gate=${bootGate ?? '无'}`,
      )
    } catch (error) {
      logger.warn?.('[dsh-pet-mic-lite] 校准文件读不了，用默认阈值：' + (error && error.message))
    }
  }

  const det = Pet.create({ thDb: bootThDb, sessionIdleMs: settings.sessionIdleMs,
    minStrokes: settings.minStrokes, minTouchMs: settings.minTouchMs }, onEvent)
  if (bootGate !== null && det.setGate) det.setGate(bootGate)

  function onEvent(ev) {
    // 只关心一件事：一段合格的抚摸结算 = 被摸摸一次
    if (ev.type !== 'session' || !ev.worthy) return
    rollDate()
    today.count += 1
    today.strokes += Number(ev.summary?.count) || 0
    today.updatedAt = Date.now()
    persistCount()
    persistSession(ev.summary)
    logger.info?.(
      `[dsh-pet-mic-lite] 第 ${today.count} 次摸摸（${ev.summary.count} 下 / ` +
      `${Math.round(ev.summary.spanMs / 1000)} 秒 / ${ev.summary.style}），今日累计 strokes=${today.strokes}`,
    )
  }

  // 判定器的时间轴由页面的 performance.now() 驱动；停手结算靠 tick 推进同一个时钟
  const timeState = { lastFrameT: 0, lastFrameWall: 0 }
  function logicalNow() {
    if (!timeState.lastFrameWall) return 0
    return timeState.lastFrameT + (Date.now() - timeState.lastFrameWall)
  }
  const tickTimer = setInterval(() => {
    try { det.tick(logicalNow()) } catch {}
  }, 1000)

  function ingest(db, t) {
    if (!Number.isFinite(db) || !Number.isFinite(t)) return
    timeState.lastFrameT = t
    timeState.lastFrameWall = Date.now()
    try { det.push(db, t) } catch (error) {
      logger.warn?.('[dsh-pet-mic-lite] 帧处理出错：' + (error && error.message))
    }
  }

  function publicState() {
    rollDate()
    const st = det.status ? det.status() : {}
    return {
      ok: true,
      date: today.date,
      count: today.count,
      strokes: today.strokes,
      updatedAt: today.updatedAt,
      countFile: countPath,
      live: {
        state: st.state || 'idle',
        db: st.db,
        rel: st.rel,
        muted: st.muted,
      },
    }
  }

  // ── HTTP 路由 ────────────────────────────────────────────
  function frameHandler(req, res) {
    if (!isLocal(req)) return send(res, 403, { ok: false, error: 'local only' })
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    // return 链式 Promise：测试可以直接 await
    return readJson(req)
      .then((body) => {
        const levels = Array.isArray(body.levels) ? body.levels : []
        for (const pair of levels) {
          if (Array.isArray(pair) && pair.length >= 2) ingest(Number(pair[0]), Number(pair[1]))
        }
        send(res, 200, publicState())
      })
      .catch((error) => send(res, 400, { ok: false, error: String(error && error.message) }))
  }

  function stateHandler(req, res) {
    if (!isLocal(req)) return send(res, 403, { ok: false, error: 'local only' })
    send(res, 200, publicState())
  }

  // POST /reset —— 把今天的计数清零（调试 / 演示用）
  function resetHandler(req, res) {
    if (!isLocal(req)) return send(res, 403, { ok: false, error: 'local only' })
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    rollDate()
    today.count = 0
    today.strokes = 0
    today.updatedAt = Date.now()
    persistCount()
    logger.info?.('[dsh-pet-mic-lite] 今日计数已手动清零')
    send(res, 200, publicState())
  }

  ctx.inject(['webServer'], (httpCtx) => {
    const routes = [
      ['/frame', frameHandler],
      ['/state', stateHandler],
      ['/reset', resetHandler],
    ]
    for (const [suffix, handler] of routes) {
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: BASE + suffix, handler }),
        'dsh-pet-mic-lite ' + suffix,
      )
    }
    logger.info?.('[dsh-pet-mic-lite] 已挂载 ' + BASE + '/{frame,state,reset}，计数文件 ' + countPath)
  })

  ctx.effect?.(() => () => {
    clearInterval(tickTimer)
    // 退出前把手头的计数再落一次盘
    persistCount()
  }, 'dsh-pet-mic-lite cleanup')
}
