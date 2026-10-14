# 流式 Markdown 渲染性能 Spec

- 状态：P1 实现与本机验收完成，见 [验收报告](streaming-markdown-performance-validation.md)；全仓仍有 5 个基线失败，P2/P3 未实施。
- 日期：2026-10-14。
- 源码与测量基线：`a22814b9d`，`main`。
- 涉及包：`packages/tui`、`packages/coding-agent`。

## 1. 问题与设计决策

长回答持续追加时，Pi 会重新解析当前内容块、渲染所有 Markdown token、重新高亮代码，并对全部输出行换行和计算显示宽度。终端最终可能只更新几行，但生成这些行之前已经重复处理了大量不变内容。

例如，回答已有 100 个段落和 10 个代码块，模型继续输出第 101 个段落。此前的段落仍重新换行，此前的代码块仍完整高亮。单个未关闭的长代码块则在每次追加后重新高亮整个块。

本设计分三个交付范围：

| 阶段 | 决策 | 解决的问题 | 本阶段不承诺 |
| --- | --- | --- | --- |
| P1，优先实施 | 完整解析，复用未变化块的最终排版结果；跳过确定无 Mermaid 的额外解析 | 中文重复换行、稳定代码块重复高亮、无图内容重复解析 | 单个开放代码块的增量高亮；流式全过程线性复杂度 |
| P2，复测后决定 | 保守的稳定前缀与尾部解析 | P1 后仍显著的全文解析开销 | 所有 Markdown 语法都能安全冻结 |
| P3，独立技术验证 | 评估公开支持解析状态续接的高亮方案 | 单个持续增长的代码块重复完整高亮 | 直接沿用 highlight.js 实现逐行续接 |

P2、P3 不互相依赖。P1 完成后必须分别报告它们对应的剩余瓶颈，不能把 P1 的通过写成“流式增量渲染全部完成”。

P1 不增加用户设置、依赖、扩展接口或新的安装方式，不改模型请求、消息存储格式或工具执行。收益由内置渲染路径提供，未安装 Grok UI 扩展也应生效。

## 2. 已有测量与证据边界

### 2.1 方法

- Apple M2 Pro，Node `v25.9.0`，dark 主题，100 列 × 30 行，底部停靠区 2 行。
- 导入当前源码，调用 `AssistantMessageComponent.updateContent → Markdown → ScrollView/VStack → TuiAltScreen.renderNow → NullTerminal`。不是测试已安装的旧 bundle。
- 内置 Mermaid transformer 使用 streaming 模式；未加载自定义扩展。
- 每次追加 128 个 UTF-16 code units 并强制渲染一帧；样本均为 BMP 字符，因此这里简称“字符”。不是模型 token 或 UTF-8 字节数。
- 每类先用 2K 字符预热，8K、32K、64K 各测 3 次；表格取各次统计结果的中位数。
- 四类合成样本：英文格式化段落、中文格式化段落、段落与多个短 TypeScript fence、一个持续增长且未关闭的 TypeScript fence。
- 分别采集阶段计时和 CPU profile；采样运行与计时运行分开。

实际 Pi 已有 16ms 渲染合并。本次强制渲染用于量出一次更新的计算成本，不等于真实网络 chunk 到达节奏，也不等于用户等待回答的总时长。

### 2.2 基线

单帧 P95，单位 ms：

| 样本 | 8K | 32K | 64K |
| --- | ---: | ---: | ---: |
| 英文长回答 | 1.25 | 5.48 | 11.32 |
| 中文长回答 | 3.48 | 22.91 | 48.73 |
| 文字与多个短代码块 | 2.07 | 7.80 | 15.93 |
| 单个增长中的代码块 | 3.03 | 11.82 | 24.04 |

64K 流式计算统计，单位 ms：

| 样本 | 累计耗时 | 单帧平均 | 最后四分之一帧平均 |
| --- | ---: | ---: | ---: |
| 英文 | 2976.90 | 5.81 | 10.41 |
| 中文 | 12022.90 | 23.48 | 43.73 |
| 混合 | 4222.49 | 8.25 | 14.54 |
| 代码 | 6511.42 | 12.71 | 22.36 |

