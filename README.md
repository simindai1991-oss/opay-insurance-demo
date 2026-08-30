# OPay Insurance Demo

HTML + light Python file-backed API demo for OPay HMO insurance flows (NEM Rose Plan style).

## Dual mode (one frontend)

| Mode | How | Data |
|------|-----|------|
| **Local API** | `python -m uvicorn server.app:app --reload --port 8787` then open http://127.0.0.1:8787 | Reads/writes `data/store/*.json` |
| **GitHub Pages / static** | Open `web/index.html` via Pages (or any static host) | Reads `data/seed/*.json`, writes `localStorage` |

Frontend always calls the same `ApiClient`. Set `window.DEMO_MODE` in `web/js/config.js` (`api` | `static` | `auto`).

## Quick start (local)

```bash
cd opay-insurance-demo
python -m venv .venv
# Windows:
.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn server.app:app --reload --host 127.0.0.1 --port 8787
```

Open Chrome: http://127.0.0.1:8787/

Reset demo data: `POST /api/demo/reset` or use the in-app **Reset Demo** button.

## Field notes

- Core tables follow the business 7-table design.
- Fields marked **【EXTRA】** in seed JSON comments / `docs/FIELDS.md` are demo-only extensions (category, hospitals map, pendingUntil, etc.).

## GitHub Pages（无需本地后端）

线上版走 **static 模式**：浏览器读取 `data/seed/*.json` 作为初始数据，所有操作写入 **localStorage**（Time travel、投保、续费等逻辑与本地 API 一致，均在浏览器内完成）。

### 部署步骤

1. **推送到 GitHub**（`main` 或 `master` 分支）  
   ```bash
   git add .
   git commit -m "your message"
   git push origin main
   ```

2. **开启 Pages**  
   仓库 → **Settings** → **Pages** → **Build and deployment**  
   - Source 选 **GitHub Actions**（不要选 Deploy from branch）

3. **等待 CI**  
   **Actions** 标签页里 `github-pages` workflow 跑绿即可。

4. **打开站点**  
   地址一般为：  
   `https://<你的用户名>.github.io/<仓库名>/`  
   右上角 mode badge 应显示 **`mode: static`**。

5. **首次或升级后**  
   点左上角 **重置** 按钮，或清除该站点 localStorage，以加载最新 seed 数据。

### 本地预览静态版（同样不需要 Python）

任意静态服务器即可，例如：

```bash
cd opay-insurance-demo/web
npx --yes serve .
```

浏览器打开后确认 badge 为 `static`。若 `config.js` 里 `mode` 为 `auto` 且本机没开 8787，也会自动回落到 static。

### 与本地 API 模式的区别

| | GitHub Pages | 本地 `uvicorn` |
|--|--|--|
| 数据持久化 | 浏览器 localStorage | `data/store/*.json` |
| Debug 面板 | 可用 | 可用 |
| 多人共享同一份数据 | 否（每人浏览器各自一份） | 是（同一 server） |
| 需要 Python | 否 | 是 |

Workflow 部署时会自动把 `config.js` 里的 `mode` 设为 `'static'`，避免尝试连接不存在的 API。
