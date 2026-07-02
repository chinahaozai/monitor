// AI 硬信号监控台 —— 轻量数据代理(零依赖,Node 原生模块)
//
// 职责:
//   1. 静态托管 index.html(页面与 /api 同源,彻底消除 CORS 问题)
//   2. 定时从 Vast.ai / RunPod 采样 H100 云 GPU 租金,追加到 data/history.json
//   3. GET /api/trends 把历史时序组装成前端 trend schema 返回
//
// 为什么需要它:两个数据源都不给浏览器 CORS 权限(实测 Vast.ai 只允许
// cloud.vast.ai,RunPod 无 ACAO 头),纯前端 fetch 必被拦;且 API 只返回
// 当下快照,历史时序只能由本代理逐次采样自行累积。
//
// 启动:node proxy.mjs   然后访问 http://localhost:8765/

import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8765;
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const SAMPLE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
const MAX_POINTS = 60;                          // history 最多保留的采样点数
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
  const data = await fetchWithRetry(url, { headers: { "Accept": "application/json" } }, "Vast.ai");
  if (!data || !Array.isArray(data.offers)) return null;
  const prices = data.offers
    .filter((o) => typeof o.gpu_name === "string" && o.gpu_name.includes("H100"))
    .filter((o) => o.rentable !== false && typeof o.dph_total === "number" && o.dph_total > 0)
    .map((o) => o.dph_total);
  const m = median(prices);
  if (m == null) return null;
  return { median: Number(m.toFixed(3)), count: prices.length };
}

// ---------- 数据源 B:RunPod H100 SXM secure 价 ----------
async function fetchRunpod() {
  const data = await fetchWithRetry(
    "https://api.runpod.io/graphql",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        query: "query{gpuTypes{id displayName securePrice communityPrice}}"
      })
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

// ---------- 采样:合成代表值并追加历史 ----------
async function sample() {
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

  const history = await loadHistory();
  const point = {
    t: new Date().toISOString(),
    vast_h100_median: vast?.median ?? null,
    runpod_h100_secure: runpod?.secure ?? null,
    value
  };
  history["gpu-rent"] = [...(history["gpu-rent"] || []), point].slice(-MAX_POINTS);
  await saveHistory(history);
  console.log(
    `[采样] ${point.t}  Vast=${vast?.median ?? "—"}  RunPod=${runpod?.secure ?? "—"}  →  代表值=${value} 美元/小时  (共 ${history["gpu-rent"].length} 点)`
  );
  return point;
}

async function loadHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveHistory(history) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ---------- 组装 /api/trends 响应 ----------
function toLabel(iso) {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

async function buildTrends() {
  const history = await loadHistory();
  const points = history["gpu-rent"] || [];
  if (!points.length) return {};
  // 点数 > 8 时降采样到最近 8 个,映射周视图密度
  const shown = points.length > 8 ? points.slice(-8) : points;
  return {
    "gpu-rent": {
      labels: shown.map((p) => toLabel(p.t)),
      values: shown.map((p) => p.value),
      source: "Vast.ai / RunPod H100 实时采样",
      updatedAt: points[points.length - 1].t
    }
  };
}

// ---------- 静态文件托管 ----------
const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".ico": "image/x-icon" };

async function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  // 防目录穿越:规范化后必须仍在项目目录内
  const filePath = path.join(__dirname, path.normalize(urlPath));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
  }
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  if (req.url.split("?")[0] === "/api/trends") {
    try {
      const body = JSON.stringify(await buildTrends());
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  await serveStatic(req, res);
});

server.listen(PORT, async () => {
  console.log(`AI 硬信号监控台代理已启动 → http://localhost:${PORT}/`);
  const history = await loadHistory();
  if (!(history["gpu-rent"] || []).length) {
    console.log("[启动] 历史为空,执行冷启动采样…");
    await sample();
  } else {
    console.log(`[启动] 已有 ${history["gpu-rent"].length} 个历史采样点`);
  }
  setInterval(sample, SAMPLE_INTERVAL_MS);
  console.log(`[定时] 每 ${SAMPLE_INTERVAL_MS / 3600000} 小时自动采样一次`);
});
