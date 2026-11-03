// dsh-pet-mic-lite —— 客户端半
//
// 采集链路：
//   getUserMedia → ScriptProcessor → 1024 点 RMS → 每 10ms 一帧 dB → 每 250ms 批量 POST /frame
// 判定在服务端（detector.cjs），这里只负责采集 + 一个小面板。
//
// 面板只有三样：麦克风开关、实时电平、今天被摸了几次。
// 「上次开着」记在 localStorage，窗口重开自动续开（被系统拦下就清标记，提示手动点）。

window.__ModuleLoader__.load({
  id: 'dsh-pet-mic-lite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const BASE = '/plugins/dsh-pet-mic-lite'
    const FRAME_MS = 10
    const RING = 1024
    const POST_EVERY_MS = 250
    const PREF_KEY = 'dsh-pet-mic-lite:mic'
    const PANEL_TITLE = '摸摸大肥鱼 Lite'

    function post(path, body) {
      return fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch((error) => ({ ok: false, error: String((error && error.message) || error) }))
    }

    function get(path) {
      return fetch(BASE + path)
        .then((r) => r.json())
        .catch((error) => ({ ok: false, error: String((error && error.message) || error) }))
    }

    // ── 采集：getUserMedia → ScriptProcessor → RMS → dB ──
    function createMeter(stream, onFrame) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      const ctx = new AudioCtx()
      const src = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(2048, 1, 1)
      const ring = new Float32Array(RING)
      let pos = 0
      let acc = 0
      const silent = ctx.createGain()
      silent.gain.value = 0

      proc.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        for (let i = 0; i < input.length; i++) {
          ring[pos] = input[i]
          pos = (pos + 1) % RING
          acc++
          if (acc >= (FRAME_MS * ctx.sampleRate) / 1000) {
            acc = 0
            let energy = 0
            for (let j = 0; j < RING; j++) energy += ring[j] * ring[j]
            const db = 20 * Math.log10(Math.sqrt(energy / RING) + 1e-9)
            onFrame(db, performance.now())
          }
        }
      }

      src.connect(proc)
      proc.connect(silent)
      silent.connect(ctx.destination)
      try { if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(() => {}) } catch {}
      return {
        close() {
          try { proc.onaudioprocess = null } catch {}
          try { src.disconnect() } catch {}
          try { proc.disconnect() } catch {}
          try { silent.disconnect() } catch {}
          try { ctx.close() } catch {}
        },
      }
    }

    // ── 采集引擎：模块级单例，不随面板卸载 ──────────────────
    const MIC = {
      stream: null,
      meter: null,
      timer: null,
      queue: [],
      level: -70,
      running: false,
      ui: null,       // 面板订阅者，面板卸载后照常采集
      seq: 0,
      resumeTried: false,
      resumeError: '',
    }

    function readPref() {
      try { return window.localStorage.getItem(PREF_KEY) === '1' } catch { return false }
    }
    function writePref(on) {
      try { window.localStorage.setItem(PREF_KEY, on ? '1' : '0') } catch {}
    }

    function attachUi(ui) {
      MIC.ui = ui
      return () => { if (MIC.ui === ui) MIC.ui = null }
    }

    function stopMic() {
      MIC.seq += 1
      if (MIC.timer) { window.clearInterval(MIC.timer); MIC.timer = null }
      if (MIC.meter) { MIC.meter.close(); MIC.meter = null }
      if (MIC.stream) { MIC.stream.getTracks().forEach((t) => t.stop()); MIC.stream = null }
      MIC.queue = []
      MIC.level = -70
      MIC.running = false
      writePref(false)
      if (MIC.ui && MIC.ui.onState) MIC.ui.onState(false)
      if (MIC.ui) MIC.ui.onLevel(-70)
    }

    async function startMic() {
      if (MIC.running) return
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        MIC.resumeError = '这个环境拿不到麦克风（mediaDevices 不可用）'
        if (MIC.ui && MIC.ui.onError) MIC.ui.onError(MIC.resumeError)
        return
      }
      const seq = ++MIC.seq
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        })
        if (seq !== MIC.seq) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        MIC.stream = stream
        MIC.meter = createMeter(stream, (db) => {
          if (seq !== MIC.seq) return
          MIC.level = db
          MIC.queue.push([Number(db.toFixed(2)), Math.round(performance.now())])
          if (MIC.queue.length > 400) MIC.queue.splice(0, MIC.queue.length - 400)
        })
        MIC.timer = window.setInterval(() => {
          if (seq !== MIC.seq) return
          const ui = MIC.ui
          if (ui) ui.onLevel(MIC.level)
          if (!MIC.queue.length) return
          const levels = MIC.queue.splice(0, MIC.queue.length)
          post('/frame', { levels }).then((data) => {
            if (data && data.ok && ui && ui.onState2) ui.onState2(data)
          })
        }, POST_EVERY_MS)
        MIC.running = true
        MIC.resumeError = ''
        writePref(true)
        if (MIC.ui && MIC.ui.onState) MIC.ui.onState(true)
      } catch (error) {
        if (seq !== MIC.seq) return
        const name = (error && error.name) || ''
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          writePref(false)
          MIC.resumeError = '麦克风被系统拦下了，点「打开麦克风」允许一次'
        } else if (name === 'NotFoundError') {
          MIC.resumeError = '找不到可用的麦克风设备'
        } else {
          MIC.resumeError = '打开麦克风失败：' + String((error && error.message) || error)
        }
        if (MIC.ui && MIC.ui.onError) MIC.ui.onError(MIC.resumeError)
      }
    }

    // 窗口重开后模块重新加载：上次开着就自动续开
    function tryAutoResume() {
      if (MIC.resumeTried) return
      MIC.resumeTried = true
      if (MIC.running || !readPref()) return
      startMic().then(() => {
        if (!MIC.running && readPref()) {
          MIC.resumeError = '上次麦克风是开着的，这次自动打开被拦下了，点「打开麦克风」即可'
        }
      })
    }

    // ── 面板（设置 → 摸摸计数）────────────────────────────────
    function PetMicLitePanel() {
      const [on, setOn] = useState(MIC.running)
      const [level, setLevel] = useState(MIC.level)
      const [error, setError] = useState(MIC.resumeError)
      const [data, setData] = useState(null)
      const aliveRef = useRef(true)

      const refresh = () => {
        get('/state').then((d) => { if (d && d.ok) setData(d) })
      }

      useEffect(() => {
        aliveRef.current = true
        const detach = attachUi({
          onState(next) { if (aliveRef.current) setOn(next) },
          onLevel(db) { if (aliveRef.current) setLevel(db) },
          onError(msg) { if (aliveRef.current) setError(msg) },
          onState2(d) { if (aliveRef.current && d) setData(d) },
        })
        tryAutoResume()
        refresh()
        const poll = window.setInterval(refresh, 3000)
        return () => {
          aliveRef.current = false
          window.clearInterval(poll)
          detach()
        }
      }, [])

      const db = Math.max(-70, Math.min(0, Number(level) || -70))
      const pct = Math.round(((db + 70) / 70) * 100)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        // 第一行：开关 + 今日计数
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
            padding: '12px 16px', borderRadius: 10,
            background: 'var(--dsh-bg-secondary, rgba(127,127,127,0.08))',
          },
        },
          h('button', {
            onClick: () => { setError(''); if (MIC.running) stopMic(); else startMic() },
            style: {
              padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid var(--dsh-border-color, rgba(127,127,127,0.35))',
            },
          }, on ? '关掉麦克风' : '打开麦克风'),
          h('div', { style: { fontSize: 13, opacity: 0.75 } },
            on ? '麦克风开着，摸一摸就计数' : '麦克风关着'),
          h('div', { style: { marginLeft: 'auto', textAlign: 'right' } },
            h('div', { style: { fontSize: 26, fontWeight: 700, lineHeight: 1.1 } },
              String(data ? data.count : '—')),
            h('div', { style: { fontSize: 12, opacity: 0.65 } },
              '今天被摸摸（次）' + (data && data.strokes ? ' · 共 ' + data.strokes + ' 下' : '')),
          ),
        ),
        // 实时电平条
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', {
            style: {
              flex: 1, height: 8, borderRadius: 4, overflow: 'hidden',
              background: 'var(--dsh-bg-secondary, rgba(127,127,127,0.15))',
            },
          },
            h('div', {
              style: {
                width: pct + '%', height: '100%',
                background: on ? 'var(--dsh-accent-color, #4a9eff)' : 'rgba(127,127,127,0.4)',
                transition: 'width 80ms linear',
              },
            }),
          ),
          h('span', { style: { fontSize: 12, opacity: 0.6, minWidth: 56, textAlign: 'right' } },
            db.toFixed(0) + ' dB'),
        ),
        // 错误 / 状态行
        error
          ? h('div', { style: { fontSize: 12, color: '#e05c5c' } }, error)
          : (data && data.live && data.live.state === 'touching')
            ? h('div', { style: { fontSize: 12, opacity: 0.7 } }, '手放上来了……')
            : null,
        h('div', { style: { fontSize: 12, opacity: 0.5 } },
          '计数存在 ' + (data && data.countFile ? data.countFile : 'logDir/count.json') +
          '，大肥鱼读这个文件就知道今天被摸了几次'),
      )
    }

    // ── 注册（设置页 section）────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx.slots
        if (!slots || typeof slots.inject !== 'function') return
        const name = 'settings.section'
        const mount = () => slots.inject(name, () =>
          slots.register({ name, id: 'dsh-pet-mic-lite', order: 43, label: () => PANEL_TITLE, inject: () => ({}) }, PetMicLitePanel))
        try {
          if (typeof ctx.effect === 'function') ctx.effect(mount, 'dsh-pet-mic-lite settings section')
          else mount()
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[dsh-pet-mic-lite] 面板挂载失败：' + (error && error.message))
          }
        }
      },
    }
  },
})
