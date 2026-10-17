# AGENTS.md

本文件面向在此仓库工作的 agent 与开发者，说明架构、约定与常用命令。
内容以仓库中实际存在的代码为准；改动代码时请同步更新本文件。

## 1. 项目概览

一个吉他 / 尤克里里练习网站，Go 后端 + 原生前端，**没有前端构建步骤**。

四大功能，前端各自独立成一个模块：

| 面板 | 作用 | 关键实现 |
| --- | --- | --- |
| 调音器 `#tuner` | 麦克风识别绝对音高，音准显示绿色，偏低/偏高给左右提示 | `web/js/tuner.js`，YIN 风格自相关基频检测 |
| 节拍器 `#metronome` | 30–260 BPM、任意拍号、四分/八分/三连音/十六分细分、首拍重音、Tap 测速 | `web/js/metronome.js`，前瞻式调度 |
| 节奏训练 `#rhythm` | 常用吉他 / 尤克里里扫弦节奏型，只播放和弦扫弦音供跟弹 | `web/js/rhythm.js` + `internal/rhythm` |
| 和弦库 `#chords` | 尤克里里（标准 G-C-E-A）42 个 + 吉他（标准 EADGBE）49 个常用和弦指法图，点击试听 | `web/js/chords.js` + `internal/chord` |

架构要点：

- **单二进制**：`main.go` 用 `//go:embed all:web` 把整个前端打进可执行文件，前端资源由 Go 的 `net/http` 提供。
- **Go 只做两件事**：提供静态资源、提供只读 JSON 数据（和弦库、节奏型）。**Go 完全不碰音频**。
- **音频全部在浏览器**：麦克风采集、基频检测、节拍器点击音、扫弦/拨弦合成都由 Web Audio API 完成，不依赖任何第三方 JS 库，也不加载任何音频素材文件。
- **数据单一来源**：和弦与节奏型定义在 Go 侧（`internal/chord`、`internal/rhythm`），前端通过 API 拉取。不要在 JS 里复制一份。
- **唯一时序原语**：`Metronome.createClock`（前瞻式步进时钟）是全局唯一的时间调度器，节奏训练器复用它。新增任何定时播放功能都应复用它，不要用裸 `setInterval` 排音频。停止走带时还要通过 `MusicAudio.cancelGroup()` 取消已经排进音频线程的声音。

## 2. 构建与命令

```bash
go run .                       # 默认监听 http://localhost:8080
go run . -addr :9000           # 换端口
go run . -web web              # 开发模式：前端从磁盘读取，改完刷新即可，无需重新编译
go build -o music .            # 构建单文件二进制（含内嵌前端）
go build -ldflags "-X main.version=1.2.3" -o music .   # 注入版本号，显示在页脚与 /api/health
go test ./...                  # 全部测试
go test ./internal/chord/ -run TestNotes -v            # 单个测试
gofmt -l .                     # 必须无输出
go vet ./...
```

前端没有 npm / 打包器 / 转译器：

- 改 `web/` 下的文件后，**默认模式（内嵌）需要重新 `go build` 才生效**；用 `-web web` 启动则直接刷新浏览器。
- 浏览器控制台就是前端唯一的调试手段，没有 source map。

命令行参数（`main.go`）：

- `-addr`：监听地址，默认 `:8080`。
- `-web`：非空时用 `os.DirFS` 从该目录提供前端，替代内嵌副本；仅供本地开发，不要指向不可信目录。

## 3. HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 单页应用外壳 `web/index.html`，响应头带 `Cache-Control: no-store` |
| GET | `/css/*`、`/js/*` | 静态资源 |
| GET | `/api/health` | `{"status":"ok","version":"dev"}` |
| GET | `/api/chords` | `{instruments[], qualities[], chords[]}`，见 `chord.NewLibrary`；`chords[].instrument` 指向所属乐器，`chords[].baseFret` 供高把位指法图使用 |
| GET | `/api/rhythms` | `{strokeLegend[], patterns[]}`，见 `rhythm.NewLibrary` |

前端用 URL hash 做面板路由（`#tuner` / `#metronome` / `#rhythm` / `#chords`），由 `web/js/main.js` 的 `activate()` 处理。
切换面板时会停止所有非当前面板的走带、和弦试听与麦克风采集，避免后台继续出声或占用麦克风。

## 4. 代码风格

Go：