内容停止变化后，同一 64K 样本的 steady 重绘平均约 0.049–0.064ms。问题集中在内容不断更新的路径。

### 2.3 瓶颈定位

| 观察 | 证据 | 推论 |
| --- | --- | --- |
| Markdown 内容生成占主要时间 | 插桩中 `Markdown.render` 约占帧时间 98–99% | 优先优化内容渲染，不重写屏幕差异算法 |
| 英文重复解析 | 主解析与 Mermaid 预解析合计约占 64K 帧时间 62% | 无图内容需要安全快速返回 |
| 中文重复排版 | CPU profile 约 61% 在宽度、grapheme、ANSI 处理和换行相关栈 | 缓存最终排版行，不能只缓存高亮 |
| 开放代码块重复高亮 | `highlightCode` 含 HTML 转 ANSI，约占 64K 帧时间 80% | 整块结果缓存不解决持续变化的代码 |
| 混合内容重复高亮稳定 fence | 高亮约占帧时间 42% | 稳定块复用具有直接收益 |

CPU profile 比例与阶段计时不能相加；高亮引擎计时已经包含在 `highlightCode` 内，Mermaid lexer 已经包含在 transformer 内。LaTeX 起始符探测也出现在 profile 中，但尚未单独验证优化收益，不列为 P1 必改项。

### 2.4 对照实验

| 32K 实验 | 累计耗时变化 | 结论 |
| --- | --- | --- |
| 英文跳过 Mermaid transformer | 718.55 → 527.99ms，下降 26.5% | 验证额外解析成本；产品仍保留 Mermaid |
| 单个代码块关闭高亮 | 1583.66 → 157.70ms | 定位高亮与相关 ANSI 成本；不建议关闭功能 |
| 仅复用 Markdown 实例 | 英文 718.55 → 710.47ms；代码 1583.66 → 1574.59ms | 对象复用是缓存的前提，本身没有实质收益 |
| 混合内容整块高亮缓存，成对实验 | 1051.42 → 623.32ms，下降 40.7%；P95 7.82 → 4.74ms | 稳定代码块无需重复高亮 |
| 开放代码块使用同一缓存 | 1559.33 → 1563.42ms | 持续变化，无法命中 |

高亮缓存原型使用固定主题及语言、完整代码文本作为键，编码后的键和输出预算合计 256KiB。它只验证高亮缓存方向，不代表本 spec 的块级排版缓存已经实现或具有相同收益。

另测 100 条历史消息、512 字符追加批次和扩大字符宽度缓存：历史消息未改变主要瓶颈；减少帧数降低累计计算，但末尾单帧开销基本不变；扩大宽度缓存收益有限。

ANSI 输出经过 `@xterm/headless` 批量回放，英文/代码平均摊到每次 write 约 0.068/0.082ms；逐回调等待含事件循环调度，不能作为纯解析时间。未测真实终端字体、GPU、PTY、SSH 或真人输入响应。

原始本机证据在 `/tmp/pi-md-perf-qHzqdI/`：`main.json`、`controls.json`、`experiments.json`、`widthcache.json`、`terminal.json`、`summary.json` 和各类 `.cpuprofile`。该目录是临时证据，不是其他设备可用的仓库依赖；关键数据已抄入本节，正式实现须补齐可重复执行的 benchmark。

## 3. 基线调用链与约束

源码路径均相对仓库根目录：

