# 长链生成器

本项目是一个本地小工具：页面收集 `accessToken` 或包含 `accessToken` 的 JSON，本地服务转发到 ChatGPT checkout 接口并返回 hosted payment 长链接。

## 启动

```bash
python server.py
```

然后打开：

```text
http://127.0.0.1:5173
```

启动时如果 5173 被占用，脚本会自动尝试后面的端口，并在终端打印实际地址。

端口被占用时可以换一个：

```powershell
$env:PORT=5174; python server.py
```

如果你的 Node 环境可用，也可以运行：

```bash
npm start
```

## 部署到 Cloudflare Workers

项目已包含 `wrangler.jsonc` 和 `src/worker.js`，可以把 `public/` 静态页面和 `/api/checkout` 接口一起部署到 Cloudflare Workers。

首次部署：

```bash
npm install
npx wrangler login
npx wrangler whoami
npx wrangler deploy
```

本地预览 Worker 版本：

```bash
npx wrangler dev
```

如果要修改 Worker 名称，编辑 `wrangler.jsonc` 里的 `name`。

## 打包 Windows 可执行文件

先安装 PyInstaller：

```powershell
python -m pip install pyinstaller
```

然后打包：

```powershell
.\build_exe.ps1
```

输出文件：

```text
dist\LongLinkGenerator.exe
```

双击运行后，终端会打印访问地址，例如：

```text
http://127.0.0.1:5173
```

## 说明

- token 不会写入本地文件，也不会在服务端日志中打印。
- 浏览器静态页面直接请求 `chatgpt.com` 通常会被 CORS 阻止，所以这里使用本地 `/api/checkout` 代理。
- 如果 ChatGPT 后端额外要求 Cookie、账号资格或地区校验，页面会展示接口返回的错误。
