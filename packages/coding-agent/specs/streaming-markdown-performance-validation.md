# P1 流式 Markdown 修复与验收

日期：2026-10-14。基线：`main@a22814b9d` 的独立源码快照；候选：该提交上的当前未提交改动。实现与范围见 [spec](streaming-markdown-performance-spec.md)。没有 build、安装、commit 或 push。

结论：P1 的本机正确性、性能和内存门槛通过。全仓测试仍有 5 个已在基线复现的失败；真人视觉体验及其他设备不在本次通过范围。P2/P3 未实施。

## 修复

结束流时重建 Markdown 会丢失块布局缓存。中文流式期间跳过稳定块，原有 512 项字符宽度缓存也随之变冷；最后一次全量布局因此比未优化基线更慢。独立插桩在原候选结束帧观察到 336–381 次宽度缓存 miss、约 58K 字符重算，基线只有 9–53 次 miss。仅在诊断 loader 中扩大宽度缓存能消除 miss，支持这一判断。

现在结束流保留 Markdown 实例，仍重新执行最终 transformer、完整解析并核对块身份。32K 中文诊断结束帧降到 0.94–1.15ms，宽度缓存 miss 为 0；正式 TUI 对照见下表。最终 transformer 改写内容时仍生效。

同时修正以下问题：

- 1MiB 逻辑预算计入完整嵌套 token，命中时复用估算与 WeakRef；记录数组最多覆盖 4096 个顶层位置。
- 显式 invalidate 清理默认样式的 ANSI 前缀，避免可变主题回调留下旧颜色。
- 有节奏输出后的 resize 仍出现 16.40 → 19.86ms 的稳定回退。插桩确认主要是冷宽度缓存，预算计算另占约 0.9ms/次；保留实例解决 finish，但无法预热 resize。仅调整现有非 ASCII 宽度缓存上限 512 → 1024，不改计算或淘汰算法；补充实验 resize 降到 14.94ms，再以最终源码重跑主对照。
- 开发 spec 移到 `specs/`，避免成为公开文档导航中的孤立页；未放宽文档测试。

## 计时方法

Apple M2 Pro、Node v25.9.0、dark、100×30、128 UTF-16 code units/chunk，0 条历史消息。路径为 `AssistantMessageComponent → Markdown → ScrollView/VStack → TuiAltScreen → NullTerminal`。每类用 4K 样本预热，前 2K 更新不计入帧统计；每帧独立事件循环，避免 WeakRef 因同一 job 而强制存活。

基线/候选串行交替 5 轮，每次独立 Node 进程；表中各统计量分别取 5 次中位数。12 个 fixture 的 SHA-256 均一致。使用随代码保存的 `test/markdown-streaming-bench.ts`，并把同一文件复制到基线快照；基线快照通过 `git archive` 生成，不改变当前 checkout。计时运行未开启 profiler。该 fixture 与 spec 第 2 节早期实验不同，不能直接混用其绝对时间。

单位 ms；累计值不含预热、finish、steady、resize。

| 样本 | 字符数 | 累计：基线 → 候选 | P95：基线 → 候选 | 末四分之一平均：基线 → 候选 | finish：基线 → 候选 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 英文 | 8192 | 50.56 → 24.82 | 1.53 → 0.74 | 1.49 → 0.71 | 1.51 → 0.19 |
| 英文 | 32768 | 798.22 → 368.49 | 5.97 → 2.79 | 5.51 → 2.55 | 6.24 → 0.66 |
| 英文 | 65536 | 3346.66 → 1763.95 | 13.14 → 7.83 | 11.90 → 6.94 | 13.69 → 2.82 |
| 中文 | 8192 | 117.94 → 38.69 | 3.53 → 1.19 | 3.36 → 1.12 | 3.50 → 0.30 |
| 中文 | 32768 | 1897.44 → 634.61 | 14.50 → 4.78 | 13.30 → 4.41 | 16.66 → 1.16 |
| 中文 | 65536 | 9984.36 → 3741.81 | 46.03 → 18.92 | 41.75 → 16.05 | 47.86 → 9.90 |
| 混合 | 8192 | 55.69 → 21.78 | 1.69 → 0.65 | 1.63 → 0.62 | 1.68 → 0.17 |
| 混合 | 32768 | 893.66 → 346.07 | 6.68 → 2.61 | 6.22 → 2.44 | 6.80 → 0.56 |
| 混合 | 65536 | 3666.25 → 1654.42 | 14.05 → 7.65 | 12.94 → 6.66 | 14.66 → 3.07 |
| 开放代码 | 8192 | 118.11 → 114.65 | 3.67 → 3.57 | 3.52 → 3.37 | 3.77 → 0.09 |
| 开放代码 | 32768 | 2081.78 → 1922.63 | 17.13 → 13.81 | 15.24 → 12.81 | 17.51 → 0.14 |
| 开放代码 | 65536 | 9092.58 → 8453.41 | 35.20 → 34.10 | 32.40 → 31.46 | 34.81 → 36.18 |