| 文件 | 当前职责与设计约束 |
| --- | --- |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | `message_start/update/end` 驱动组件；结束时传 `isStreaming=false`；高亮语言延迟加载完成后已有 UI invalidate 路径 |
| `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` | 每次更新清空内容容器并新建 Markdown；合并相邻 thinking；保留折叠点击、错误提示与 OSC 133 标记 |
| `packages/coding-agent/src/modes/interactive/components/markdown-transform.ts` | 按注册顺序传入完整文本、宽度、消息类型、streaming 状态和 model；某 transformer 抛错时继续后续链 |
| `packages/coding-agent/src/modes/interactive/components/mermaid.ts` | 即使没有 Mermaid，也 lex 完整文本；识别顶层 code token 的语言名 |
| `packages/tui/src/components/markdown.ts` | 按原文与宽度缓存完整行；有弱引用 token 缓存；文本变化后通常重新解析和排版；包括 partial fence 修正 |
| `packages/coding-agent/src/modes/interactive/theme/theme.ts` | 提供高亮和样式回调，code block 缩进来自设置 |
| `packages/coding-agent/src/utils/syntax-highlight.ts` | highlight.js 生成 HTML，再转换为 ANSI；部分语言延迟加载 |
| `packages/tui/src/utils.ts` | 现有字符宽度、ANSI 安全换行和行字符串处理，继续复用 |
| `packages/tui/src/tui.ts`、`tui-alt-screen.ts` | 已有合并渲染与屏幕差异输出；P1 不修改其调度算法 |

不得只依据 theme 对象引用判断样式是否变化：回调可能引用可变的全局主题。不得认为输入一定只追加：消息替换、重试、transformer 都可能改变前文。

## 4. P1 行为契约

对于相同的输入前缀、主题、宽度、设置、终端能力和 transformer 状态，优化后的输出必须与基线一致，包括 ANSI、OSC 超链接、空行、列表标记、代码边框和背景填充。

具体要求：

1. 不丢弃、延后或改变文本；不暂时取消高亮，不减少全局刷新频率。
2. 每次输入更新仍以完整 transformer 输出为解析输入，保持注册顺序和异常处理。
3. 每次文本变化仍执行完整 Marked 解析；只有已证明渲染输入相同的块可以复用结果。
4. 不能仅按 `token.raw` 或“遇到空行”判定复用。后置引用定义可以改变旧段落的 inline tokens。
5. 不改变 `trimPartialClosingFences` 的既有行为；缓存身份在该修正之后计算。
6. 缓存缺失、回收、超限或无法安全识别时，执行现有渲染路径。性能退化允许，错误或旧内容不允许。
7. 保留空内容、停止、失败、中断、长度截断及 tool call 的现有呈现。
8. 保持同步 `Component.render(width): string[]`；不新增异步渲染接口或后台 worker。

## 5. P1 详细设计

### 5.1 Mermaid 无目标快速返回

在已有 mode/messageType/streaming 检查之后、调用 lexer 之前，增加保守的否定判断：全文没有大小写不敏感的 `mermaid` 字样，且不含 `\r`，则返回原文。

优先使用简单、无假阴性的检查，不自建 fence 解析器。文本里出现普通单词 `mermaid` 时仍走原流程，允许这种假阳性。只要存在候选就继续使用原 lexer 和 `isMermaid`，保留反引号、波浪号、语言附加信息、缩进、未闭合代码块、渲染失败和过宽回退行为。

该检查仍为全文扫描，但避免更昂贵的完整 tokenization。不得缓存“此消息永远没有 Mermaid”，因为后续 delta 可以首次带来 Mermaid。

现有 Marked 预解析会将 CRLF/CR 规范化为 LF，后续 transformer 能观察到这个结果。编写本 spec 时已用本地 Marked 验证该差异，因此初版含 `\r` 的内容保留原路径，不悄悄改变 transformer 链输入。增加原始文本与重组文本的差分 fixture；若发现其他重组副作用，也须保守回退或单独评审行为修正。

### 5.2 AssistantMessageComponent 复用内容组件

容器结构允许按原逻辑重新组合；无需引入通用虚拟 DOM。新增最小的组件记录，用于在同一消息的相同内容位置复用 Markdown 对象。

记录身份由内容位置、种类及配置决定，不依赖消息或 content 对象引用，因为 provider 更新可能原地修改对象。