- 严格 `gofmt`（tab 缩进），`gofmt -l .` 必须为空；提交前跑 `go vet ./...`。
- 布局：`main.go` 在仓库根（`package main`），业务数据放在 `internal/<域>` 下，每个包单一职责。
- 注释用**英文**，导出标识符必须有文档注释；面向用户的字符串（和弦类型中文名、节奏型名称与描述）用中文，集中在数据表里，不要散落在逻辑中。
- JSON 字段用小写单词或 camelCase（`nameEn`、`timeSignature`、`strokeLegend`）。
- 错误处理：只读接口不 panic；`writeJSON` 统一编码响应，编码失败只记日志。日志用 `log.Printf`，前缀 `music:`。

JavaScript（`web/js/`）：

- 每个文件是一个 IIFE 模块：`(function (global) { 'use strict'; ... })(window)`，通过 `global.Xxx = {...}` 暴露。
- 现有模块：`MusicAudio`（音频原语）、`Tuner`、`Metronome`、`Rhythm`、`Chords`；`main.js` 只负责初始化与标签页，不要往里塞业务逻辑。
- 刻意使用 ES5 风格（`var` + 函数声明），不使用 ES module / import，也不引入任何第三方库。
- 代码注释与所有界面文案用**中文**。
- DOM 通过 `document.getElementById` 直接引用，id 定义在 `web/index.html`；每个模块在 `init()` 里一次性抓取并缓存到模块级 `el` 对象。
- 新面板的接入方式：在 `index.html` 加 `<section class="panel" id="panel-xxx">` 与对应 `<script>`，在 `main.js` 的 `PANELS` 数组和 `init()` 里各加一项。

CSS：

- 单文件 `web/css/style.css`，设计变量集中在 `:root`（深色底 + 冷色强调 `--accent` / `--accent-2`），新样式复用变量，不要写死颜色。
- 布局优先用 flex / grid + `minmax` 自适应，不写媒体查询以外的断点魔法值。

命名：

- 和弦 id 用和弦名（`C`、`Bb`、`Gm7`），根音用升号表示（`A#` 而非 `Bb`，显示时再由 `ROOT_LABEL` 映射）。不同乐器可以有同名和弦，唯一键是 `instrument + "/" + name`。
- 和弦数据按乐器分文件：`internal/chord/ukulele.go`、`internal/chord/guitar.go`。数组顺序 = 指法图从左到右 = 最粗的弦在前（尤克里里 4→1 弦，吉他 6→1 弦）。
- 节奏型 id 用 kebab-case（`folk-ddu-udu`、`six-eight-folk`）。
- 节奏型 `instrument` 只允许 `guitar` / `ukulele` / `both`。

## 5. 测试

Go 测试是唯一的自动化测试，与源码同目录：

- `main_test.go`：用 `httptest` 打真实路由。`newHandler("")` 测内嵌资源，`newHandler("web")` 测磁盘模式；`/api/chords` 会校验乐器数量、每件乐器的弦数与 `Frets` 长度一致。
- `internal/chord/chord_test.go`：**和弦音校验**、音名推导、指法可弹性、和弦名唯一、横按一致性、`BaseFret` 计算。
- `internal/rhythm/rhythm_test.go`：校验步数与拍号一致、记谱符号合法、重音有效、id 唯一。

**修改数据表时必须保持以下不变量**（测试会失败）：

- **和弦音校验（最重要的一条）**：每个指法实际发出的音（按该乐器调弦 + 品位推导，跳过不弹的弦）必须全部属于该和弦类型的音程集合，并且必须包含根音与决定性质的音（三音、七音等）。这条能抓出「指法写错 / 和弦名标错」——例如尤克里里的 E 曾经误写成 `1-4-4-4`，实际发的是 E-G#-C#（E6）而不是 E 大三和弦。
- 节奏型 `len(Steps) == Beats * Subdivision * Bars`，`Subdivision ∈ {1,2,3,4}`。
- `Accents` 非空、必须包含第 0 步（首拍重音）、下标在范围内。
- 和弦 `len(Frets) == len(Fingers) == 该乐器弦数`，每个品位在 `[-1, 7]`；按弦（fret > 0）必须有手指编号（1–4），空弦 / 不弹（fret <= 0）不得有手指编号。
- `Barre > 0` 时该品位至少覆盖 2 根弦。
- 每个和弦至少有 3 个不同音名。
- `BaseFret >= 1`，且最高品位必须落在 `[BaseFret, BaseFret + displayFrets - 1]` 窗口内。

前端没有测试框架，验证方式是浏览器手测。为此 `tuner.js` 与 `chords.js` 刻意导出了纯函数，可脱离浏览器验证：

- `window.Tuner.analyze()`：跑一帧检测（含拨弦结算逻辑），配合 `window.Tuner.state`（可读写 `analyser` / `buffer` / `running` / `preset` / `mode`）可完整模拟「拨弦 → 衰减 → 结算」。
- `window.Tuner.detectPitch(buf, sampleRate, fmin, fmax)`、`window.Tuner.freqToNote(freq, refA)`、`window.Tuner.midiToFreq`、`window.Tuner.labelFor(midi)`。
- `window.Chords.diagram(chord)` 返回指法图的 SVG 字符串；`window.Chords.chordFreqs(chord)` 返回该指法的发音频率（已按和弦自己的乐器调弦换算）。

