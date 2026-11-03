# 摸摸大肥鱼 Lite（dsh-pet-mic-lite）

用麦克风识别「摸一摸」这个动作，只做一件事：**数今天被摸了几次**，写在本地一个 JSON 文件里，让你的桌面宠物 / 角色自己去读。

手对着麦克风摸几下，停手 3 秒，这一段就结算成一次「摸摸」，`count` +1。不合成语音、不调用模型、不联网。

## 安装

```sh
dsh plugin add dsh-pet-mic-lite
```

从源码安装（本地目录 / tgz）：

```sh
dsh plugin add /path/to/dsh-pet-mic-lite
```

装好后打开 **设置 → 摸摸大肥鱼 Lite**，点「打开麦克风」并允许一次权限即可。

> 麦克风采集走浏览器的 `getUserMedia`，要求安全上下文 —— DSH 的 Web 界面跑在 `127.0.0.1` / `localhost`，天生满足。用局域网 IP 访问面板时浏览器会拒绝开麦。

## 它是怎么工作的

```
麦克风 getUserMedia → 每 10ms 一帧 dB → POST /frame → detector 判定
                                            ↓
                          手停 3 秒 → 这一段结算成一次「摸摸」
                                            ↓
                              count.json 的 count +1
```

判定核心 `detector.cjs` 不看绝对音量：它维护一个只在「没接触时」更新的环境基准（3 秒中位数），电平高出基准 `thDb` 且持续 `enterMs` 才算接触，掉到门限的 `exitRatio` 以下并持续 `exitMs` 才算离开。所以房间吵一点、麦克风增益大一点，都不用重调阈值。

## 数据：给你的角色读

**默认路径**：`~/.dsh-pet-mic-lite/count.json`（Windows 上是 `C:\Users\<你>\.dsh-pet-mic-lite\count.json`）

```json
{
  "note": "大肥鱼读这里：date 是今天，count 是今天被摸摸的次数，strokes 是被摸的总下数。跨天自动从 0 开始。",
  "date": "2026-11-02",
  "count": 12,
  "strokes": 87,
  "updatedAt": 1793615472187
}
```

| 字段 | 含义 |
|---|---|
| `date` | 本地时区的今天（`YYYY-MM-DD`） |
| `count` | 今天被摸摸的**次数**（手停 3 秒结算一次） |
| `strokes` | 今天被摸的**总下数**（另一个口径，顺带记的） |
| `updatedAt` | 最后一次结算的时间戳（毫秒） |

跨天自动归零（不清文件，直接覆盖）；写入是「写临时文件 + 原子改名」，断电不会留半个文件；文件坏了下次结算自然覆盖重来。

每次结算还会往同目录追加一行 `sessions-YYYY-MM-DD.jsonl`，记单次的下数、时长、风格，排查用。

## HTTP 路由

都挂在 `/plugins/dsh-pet-mic-lite` 下，且**只接受本机请求**（非 `127.0.0.1` / `::1` 一律 403）。

| 路由 | 说明 |
|---|---|
| `POST /frame` | 页面推电平帧 `{ levels: [[db, t], ...] }`，返回当前计数 |
| `GET /state` | 今日计数 + 实时电平状态 |
| `POST /reset` | 今日计数清零（调试 / 演示用） |

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-pet-mic-lite
  name: dsh-pet-mic-lite
  config:
    thDb: 9
    logDir: D:/dsh-data/pet-mic-lite
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不注册路由、不计数 |
| `thDb` | `9` | 高出环境基准多少 dB 算「手放上去」，可调 3–30 |
| `minStrokes` | `3` | 一段至少摸几下才算一次 |
| `minTouchMs` | `2000` | 或累计接触满多少毫秒（按住慢慢摸只有 1 下，也算真互动） |
| `sessionIdleMs` | `3000` | 手停多久结算这一段，可调 500–30000 |
| `logDir` | `~/.dsh-pet-mic-lite` | 计数与日志落盘目录 |
| `noiseFile` | 空 | 可选：指向一份含 `{ thDb, gateDb }` 的噪声校准 JSON，填了就替代默认阈值 |

阈值不合手就先调 `thDb`（房间安静就往小调，吵就往大调）；想固定一套量好的参数，就写进一个 `{ "thDb": 6, "gateDb": -61.7 }` 的 JSON，把路径填到 `noiseFile`。

## 面板

**设置 → 摸摸大肥鱼 Lite**，只有三样：麦克风开关、实时电平条、今天被摸了几次。「上次开着」记在 `localStorage`，窗口重开会自动续开；被系统拦下就清标记并提示手动点一次。

## 隐私

- 音频只在本机浏览器里算成一个 dB 数字，**不上传、不落盘、不合成**。
- 服务端只收到 `[[dB, 时间戳], ...]`，据此判定动作。
- 落盘的只有次数、下数和时间戳。
- 三个 HTTP 路由都只服务本机回环地址。

## 开发与测试

```sh
npm test    # 等价于 node test-count.mjs
```

不起 DSH，伪造 cordis 上下文跑完整链路：环境音 → 摸 4 下 → 停手结算 → `count=1` 落盘 → `/state` / `/reset` / 非本机 403，13 项断言。

## 许可

MIT。非 DeepSeek 官方插件；「大肥鱼」是本插件作者桌面宠物的名字，计数逻辑本身与任何角色无关 —— 你拿它数什么都行。