- text：按 content 索引复用，仍使用现有 `.trim()` 行为。
- thinking：按相邻 thinking run 的起始位置复用。run 合并规则和 `thinkingVisibilityOverrides` 的现有序号语义不变。
- 隐藏 thinking 不需要 Markdown 缓存；点击回调必须引用本次 run/显示状态，不能捕获过期的 `hidden` 值。
- 插入、删除、类型变化或无法匹配时，只重建受影响记录；删除记录立即释放引用。
- 即使文本值相同，显式 `updateContent` 仍应使本次需要执行的 transform 重新求值，保持目前重建组件时的行为。

以下变化直接重建相应 Markdown，避免为低频配置变化增加 setter/API：model、消息类型、输出 padding，以及通过 invalidate 传入的样式/高亮变化。隐藏的 thinking 记录不保留，重新展开时新建。

`true → false` 重新执行最终 transformer，但保留 Markdown 实例。transform 在调用时读取最新 streaming 状态；setText 清除整行缓存，最终 transform 输出经过完整解析和块身份检查。原先“结束时必须重建”的设计已修正：重建造成中文结束帧重新排版，且字符宽度缓存因流式期间跳过稳定块而变冷；保留实例不会跳过最终处理，也不需要新的 API。

`AssistantMessageComponent.invalidate()` 保留强制刷新语义：清除可复用记录并按当前消息重建，覆盖主题预览、主题切换和高亮语言加载等路径。`setHideThinkingBlock`、`setHiddenThinkingLabel`、`setOutputPad` 按各自影响重建，不把 UI 状态变更误判为文本 delta。

每条消息的实例和缓存独立。切换会话、重试或重新构建 transcript 时不跨消息寻找相似内容复用。

### 5.3 Markdown 两种失效路径

现有 `setText()` 调用 `invalidate()`。加入块缓存后需要区分：

| 操作 | 完整行缓存 | 块排版缓存 | token 缓存 |
| --- | --- | --- | --- |
| `setText(text)` | 清除，即使文本相同 | 暂时保留，下一次 render 验证后使用 | 继续按规范化全文完全匹配 |
| 同文本、同宽度的普通 render | 命中时直接返回 | 不访问 | 不访问 |
| 宽度变化 | 重新计算 | 丢弃旧宽度结果 | transformer 后原文相同才可复用 |
| 显式 `invalidate()` | 清除 | 清除及相关样式派生缓存 | 可保留现有弱引用，但必须重新核对解析输入 |
| 规范化后的文本不再是上次文本的追加 | 清除 | 按新解析的完整 token 结构逐块验证，不以追加假设判断 | 全文匹配，否则重新解析 |
| 空内容 | 返回现有空结果 | 释放旧记录 | 不保留旧文本的强引用 |

`setText` 保留“要求重新计算 transform”的行为；不要为了同值文本省掉它而改变调用契约。theme/highlighter 外部状态改变沿用显式 `invalidate()`，不能靠下次 source 变化碰运气刷新。

### 5.4 块缓存的粒度和身份

初版只缓存顶层 token 的完整输出块。列表、blockquote、table 作为一个整体；正在变化的容器仍整体渲染。初版不增加嵌套缓存树。

缓存至少记录：

- 当前顶层位置以及规范化、partial fence 修正后的有效 token 子树。
- 下一个 token 的 `type`，包括“不存在”。当前 `renderToken` 会依赖它决定尾部空行。
- 外部宽度、contentWidth、padding、Markdown options、默认样式所在的失效周期。
- 影响输出的终端能力，例如 OSC 8 超链接支持。
- 已完成样式、换行、左右 padding、背景和补齐的行数组。

有效 token 身份必须覆盖嵌套 inline tokens、解析后的链接目标、列表起始编号/loose/task/checked、表格 cell、语言、LaTeX pending 状态等。实现使用 plain object、数组和原始值的结构比较，不生成与代码块等长的序列化副本，也不采用仅有短 hash 的键。记录弱引用其 token 子树，未命中时使用本次完整解析；相同块可保留最初的等价记录，但不积累历史版本。

未知 token 形状、不可序列化值或依赖不明确的 token 跳过缓存；不要为它们发明近似键。私有缓存记录留在 `markdown.ts`，没有第二个使用者时不拆通用缓存框架。