要在 Node 里跑这些函数，需要造一个最小 DOM 桩（`document.getElementById` 返回带 `textContent` / `innerHTML` / `className` / `style` / `classList` 的假元素、`addEventListener` 空实现、`window` 指向沙箱自身），再用 `vm.runInContext` 加载文件；假 analyser 只需实现 `getFloatTimeDomainData(buf)` 与 `context.sampleRate`。

注意：无头 Chrome 下 `getUserMedia` 不会真正返回麦克风流（会停在「正在请求麦克风权限…」），所以真实麦克风链路只能手动验证。

## 6. 安全与数据保护

- **麦克风**：`getUserMedia` 只在 `#tuner` 面板、用户点击「开始聆听」后调用，且只在安全上下文（`https` 或 `localhost`）可用。音频流**不录制、不上传、不落盘**，只在本页内存中做 4096 采样点的实时分析；离开页面或点「停止聆听」立即 `track.stop()`。
- **服务端是只读的**：只有 GET 路由，不写文件、不写数据库、不保存任何用户输入、没有登录态与 Cookie。**新增会改变状态的接口前，必须先补上对应的防护（CSRF、体积与频率限制、输入校验）**，不要直接把写接口挂到现有 mux 上。
- **静态资源**：`http.FileServer` 服务于内嵌 FS 或 `-web` 指定目录。`-web` 会暴露任意目录内容，仅限本地开发使用，禁止指向不可信路径或生产环境。
- **响应头与超时**：HTML 外壳带 `Cache-Control: no-store`；`http.Server` 已设置 `ReadHeaderTimeout` / `ReadTimeout` / `WriteTimeout` / `IdleTimeout`，不要移除。
- **日志**：访问日志只记录方法、路径、状态码、耗时，不记录请求体或任何用户数据。
- **浏览器自动播放策略**：`AudioContext` 必须在用户手势中 `resume()`，由 `MusicAudio` 在首次 `pointerdown` / `keydown` 时自动解锁，不要改成页面加载即播放。
- **参考音高**：A4 可在 415–466 Hz 之间调整，前端已做范围钳制。

## 7. 配置

- 运行时配置只有两个命令行参数：`-addr`、`-web`（见第 2 节）。**没有环境变量、没有配置文件、没有密钥。**
- 版本号是编译期变量 `main.version`（默认 `dev`），用 `-ldflags "-X main.version=..."` 覆盖。
- 节拍器与节奏训练的 BPM 分别保存在 `localStorage` 的 `music.metronome.bpm`、`music.rhythm.bpm`，首次打开默认均为 75；其他界面设置仍只存在于页面内存中，刷新即恢复默认值。持久化是纯前端行为，不涉及后端。
- 调弦预设表在 `web/js/tuner.js` 的 `PRESETS`：新增一个 `[显示名, 音名, 八度]` 列表即可，界面下拉框自动生成。
- 新增和弦：在 `internal/chord/ukulele.go` 或 `internal/chord/guitar.go` 的数组里加一行（`name/root/quality/frets/fingers/barre`），音名与 `BaseFret` 分别由 `Notes()` / `baseFret()` 自动推导，不要手写。加完必须跑 `go test ./internal/chord/`，音程校验会告诉你指法是否真的构成该和弦。
- 新增乐器：在 `internal/chord/chord.go` 的 `instruments` 里加一项（`Key` / `Label` / `Tuning` / `Strings` / `openPitch`），再建一个同名的数据文件并在 `All()` / `ForInstrument()` 里挂上；前端不需要改代码，乐器筛选按钮和指法图弦数都由接口数据驱动。
- 新增节奏型：在 `internal/rhythm/rhythm.go` 的 `patterns` 里加一项，`Steps` 用 `cells("D- DU -U DU")` 紧凑记谱（空格仅为可读性，`D` 下扫 / `U` 上扫 / `x` 闷音 / `-` 空拍），并确认满足第 5 节的不变量。
- 和弦类型的中文名在 `chord.QualityLabel`，乐器中文名在 `Instrument` 的 `Label`；`qualities` 的顺序决定界面上筛选按钮的顺序。

## 8. 关键实现细节（改代码前先读）

