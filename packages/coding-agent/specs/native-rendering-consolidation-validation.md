# Pi 1.5 原生渲染机制收敛与验收

日期：2026-11-02。上游基线：`3e0eec29f`；改前 fork：`0bbea92c3`。本地 `main` 已按用户要求 mixed reset 到上游，定制内容和本次修改均保留为未暂存改动，没有 commit、push 或重装。旧历史保存在 `refs/codex/backups/pi-before-native-consolidation-20261102-0bbea92c3`。

## 实现范围

- Markdown 恢复上游 `RenderedBlock`、raw 键弱 Map 和 resize 高亮复用；保留 1MiB／4096 项实际缓存载荷预算，以及终端 hyperlink 能力变化失效。删除递归 token 比较、AST 估算和按位置 WeakRef 数组。引用定义使用上游停用块复用的安全规则。
- Assistant 使用上游 `MarkdownSlot`，删除额外 Map、配置序列化和 acquireMarkdown；保留模型／padding／主题失效、Thinking renderer 生命周期、折叠时的 Markdown 和历史整条渲染缓存。
- Shell 分行、脚本折叠和 edit/write 紧凑标题移到 tool-display。`core/tools/bash.ts` 与 `renderers/{bash,index,edit,write}.ts` 五个文件与上游相同。
- Text 只增加通用 getText；扩展仅在委托组件确实显示原生格式时派生摘要，尊重第三方脱敏标题、render 覆写和显式 compact/false。执行、上下文恢复、安装脚本和展示三态均保留。

## 性能

环境：Apple M2 Pro，Node v25.9.0，100×30、dark、128 字符/chunk、100 条历史消息，强制逐帧 TUI 路径；每类先预热 4K，前 2K 不计。两树使用相同依赖、模型数据和输入 SHA-256。计时不含 profiler。

中文与混合样本分别在改前、改后串行执行，每种 3 次进程内重复，取中位数，单位 ms。这组没有采用交替次序，不能排除所有环境漂移。

| 样本 | 字符数 | 累计耗时：前 → 后 | P95：前 → 后 | P95 变化 |
| --- | ---: | ---: | ---: | ---: |
| 中文 | 32768 | 675.13 → 528.83 | 4.91 → 4.01 | -18.2% |
| 中文 | 65536 | 4226.18 → 2326.65 | 20.57 → 9.47 | -54.0% |
| 混合 Markdown | 32768 | 499.60 → 313.13 | 3.02 → 2.38 | -21.3% |
| 混合 Markdown | 65536 | 1706.70 → 1344.75 | 8.01 → 5.66 | -29.4% |

首轮 64K 开放代码块出现超过 10% 的回退，因此另做 3 轮独立进程串行交替，顺序为前/后、后/前、前/后。复测 P95 38.35 → 38.76ms（1.1%），累计 9537.52 → 9828.31ms（3.0%），resize 45.34 → 45.23ms。首轮的大幅回退没有稳定复现；复测未超过既有 10% 回退门槛。开放代码块仍整体高亮，没有实现 P3 增量语法高亮。

## 正确性、内存与运行证据

- Markdown 单文件 113 项通过；另有 7 组 fixture × 宽度／hyperlink／样式组合的 7452 帧 ANSI 对照，与旧 fork 一致，覆盖逐 UTF-16 前缀、前文替换、引用定义、CRLF、中文和 emoji。
- 单次显式 GC 观察中，100 条 8K mixed 历史消息保留增量 5,121,848 → 5,474,008 bytes，中文 8,372,088 → 8,977,048 bytes，候选多约 0.34／0.58MiB。清空后的残量未增加；它不是长期无泄漏证明，WeakRef 回收另由测试覆盖。
- npm run build:offline 和 npm run check 通过。check 覆盖未暂存／未跟踪源码、类型、依赖、安装锁、entry graph 和 browser smoke。
- 最终 coding-agent 33 文件 455 项、TUI 12 文件 356 项、安装脚本 20 项，共 831 项通过，无 skip/fail。包含三态、hover/click、流式结束、主题／宽度失效、第三方 renderer、图片 overlay、滚动和上下文恢复。前面的定向回归与此集合有重叠，不重复计数。
- 按仓库 interactive-testing 规则运行隔离 tmux + fauxProvider 源码 CLI。fullscreen 100×32 → 70×24 → 100×32，输出期输入草稿、PageUp 回看、Ctrl+Home/End、Ctrl+O／Alt+T 三态切换和完整脚本展开通过；regular 80×24 也到达 UI_SMOKE_COMPLETE。仅执行 echo fixture，不使用真实 provider 或用户凭据。

未执行完整仓库 suite、先前 Chord 文件监听用例、真实模型、Herdr 字体／GPU 真人验收和已安装 bundle 验收。831 项通过不代表这些范围已通过。

## 复现

在 packages/coding-agent 中运行：

```bash
node --import ./src/experimental/source-resolver.ts test/markdown-streaming-bench.ts --runs=3 --sizes=32768,65536 --kinds=chinese,mixed,code --tui --history=100 --json
node --expose-gc --import ./src/experimental/source-resolver.ts test/markdown-streaming-bench.ts --memory --kinds=mixed
```

基线从上述备份引用 git archive 到临时目录，链接相同 node_modules 并复制 ignored provider data，使用它自己的 source-resolver；没有新建 Git worktree。原始 JSON、测试和 tmux 日志保存在忽略目录 `.artifacts/native-consolidation-20261102/`，不是其他设备上的运行依赖。
