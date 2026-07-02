# AI 硬信号监控台

这是一个用于跟踪 AI 硬件产业链景气度的本地静态看板。项目的创立目的，是把影响 AI 相关股票情绪的关键硬信号放在同一个页面里，减少只被短期新闻和价格波动牵着走的概率。

## 项目目的

AI 产业链的股价波动经常被几个问题驱动：

- 云厂商是否继续增加 AI capital expenditure；
- Nvidia、AMD、Broadcom、Micron 等核心硬件公司的订单和指引是否转弱；
- HBM、光模块、PCB、服务器、液冷、电源等环节是否出现砍单、压价或毛利率压力；
- GPU 云租赁价格和可租库存是否显示算力利用率下降；
- A股 AI 核心公司业绩是否能兑现高估值。

这个看板试图把这些问题拆成可观察的信号，并用红灯、黄灯、绿灯和趋势图帮助做持续复盘。

## 当前功能

- 综合风险评分和红黄绿状态统计；
- 大厂 AI capex、芯片/HBM、云 GPU、光模块/PCB、A股验证等分层信号；
- GPU 租金、云厂商 capex、HBM、光模块订单、PCB/服务器链趋势折线图；
- 信号卡片备注和状态切换；
- 自定义观察关键词；
- JSON 导入和导出；
- 纯静态页面，可直接本地打开或用任意静态服务器部署。

## 本地运行

### 方式一:纯静态(示例数据)

直接打开 `index.html`，或在项目目录启动静态服务：

```bash
python3 -m http.server 8765
```

### 方式二:带实时数据(本地 Worker)

用 Cloudflare 的 `wrangler` 在本地起 Worker，页面会自动拉取实时 GPU 租金：

```bash
npx wrangler dev   # 首次会自动下载 wrangler，随后访问 http://localhost:8787/
```

本地 `wrangler dev` 内置 KV 模拟，可直接调 `curl http://localhost:8787/api/trends` 看接口。若接口无数据，页面会自动回退到内置示例数据，不影响使用。

### 方式三:部署到 Cloudflare(常驻、免费、不休眠)

采样逻辑与页面托管都在单个 Worker（`worker.mjs`），由 `scheduled` 定时器每 6 小时自动采样一次并写入 KV，无需自备服务器：

```bash
npx wrangler login                              # 浏览器授权(需免费 Cloudflare 账号)
npx wrangler kv namespace create MONITOR_KV     # 拿到 id 回填 wrangler.jsonc
npx wrangler secret put SAMPLE_TOKEN            # 设手动采样接口的校验令牌
npx wrangler deploy                             # 部署,得到 *.workers.dev 地址
```

部署后可立即播种第一个数据点（否则要等下一个 cron 周期）：

```bash
curl -X POST "https://<你的地址>.workers.dev/api/sample?token=<SAMPLE_TOKEN>"
```

## 数据说明

GPU 租金一项已接入真实数据源（Vast.ai / RunPod 的公开 H100 定价，取代表值中位数）。由于数据源只提供当下快照、且不向浏览器开放跨域访问，趋势时序由 Worker 每 6 小时采样一次自行累积（存入 Cloudflare KV）——刚部署时只有一个数据点，随运行时间增长逐步形成完整曲线。

其余信号（大厂 capex、芯片/HBM、光模块/PCB、A股验证等）当前仍为示例或手动维护数据，后续可逐步接入公司 IR 财报、公告、调研纪要、台股月营收和 A股公告等自动数据源。

本项目不构成投资建议，只用于个人复盘和风险监控。