主要门槛：32K 英文累计下降 53.8%；32K 混合累计下降 61.3%、P95 下降 60.9%；64K 中文 P95 下降 58.9%、末段平均下降 61.6%。单个开放代码块仍整体高亮；64K 时超出缓存载荷预算，结束帧也仍完整计算。

## 补充场景

100 条历史消息、512 字符/chunk、32K 内容的 5 次进程内重复中位数：中文累计 489.79 → 180.05ms，P95 14.67 → 5.16ms；混合累计 220.72 → 95.57ms，P95 6.47 → 2.77ms。历史消息没有抵消收益。这组按基线/候选先后运行，作为补充，不取代上面的交替主实验。

128K、512 字符/chunk 的 3 次压力测试：中文累计 11933.47 → 8114.13ms，P95 98.78 → 80.35ms；开放代码累计 9459.47 → 9428.68ms，P95 71.64 → 72.77ms。预算之外的块仍完整处理，不能把 P1 描述成无论文本多长都只处理尾部。

steady 平均约 0.03–0.08ms，候选相对基线的绝对增加均小于 0.05ms。最终主实验 8K 英文 resize 为 1.19 → 1.28ms，增加约 0.09ms、8.0%；其余主实验 resize 为改善或小幅波动，未超过 10% 回退门槛。

最终源码的 paced 场景串行交替 5 轮：32K 中文的 240 次计入统计的更新，实际 render 中位数 97 → 44，约合并 143 → 196 次；P95 16.87 → 5.84ms，累计 TUI 渲染 1093.43 → 171.18ms。resize 15.98 → 12.16ms，原先稳定回退已消除。到达间隔受事件循环阻塞影响，wall 1646.84 → 748.33ms 不是模型网络延迟预测。

## 内存与分配

100 条不同的 8K 混合消息经历 streaming → final，显式 GC 后的堆：

| 状态 | 基线 bytes | 候选 bytes |
| --- | ---: | ---: |
| 建立历史之前 | 14462344 | 14383352 |
| 保留 100 条消息 | 18972408 | 19231456 |
| 清空历史并 GC | 11538864 | 11464712 |

持有阶段候选比基线约多 0.25MiB；以各自起点扣除后差约 0.32MiB。弱引用槽位仍随活消息数量增加，每条约 73 个 WeakRef 的本样本并非“零额外常驻开销”。快照中 GC 后的 BlockRecord 数为 0；100 个 AssistantMessageComponent/Markdown 在清空后均降到 1，最后一个由 benchmark 的当前局部作用域保留，基线也相同。清空后堆低于起点来自全局/预热垃圾的回收，不能解释为负内存占用。

另测 100 条中文 8K 消息，覆盖扩大后的宽度缓存：保留堆 22151432 → 22444168 bytes，释放后 11831120 → 11673752 bytes；额外缓存仍为固定上限 512 项，可能继续持有最近字符串键，但没有保留消息对象或 AST。

独立 CPU/分配采样包含启动、预热、32K 中文与开放代码各一次及收尾；采样纳入已被 minor/major GC 回收的对象。估算累计分配 5817.40 → 4420.51MiB，下降约 24%；这是分配流量，不是同时存活的堆。该诊断只有一次，不能作为五轮性能表的替代。初次诊断的 token 结构比较 CPU self 占比约 2.5%；高亮栈仍显著，支持开放代码属于 P3，而非再叠加整块缓存。

## 正确性与交互

