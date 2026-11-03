/*!
 * dafish-pet-core.js — 抚摸识别与计次核心
 *
 * 纯逻辑，不碰 DOM / AudioContext。输入每帧的 dB 电平，输出抚摸事件与计数。
 * 浏览器 <script> 直接引入得到 window.DafishPet；Node 里 require 即可。
 *
 * 用法：
 *   var det = DafishPet.create({ thDb: 8 }, function (ev) {
 *     if (ev.type === 'start') console.log('摸了一下 #' + ev.stroke.n);
 *     if (ev.type === 'end')   console.log('这一下摸了 ' + ev.stroke.dur + 'ms');
 *   });
 *   // 每 10ms 调一次（可以是 AudioWorklet 发来的电平，也可以是别的来源）
 *   det.push(dbLevel, timestampMs);
 *
 * 判定原理：维护一个只在"没接触时"更新的环境基准（3 秒中位数），
 * 电平高出基准 thDb 且持续 enterMs 才确认接触；掉到 thDb*exitRatio 以下
 * 并持续 exitMs 才算离开。基准不跟手，所以不会出现阈值骑线的连击。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DafishPet = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    thDb: 9,             // 高出环境基准多少 dB 算接触（实测 rel 中位 25，环境自身能飘到 5，
                         // 取 9 既挡住环境波动，又留 16dB 余量）
    minLiftMs: 30,       // 抬手到再落下少于这么久，算同一次接触（只剩防重复触发的作用）
    enterMs: 80,         // 连续超过门限多久才确认，挡单帧毛刺
    exitRatio: 0.40,     // 掉到门限的这个比例以下才算离开（迟滞死区）
    exitMs: 100,         // 离开状态持续多久才结束。旧值 200ms 加衰减时间实际要 280ms
                         // 才断得开，而快步搓的抬手只有 200~250ms，会被整段合并成一下
    maxHoldMs: 60000,    // 单次接触的续期间隔。超过就续期，连续摸很久仍然算一次接触
    ambWindowMs: 3000,   // 环境基准的统计窗口
    smoothMs: 60,        // 包络平滑时间常数
    warmupMs: 1500,      // 启动后多久开始出数
    muteDb: -100,        // 低于此值视为数字静音（麦克风硬件开关关掉）
    windowMs: 30000,     // 速度统计窗口
    ambMinSamples: 20,   // 基准至少积累多少帧才可信
    sessionIdleMs: 3000, // 手离开这么久没有新的抚摸，就把这一段结算成一次会话
    splitGapMs: 1200,    // 段内空档超过它就在此处切段（不是丢弃），两段各自结算
                         // 实测正常抚摸最大空档约 920ms，取 1.2s 留出余量
    minStrokes: 3,       // 少于这么多下不发送给上层，只作为跳过事件留给调试
    minTouchMs: 2000,    // 但累计接触够久时同样放行 —— 按住慢慢摸只有 1 下，却是真互动
    ambPercent: 0.20,    // 环境基准取安静帧的**低分位**而不是中位数。
                         // 空调一开，中位数会被噪声抬上去，慢速轻抚那点涨幅就不够看了
    noisePercent: 0.85,  // 噪声上限取同一批安静帧的高分位，用来算「噪声闸」
    noiseMinSwing: 3,    // 噪声上限比基准高出这么多，才算「环境里有噪声」，闸才启用
    gateMarginDb: 2,     // 噪声闸 = 噪声上限 + 这么多。低于闸的电平一律当安静
    gateDb: null,        // 校准出来的固定噪声闸（绝对 dB）。自适应闸学得慢，
                         // 校准过的房间直接把它写死，空调第一声就挡得住
    noiseWindowMs: 1500, // 噪声统计窗口比基准窗口短，空调一停闸要尽快松开
    steadyDropMs: 5000,  // 一直平着的接触超过这么久（波动小于 steadyDb）判成稳态噪声，丢弃
    steadyDb: 2          // 上面那句里的「平」：这段时间 rel 的极差小于这么多 dB
  };

  // 六种手感 = 速度档 × 力度档。查这张表拿最终标签，两维都可以单独取出来做统计。
  var STYLE_OF = {
    fast: { heavy: 'eager', light: 'brisk' },   // 快·重 = 急促，快·轻 = 轻快
    mid: { heavy: 'knead', light: 'caress' },   // 中·重 = 揉捏，中·轻 = 轻抚
    slow: { heavy: 'press', light: 'gentle' },  // 慢·重 = 按压，慢·轻 = 轻柔
  };

  function median(values) {
    var n = values.length;
    if (!n) return null;
    var a = values.slice().sort(function (x, y) { return x - y; });
    return n % 2 ? a[(n - 1) >> 1] : (a[(n >> 1) - 1] + a[n >> 1]) / 2;
  }

  // 分位数。比中位数更能躲开噪声：低分位贴住真正的底噪，高分位量出噪声顶到哪儿。
  function percentile(values, p) {
    var n = values.length;
    if (!n) return null;
    var a = values.slice().sort(function (x, y) { return x - y; });
    var i = Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)));
    return a[i];
  }

  function create(options, onEvent) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (options) {
      for (k in options) {
        if (options[k] !== undefined && options[k] !== null) o[k] = options[k];
      }
    }
    if (typeof options === 'function') { onEvent = options; o = {}; for (k in DEFAULTS) o[k] = DEFAULTS[k]; }

    var emit = typeof onEvent === 'function' ? onEvent : function () {};

    var smooth = null;      // 平滑包络
    var amb = null;         // 环境基准（安静帧的低分位）
    var ambBuf = [];        // [{ t, v }]
    var noiseTop = null;    // 噪声上限（最近 noiseWindowMs 安静帧的高分位）
    var lastGate = null;    // 当前生效的噪声闸，null = 没开
    var steadyT0 = 0, steadyMin = 0, steadyMax = 0;   // 稳态噪声的判定窗口
    var inContact = false;
    var holdStart = 0;      // 首次超过门限的时刻
    var exitStart = 0;      // 首次掉到退出线的时刻
    var needReset = false;  // 被 maxHoldMs 强制收段后，必须真正掉下去才允许再计数
    var contactStart = 0;
    var peakDb = -120;
    var cur = null;         // 正在进行的这一下
    var strokes = [];
    var lastStart = 0, lastGap = 0, lastEnd = 0, gapDrops = 0, lastCur = null;
    var mergedOffs = [];   // 被并入的那些空档实测值，用来判断是毛刺还是真抬手
    var lastT = null, startedAt = null;
    var muted = true;
    var frame = 0;
    var lastDb = -120, lastRel = 0;
    var session = null;     // 当前这一段抚摸：{ start, last, items: [] }
    var sessionNo = 0;
    var lastFlushAt = 0;    // 上一次「提前切片」的时间点，用来判断这一拍有没有新动作

    function snapshot(s) {
      return {
        n: s.n, peak: s.peak, rel: s.rel, dur: s.dur,
        gap: s.gap, lift: s.lift, t0: s.t0, t1: s.t1,
        merged: s.merged || 0
      };
    }

    // 把一段抚摸压成一次总结。这是给上层消费的唯一数据形态：
    // 上层不需要关心逐下事件，只在收到 session 时让角色回应一次。
    function summarize(sess, now) {
      var items = sess.items, n = items.length;
      var totalDur = 0, durs = [], rels = [], gaps = [], first = 0, last = 0;
      for (var i = 0; i < n; i++) {
        var s = items[i];
        totalDur += s.dur;
        durs.push(s.dur);
        rels.push(s.rel);
        if (s.gap) gaps.push(s.gap);
        if (i === 0) first = s.t0;
        last = s.t1 === null ? now : s.t1;
      }
      var span = Math.max(1, last - first);
      var avgDur = Math.round(totalDur / n);
      var avgRel = +(rels.reduce(function (a, b) { return a + b; }, 0) / n).toFixed(1);
      var avgGap = gaps.length
        ? Math.round(gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length) : 0;
      var perMinute = span >= 1000 ? Math.round(n * 60000 / span) : null;

      // 六种手感 = 速度 × 力度 两个维度各算各的，再查表组合。
      // 旧版是短路判定（先判快、再判慢、最后才看力度），结果是「快而轻」被吞成急促、
      // 「慢而重」被吞成轻柔，六格里只有四格能产出不同名字。
      //
      // 速度用每分钟下数切三段：实测快档 122、中档 65、慢档 40，分界取 100 和 50。
      // 长按（平均单下 >= 900ms）也算慢，否则「按住不动慢慢蹭」会因为下数太少被判成中速。
      var speed = 'mid';
      if (n >= 3 && perMinute !== null && perMinute >= 100) speed = 'fast';
      else if (perMinute !== null && perMinute < 50) speed = 'slow';
      else if (avgDur >= 900) speed = 'slow';
      // 力度只有一条线：20dB。实测中速抚摸是 18.7，真用力在 21~24。
      var force = avgRel >= 20 ? 'heavy' : 'light';
      var style = STYLE_OF[speed][force];

      return {
        count: n,
        spanMs: Math.round(span),
        totalTouchMs: Math.round(totalDur),
        avgDur: avgDur,
        avgGap: avgGap,
        avgRel: avgRel,
        peakRel: +Math.max.apply(null, rels).toFixed(1),
        perMinute: perMinute,
        dutyCycle: +(totalDur / span).toFixed(2),
        style: style,
        speed: speed,
        force: force,
        startedAt: Math.round(first),
        endedAt: Math.round(last),
        idx: ++sessionNo
      };
    }

    function touchSession(t) {
      if (!session) session = { start: t, last: t, items: [] };
      session.last = t;
    }

    // 结算当前这一段。够格的事件 type 是 'session'（上层据此让角色回应），
    // 不够格的降级成 'session-skipped'，只供界面/调试展示，调用方监听 session 即可自然过滤。
    function closeSession(t, reason) {
      if (!session) return null;
      if (!session.items.length) { session = null; return null; }
      var sum = summarize(session, t);
      session = null;
      var worthy = sum.count >= o.minStrokes || sum.totalTouchMs >= o.minTouchMs;
      return {
        type: worthy ? 'session' : 'session-skipped',
        summary: sum,
        reason: worthy ? reason : 'few',
        worthy: worthy
      };
    }

    // 超过 sessionIdleMs 没有新的抚摸动作，就结算一次
    function checkSession(t) {
      if (!session) return null;
      if (!session.items.length) { session = null; return null; }
      if (t - session.last < o.sessionIdleMs) return null;
      return closeSession(t, 'idle');
    }

    // 通话切片（v1.3.6）：不等停手，手还按着也把这一段的统计提前结算掉。
    // 只关「这一段」，不动接触状态和 cur —— 下一拍从这一下继续往下算。
    // 这一拍没有新动作就返回 null，免得手放着不动时每 8 秒都说一遍同样的「1 下」。
    function flush(t, reason) {
      if (!session || !session.items.length) return null;
      if (session.last <= lastFlushAt) return null;
      lastFlushAt = t;
      var ev = closeSession(t, reason || 'beat');
      // 门槛（3 下 / 2 秒）是给「一整段」定的，切片只是一段里的一小片，
      // 拿整段门槛卡它会把慢速轻抚全丢掉。切片只要两下 / 0.8 秒就够说一句。
      if (ev && ev.type === 'session-skipped') {
        var sum = ev.summary || {};
        if (sum.count >= 2 || sum.totalTouchMs >= 800) {
          ev.type = 'session';
          ev.reason = reason || 'beat';
          ev.worthy = true;
        }
      }
      return ev;
    }

    function closeStroke(t, forced) {
      inContact = false;
      exitStart = 0;
      holdStart = 0;
      steadyT0 = 0; steadyMin = 0; steadyMax = 0;
      if (!cur) return [];
      cur.dur = Math.round((cur._acc || 0) + (t - contactStart));
      cur.t1 = t;
      lastEnd = t;
      cur.rel = +(cur.peak - amb).toFixed(2);
      var ev = { type: 'end', stroke: snapshot(cur), forced: !!forced };
      lastCur = cur;
      cur = null;
      return [ev];
    }

    function push(db, t) {
      if (typeof t !== 'number' || !isFinite(t)) {
        t = lastT === null ? 0 : lastT + 10;
      }
      if (startedAt === null) startedAt = t;
      var dt = lastT === null ? 10 : Math.min(200, Math.max(1, t - lastT));
      lastT = t;
      lastDb = db;
      frame++;

      // 数字静音：麦克风硬件开关关掉时是 -180 一类的值，整段丢弃并重置基线
      if (db < o.muteDb) {
        muted = true;
        smooth = null; amb = null; ambBuf.length = 0;
        noiseTop = null; lastGate = null;
        steadyT0 = 0; steadyMin = 0; steadyMax = 0;
        inContact = false; holdStart = 0; exitStart = 0; needReset = false;
        if (cur) {
          cur.dur = Math.round((cur._acc || 0) + (t - contactStart));
          cur.t1 = t;
          cur = null;
        }
        lastCur = null; lastEnd = 0;   // 关麦断链，别让下次开麦接回上一段
        var mutedEv = checkSession(t);
        if (mutedEv) emit(mutedEv);
        return mutedEv ? [mutedEv] : [];
      }
      // 刚从静音恢复：清空历史，避免把"开麦"那一下的跳变当成抚摸
      if (muted) {
        muted = false;
        smooth = db; amb = null; ambBuf.length = 0;
        noiseTop = null; lastGate = null;
        steadyT0 = 0; steadyMin = 0; steadyMax = 0;
        inContact = false; holdStart = 0; exitStart = 0;
      }

      var a = 1 - Math.exp(-dt / o.smoothMs);
      smooth = smooth === null ? db : smooth + (db - smooth) * a;
      if (amb === null) amb = smooth;

      var rel = smooth - amb;
      // 噪声闸：max(自适应, 校准值)。自适应看得懂「这一秒环境里有噪声」，
      // 校准值负责第一声就挡住 —— 否则要等自适应学几十秒，中间全是误触。
      var gate = noiseTop !== null && noiseTop - amb >= o.noiseMinSwing
        ? noiseTop + o.gateMarginDb : null;
      if (o.gateDb !== null && o.gateDb !== undefined &&
          (gate === null || o.gateDb > gate)) gate = o.gateDb;

      // 基准只用"确认安静"的帧更新：不在接触中、不在待确认期、且已经回落到退出线以下。
      // 手刚按上去但还没到确认门槛的那 120ms 必须排除，否则基准会被自己的动作抬高。
      if (!inContact && holdStart === 0 && ((gate !== null && smooth < gate) || rel < o.thDb * o.exitRatio)) {
        ambBuf.push({ t: t, v: smooth });
        while (ambBuf.length && t - ambBuf[0].t > o.ambWindowMs) ambBuf.shift();
        if (frame % 5 === 0 && ambBuf.length >= o.ambMinSamples) {
          // 基准取低分位：空调开着时中位数会被噪声抬走，慢速轻抚那点涨幅就再也够不着门限。
          amb = percentile(ambBuf.map(function (p) { return p.v; }), o.ambPercent);
          rel = smooth - amb;
          // 噪声上限只看最近一小段（比基准窗口短），空调一停闸要立刻松开
          var recent = [];
          for (var bi = ambBuf.length - 1; bi >= 0; bi--) {
            if (t - ambBuf[bi].t > o.noiseWindowMs) break;
            recent.push(ambBuf[bi].v);
          }
          noiseTop = recent.length >= Math.min(10, o.ambMinSamples)
            ? percentile(recent, o.noisePercent) : null;
          gate = noiseTop !== null && noiseTop - amb >= o.noiseMinSwing
            ? noiseTop + o.gateMarginDb : null;
          if (o.gateDb !== null && o.gateDb !== undefined &&
              (gate === null || o.gateDb > gate)) gate = o.gateDb;
        }
      }
      lastRel = rel;
      lastGate = gate;
      // 噪声闸：低于闸的电平一律当安静，既不能起接触，也会把正在进行的接触推去退出。
      var gated = gate !== null && smooth < gate;
      var effRel = gated ? -1 : rel;
      var warming = t - startedAt < o.warmupMs;
      var out = null;

      if (!inContact) {
        if (needReset && effRel < o.thDb * o.exitRatio) needReset = false;

        if (effRel >= o.thDb) {
          if (holdStart === 0) { holdStart = t; peakDb = db; }
          if (db > peakDb) peakDb = db;

          if (t - holdStart >= o.enterMs && !warming && !needReset) {
            inContact = true;
            exitStart = 0;
            steadyT0 = 0; steadyMin = 0; steadyMax = 0;
            // 抬手太短（比 minLiftMs 还短）说明手没真正离开，仍算同一次接触。
            // 关键：不能把这一下"丢掉"——要把上一段重新打开，时长接着累加，
            // 否则快速搓时每一次过短的抬手都会让一整下凭空消失（实测丢过 7/18 下）。
            var lift = lastEnd ? Math.round(t - lastEnd) : null;
            if (lift !== null && lift < o.minLiftMs) {
              gapDrops++;
              if (mergedOffs.length >= 40) mergedOffs.shift();
              mergedOffs.push(lift);
              if (lastCur && !cur) {
                lastCur._acc = (lastCur._acc || 0) + lastCur.dur;
                lastCur.merged = (lastCur.merged || 0) + 1;
                lastCur.t1 = null;
                cur = lastCur;
                contactStart = t;
                if (session) session.last = t;
                lastEnd = 0;
              }
            } else {
              // 空档超过 splitGapMs：先把上一段结算掉，再开新段。
              // "摸几下、停一会儿、再摸几下"因此变成两段各自判定，
              // 而不是因为中间有一次长间隔就把整轮真实互动丢掉。
              var splitEv = null;
              if (session && session.items.length && t - session.last > o.splitGapMs) {
                splitEv = closeSession(t, 'split');
              }
              lastGap = lastStart ? Math.round(t - lastStart) : 0;
              lastStart = t;
              contactStart = t;
              cur = {
                n: strokes.length + 1, peak: peakDb, rel: rel,
                dur: 0, gap: lastGap, lift: lift, t0: t, t1: null
              };
              strokes.push(cur);
              if (strokes.length > 500) strokes.shift();
              touchSession(t);
              session.items.push(cur);
              out = [{ type: 'start', stroke: snapshot(cur) }];
              if (splitEv) out.unshift(splitEv);
            }
          }
        } else {
          holdStart = 0;
        }
      } else {
        if (db > peakDb) peakDb = db;
        if (session) session.last = t;   // 还在摸，会话保持活跃，绝不中途结算

        if (steadyT0 === 0) { steadyT0 = t; steadyMin = rel; steadyMax = rel; }
        if (rel < steadyMin) steadyMin = rel;
        if (rel > steadyMax) steadyMax = rel;

        // 稳态噪声兜底：空调/风扇那种「平直」的电平一旦被当成「手按着不放」，
        // 接触就永远退不出去，会话也就永远不结算。这里按「一直很平」把它判掉：
        // 强制收段 + 丢弃这一下 + 要求电平真的掉下去才允许再接。
        if (t - steadyT0 >= o.steadyDropMs && steadyMax - steadyMin < o.steadyDb) {
          var dropped = cur;
          cur = null; lastCur = null; lastEnd = 0;
          inContact = false; exitStart = 0; holdStart = 0; needReset = true;
          steadyT0 = 0;
          if (dropped) {
            if (session && session.items[session.items.length - 1] === dropped) session.items.pop();
            if (strokes[strokes.length - 1] === dropped) strokes.pop();
          }
          ambBuf.length = 0; noiseTop = null;   // 这段电平算噪声，基准重新学一遍
          out = [{ type: 'noise-drop', at: Math.round(t), rel: +rel.toFixed(1) }];
        } else {
          if (effRel < o.thDb * o.exitRatio) {
            if (exitStart === 0) exitStart = t;
          } else {
            exitStart = 0;
          }

          if (exitStart && t - exitStart >= o.exitMs) {
            out = closeStroke(t, false);
            if (session) session.last = t;
          } else if (t - contactStart > o.maxHoldMs) {
            // 摸得异常久：续期而不是结束。连续摸一分钟仍然算"一次接触"，
            // 既不产生新计数，也不会打断当前会话。
            if (cur) cur._acc = (cur._acc || 0) + (t - contactStart);
            contactStart = t;
          }
        }
      }

      var sev = checkSession(t);
      if (sev) out = (out || []).concat([sev]);

      if (out) {
        for (var i = 0; i < out.length; i++) emit(out[i]);
      }
      return out || [];
    }

    // 没有音频帧时（麦克风关了、推流停了）由外部定时驱动，保证会话一定能结算
    function tick(t) {
      if (typeof t !== 'number' || !isFinite(t)) t = lastT === null ? 0 : lastT;
      var ev = checkSession(t);
      if (ev) emit(ev);
      return ev;
    }

    function stats(now) {
      var t = typeof now === 'number' ? now : (lastT || 0);
      var inWin = 0;
      for (var i = strokes.length - 1; i >= 0; i--) {
        if (t - strokes[i].t0 <= o.windowMs) inWin++; else break;
      }
      var recent = strokes.slice(-20);
      var durs = [], rels = [], gaps = [];
      for (var j = 0; j < recent.length; j++) {
        if (recent[j].t1 !== null) {
          durs.push(recent[j].dur);
          rels.push(recent[j].rel);
          if (recent[j].gap) gaps.push(recent[j].gap);
        }
      }
      var avg = function (arr) {
        if (!arr.length) return 0;
        var s = 0;
        for (var q = 0; q < arr.length; q++) s += arr[q];
        return s / arr.length;
      };
      return {
        total: strokes.length,
        inWindow: inWin,
        perMinute: Math.round(inWin * 60000 / o.windowMs),
        avgDur: Math.round(avg(durs)),
        avgGap: Math.round(avg(gaps)),
        avgRel: +avg(rels).toFixed(1),
        lastStroke: strokes.length ? snapshot(strokes[strokes.length - 1]) : null,
        windowMs: o.windowMs
      };
    }

    function status() {
      return {
        state: inContact ? 'touching' : (holdStart ? 'pending' : 'idle'),
        db: lastDb,
        amb: amb === null ? null : +amb.toFixed(1),
        noiseTop: noiseTop === null ? null : +noiseTop.toFixed(1),
        gate: lastGate === null ? null : +lastGate.toFixed(1),
        rel: +lastRel.toFixed(1),
        thDb: o.thDb,
        muted: muted,
        gapDrops: gapDrops,
        mergedOffs: mergedOffs.slice(-20),
        sinceLast: lastStart && lastT ? Math.round(lastT - lastStart) : null
      };
    }

    function setThreshold(db) {
      o.thDb = Math.max(1, +db || o.thDb);
      return o.thDb;
    }

    // 校准出来的噪声闸（绝对 dB）。传 null 关掉。
    function setGate(db) {
      if (db === null || db === undefined || !isFinite(Number(db))) {
        o.gateDb = null;
        return null;
      }
      o.gateDb = Number(db);
      return o.gateDb;
    }

    // 只清「这一轮」的计数，保留环境基准与包络状态。
    // 用于「结算完、角色回复完，重新开始数下一轮」：不动 amb，手一放上去立刻能计，
    // 不用再等 3 秒基线。
    function clearRound() {
      strokes = []; lastStart = 0; lastGap = 0; lastEnd = 0; gapDrops = 0;
      lastCur = null; mergedOffs = [];
      session = null; lastFlushAt = 0;
      cur = null; inContact = false; holdStart = 0; exitStart = 0; contactStart = 0;
      steadyT0 = 0; steadyMin = 0; steadyMax = 0;
      peakDb = -120;
    }

    function reset() {
      smooth = null; amb = null; ambBuf.length = 0;
      noiseTop = null; lastGate = null;
      steadyT0 = 0; steadyMin = 0; steadyMax = 0;
      inContact = false; holdStart = 0; exitStart = 0; needReset = false;
      contactStart = 0; peakDb = -120; cur = null;
      strokes = []; lastStart = 0; lastGap = 0; lastEnd = 0; gapDrops = 0;
      lastCur = null; mergedOffs = [];
      lastT = null; startedAt = null; muted = true; frame = 0;
      lastRel = 0; session = null; sessionNo = 0;
    }

    return {
      push: push,
      tick: tick,
      stats: stats,
      status: status,
      setThreshold: setThreshold,
      setGate: setGate,
      reset: reset,
      clearRound: clearRound,
      flush: flush,
      session: function () {
        return session ? {
          startedAt: session.start,
          lastAt: session.last,
          count: session.items.length
        } : null;
      },
      options: o,
      strokes: function () { return strokes.slice(); }
    };
  }

  return { create: create, DEFAULT_OPTIONS: DEFAULTS, median: median, percentile: percentile };
}));
