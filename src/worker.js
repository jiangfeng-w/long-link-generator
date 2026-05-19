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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
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
    const error = new Error("暂不支持这个国家。");
    error.statusCode = 400;
    throw error;
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

function sanitizeErrorBody(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(sanitizeErrorBody);

  const clone = {};
  for (const [key, value] of Object.entries(data)) {
    clone[key] = /token|authorization|cookie/i.test(key)
      ? "[redacted]"
      : sanitizeErrorBody(value);
  }
  return clone;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

async function handleCheckout(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const country = String(body.country || "US").toUpperCase();
    const tokenSource = body.accessToken || body.sessionJson || body.tokenJson || "";
    const accessToken = findAccessToken(tokenSource);

    if (!accessToken) {
      return jsonResponse({ error: "没有找到 accessToken。" }, 400);
    }

    const payload = buildCheckoutPayload(country);
    const response = await fetch(CHECKOUT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0 LongLinkGenerator/1.0"
      },
      body: JSON.stringify(payload)
    });

    const data = await parseResponse(response);
    if (!response.ok) {
      return jsonResponse(
        {
          error: `ChatGPT checkout 接口返回 HTTP ${response.status}`,
          detail: sanitizeErrorBody(data)
        },
        response.status
      );
    }

    const hostedUrl = data?.url || data?.stripe_hosted_url || data?.checkout_url;
    if (!hostedUrl) {
      return jsonResponse(
        {
          error: "响应里没有找到付款长链接。",
          detail: sanitizeErrorBody(data)
        },
        502
      );
    }

    return jsonResponse({
      url: hostedUrl,
      country,
      currency: payload.billing_details.currency
    });
  } catch (error) {
    return jsonResponse(
      {
        error: error.message || "生成失败。"
      },
      error.statusCode || 500
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/checkout") {
      return handleCheckout(request);
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Not Found" }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
