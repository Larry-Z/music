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
| 节奏训练 `#rhythm` | 常用扫弦节奏型，以及可选择音色、小节数并逐小节编辑和弦、扫弦的自定义循环 | `web/js/rhythm.js` + `internal/rhythm` |
| 和弦库 `#chords` | 尤克里里（标准 G-C-E-A）42 个 + 吉他（标准 EADGBE）49 个常用和弦指法图，点击试听 | `web/js/chords.js` + `internal/chord` |

架构要点：

- **单二进制**：`main.go` 用 `//go:embed all:web` 把整个前端打进可执行文件，前端资源由 Go 的 `net/http` 提供。
- **Go 只做两件事**：提供静态资源、提供只读 JSON 数据（和弦库、节奏型）。**Go 完全不碰音频**。
- **音频全部在浏览器**：麦克风采集、基频检测、节拍器点击音、扫弦/拨弦合成都由 Web Audio API 完成，不依赖任何第三方 JS 库，也不加载任何音频素材文件。
- **数据单一来源**：和弦与节奏型定义在 Go 侧（`internal/chord`、`internal/rhythm`），前端通过 API 拉取。不要在 JS 里复制一份。
- **共享数据加载**：`web/js/data.js` 的 `MusicData.load()` 缓存页面内的请求 Promise，节奏训练与和弦库共用一次 `/api/chords` 请求；失败后清除缓存，允许后续重试。
- **唯一时序原语**：`Metronome.createClock`（前瞻式步进时钟）是全局唯一的时间调度器，节奏训练器复用它。新增任何定时播放功能都应复用它，不要用裸 `setInterval` 排音频。停止走带时还要通过 `MusicAudio.cancelGroup()` 取消已经排进音频线程的声音。

## 2. 构建与命令

