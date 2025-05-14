# AI Code Review Helper (Cloudflare Workers 版本)

这是一个基于 Cloudflare Workers 构建的 AI 代码审查助手，旨在自动化代码审查过程。该项目利用 LLM (如 GPT) 分析代码变更并提供有用的反馈。

## 项目架构

本项目包含两个主要组件，均以 Cloudflare Workers 形式部署：

1. **Worker Webhook** (`cloudflare/workers/worker-webhook`):
   - 接收来自 GitHub/GitLab 的 webhook 事件通知
   - 分析 PR/MR 变更并将审查任务发送至队列

2. **Worker Reviewer** (`cloudflare/workers/worker-reviewer`):
   - 从队列中消费审查任务
   - 调用 LLM API 获取代码审查结果
   - 将结果发布回 GitHub/GitLab 作为评论

## 技术栈

- **Cloudflare Workers**: 无服务器计算平台
- **TypeScript**: 开发语言
- **Cloudflare Queues**: 任务队列服务
- **Cloudflare KV**: 键值存储服务
- **Vitest**: 测试框架
- **MSW**: 模拟测试中的 HTTP 请求

## 通过 GitHub 部署到 Cloudflare

本项目使用 GitHub Actions 自动部署到 Cloudflare Workers。以下是详细的部署步骤：

### 1. 前提条件

- Cloudflare 账户
- GitHub 账户
- OpenAI API 密钥或其他 LLM 服务密钥
- GitHub 和/或 GitLab 访问令牌
- 可选：自部署 GitLab 实例（如需集成）
- 可选：符合 OpenAI 接口标准的自定义 LLM 服务

### 2. Cloudflare 资源设置

1. **创建 KV 命名空间**:
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
   - 进入 Workers & Pages > KV
   - 创建新命名空间: `REVIEW_RESULTS_KV`
   - 记下命名空间 ID 供后续使用

2. **创建队列**:
   - 进入 Workers & Pages > Queues
   - 创建新队列: `review-tasks-queue`

3. **创建 API 令牌**:
   - 进入 My Profile > API Tokens
   - 点击 "Create Token"
   - 选择 "Edit Cloudflare Workers" 模板
   - 设置必要权限 (Account > Workers Scripts > Edit)
   - 创建并保存令牌

### 3. GitHub 仓库设置

1. **Fork 或克隆本仓库**
   - 访问 [https://github.com/ImKK666/ai-code-review-helper-cf](https://github.com/ImKK666/ai-code-review-helper-cf)
   - 点击 "Fork" 或复制仓库到您的账户

2. **配置 GitHub Secrets**
   - 在您的仓库中，进入 Settings > Secrets and variables > Actions
   - 添加以下 secrets:
     - `CLOUDFLARE_API_TOKEN`: 从 Cloudflare 获取的 API 令牌
     - `LLM_API_KEY`: OpenAI 或其他 LLM 服务的 API 密钥
     - `GH_ACCESS_TOKEN`: GitHub 访问令牌
     - `GITLAB_TOKEN`: GitLab 访问令牌 (如果需要)
     - `REVIEW_RESULTS_KV_ID`: Cloudflare KV 命名空间 ID
     - `LLM_ENDPOINT`: LLM API 端点 URL (可选，默认为 OpenAI)
     - `GITLAB_BASE_URL`: GitLab 基础 URL (可选，用于自部署 GitLab 实例)

### 4. 部署过程

**自动化部署流程**:

1. 当代码推送到主分支时，GitHub Actions 工作流会自动触发
2. 工作流会为每个 Worker 执行以下步骤:
   - 配置 Node.js 环境
   - 安装依赖
   - 运行测试
   - 使用 Wrangler 部署到 Cloudflare
3. 环境变量和密钥会从 GitHub Secrets 安全传递到部署过程
4. 部署完成后，Workers 立即可用

**手动触发部署**:
- 进入 GitHub 仓库的 Actions 选项卡
- 选择 "Deploy to Cloudflare Workers" 工作流
- 点击 "Run workflow"
- 选择要部署的分支
- 点击 "Run workflow" 按钮

### 5. 验证部署

1. **检查 GitHub Actions 结果**:
   - 在 Actions 选项卡查看部署日志
   - 确认工作流程成功完成

2. **验证 Cloudflare 部署**:
   - 登录 Cloudflare Dashboard
   - 进入 Workers & Pages > Overview
   - 确认 `worker-reviewer` 和 `worker-webhook` 已成功部署
   - 点击每个 Worker 查看详情和 URL

### 6. 配置 Webhook 集成

1. **GitHub 配置**:
   - 在需要代码审查的仓库中，进入 Settings > Webhooks
   - 添加新 webhook:
     - Payload URL: 您的 worker-webhook URL (例如: `https://worker-webhook.your-subdomain.workers.dev`)
     - Content type: `application/json`
     - 仅选择 "Pull request" 事件
     - 激活 webhook

2. **GitLab 配置**:
   - 在项目中，进入 Settings > Webhooks
   - 添加新 webhook:
     - URL: 您的 worker-webhook URL
     - 选择 "Merge Request events"
     - 添加 webhook

## 故障排除

- **部署失败**:
  - 检查 GitHub Actions 日志以识别错误
  - 验证所有必要的 secrets 是否正确设置
  - 确保 Cloudflare API 令牌有足够的权限

- **"Missing XYZ secret" 错误**:
  - 检查 GitHub 仓库的 Secrets 设置
  - 确保所有必需的 secrets 都已添加并且名称正确

- **"Worker already exists with a different ID" 错误**:
  - 在 Cloudflare Dashboard 中删除现有 Worker
  - 或更改 wrangler.toml 中的 Worker 名称

- **Webhook 未触发**:
  - 检查 webhook 配置和 URL
  - 在 GitHub/GitLab webhook 设置中查看最近投递记录

- **未能连接到 KV 或队列**:
  - 验证 KV 命名空间 ID 是否正确
  - 确保队列名称与配置文件匹配

## 使用方法

一旦部署完成并配置 webhook，系统将自动处理:

1. 当有新的 PR/MR 创建或更新时，webhook 会触发
2. Worker Webhook 会分析变更并提交审查任务到队列
3. Worker Reviewer 处理任务，调用 LLM 进行代码审查
4. 审查结果作为评论发布回 PR/MR

## 高级配置

### 自定义 LLM API 端点

默认情况下，系统使用 OpenAI API 进行代码审查。您可以配置任何符合 OpenAI 接口标准的 LLM API:

1. 在 GitHub 仓库的 Secrets 中设置 `LLM_ENDPOINT`:
   - OpenAI API: `https://api.openai.com/v1/chat/completions`
   - 或其他兼容的 API 端点

2. 模型名称可通过 `LLM_MODEL_NAME` 环境变量或 wrangler.toml 中设置（默认为 "gpt-3.5-turbo"）

### 自部署 GitLab 集成

如果您使用自行部署的 GitLab 实例而非 gitlab.com，可进行以下配置:

1. 在 GitHub 仓库的 Secrets 中设置 `GITLAB_BASE_URL`:
   - 示例: `https://gitlab.example.com`（不包含末尾斜杠和 "/api/v4" 路径）

2. 确保您的 GitLab 访问令牌具有适当的权限，并已在 Secrets 中设置为 `GITLAB_TOKEN`

## 许可证

MIT

## 联系方式

如有问题或建议，请创建 issue 或联系仓库维护者。