按同一顶层位置匹配上一次记录，命中才复用；不要跨位置做全局内容去重。只保留最近一次渲染的记录，不积累每个开放 fence 的所有历史前缀。

后置引用示例：

```markdown
See [guide][target].

[target]: https://example.com
```

定义到达前后，第一段 raw 可能相同，但完整解析产生的 inline token 不同，必须重新渲染。Setext 标题、列表 tight/loose、表格分隔行等同理。

### 5.5 缓存必须覆盖最终排版

当前路径为 `renderToken → wrapTextWithAnsi → margin/background/visibleWidth → flattenLines`。仅缓存 `renderToken` 返回值仍会重复执行中文换行和宽度计算，不满足 P1 目标。

将现有逐行排版按顶层块应用，缓存最终内容行；Markdown 整体的上下 padding 仍在组合阶段处理。顶层块之间没有隐式拼接为同一文本行，输出顺序和空行必须保持基线。

需特别处理：

- `isImageLine` 继续走既有跳过换行和 padding 的路径；遇到无法证明可缓存的图像控制输出时绕过块缓存。
- 列表、引用和表格内部已有换行，不得改写其宽度算法；外层既有处理仍保持相同效果。
- 缓存行数组视为内部只读。向完整输出数组复制元素，不将内部数组交给上层修改。
- `flattenLines` 等原地数组处理不得污染旧记录；OSC 133 包装不得累积到缓存行中。
- 拼接旧行仍为随总行数增长的工作。P1 不宣称每帧严格 O(delta)，也不引入 rope、持久化树或 viewport-only Markdown。

顶层代码块的命中已经同时跳过高亮和排版，P1 不额外建立一个内容重复的全局高亮缓存。闭合代码块位于一个持续变化的大列表内时仍可能重新高亮，列入复测与剩余限制；有数据证明重要时再添加独立、有界的嵌套 fence 缓存。

### 5.6 容量与生命周期

新增缓存不能让长会话永久保留每条消息的强引用 AST 或多个历史输出版本。

- 实现上限：最多覆盖前 4096 个顶层位置，估算载荷不超过 1MiB。原设计的 512 个位置不足以覆盖中文 64K 样本；提高位置上限，仍保留字节预算。记录数组本身也不得超过 4096 槽位。
- 估算包含完整嵌套 token 数据和输出行：字符串 UTF-16 长度乘 2，加对象及数组槽位的逻辑估算。原实现仅计算 raw 与输出，漏算子树，已修正；命中块复用估算值。它不覆盖 V8 切片字符串背后的所有存储，不是精确堆上限，必须另测 retained heap。
- 每个块记录用 `WeakRef`；命中时复用已有 WeakRef，GC 回收后完全重算，正确性不能依赖缓存存活。
- 收集记录时按文档顺序保存至预算用完；后续块正常渲染但不保存。避免每帧 LRU 扫描和反复淘汰导致的抖动。
- 单个块或身份超过预算时不缓存。不得截断输出以满足缓存限制。
- 独立输出 `cachedLines` 仍按现有行为保留；不得重复持有多个旧版本。失效、空内容或组件丢弃时释放新增引用。

验收同时检查无 GC 的上界和 GC 后的释放。单组件预算不等于进程全局上界，需用长 transcript 测试确认不会产生随消息数量增长的新增长系数。若弱缓存频繁回收导致收益不稳定，先记录证据并调整设计，不自动改为全局强引用缓存。

验收补充：真实 `requestRender` 合并后，稳定块不再预热全局宽度缓存，512 项缓存导致 32K 中文 resize 稳定变慢。将既有 `utils.ts` 非 ASCII 宽度缓存上限调整为 1024 项；计算、键和淘汰策略不变，不新增缓存层。这是基于回归证据的范围调整，额外最多 512 个字符串键/宽度值，须在最终性能及 retained heap 测量中计入；不是每组件 1MiB 预算的一部分。

## 6. P2：保守的尾部解析

