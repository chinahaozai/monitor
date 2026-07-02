# AI 硬信号监控台

纯静态单文件看板(`index.html`),无构建工具。技术栈:原生 HTML/CSS/JS + lucide 图标 + Canvas 手绘图表 + localStorage 持久化。

## 架构边界

- **单文件**:所有 HTML/CSS/JS 都在 `index.html` 内,不拆分、不引入构建步骤。
- **数据与视图分离**:`defaultState` 是数据源,`render()` 及各 `renderXxx()` 负责渲染。改视觉时不要动数据逻辑。
- **状态合并**:`loadState` / `mergeTrends` / `mergeSignals` 以 `id` 对齐默认值与 localStorage,新增字段要保证向后兼容。

## 设计基调(改视觉时必须遵守)

方向:**清爽现代数据看板 + Linear 风**。冷静、精密、科技感、克制,白天友好。核心是让数据当主角:冷白底、无衬线、极细边框、极柔阴影,强调色只在关键点出现。

### 配色(CSS 变量,定义在 `:root`)

- 冷白底 `--bg: #fbfcfd`,slate 石板文字 `--text: #0f172a`(梯度:`--ink-2 #334155` / `--muted #64748b` / `--faint #94a3b8`)。
- 品牌强调用**靛蓝** `--accent: #4f46e5`(仅用于非状态场景:品牌方块、分区竖条标记、hover、焦点、分割线)。切忌滥用,强调色只在关键点出现。
- **数据语义色是红涨绿跌**(中国市场口径),不可反转:涨/恶化 `--red: #dc2626`,跌/转好 `--green: #059669`,黄灯 `--amber #d97706`,观察 `--blue #2563eb`。
- 风险主卡用深色反白(slate-900 板岩底 `#0f172a`→`#1e293b` + 靛蓝辉光),是全页视觉焦点。
- 边框极细极浅(`--line #e9ebf0`),阴影极柔(几乎只是一层薄雾),圆角克制(`--radius: 10px`)。这三点是 Linear 现代感的关键,别加重。
- Canvas 内有绕过变量的硬编码色(轴线/tooltip/末点/风险环弧),改配色时记得同步(集中在 `drawLineChart`/`drawHover`/`renderSummary`)。

### 字体(Geist,已在 `<head>` 用 Google Fonts 加载)

- 标题与正文统一 `Geist`(`--font-display` / `--font-sans` 都指向它)。无衬线,不要回退到 Fraunces 等衬线体(会立刻变复古)。
- **所有数字**(分数、数值、坐标轴、变化率):`Geist Mono` + `font-variant-numeric: tabular-nums`,保证等宽对齐。

### 图表规范(`drawLineChart`)

- 平滑曲线用 Catmull-Rom 转贝塞尔(`traceSmooth`),不要退回直线折线。
- 面积渐变填充 + 末点强调 + 主图 hover 十字准线/tooltip/高亮点(`drawHover` / `setupChartHover`)。
- 线色跟随 `trendMoveClass` 的红涨绿跌语义。
- 高清渲染必须走 `devicePixelRatio` 缩放。

### 其他

- 卡片状态色条通过 `tone-{status}` class 驱动(red/yellow/watch/green)。
- 分区标题(`.section-head`)和面板标题(`.panel h2`)用**靛蓝小竖条**做标记,不要用杂志式编号(01/02/03)或菱形等装饰,那会拉回复古。
- 顶栏左侧有靛蓝渐变品牌方块(`.brand-mark`);顶栏顶部一条细靛蓝渐变线,是唯一的品牌色装饰。
- 入场动画尊重 `prefers-reduced-motion`。

## 本地验证

```bash
python3 -m http.server 8765   # 然后访问 http://localhost:8765/
```

UI 改动后应在浏览器实跑验证(可用 headless Chrome + CDP 截图并检查无 console 错误),不要只靠读代码下结论。
