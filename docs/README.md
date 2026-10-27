# 使用指南

本公开版本收录 82 篇“智能体与工作流”原文（Anthropic 13 篇、ChatGPT Learn 69 篇），另有 2 份中文副本。配置与抓取报告仅覆盖这些原文。运行记录、元数据和截图等目录会在实际操作时生成，不随本次发布上传。

网页翻译遵循[网页翻译 SOP](网页翻译SOP.md)：以原始 HTML 为底稿，仅替换文字，保留原版式并另存中文副本。

## 浏览和新增

Mac 上优先使用 `run/` 中的三个双击入口。资料库首页支持按站点筛选，搜索范围是标题和网址；搜索不会联网，也不搜索全文正文。

添加网页时粘贴完整 HTTP(S) 网址。首次添加某个站点时自动创建目录和配置，例如 `www.anthropic.com` 归入 `anthropic.com`；原始请求地址保持不变。子域名单独存放，不把同一机构的多个域名强行合并。跳转后的地址记录在抓取报告中，资料仍属于最初选择的站点。

重复添加同一网址（忽略 `#` 片段）会复用已有成功归档。不同查询参数视为不同网址。要重新保存：

```bash
npm run add -- 'https://www.anthropic.com/research/building-effective-agents' --refresh
```

生成目录只读取配置和抓取报告，不修改快照。指向尚未归档的网页仍会访问原站。

## 抓取与验证

```bash
# 先查看计划，不创建浏览器，不改动配置或归档
npm run capture -- --source=learn.chatgpt.com --dry-run

# 处理该站点尚未成功的目标；默认并发 2
npm run capture -- --source=learn.chatgpt.com --concurrency=2

# 指定一页；文件名从站点配置或报告获取
npm run capture -- --source=anthropic.com --only=research-building-effective-agents-38c43325a5.html --refresh

# 默认只检查已保存的离线副本；增加 --screenshots 保存截图
npm run verify -- --source=anthropic.com --screenshots

# 明确需要线上正文对照时再加 --live
npm run verify -- --source=anthropic.com --live
```

HTTP 200、文件有效且离线正文检查通过，才登记为成功。可见图片加载失败会记录在报告中。失败刷新保留先前可阅读的快照，并把失败尝试写入记录。遇到 403、429 或验证页面时，抓取会等待后重试；中断可用同一命令继续。

每站点使用独立的运行锁，避免同一时间写入同一站点。锁中的进程已退出时会清理旧锁；不要删除仍有任务运行的锁文件。

## 浏览器和网络

浏览器选择顺序：`--browser` 指定的路径或 `PUPPETEER_EXECUTABLE_PATH` → 系统 Chrome → 当前平台的项目缓存。Mac 优先使用 `/Applications/Google Chrome.app`。原有 Linux 浏览器缓存保留，不会拿来在 Mac 上启动。

```bash
PUPPETEER_EXECUTABLE_PATH='/你的路径/Chrome' npm run add -- 'https://example.org/article'
```

抓取沿用环境中的 `HTTPS_PROXY`／`HTTP_PROXY`；本项目不会更改系统代理设置。预览服务只监听本机，服务根目录是归档资料，不暴露配置、报告或历史备份。需要换端口：

```bash
npm run preview -- --port=8766
```

## 可选操作

批量发现站内网址会联网检查站点地图及网页链接，将新目标合并到所选站点配置，保留已有文件名；不会自动保存网页。仅在确实需要整站收集时使用：

```bash
npm run discover -- --source=example.org --limit=2000
npm run capture -- --source=example.org --dry-run
```

站点需先通过“添加网页”建立配置。发现功能仅沿配置 `origin` 的主机继续发现，站外链接另行记录。

新保存的页面会将指向已有归档的链接改为本地链接。需要事后整理旧页面的链接时，显式运行：

```bash
npm run relink -- --source=anthropic.com
npm run prepare
```

`relink` 会改写指定站点的网页；已经是本地相对链接的保持原样。它独立于日常更新目录。

重新安装工具依赖：`npm ci --ignore-scripts`。依赖版本锁在 package-lock 中；使用系统 Chrome 时无需下载项目浏览器。

## 结果位置

| 内容 | 站点目录下的位置 |
| --- | --- |
| 网页和正文 | `pages/`、`texts/` |
| 抓取结果及整体状态 | `records/reports/capture-report.json`、`full-run-summary.json` |
| 新的离线复核结果 | `records/reports/offline-verification-report.json` |
| 原有历史验证报告 | `records/reports/verification-report.json`，保留原样 |
| 元数据、日志、截图 | `records/metadata/`、`records/logs/`、`records/screenshots/` |
| 抓取失败的 HTML（如有） | `records/failed/` |
| 网址发现证据 | `records/discovery/` |

日常回归检查使用 `npm test`。需要浏览器验收时，先启动 `npm run preview`，再运行 `npm run test:browser`；截图和结果写入 `tests/.artifacts/browser/`。