进入条件：P1 正确性和内存检查通过，并且 64K 英文/中文复测中解析仍是主要瓶颈之一，影响剩余帧耗时目标。若 P1 已满足目标，不为理论复杂度实现第二套 parser。

借鉴 Grok 的 checkpoint：记录已确认不受追加影响的顶层边界，复用其解析/渲染结果，只处理未确认尾部。但不能将 Rust parser 的边界假设直接用于 Marked。

实现前必须证明：

1. offset 基于哪一层文本：必须明确 transformer 后、tab 规范化后的位置，不能混用原始消息 offset。
2. 非追加编辑、主题/宽度影响 transform、stream finish 改写时如何清除 checkpoint。
3. 未关闭 fence、嵌套列表/引用、表格、Setext 标题、HTML、数学块何时能成为稳定边界。
4. 引用定义等全局依赖如何被发现并使前缀失效；不能只保存最后一个段落。
5. 任意现有 transformer 仍可读取并改写全文；未声明局部语义的 transformer 必须保留完整处理和保守回退，不在此阶段扩大扩展 API。

与 P1 不同，P2 涉及 parser 行为。须先增加逐前缀差分测试，再实现冻结。无法证明安全的文档继续完整解析；不要用“通常不会发生”替代规则。

## 7. P3：开放代码块高亮

P1 对单个增长代码块不会产生稳定缓存命中，这个边界必须在交付说明和性能表中持续显示。

Grok 使用 Syntect 的 `ParseState`、`HighlightState` 保存已经提交的完整行状态，不完整的最后一行使用临时状态。Pi 当前 highlight.js 的现代 `highlight(code, options)` 明确不支持 continuation。禁止通过 deprecated 调用或私有 mode stack 模拟受支持接口。

P3 首先交付技术验证结论，不直接替换引擎：

| 需要回答的问题 | 验收证据 |
| --- | --- |
| 是否有公开、受支持的状态续接 API | 固定版本的文档、类型与最小实验 |
| 跨行注释、字符串、模板插值、嵌入语言能否正确续接 | 每个前缀与候选引擎 batch 输出一致；不能把每行当独立文件 |
| 能否保持 Pi 当前高亮呈现 | 与现有 highlight.js 对照；任何颜色或语言覆盖差异单独列出 |
| 是否值得更换 | 开放代码样本的 P95、累计耗时、内存、启动成本与包体变化 |
| 各设备能否继续自行 clone/build/install | 支持平台、打包路径及依赖变更检查，尤其本地 native/WASM 资源 |

若选择新引擎，新增依赖和安装影响必须另行评审。若只选择降低高亮刷新频率、显示临时纯文本或移到 worker，应明确这些方案改变了呈现时序或架构，不作为 P1 的隐含实现。

## 8. 修改范围

| 文件/区域 | P1 计划 |
| --- | --- |
| `packages/coding-agent/src/modes/interactive/components/mermaid.ts` | 无目标快速返回 |
| `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` | 最小组件记录、delta 复用及状态变化重建 |
| `packages/tui/src/components/markdown.ts` | 文本更新与显式失效分离；有界弱引用块缓存；逐块复用最终排版 |
| `packages/tui/src/utils.ts` | 将已有非 ASCII 宽度缓存从 512 项调到 1024 项，修复流结束后的 resize 回退；不改宽度算法 |
| `packages/tui/test/markdown.test.ts` | 缓存正确性、失效和边界回归 |
| `packages/coding-agent/test/assistant-message.test.ts` | 生命周期、thinking、transform 与 OSC 行为 |
| `packages/coding-agent/test/mermaid.test.ts` | 快速返回与实际 Mermaid 不回退 |
| `packages/coding-agent/test/markdown-streaming-bench.ts` | 真实主题和 agent→TUI 路径的离线 benchmark；不接入默认单测性能门槛 |
| `packages/tui/test/alt-screen-large-transcript-bench.ts`、`render-churn-bench.ts` | 复用现有大 transcript/分配验证方法，必要时补充场景 |

`markdown-transform.ts`、theme、syntax-highlight、interactive-mode 是验证调用方；除非发现失效传递缺口，否则不改。TUI 调度和屏幕差异算法不在 P1 修改范围。

