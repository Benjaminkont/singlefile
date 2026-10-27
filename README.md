# 智能体与工作流 · 本地网页资料库

用 SingleFile 保存的智能体与工作流精选网页，附带归档、检索、验证和翻译工具。资料按来源站点组织，可在本地离线阅读。

## 收录范围

- **82 篇原始网页**：Anthropic 13 篇，ChatGPT Learn 69 篇。
- **2 份中文副本**和 **82 份提取正文**。
- 主题涵盖 Agent 架构、规划、多代理、工具调用、MCP、Skills、记忆和上下文工程。
- [网页分类与逐篇清单](docs/网页内容分类.md)。

仓库仅包含这批精选资料。网页中指向未收录文章的链接会访问原站；视频、登录和依赖在线服务的交互不保证离线可用。

## 阅读资料

克隆或下载仓库后，直接打开 [归档首页](archives/index.html)，无需安装依赖。GitHub 文件页面用于浏览仓库内容；网页快照应在本地打开。

中文副本：

- [中文：zh-CN-research-building-effective-agents-38c43325a5.html](./archives/anthropic.com/pages/zh-CN-research-building-effective-agents-38c43325a5.html)
- [中文：zh-CN-research-claude-think-tool-d2127010b0.html](./archives/anthropic.com/pages/zh-CN-research-claude-think-tool-d2127010b0.html)

Mac 上也可以打开 `run/`，双击：

| 入口 | 用途 |
| --- | --- |
| `打开资料库.command` | 启动本地服务；搜索标题和网址、按站点筛选 |
| `添加网页.command` | 保存指定网址并检查离线结果，自动更新目录 |
| `更新目录.command` | 重建目录，不联网、不改写快照 |

预览服务仅监听本机。默认地址为 <http://127.0.0.1:8765/>；端口被其他项目占用时可指定其他端口。

## 使用工具

需要 Node.js 24 或更高版本。抓取和浏览器验证还需要系统 Chrome；浏览已有资料和更新目录无需 Chrome。

```bash
npm ci --ignore-scripts
npm run preview -- --port=8766
npm run prepare
npm run capture -- --source=anthropic.com --dry-run
npm run capture -- --source=learn.chatgpt.com --dry-run
npm test
```

两个站点的目标配置均只包含已收录原文。默认复用现有成功网页，只有显式使用 `--refresh` 才重新抓取。

新增资料仍可使用 `npm run add -- '完整网址'`。本仓库的 Git 忽略规则只允许本次精选资料进入版本管理；新增页面若要公开，需要同时更新目标范围、清单和忽略规则，再检查暂存内容。

## 文件与流程

- `archives/`：阅读目录、原始及中文 HTML、提取正文和精选抓取报告。
- `config/sources/`：按站点划分的精选目标配置。
- `scripts/`、`tests/`、`run/`：通用工具、测试及 Mac 入口。
- `docs/`：[使用指南](docs/README.md)、[归档流程](docs/页面归档SOP.md)、[翻译 SOP](docs/网页翻译SOP.md)、[文件结构](docs/文件结构表.md)及固定版本的官方参考资料。

依赖、浏览器缓存、运行日志、截图、失败快照和翻译工作文件不随仓库上传，运行工具时可能在本地生成。公开副本中的跨页链接经过范围整理，网页路径与正文保持原有组织方式。