- 最终 TUI 定向回归：Markdown、visible-width、tab-width、truncate-to-width、wrap-ansi、regional-indicator-width 六个文件，共 138 项通过；其中 Markdown 90 项，包含稳定块高亮计数、逐前缀、后置链接定义、宽度/能力/主题失效、超过位置/字节预算回退。
- coding-agent 的 assistant-message、mermaid、syntax-highlight、documentation：4 文件、42 项通过；新增 finish/abort/error/length、重复 render、同文本 transform 和 model 变化用例。
- 独立基线 oracle：8 个语法 fixture × hyperlink 开关 × 1/25/80 列 × 默认/背景样式，枚举每个 UTF-16 边界并做前文替换；合计 6036 帧的完整 ANSI 行摘要全部一致。覆盖 Setext、后置引用、嵌套 task/list/fence、表格、LaTeX、CRLF、emoji/ZWJ/组合字符、转义与未知语言。
- 离线真实 CLI + 隔离 tmux：fullscreen/regular 均完整输出 180 个中文段落和代码块，到达最终 marker；fullscreen 在输出期间保留输入草稿，60×24 → 100×30 重排、PageUp/PageDown 回看成功；dark → light → dark 的 ANSI 改变而文本不变；Escape 保留部分回答并显示 Operation aborted。使用本地合成 provider，没有模型网络调用。
- `npm run check` 通过，未修改依赖、安装锁或公开 API。
- `./test.sh` 已完整运行，退出 1：只剩 2 个模型元数据断言与 3 个 Bun worker lifetime 断言失败，均在相同 HEAD 独立快照复现。coding-agent 296 文件、2730 项通过，另有 6 文件/50 项跳过。文档孤立页失败已消失。没有调整或跳过这 5 个失败的测试。

完整仓库测试与 tmux 操作在最后一次宽度缓存上限调整前完成；调整后重跑上述定向回归、ANSI 基线 oracle、性能/内存实验及 `npm run check`，没有重复全仓测试。

既有失败具体为 `anthropic-adaptive-thinking-models.test.ts` 缺失 Haiku 5.5、`supports-xhigh.test.ts` Sonnet 5.5 cacheRead 期望 0.1/实际 0.2，以及 `packages/codemode/test/worker-lifetime.test.ts` 的 Bun abort/timeout/close 三项。它们不经过本次 Markdown 代码。

未覆盖真实模型、真实终端字体/GPU、SSH、已安装 bundle、其他设备，以及变化中大列表内嵌代码的专项性能。tmux 检查证明 CLI 输入/布局/状态路径可运行，不等同于真人视觉验收。

## 复现入口

以下命令在 `packages/coding-agent` 执行；两份源码使用相同依赖、provider catalog 和 benchmark 文件，避免加载旧 dist。

```bash
node --import ./src/experimental/source-resolver.ts test/markdown-streaming-bench.ts --runs=5 --tui --json
node --import ./src/experimental/source-resolver.ts test/markdown-streaming-bench.ts --runs=5 --tui --history=100 --chunk=512 --sizes=32768 --kinds=chinese,mixed --json
node --import ./src/experimental/source-resolver.ts test/markdown-streaming-bench.ts --runs=3 --tui --chunk=512 --sizes=131072 --kinds=chinese,code --json
node --import ./src/experimental/source-resolver.ts test/markdown-streaming-bench.ts --runs=3 --paced --sizes=32768 --kinds=chinese --json
node --expose-gc --import ./src/experimental/source-resolver.ts test/markdown-streaming-bench.ts --memory --snapshots=/tmp/pi-markdown-heap
node --expose-gc --import ./src/experimental/source-resolver.ts test/markdown-streaming-bench.ts --memory --kinds=chinese --snapshots=/tmp/pi-markdown-heap-chinese
```

`--paced` 使用 2ms 到达间隔和真实 `requestRender` 合并，统计 TUI 实际渲染耗时；不含 `updateContent`，不能与 forced-render 的累计值直接比较。`--memory` 单独执行显式 GC 与 heap snapshot，不把采样开销混入性能表。JSON 保留每帧时间、每次运行、fixture hash、输出字节数、源码 URL 和运行环境。

本机原始证据保存于仓库忽略目录 `.artifacts/markdown-streaming-p1-20261014/`：`final-summary.json`、`final-ab-*.json`、`final-paced-ab-*.json`、`final-memory-*.json`、heap/CPU profiles、测试日志、tmux 捕获和候选源码 SHA-256。它不是提交内容或其他设备上的路径依赖；复现应使用仓库 benchmark 和上述命令。