不新增公开导出、配置项、兼容 shim、lockfile 变更或 Grok 扩展依赖。代码实施时按分支规则补充 `tui` 与 `coding-agent` changelog；本设计文档不宣告功能已发布。

## 9. 正确性验收

### 9.1 差分方法

必须同时有两个 oracle，避免新实现自证：

- P1 基线提交的输出或事先记录的语义 fixture，验证渲染流程重排没有改变结果。
- 每个流式前缀新建无历史缓存组件的输出，验证缓存命中与失效。仅流结束比较不足以发现中途错色、缺行或抖动。

短而有针对性的 fixture 枚举每个字符边界，并额外拆分 surrogate pair/组合字符；长样本使用固定种子的多种 chunk 边界。完整 ANSI 行必须一致，并用现有 VirtualTerminal 检查关键单元格/宽度，不只 strip ANSI 比文本。

### 9.2 测试矩阵

| 类别 | 必测条件 |
| --- | --- |
| 普通文本 | 空文本、空白、相同 setText、追加、前文替换、缩短、整条消息替换 |
| 块间依赖 | nextToken 从无到有、space token 到来、段落转 Setext 标题、表格分隔行到来 |
| 全局解析 | 后置链接定义、定义被替换、重复定义、引用样式图片 |
| 列表和引用 | tight/loose、嵌套、ordered 起始编号、task checked、列表内代码与引用 |
| 代码 | 反引号/波浪号、不同 fence 长度、未关闭及部分关闭 fence、语言名增量、未知语言、超预算块 |
| 数学与转义 | inline/block LaTeX、pending delimiter、反斜杠、HTML-like 文本 |
| 宽度与样式 | 100→60→100 列、极窄宽度、padding、背景、codeBlockIndent、同对象主题状态变化后 invalidate |
| Unicode/终端 | CJK、emoji/ZWJ、组合符、tab、ANSI 状态、OSC 8 on/off、图像行跳过处理 |
| Transformer | 顺序、多次更新、修改前文、宽度/model/streaming 分支、抛异常、非字符串返回、CRLF/CR 规范化后传给下一项的文本 |
| Agent 生命周期 | text/thinking/tool 交错、thinking run 合并与单独折叠、finish/abort/error/length、重复 render 的 OSC 133 不累积 |
| 异步初始化 | 高亮语言加载完成后 invalidate，旧的纯文本 fallback 能重新高亮 |
| 容量与回收 | 超过 4096 位置/1MiB、单块超限、缓存失活/被回收、长会话组件丢弃，输出仍一致 |

无需为了测试导出缓存内部结构；优先用计数高亮回调证明稳定块不再重算，并用外部输出验证。GC 回收时机不可用普通单测做确定性断言；在独立 memory benchmark 中使用显式 GC 和 retained heap 测量。

### 9.3 检查命令

实施后，从对应 package 运行现有相关测试：

```bash
# cwd: packages/tui
node --test test/markdown.test.ts

# cwd: packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/assistant-message.test.ts test/mermaid.test.ts test/syntax-highlight.test.ts

# cwd: repository root，代码修改后
npm run check
```

若拆出新的 test 文件，必须运行新增文件。不要运行完整 vitest suite、`npm test` 或未经请求的 `npm run build`。真人终端验证遵循 `.pi/skills/interactive-testing.md`，provider 使用离线 faux 数据，避免真实请求与付费 token。

## 10. 性能与内存验收

### 10.1 可重复 benchmark

正式 benchmark 必须随实现落库，不能依赖本次已清理的临时 loader/script。沿用项目现有源码测试解析方式，记录实际加载的源码路径，避免混入旧 `dist`。若需要源码映射，使用仓库已有配置或最小的测试专用方式，不改产品加载器。

记录 commit、Node、CPU、终端尺寸、主题、样本字符数/UTF-8 字节数、chunk、repeat、是否加载扩展和 Mermaid 模式。输入由固定 fixture/确定性生成器生成，并记录摘要以确保基线与候选一致。

