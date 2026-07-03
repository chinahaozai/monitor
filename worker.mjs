// AI 硬信号监控台 —— Cloudflare Worker(单一 Worker:托管页面 + 定时采样 + KV 持久化)
//
// 职责:
//   1. 静态托管 index.html(assets 绑定,页面与 /api 同源 → 无 CORS)
//   2. scheduled():每 6h 从 Vast.ai / RunPod 采样 H100 云 GPU 租金,追加进 KV
//   3. GET  /api/trends:读 KV 历史,组装成前端 trend schema 返回
//   4. POST /api/sample?token=…:手动触发一次采样(冷启动播种,token 校验防公开刷写)
//
// 为什么用 Worker:两个数据源都不给浏览器 CORS(Vast.ai 只允许 cloud.vast.ai,
// RunPod 无 ACAO 头),纯前端 fetch 必被拦;且 API 只返回当下快照,历史时序只能
// 由服务端逐次采样自行累积。Worker 常驻、不休眠、免费,替代原本地 proxy.mjs。
//
// 路由分流:wrangler.jsonc 里 assets.run_worker_first=["/api/*"],
// 只有 /api/* 进本脚本,其余路径由静态资源层直接服务。

const KV_KEY = "gpu-rent-history";
const MAX_POINTS = 60; // KV 里最多保留的采样点数
const FETCH_TIMEOUT_MS = 8000;

// ---------- 通用:带超时 + 单次重试的 fetch ----------
async function fetchWithRetry(url, options = {}, label = "") {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 2) {
        console.warn(`[采样] ${label} 失败(第 ${attempt} 次):${err.message}`);
        return null;
      }
      // 重试前退避,避免触发数据源限流(HTTP 429)
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- 数据源 A:Vast.ai H100 dph_total 中位数 ----------
// 必须带 q 过滤:不带参数的 bundles/ 返回随机一页,H100 命中不稳定(时有时无)。
async function fetchVast() {
  const q = { gpu_name: { eq: "H100 SXM" }, rentable: { eq: true }, type: "on-demand" };
  const url = "https://cloud.vast.ai/api/v0/bundles/?q=" + encodeURIComponent(JSON.stringify(q));
  const data = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, "Vast.ai");
  if (!data || !Array.isArray(data.offers)) return null;
  const prices = data.offers
    .filter((o) => typeof o.gpu_name === "string" && o.gpu_name.includes("H100"))
    .filter((o) => o.rentable !== false && typeof o.dph_total === "number" && o.dph_total > 0)
    .map((o) => o.dph_total);
  const m = median(prices);
  if (m == null) return null;
  return { median: Number(m.toFixed(3)), count: prices.length };
}

