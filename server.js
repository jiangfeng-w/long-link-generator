const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");

const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.join(__dirname, "public");
const CHECKOUT_ENDPOINT = "https://chatgpt.com/backend-api/payments/checkout";

const COUNTRY_OPTIONS = {
  US: { name: "美国", currency: "USD" },
  ID: { name: "印尼", currency: "IDR" },
  DE: { name: "德国", currency: "EUR" },
  FR: { name: "法国", currency: "EUR" },
  GB: { name: "英国", currency: "GBP" },
  JP: { name: "日本", currency: "JPY" },
  KR: { name: "韩国", currency: "KRW" },
  SG: { name: "新加坡", currency: "SGD" },
  CA: { name: "加拿大", currency: "CAD" },
  AU: { name: "澳大利亚", currency: "AUD" }
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sanitizeErrorBody(data) {
  if (!data || typeof data !== "object") return data;
  const clone = Array.isArray(data) ? [...data] : { ...data };
  for (const key of Object.keys(clone)) {
    if (/token|authorization|cookie/i.test(key)) clone[key] = "[redacted]";
  }
  return clone;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("请求体过大。"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function parseMaybeJson(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  return JSON.parse(trimmed);
}

function findAccessToken(input) {
  if (!input) return "";

  if (typeof input === "string") {
    const maybeJson = parseMaybeJson(input);
    if (maybeJson) return findAccessToken(maybeJson);
    return input.trim();
  }

  if (typeof input !== "object") return "";

  const direct =
    input.accessToken ||
    input.access_token ||
    input.token ||
    input.authToken ||
    input?.session?.accessToken ||
    input?.data?.accessToken ||
    input?.props?.pageProps?.session?.accessToken;

  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const seen = new Set();
  const queue = [input];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    for (const [key, value] of Object.entries(current)) {
      if (/access_?token/i.test(key) && typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return "";
}

function buildCheckoutPayload(countryCode) {
  const country = COUNTRY_OPTIONS[countryCode];
  if (!country) {
    const err = new Error("暂不支持这个国家。");
    err.statusCode = 400;
    throw err;
  }

  return {
    plan_name: "chatgptplusplan",
    billing_details: {
      country: countryCode,
      currency: country.currency
    },
    cancel_url: "https://chatgpt.com/#pricing",
    promo_campaign: {
      promo_campaign_id: "plus-1-month-free",
      is_coupon_from_query_param: false
    },
    checkout_ui_mode: "hosted"
  };
}

async function handleCheckout(req, res) {
  try {
    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const country = String(body.country || "US").toUpperCase();
    const tokenSource = body.accessToken || body.sessionJson || body.tokenJson || "";
    const accessToken = findAccessToken(tokenSource);

    if (!accessToken) {
      return sendJson(res, 400, { error: "没有找到 accessToken。" });
    }

    const payload = buildCheckoutPayload(country);
    const response = await fetch(CHECKOUT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { raw: text };
    }

    if (!response.ok) {
      return sendJson(res, response.status, {
        error: `ChatGPT checkout 接口返回 HTTP ${response.status}`,
        detail: sanitizeErrorBody(data)
      });
    }

    const hostedUrl = data?.url || data?.stripe_hosted_url || data?.checkout_url;
    if (!hostedUrl) {
      return sendJson(res, 502, {
        error: "响应里没有找到付款长链接。",
        detail: sanitizeErrorBody(data)
      });
    }

    sendJson(res, 200, {
      url: hostedUrl,
      country,
      currency: payload.billing_details.currency
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || "生成失败。"
    });
  }
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(file);
  } catch (_) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/checkout") {
    handleCheckout(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`Long link generator is running at http://localhost:${PORT}`);
});