- **基频检测**（`web/js/tuner.js` 的 `detectPitch`）：4096 点窗口 → 累积均值归一化差值函数（CMND）→ 取首个低于阈值 0.15 的周期 → 抛物线插值细化周期。`rms < 0.008` 视为静音，`clarity <= 0.5` 的结果丢弃。音准判定阈值是 `IN_TUNE_CENTS = 5`。
- **拨弦结算（重要）**：调音器不是「没声音就归零」。一次拨弦的读数累积在 `state.samples`，连续 `SILENT_FRAMES`（4 帧，约 240 ms）没有识别到有效音高就调用 `finalizeSession()` 结算：取样本中出现最多的目标音，丢掉前 `ATTACK_SKIP`（30%）的起音采样（起音瞬间音高偏高），用余下采样音分/频率的**中位数**作为最终音高，然后**冻结**读数并给出「偏高 / 偏低 / 音准正确」的结论，显示在 `#tuner-verdict`，直到下一次拨弦或复位。实时显示取最近 `LIVE_WINDOW`（3）个同目标音采样的中位数以抑制指针抖动。修改检测逻辑时不要退回「静音即 `resetReadout()`」的写法。
- **按弦模式 vs 自动模式**：自动模式直接显示十二平均律下的绝对音名；按弦模式把结果吸附到当前预设中最接近的弦，并用该弦的目标频率计算音分偏差。检测频率范围由预设各弦音高上下各留几个半音动态算出。
- **自动化验证调音器**：`Tuner.analyze()` 是帧循环 `frame()` 里的一次检测，已导出，配合 `Tuner.state` 可在 Node 里用假 DOM + 假 analyser 喂合成音，跑完整的「拨弦 → 衰减 → 结算」流程，不需要浏览器和麦克风。
- **前瞻式调度**（`Metronome.createClock`）：每 25 ms 轮询一次，把未来 120 ms 内的步骤按 `AudioContext.currentTime` 提前排进音频线程。`secondsPerStep` 是函数，所以运行中改 BPM 会在下一步生效。
- **视听同步**：两个走带都维护一个 `pending` 队列，把「已排程未响」的事件按音频时间排序，再用 16 ms 的 `setInterval` 取出音频时间已过去的事件来点灯（`paintPending`）。**不要用 UI 定时器直接决定发声时刻**，否则会抖。
- **声音合成**（`web/js/audio.js`）：节拍器用振荡器 + 指数包络（三种音色在 `SOUNDS` 里）；扫弦用 Karplus-Strong 拨弦合成（`pluckBuffer` / `pluck` / `strum`）叠加带通滤波噪声（`noiseBurst`）。尤克里里使用单独的尼龙弦参数（柔化起振、较低的高频截止、较弱的拨片噪声与中频琴体共鸣），吉他保留较亮的钢弦参数；调用扫弦接口时必须传入和弦的 `instrument`，不要按发音弦数猜乐器。下扫从粗弦到细弦逐根发声（约 20 ms / 弦），上扫从细弦到粗弦逐根发声（约 16 ms / 弦）；闷音 `x` 只发噪声并收住正在共鸣的弦。节奏训练的尤克里里 / 吉他弦音分别保留约 1.4 / 1.8 秒自然共鸣，下一次扫弦会快速释放上一组弦音，避免长尾叠加失真。拨弦缓冲带有小型缓存，走带声音按 `metronome` / `rhythm` / `chord-preview` 分组，停止时应取消对应分组。
- **和弦试听**：`internal/chord` 只给品位，频率换算在前端。调弦表在 `web/js/chords.js` 的 `STRING_MIDI`（尤克里里 `[67,60,64,69]` = G4-C4-E4-A4，吉他 `[40,45,50,55,59,64]` = E2-A2-D3-G3-B3-E4），由 `Chords.chordFreqs(chord)` 按和弦自己的乐器换算。节奏训练器直接复用这个函数，**不要再写第二份调弦表**。标准尤克里里是 re-entrant 调弦，4 弦 G 比 3 弦 C 高，下扫按弦序（4→1 弦）发音。
- **指法图**（`web/js/chords.js` 的 `diagram`）：全部内联 SVG，无图片资源。弦数由 `chord.frets.length` 决定（4 或 6），间距与宽度自适应。`baseFret > 1` 时指法图从该品位起显示，左侧标 `nfr`，点的行号是 `fret - baseFret + 1`；`baseFret` 由 Go 侧的 `baseFret()` 按「最高品位是否超出 1–5 品」自动算出，前端不要自己重算。横按矩形从第一个到最后一个使用该品位的弦之间绘制，因此像 `Cm = x35543` 这类「食指横按 + 其余手指按更高品位」的指法也能正确呈现。
- **和弦筛选**：乐器、根音、类型三个筛选器都由接口数据生成；切换乐器时根音筛选会重置为「全部调」（原调在新乐器下可能不存在），类型筛选保留。