```bash
go run .                       # 默认监听 http://localhost:8080
go run . -addr :9000           # 换端口
go run . -web web              # 开发模式：前端从磁盘读取，改完刷新即可，无需重新编译
go build -o music .            # 构建单文件二进制（含内嵌前端）
go build -ldflags "-X main.version=1.2.3" -o music .   # 注入版本号，显示在页脚与 /api/health
go test ./...                  # Go 测试
node --test tests/*.test.js     # 全部前端回归验证，无需安装依赖
node scripts/render-audio.js /tmp/music-audio-preview  # 需服务运行，导出扫弦音样例
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
| GET | `/css/*`、`/js/*` | 内嵌模式使用 `no-cache` + 内容 ETag；磁盘开发模式使用 `no-store` |
| GET | `/api/health` | `{"status":"ok","version":"dev"}`，使用 `no-store` |
| GET | `/api/chords` | `{instruments[], qualities[], chords[]}`，见 `chord.NewLibrary`；`instruments[].openMidi` 为按物理弦序排列的空弦 MIDI 音高，`chords[].instrument` 指向所属乐器，`chords[].baseFret` 供高把位指法图使用；使用 `no-cache` + 内容 ETag |
| GET | `/api/rhythms` | `{strokeLegend[], patterns[]}`，见 `rhythm.NewLibrary`；使用 `no-cache` + 内容 ETag |

两个数据接口在创建 handler 时预先编码，后续请求复用固定 JSON。ETag 匹配时返回无响应体的 `304`，HEAD 同样返回校验信息；资源内容变化后 ETag 随之改变。

前端用 URL hash 做面板路由（`#tuner` / `#metronome` / `#rhythm` / `#chords`），由 `web/js/main.js` 的 `activate()` 处理。
切换面板时会停止所有非当前面板的走带、和弦试听与麦克风采集，避免后台继续出声或占用麦克风。

## 4. 代码风格

Go：

- 严格 `gofmt`（tab 缩进），`gofmt -l .` 必须为空；提交前跑 `go vet ./...`。
- 布局：`main.go` 在仓库根（`package main`），业务数据放在 `internal/<域>` 下，每个包单一职责。
- 注释用**英文**，导出标识符必须有文档注释；面向用户的字符串（和弦类型中文名、节奏型名称与描述）用中文，集中在数据表里，不要散落在逻辑中。
- JSON 字段用小写单词或 camelCase（`nameEn`、`timeSignature`、`strokeLegend`）。
- 错误处理：只读接口不 panic；健康接口由 `writeJSON` 编码，编码失败只记日志；固定数据由 `newJSONHandler` 在启动时编码，失败则返回启动错误。日志用 `log.Printf`，前缀 `music:`。

JavaScript（`web/js/`）：

- 每个文件是一个 IIFE 模块：`(function (global) { 'use strict'; ... })(window)`，通过 `global.Xxx = {...}` 暴露。
- 现有模块：`MusicAudio`（音频原语）、`MusicData`（共享数据加载）、`Tuner`、`Metronome`、`Rhythm`、`Chords`；`main.js` 只负责初始化与标签页，不要往里塞业务逻辑。
- 刻意使用 ES5 风格（`var` + 函数声明），不使用 ES module / import，也不引入任何第三方库。
- 代码注释与所有界面文案用**中文**。
- DOM 通过 `document.getElementById` 直接引用，固定 id 定义在 `web/index.html`；每个模块在 `init()` 里抓取并缓存到模块级 `el` 对象。自定义循环编辑器的动态控件由 `renderLoop()` 生成后缓存，播放时复用缓存点亮小节与细分格。
- 新面板的接入方式：在 `index.html` 加 `<section class="panel" id="panel-xxx">` 与对应 `<script>`，在 `main.js` 的 `PANELS` 数组和 `init()` 里各加一项。

CSS：

- 单文件 `web/css/style.css`，设计变量集中在 `:root`（深色底 + 冷色强调 `--accent` / `--accent-2`），新样式复用变量，不要写死颜色。
- 布局优先用 flex / grid + `minmax` 自适应，不写媒体查询以外的断点魔法值。
- 操作区 `.actions` 按控件底边对齐，带上方标签的下拉框与旁边按钮使用同一条底边。

命名：

- 和弦 id 用和弦名（`C`、`Bb`、`Gm7`），根音用升号表示（`A#` 而非 `Bb`，显示时再由 `ROOT_LABEL` 映射）。不同乐器可以有同名和弦，唯一键是 `instrument + "/" + name`。
- 和弦数据按乐器分文件：`internal/chord/ukulele.go`、`internal/chord/guitar.go`。数组顺序 = 指法图从左到右 = 最粗的弦在前（尤克里里 4→1 弦，吉他 6→1 弦）。
- 节奏型 id 用 kebab-case（`folk-ddu-udu`、`six-eight-folk`）。
- 节奏型 `instrument` 只允许 `guitar` / `ukulele` / `both`。

## 5. 测试

Go 测试与源码同目录，前端回归验证使用 Node 内置的 `node:test`：

- `main_test.go`：用 `httptest` 打真实路由。`newHandler("")` 测内嵌资源，`newHandler("web")` 测磁盘模式；`/api/chords` 会校验乐器数量、弦数与指法、MIDI 音高长度一致，还会验证 ETag、条件请求、HEAD 和磁盘资源刷新。
- `internal/chord/chord_test.go`：**和弦音校验**、音名推导、指法可弹性、和弦名唯一、横按一致性、`BaseFret` 计算。
- `internal/rhythm/rhythm_test.go`：校验步数与拍号一致、记谱符号合法、重音有效、id 唯一。
- `tests/frontend.test.js`：用可控 DOM、音频与时钟验证漏拍恢复、高速扫弦、停止时取消声音、空格重复触发、共享请求与失败重试、接口调弦、麦克风请求取消和拨弦结算；还会检查两种乐器在 44.1/48 kHz 下的合成音高、泛音与衰减差异、上扫保留低弦共鸣，以及高速混音峰值。`tests/browser-harness.js` 提供共用音频桩。运行需要 Node，网站构建与运行不需要 Node。
- `tests/rhythm-loop.test.js`：验证自定义小节和弦与扫弦独立生效、循环与播放清理、编辑时取消旧排程、拍号与细分映射、模板与音色切换、小节数量增减和范围校验、1/3/8/32 小节的循环边界、旧四小节版本兼容与刷新恢复；还覆盖命名保存的快照独立性、载入、更新与删除、名称验证和文本渲染、存储失败及不兼容版本保留。

**修改数据表时必须保持以下不变量**（测试会失败）：

- **和弦音校验（最重要的一条）**：每个指法实际发出的音（按该乐器调弦 + 品位推导，跳过不弹的弦）必须全部属于该和弦类型的音程集合，并且必须包含根音与决定性质的音（三音、七音等）。这条能抓出「指法写错 / 和弦名标错」——例如尤克里里的 E 曾经误写成 `1-4-4-4`，实际发的是 E-G#-C#（E6）而不是 E 大三和弦。
- 节奏型 `len(Steps) == Beats * Subdivision * Bars`，`Subdivision ∈ {1,2,3,4}`。
- `Accents` 非空、必须包含第 0 步（首拍重音）、下标在范围内。
- 和弦 `len(Frets) == len(Fingers) == 该乐器弦数`，每个品位在 `[-1, 7]`；按弦（fret > 0）必须有手指编号（1–4），空弦 / 不弹（fret <= 0）不得有手指编号。
- `Barre > 0` 时该品位至少覆盖 2 根弦。
- 每个和弦至少有 3 个不同音名。
- `BaseFret >= 1`，且最高品位必须落在 `[BaseFret, BaseFret + displayFrets - 1]` 窗口内。

前端不引入第三方测试框架；回归用例可脱离浏览器运行，真实麦克风与听感仍需浏览器手测。`tuner.js` 与 `chords.js` 导出以下函数供验证：

- `window.Tuner.analyze()`：跑一帧检测（含拨弦结算逻辑），配合 `window.Tuner.state`（可读写 `analyser` / `buffer` / `running` / `preset` / `mode`）可完整模拟「拨弦 → 衰减 → 结算」。
- `window.Tuner.detectPitch(buf, sampleRate, fmin, fmax)`、`window.Tuner.freqToNote(freq, refA)`、`window.Tuner.midiToFreq`、`window.Tuner.labelFor(midi)`。
- `window.Chords.diagram(chord)` 返回指法图的 SVG 字符串；`window.Chords.chordFreqs(chord, instruments)` 返回该指法的发音频率。`instruments` 使用接口数据，省略时使用和弦库已加载的数据；未知乐器或弦数不匹配时返回空数组。

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
- 节拍器与节奏训练的 BPM 分别保存在 `localStorage` 的 `music.metronome.bpm`、`music.rhythm.bpm`，首次打开默认均为 75。自定义循环模式、音色对应的乐器、拍号、细分、所有小节的和弦与扫弦格保存在 `music.rhythm.loop`；加载后验证乐器、和弦、拍号、步数与符号，损坏或不兼容的数据回退到默认设置。其他界面设置仍只存在于页面内存中。持久化是纯前端行为，不涉及后端。
- 命名保存的自定义循环版本保存在 `music.rhythm.savedLoops`，结构为 `{version: 1, items: [{id, name, bpm, loop}]}`。草稿自动保存与命名版本互相独立，载入复制版本并恢复速度，更新只覆盖当前载入且选中的版本；删除保留当前草稿。名称最多 60 个字，重复名称需改名或载入后更新，用户名称用 DOM 文本属性呈现。存储写入成功后才更新内存中的版本列表；失败提示用户，不伪报成功。不兼容版本保留在列表，禁止载入但允许删除。
- 调弦预设表在 `web/js/tuner.js` 的 `PRESETS`：新增一个 `[显示名, 音名, 八度]` 列表即可，界面下拉框自动生成。
- 新增和弦：在 `internal/chord/ukulele.go` 或 `internal/chord/guitar.go` 的数组里加一行（`name/root/quality/frets/fingers/barre`），音名与 `BaseFret` 分别由 `Notes()` / `baseFret()` 自动推导，不要手写。加完必须跑 `go test ./internal/chord/`，音程校验会告诉你指法是否真的构成该和弦。
- 新增乐器：在 `internal/chord/chord.go` 的 `instruments` 里加一项（`Key` / `Label` / `Tuning` / `Strings` / `OpenMIDI`），再建一个同名的数据文件并在 `All()` / `ForInstrument()` 里挂上；和弦库的筛选、指法图与试听都由接口数据驱动，前端不需要新增调弦表。Go 音程校验也从 `OpenMIDI` 推导音级，并验证它与 `Tuning` 的音名及八度一致。
- 新增节奏型：在 `internal/rhythm/rhythm.go` 的 `patterns` 里加一项，`Steps` 用 `cells("D- DU -U DU")` 紧凑记谱（空格仅为可读性，`D` 下扫 / `U` 上扫 / `x` 闷音 / `-` 空拍），并确认满足第 5 节的不变量。
- 和弦类型的中文名在 `chord.QualityLabel`，乐器中文名在 `Instrument` 的 `Label`；`qualities` 的顺序决定界面上筛选按钮的顺序。

## 8. 关键实现细节（改代码前先读）

- **基频检测**（`web/js/tuner.js` 的 `detectPitch`）：4096 点窗口 → 累积均值归一化差值函数（CMND）→ 取首个低于阈值 0.15 的周期 → 抛物线插值细化周期。`rms < 0.008` 视为静音，`clarity <= 0.5` 的结果丢弃。音准判定阈值是 `IN_TUNE_CENTS = 5`。
- **拨弦结算（重要）**：调音器不是「没声音就归零」。一次拨弦的读数累积在 `state.samples`，连续 `SILENT_FRAMES`（4 帧，约 240 ms）没有识别到有效音高就调用 `finalizeSession()` 结算：取样本中出现最多的目标音，丢掉前 `ATTACK_SKIP`（30%）的起音采样（起音瞬间音高偏高），用余下采样音分/频率的**中位数**作为最终音高，然后**冻结**读数并给出「偏高 / 偏低 / 音准正确」的结论，显示在 `#tuner-verdict`，直到下一次拨弦或复位。实时显示取最近 `LIVE_WINDOW`（3）个同目标音采样的中位数以抑制指针抖动。修改检测逻辑时不要退回「静音即 `resetReadout()`」的写法。
- **按弦模式 vs 自动模式**：自动模式直接显示十二平均律下的绝对音名；按弦模式把结果吸附到当前预设中最接近的弦，并用该弦的目标频率计算音分偏差。检测频率范围由预设各弦音高上下各留几个半音动态算出。
- **自动化验证调音器**：`Tuner.analyze()` 是帧循环 `frame()` 里的一次检测，已导出，配合 `Tuner.state` 可在 Node 里用假 DOM + 假 analyser 喂合成音，跑完整的「拨弦 → 衰减 → 结算」流程，不需要浏览器和麦克风。
- **前瞻式调度**（`Metronome.createClock`）：每 25 ms 轮询一次，把未来 120 ms 内的步骤按 `AudioContext.currentTime` 提前排进音频线程。卡顿后跳过已过期步骤，按当前步长保留拍位；单次回调最多尝试排程 4 次，避免集中补播或长循环。`onSkip` 清理旧声音与 UI 队列，`onStep(step, time, duration)` 同时提供步长供扫弦使用。`secondsPerStep` 是函数，所以运行中改 BPM 会在下一步生效。两个走带的空格快捷键均忽略键盘自动重复事件。
- **视听同步**：两个走带都维护一个 `pending` 队列，把「已排程未响」的事件按音频时间排序，再用 16 ms 的 `setInterval` 取出音频时间已过去的事件来点灯（`paintPending`）。**不要用 UI 定时器直接决定发声时刻**，否则会抖。
- **自定义循环**：`Rhythm.state.loop` 保存统一的乐器、拍号、细分与 1–32 个独立小节，默认 4 个；数量以 `loop.bars.length` 为准。每小节包含和弦名、独立 `steps` / `accents` 数组和模板 id；和弦始终按当前乐器从接口库查找。播放将累计步号对当前小节数对应的总步数取模，再定位小节与格子，复用 `Metronome.createClock` 调度。编辑、清空、切换乐器/拍号/细分或练习模式先停止走带并取消已排程声音，BPM 修改仍支持运行中生效。
- **循环编辑**：点击格子按 D → U → x → - 切换；每小节可独立套用兼容模板，较粗的模板按拍内位置填入更细的网格。左侧选择模板不会覆盖已有循环，只有点击「用左侧节奏型填充所有小节」才统一应用它的拍号、细分与扫弦，保留各小节的和弦。修改细分按拍内位置映射动作，降低细分时同一格的动作会合并；新增拍子的默认格为空拍。初次进入自定义默认使用四小节 C–Am–F–G，缺少某个和弦时使用当前有效和弦。
- **音色与小节数**：界面「音色」选择对应木吉他钢弦或尤克里里尼龙弦，并同步使用对应乐器的调弦、指法和合成参数。小节数输入只接受 1–32 的整数；增加时深拷贝末小节的和弦、扫弦和重音，减少时截去末尾，已有小节保留。数量与音色修改前停止走带并取消旧声音，修改后自动保存草稿；命名版本随 `loop` 一并保存。旧版本的四小节数组可以直接载入，无需迁移。
- **声音合成**（`web/js/audio.js`）：节拍器用振荡器 + 指数包络（三种音色在 `SOUNDS` 里）；扫弦仍使用 Karplus-Strong 琴弦反馈模型。触弦位置与弦材质决定初始泛音，反馈损耗决定自然衰减；吉他使用较丰富的钢弦泛音与低频琴体响应，尤克里里使用更柔和、衰减更快的尼龙弦泛音与较高的琴体共鸣。几毫秒的拨片/指甲触弦噪声和多段琴体滤波直接合入拨弦缓冲，音量包络只负责起音、接管与末尾淡出，避免重复压短延音。反馈低通的环路延迟通过播放速率补偿，起音有很小的音高回落。调用时必须传入 `instrument`，不要按弦数猜乐器。吉他 / 尤克里里最长保留约 2.6 / 1.7 秒弦音，缓冲缓存最多 48 项；声音按 `metronome` / `rhythm` / `chord-preview` 分组，停止时取消对应分组。
- **扫弦细节**：下扫按物理弦序发声，吉他 / 尤克里里基础间隔约 12 / 9 ms；上扫反向，基础间隔约 8 / 6 ms，主要轻扫最高侧的 4 / 3 根弦，未触碰的低侧弦保持共鸣。每根弦有独立的弦序标识，在实际触弦时刻接管自己的旧音，同音高的两根弦也独立释放；换和弦先收住不属于新指法的旧音。起音、释放和末尾淡出使用到零的线性包络，避免突然截断波形；普通扫弦释放约 35 ms。弦间隔、力度、触弦位置有小幅变化，累计步号先打散再选取最多 4 个缓存变体，避免每次下扫重复同一变体。闷音 `x` 快速收住共鸣并发出短促噪声，空拍保持自然延音。
- **上下扫音色**：方向进入每根弦的合成参数和缓存键。下扫保留较多低弦能量，泛音稍圆润；上扫采用更明亮的泛音、较短的触弦声和较快起音，减少低频琴体成分。十六分的轻触调整叠加在方向参数上，两个方向仍有音色区别。单独拨弦沿用原乐器参数；方向回归使用相同音高与音量验证泛音差异与音准。`render-audio.js` 的 `*-down-up.wav` 以相同输入音量播放下、上、下、上四次，便于试听。
- **十六分扫弦**：`Rhythm` 调用 `MusicAudio.stroke` 时传入 `{subdivision, position}`，节奏型与自定义循环共用。四等分时缩短下扫/上扫展开至基础值的约 55%/65%，整体最多占一步的 65%；每根旧弦在对应触弦时刻约 14 ms 淡出，并限制为步长的 22%，减少密集叠加。非重音格根据拍内位置减轻力度，并使用较柔和的泛音、较弱的触弦噪声与稍缓的起音；高速八分音符有明确的细分信息时不套用十六分处理。未提供细分信息的音频原语调用仅在步长不超过 125 ms 时启用密集扫弦处理。
- **和弦试听**：`internal/chord` 提供品位与 `instruments[].openMidi`，频率换算仍在前端，由 `Chords.chordFreqs(chord, instruments)` 按和弦自己的乐器换算。节奏训练器复用这个函数并传入自己的接口数据，避免依赖和弦面板的初始化顺序，**不要在 JS 中另写调弦表**。标准尤克里里是 re-entrant 调弦，4 弦 G 比 3 弦 C 高，下扫按弦序（4→1 弦）发音。
- **指法图**（`web/js/chords.js` 的 `diagram`）：全部内联 SVG，无图片资源。弦数由 `chord.frets.length` 决定（4 或 6），间距与宽度自适应。`baseFret > 1` 时指法图从该品位起显示，左侧标 `nfr`，点的行号是 `fret - baseFret + 1`；`baseFret` 由 Go 侧的 `baseFret()` 按「最高品位是否超出 1–5 品」自动算出，前端不要自己重算。横按矩形从第一个到最后一个使用该品位的弦之间绘制，因此像 `Cm = x35543` 这类「食指横按 + 其余手指按更高品位」的指法也能正确呈现。
- **和弦筛选**：乐器、根音、类型三个筛选器都由接口数据生成；切换乐器时根音筛选会重置为「全部调」（原调在新乐器下可能不存在），类型筛选保留。

离线音频验证：`scripts/render-audio.js` 从本地服务读取真实和弦与节奏数据，用共用音频桩导出两种乐器的单次扫弦、75 BPM 伴奏与 75/120/180 BPM 连续十六分 WAV，并报告未归一化的混音峰值。导出文件仅用于试听与验证，网站不加载这些文件。该导出器用线性插值模拟播放速率，最终听感仍以浏览器播放为准。音频回归还验证逐弦接管、重复音高独立释放、十六分弱格与八分区别、变体缓存和空拍延音。
