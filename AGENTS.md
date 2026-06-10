# AGENTS.md

## Cursor Cloud specific instructions

### 项目性质

本仓库是 **Huashu Design** agent skill（非传统 Web 应用）。没有 `npm run dev` 或常驻后端服务。开发流程为：安装工具链 → 打开/验证 `demos/*.html` → 运行 `scripts/` 导出脚本。

### 必需依赖

| 依赖 | 用途 |
|------|------|
| Node.js 18+ | 导出脚本（`render-video.js`、`export_deck_*.mjs` 等） |
| `npm install` | `playwright`、`pdf-lib`、`pptxgenjs`、`sharp` |
| Playwright Chromium | 截图、录屏、PDF/PPTX 导出 |
| ffmpeg | MP4/GIF 编码、BGM 混音 |

### 常用命令

```bash
# 安装 JS 依赖（VM 启动时自动执行）
npm install
npx playwright install chromium

# 验证 HTML demo（Node 路径，推荐）
NODE_PATH=$(npm root) node scripts/render-video.js demos/c3-motion-design.html --duration=5

# 验证 HTML demo（Python 路径，需一次性安装）
pip install playwright && python3 -m playwright install chromium
python3 scripts/verify.py demos/c1-ios-prototype.html

# 本地预览 demo（CDN 资源建议用 HTTP 而非 file://）
python3 -m http.server 8765
# 浏览器打开 http://localhost:8765/demos/c1-ios-prototype.html
```

### 服务说明

- **无数据库 / 无 Docker / 无后端 API**
- **HTTP 服务器**（`python3 -m http.server`）：仅多文件 React 项目或 CDN 资源加载不稳定时需要；单文件 demo 可直接 `file://` 打开
- **Doubao TTS**（`.env` 中 `DOUBAO_TTS_*`）：仅配音流水线需要，其余能力无需配置

### 注意事项

- Node 与 Python 的 Playwright 各自维护浏览器缓存；若 `verify.py` 报 `Executable doesn't exist`，运行 `python3 -m playwright install chromium`
- `render-video.js` 等脚本需设置 `NODE_PATH=$(npm root)` 以解析本地 `playwright` 包
- 导出脚本会在 demo 同目录生成 `.mp4` 等文件，注意勿将大文件误提交
- Console 中的 `AudioContext` 警告在无用户手势时属正常，不影响原型交互验证