至少包含：

- 本文四类样本，8K/32K/64K，128 字符追加；补充 512 字符追加及一个更大的压力样本。
- 0/100 条已完成历史消息；无更新、stream finish 和宽度变化场景。
- 原始 forced-render 场景与单独的有节奏 `requestRender` 场景；后者报告被合并的更新数，不能混为一张帧耗时表。
- 原始阶段计时、每帧数据、P50/P95/max、末段平均、累计耗时、输出 bytes、分配量与 retained heap。
- 无 profiler 的计时运行，与 CPU/heap profile 分开；没有 profiler 时仍应看到收益。

基线与候选同机串行、交替测量，各至少 5 次，先预热。禁止并发 CPU benchmark；温度或其他任务导致明显波动时保留离散数据并重测。benchmark 不设置脆弱的跨机器 CI 毫秒断言。

### 10.2 P1 目标与通过条件

以下是设计目标，不是已达成指标。以同机、同 fixture、重新测得的未优化基线为分母，不能直接拿本文历史数字做跨环境比较。

| 项目 | 目标 |
| --- | --- |
| 32K 英文、无 Mermaid 内容 | 累计渲染耗时下降至少 20% |
| 32K 混合内容 | 累计耗时和 P95 各下降至少 30% |
| 64K 中文 | P95 和末四分之一帧平均各下降至少 30% |
| 单个开放代码块 | 不要求 P1 改善；不得稳定回退超过 10% |
| 8K 小内容、steady、resize | 不得出现稳定超过 10% 且有实际影响的回退；steady 绝对增量低于 0.05ms 时记录而不作相对值阻断 |
| 缓存 | 满足容量和最近一代约束；丢弃后没有新增强引用保留历史消息/AST |

未达到目标时提交差异、profile 和原因，状态保留为未通过，不静默降低门槛。缓存身份比较、预算计算或 GC 若抵消收益，优先简化它们；不把问题转移到新线程来掩盖。

16ms 可作为交互目标参考，但 P1 不承诺 64K 中文或所有语言代码块都低于 16ms。P2/P3 的立项由剩余耗时和实际交互测试决定。

## 11. 交付顺序与回退

1. 固化 baseline fixture、源码加载方式及 benchmark；先运行一次，确认能复现瓶颈。
2. 独立实现 Mermaid 快速返回及用例，验证实际 Mermaid 输出不变。
3. 实现 assistant 组件复用与生命周期回归；暂时不把构造耗时降低计作主要收益。
4. 实现 Markdown 块缓存和逐前缀差分，先确保行为一致，再做容量与性能验证。
5. 运行相关测试、`npm run check`、性能和内存 benchmark；最后做实际终端回归。
6. 交付基线/候选对照、已通过与未通过场景，单列开放代码块和变化中的大容器；决定是否进入 P2/P3。

分层保持可独立撤回：Mermaid 快速返回不依赖块缓存；缓存回退仅恢复重算，不迁移用户数据、不改变配置格式。使用缓存 miss 的保守路径处理不支持场景，不吞掉原有渲染错误或隐藏功能。

## 12. Grok Build 参考与未决项

参考固定提交 `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`：

- [streaming.rs](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-markdown/src/streaming.rs)：稳定前缀、尾部重绘和失效。
- [checkpoint.rs](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-markdown/src/checkpoint.rs)：保守的顶层边界。
- [open_code_highlighter.rs](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-markdown/src/open_code_highlighter.rs)：Syntect 逐行状态、临时尾行与闭合 fence 缓存。

借鉴复用稳定结果、容量限制、明确失效和 batch 等价性；不直接移植 Rust 模块、不引用 Grok 自述耗时作为 Pi 实测收益。本轮没有 Grok/Pi 同机性能 A/B。

验收需用证据关闭的事项：块身份比较成本、弱缓存存活率、1MiB/4096 预算是否覆盖目标样本。变化中大列表的剩余重复高亮、P2 的 Marked 安全边界和 P3 的高亮引擎选择仍是后续范围，不能在 P1 验收报告中写成已解决。