// ---------- 数据源 C:Yahoo Finance 日频股价时序(通用) ----------
// 与 gpu-rent 不同,Yahoo 一次给完整历史序列,无需 KV 累积。
// Cloudflare Cache API 缓存 6h,避免每次页面访问都外呼。
// 所有股票信号(TSMC 2330.TW、NVDA…)共用此函数,只换 symbol/source。
// range: Yahoo 区间(1mo/3mo/6mo/1y/2y…);points: 降采样后的目标点数。
// 1 年约 250 个交易日,降采样到 ~52 个点即周度密度,曲线有厚度又不过密。
async function fetchYahooStock(symbol, source, decimals = 2, range = "1y", points = 52) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${encodeURIComponent(range)}`;
  const data = await fetchWithRetry(
    url,
    {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; monitor/1.0)" },
      cf: { cacheTtl: 21600, cacheEverything: true }, // 6h 边缘缓存
    },
    `Yahoo ${symbol}`
  );
  const r = data?.chart?.result?.[0];
  const ts = r?.timestamp;
  const close = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(close) || !ts.length) return null;
  // 过滤 close=null(停牌日)
  const pairs = ts.map((t, i) => [t, close[i]]).filter(([, c]) => typeof c === "number");
  if (!pairs.length) return null;
  // 等距降采样到 points 个,并确保末点(最新)一定入选
  const step = Math.max(1, Math.floor(pairs.length / points));
  const picked = [];
  for (let i = pairs.length - 1; i >= 0 && picked.length < points; i -= step) picked.unshift(pairs[i]);
  return {
    labels: picked.map(([t]) => toLabel(new Date(t * 1000).toISOString())),
    values: picked.map(([, c]) => Number(c.toFixed(decimals))),
    source,
    updatedAt: new Date(pairs[pairs.length - 1][0] * 1000).toISOString(),
  };
}

// ---------- 数据源 B:RunPod H100 SXM secure 价 ----------
async function fetchRunpod() {
  const data = await fetchWithRetry(
    "https://api.runpod.io/graphql",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: "query{gpuTypes{id displayName securePrice communityPrice}}",
      }),
    },
    "RunPod"
  );
  const types = data?.data?.gpuTypes;
  if (!Array.isArray(types)) return null;
  const h100sxm = types.find((g) => g.id === "NVIDIA H100 80GB HBM3" || g.displayName === "H100 SXM");
  const secure = h100sxm?.securePrice;
  if (typeof secure !== "number" || secure <= 0) return null;
  return { secure: Number(secure.toFixed(3)) };
}

// ---------- KV 存储层 ----------
async function loadHistory(env) {
  try {
    const raw = await env.MONITOR_KV.get(KV_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveHistory(env, points) {
  await env.MONITOR_KV.put(KV_KEY, JSON.stringify(points.slice(-MAX_POINTS)));
}

// ---------- 采样:合成代表值并追加历史 ----------
async function sample(env) {
  const [vast, runpod] = await Promise.all([fetchVast(), fetchRunpod()]);

  // 代表值:两源均值(Vast=散户市场价,RunPod=托管价);只有一个成功则用它
  const parts = [];
  if (vast) parts.push(vast.median);
  if (runpod) parts.push(runpod.secure);
  if (!parts.length) {
    console.warn("[采样] 两个数据源均失败,本次不写入历史");
    return null;
  }
  const value = Number((parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(3));

  const history = await loadHistory(env);
  const point = {
    t: new Date().toISOString(),
    vast_h100_median: vast?.median ?? null,
    runpod_h100_secure: runpod?.secure ?? null,
    value,
  };
  const next = [...history, point].slice(-MAX_POINTS);
  await saveHistory(env, next);
  console.log(
    `[采样] ${point.t}  Vast=${vast?.median ?? "—"}  RunPod=${runpod?.secure ?? "—"}  →  代表值=${value} 美元/小时  (共 ${next.length} 点)`
  );
  return point;
}

// ---------- 组装 /api/trends 响应 ----------
// 日频 label:股票用,一天一个点,MM-DD 足够
function toLabel(iso) {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

// 时级 label:GPU 租金用,6h 采样一天 4 个点,MM-DD 会全一样,必须精确到小时。
// 时区:输出中国时区(+8),用户在中国看到本地时间直接对得上;Worker 环境是 UTC,
// 手动加 8h 偏移,再取 UTC 各字段(避免依赖 Intl.DateTimeFormat 在 Worker 里的实现差异)。
function toLabelHour(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:00`;
}

function buildTrends(points) {
  if (!points.length) return {};
  // 点数 > 8 时降采样到最近 8 个,映射周视图密度
  const shown = points.length > 8 ? points.slice(-8) : points;
  return {
    "gpu-rent": {
      labels: shown.map((p) => toLabelHour(p.t)),
      values: shown.map((p) => p.value),
      source: "Vast.ai / RunPod H100 实时采样",
      updatedAt: points[points.length - 1].t,
    },
  };
}

// AI 分析(DeepSeek)已迁移到前端 BYOK 直调,详见 public/index.html。
// 原因:DeepSeek API 走腾讯 EdgeOne,对海外来源(Cloudflare Worker)极慢(20s 仍超时),
// 而对中国用户浏览器直接命中很快。前端直调 + localStorage 存 key 是唯一可用架构。

// ---------- HTTP 入口 ----------
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/trends") {
      try {
        // 多源并发:gpu-rent 从 KV(6h 采样累积),股票类从 Yahoo(边缘缓存)。
        // 任一失败不影响其它源,前端会静默降级到该 trend 的示例数据。
        const [history, tsmc, nvda] = await Promise.all([
          loadHistory(env),
          fetchYahooStock("2330.TW", "Yahoo Finance TSMC 2330.TW 日频", 0).catch(() => null),
          fetchYahooStock("NVDA", "Yahoo Finance NVDA 日频", 2).catch(() => null),
        ]);
        const payload = { ...buildTrends(history) };
        if (tsmc) payload["tsmc-stock"] = tsmc;
        if (nvda) payload["nvda-stock"] = nvda;
        return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
      }
    }

    if (url.pathname === "/api/sample") {
      // 手动播种/触发:仅 POST,且 token 必须匹配 secret,防公开刷 KV 写额度
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: JSON_HEADERS });
      }
      const token = url.searchParams.get("token") || request.headers.get("x-sample-token");
      if (!env.SAMPLE_TOKEN || token !== env.SAMPLE_TOKEN) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
      }
      const point = await sample(env);
      return new Response(JSON.stringify({ ok: !!point, point }), { headers: JSON_HEADERS });
    }

    // 理论上 /api/* 之外的请求不会进到这里(run_worker_first 只匹配 /api/*),
    // 但显式兜底:交给静态资源层。
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sample(env));
  },
};
