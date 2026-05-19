from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import errno
import json
import os
import sys


PORT = int(os.environ.get("PORT", "5173"))
CHECKOUT_ENDPOINT = "https://chatgpt.com/backend-api/payments/checkout"


def resource_path(*parts):
    base_path = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base_path.joinpath(*parts)


PUBLIC_DIR = resource_path("public")

COUNTRY_OPTIONS = {
    "US": {"name": "美国", "currency": "USD"},
    "ID": {"name": "印尼", "currency": "IDR"},
    "DE": {"name": "德国", "currency": "EUR"},
    "FR": {"name": "法国", "currency": "EUR"},
    "GB": {"name": "英国", "currency": "GBP"},
    "JP": {"name": "日本", "currency": "JPY"},
    "KR": {"name": "韩国", "currency": "KRW"},
    "SG": {"name": "新加坡", "currency": "SGD"},
    "CA": {"name": "加拿大", "currency": "CAD"},
    "AU": {"name": "澳大利亚", "currency": "AUD"},
}


def parse_maybe_json(value):
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed.startswith("{") and not trimmed.startswith("["):
        return None
    return json.loads(trimmed)


def find_access_token(source):
    if not source:
        return ""

    if isinstance(source, str):
        maybe_json = parse_maybe_json(source)
        if maybe_json is not None:
            return find_access_token(maybe_json)
        return source.strip()

    if not isinstance(source, (dict, list)):
        return ""

    if isinstance(source, dict):
        direct_paths = [
            source.get("accessToken"),
            source.get("access_token"),
            source.get("token"),
            source.get("authToken"),
            source.get("session", {}).get("accessToken") if isinstance(source.get("session"), dict) else None,
            source.get("data", {}).get("accessToken") if isinstance(source.get("data"), dict) else None,
        ]
        for value in direct_paths:
            if isinstance(value, str) and value.strip():
                return value.strip()

    queue = [source]
    seen = set()
    while queue:
        current = queue.pop(0)
        current_id = id(current)
        if current_id in seen:
            continue
        seen.add(current_id)

        if isinstance(current, dict):
            for key, value in current.items():
                normalized = key.replace("_", "").lower()
                if normalized == "accesstoken" and isinstance(value, str) and value.strip():
                    return value.strip()
                if isinstance(value, (dict, list)):
                    queue.append(value)
        elif isinstance(current, list):
            for value in current:
                if isinstance(value, (dict, list)):
                    queue.append(value)

    return ""


def build_checkout_payload(country_code):
    country = COUNTRY_OPTIONS.get(country_code)
    if not country:
        raise ValueError("暂不支持这个国家。")

    return {
        "plan_name": "chatgptplusplan",
        "billing_details": {
            "country": country_code,
            "currency": country["currency"],
        },
        "cancel_url": "https://chatgpt.com/#pricing",
        "promo_campaign": {
            "promo_campaign_id": "plus-1-month-free",
            "is_coupon_from_query_param": False,
        },
        "checkout_ui_mode": "hosted",
    }


def scrub_sensitive(data):
    if isinstance(data, dict):
        cleaned = {}
        for key, value in data.items():
            if any(word in key.lower() for word in ("token", "authorization", "cookie")):
                cleaned[key] = "[redacted]"
            else:
                cleaned[key] = scrub_sensitive(value)
        return cleaned
    if isinstance(data, list):
        return [scrub_sensitive(item) for item in data]
    return data


def parse_response_text(text):
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def log_message(self, format, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), format % args))

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/checkout":
            self.send_json(404, {"error": "Not Found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1024 * 1024:
                self.send_json(413, {"error": "请求体过大。"})
                return

            raw = self.rfile.read(length).decode("utf-8")
            body = json.loads(raw) if raw else {}
            country = str(body.get("country") or "US").upper()
            token_source = body.get("accessToken") or body.get("sessionJson") or body.get("tokenJson") or ""
            access_token = find_access_token(token_source)

            if not access_token:
                self.send_json(400, {"error": "没有找到 accessToken。"})
                return

            payload = build_checkout_payload(country)
            request = Request(
                CHECKOUT_ENDPOINT,
                data=json.dumps(payload).encode("utf-8"),
                method="POST",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Origin": "https://chatgpt.com",
                    "Referer": "https://chatgpt.com/",
                    "User-Agent": "Mozilla/5.0 LongLinkGenerator/1.0",
                },
            )

            try:
                with urlopen(request, timeout=45) as response:
                    response_text = response.read().decode("utf-8", errors="replace")
                    data = parse_response_text(response_text)
            except HTTPError as error:
                response_text = error.read().decode("utf-8", errors="replace")
                self.send_json(
                    error.code,
                    {
                        "error": f"ChatGPT checkout 接口返回 HTTP {error.code}",
                        "detail": scrub_sensitive(parse_response_text(response_text)),
                    },
                )
                return
            except URLError as error:
                self.send_json(502, {"error": f"请求 ChatGPT checkout 接口失败：{error.reason}"})
                return

            hosted_url = None
            if isinstance(data, dict):
                hosted_url = data.get("url") or data.get("stripe_hosted_url") or data.get("checkout_url")

            if not hosted_url:
                self.send_json(
                    502,
                    {
                        "error": "响应里没有找到付款长链接。",
                        "detail": scrub_sensitive(data),
                    },
                )
                return

            self.send_json(
                200,
                {
                    "url": hosted_url,
                    "country": country,
                    "currency": payload["billing_details"]["currency"],
                },
            )
        except json.JSONDecodeError:
            self.send_json(400, {"error": "JSON 格式不正确。"})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(500, {"error": str(error) or "生成失败。"})


def main():
    server = None
    active_port = PORT
    for offset in range(10):
        active_port = PORT + offset
        try:
            server = ThreadingHTTPServer(("127.0.0.1", active_port), Handler)
            break
        except OSError as error:
            if error.errno not in (errno.EADDRINUSE, errno.EACCES, 10048, 10013):
                raise

    if server is None:
        raise OSError(f"无法在 {PORT}-{PORT + 9} 范围内找到可用端口。")

    print(f"Long link generator is running at http://127.0.0.1:{active_port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
