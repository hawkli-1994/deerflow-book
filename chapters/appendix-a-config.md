# 附录 A · 配置参考

## A.1 config.yaml 完整配置

```yaml
# DeerFlow 主配置文件
# 路径：项目根目录

config_version: "2.0"  # 配置版本，用于升级检测

#========================================
# 模型配置
#========================================
models:
  # 示例：OpenAI 模型
  - name: gpt-4                    # 内部标识
    display_name: GPT-4           # 显示名称
    use: langchain_openai:ChatOpenAI  # LangChain 类路径
    model: gpt-4                  # API 模型名
    api_key: $OPENAI_API_KEY     # API Key（环境变量引用）
    base_url: https://api.openai.com/v1  # 可选，自定义端点
    max_tokens: 4096              # 单次请求最大 tokens
    temperature: 0.7              # 采样温度
    
  # 示例：Anthropic 模型
  - name: claude-sonnet-4-6
    display_name: Claude Sonnet 4.6
    use: deerflow.models.claude_provider:ClaudeChatModel
    model: claude-sonnet-4-6
    api_key: $ANTHROPIC_API_KEY
    max_tokens: 4096
    supports_thinking: true      # 支持扩展思考
    supports_reasoning_effort: true

  # 示例：OpenRouter 模型
  - name: openrouter-gemini-2.5-flash
    display_name: Gemini 2.5 Flash (OpenRouter)
    use: langchain_openai:ChatOpenAI
    model: google/gemini-2.5-flash-preview
    api_key: $OPENAI_API_KEY
    base_url: https://openrouter.ai/api/v1
    
  # 示例：Codex CLI
  - name: gpt-5.4
    display_name: GPT-5.4 (Codex CLI)
    use: deerflow.models.openai_codex_provider:CodexChatModel
    model: gpt-5.4
    supports_thinking: true
    supports_reasoning_effort: true

#========================================
# 默认 Agent 配置
#========================================
agents:
  defaults:
    # 默认模型
    model:
      primary: claude-sonnet-4-6  # 主用模型
      fallbacks:                  # 备用模型列表
        - gpt-4
        - openrouter-gemini-2.5-flash
    
    # 工作目录
    workspace: ~/.deer-flow/workspace
    
    # 中间件配置
    middlewares:
      # 上下文压缩
      summarization:
        enabled: true
        threshold_tokens: 80000
        compression_ratio: 0.5
      
      # 任务跟踪（Plan 模式）
      todo_list:
        enabled: false  # 仅在 plan_mode 时启用
      
      # 沙箱配置
      sandbox:
        enabled: true
    
    # 并发限制
    max_concurrent_subagents: 4
    
    # 递归深度限制
    recursion_limit: 100

#========================================
# Sandbox 配置
#========================================
sandbox:
  # 沙箱模式：local | docker | provisioner
  mode: docker
  
  # Local 模式配置
  local:
    enabled: true
    # 无需额外配置，直接在宿主机执行
  
  # Docker 模式配置
  docker:
    enabled: true
    image: deer-flow-sandbox:latest
    # 资源限制
    resources:
      cpu_limit: "2"
      memory_limit: "4g"
    # 网络配置
    network: bridge
    # 存储卷
    volumes:
      - type: bind
        source: ./workspace
        target: /mnt/user-data
  
  # Provisioner (K8s) 模式配置
  provisioner:
    enabled: false
    provisioner_url: https://provisioner.example.com:8002
    kubeconfig: ~/.kube/config
    # 默认资源限制
    defaults:
      cpu_limit: "2"
      memory_limit: "4g"
      timeout_seconds: 3600
    # 镜像预拉取
    prepull_images:
      - deer-flow-sandbox:latest

#========================================
# 社区工具配置
#========================================
community:
  # Tavily 搜索
  tavily:
    enabled: true
    api_key: $TAVILY_API_KEY
  
  # Jina AI 读取器
  jina_ai:
    enabled: true
    api_key: $JINA_API_KEY
  
  # Firecrawl 抓取
  firecrawl:
    enabled: false
    api_key: $FIRECRAWL_API_KEY

#========================================
# MCP Server 配置
#========================================
mcp_servers:
  - name: filesystem
    enabled: true
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"]
    args: ["/tmp"]
    env: {}
  
  - name: github
    enabled: false
    command: ["npx", "-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: $GITHUB_TOKEN

#========================================
# Summarization 配置
#========================================
summarization:
  # 摘要模型
  model: gpt-4
  # 触发阈值（tokens）
  threshold_tokens: 80000
  # 压缩比
  compression_ratio: 0.5
  # 保留最近 N 轮完整消息
  keep_recent_turns: 2

#========================================
# Guardrails 配置（可选）
#========================================
guardrails:
  enabled: false
  # 内置 Allowlist Provider（无需额外依赖）
  provider:
    type: allowlist  # 或 "oap"（需安装 aport-agent-guardrails）
    # allowlist 类型配置
    allowlist:
      # 允许的域名
      allowed_domains:
        - example.com
        - trusted-site.io
      # 允许的 IP
      allowed_ips:
        - 10.0.0.0/8
        - 192.168.0.0/16

#========================================
# LangSmith 链路追踪（可选）
#========================================
langsmith:
  enabled: false
  api_key: $LANGCHAIN_API_KEY
  project: deer-flow  # 项目名称
  # 可选：过滤追踪内容
  tracing:
    sandbox: false  # 是否追踪沙箱执行
```

## A.2 extensions_config.json 完整配置

```json
{
  "mcp_servers": [
    {
      "name": "filesystem",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      "args": ["/tmp"],
      "env": {},
      "enabled": true
    },
    {
      "name": "github",
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "args": [],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN"
      },
      "enabled": false
    }
  ],
  "skills": {
    "deer-flow-skills/recursive-summarizer": {
      "enabled": true,
      "config": {
        "max_tokens": 2000
      }
    },
    "deer-flow-skills/quick-searcher": {
      "enabled": true
    },
    "deer-flow-skills/in-depth-researcher": {
      "enabled": true,
      "config": {
        "max_iterations": 5
      }
    }
  }
}
```

## A.3 环境变量参考

```bash
#========================================
# 必需的环境变量
#========================================

# OpenAI API
OPENAI_API_KEY=sk-...

#========================================
# 可选的环境变量
#========================================

# Anthropic API (Claude)
ANTHROPIC_API_KEY=sk-ant-...

# Tavily Search
TAVILY_API_KEY=tvly-...

# Jina AI Reader
JINA_API_KEY=...

# Firecrawl
FIRECRAWL_API_KEY=...

# GitHub Token
GITHUB_TOKEN=ghp_...

# LangChain (for tracing)
LANGCHAIN_API_KEY=...
LANGCHAIN_PROJECT=deer-flow
LANGCHAIN_TRACING_V2=true

#========================================
# DeerFlow 特定配置
#========================================

# 配置文件路径
DEER_FLOW_CONFIG_PATH=/path/to/config.yaml
DEER_FLOW_EXTENSIONS_CONFIG_PATH=/path/to/extensions_config.json

# 日志级别
DEER_FLOW_LOG_LEVEL=info

# 开发模式
DEER_FLOW_DEV=true
```

## A.4 Docker 环境变量

```bash
# Docker Compose 环境变量文件 (.env)

#======== 基础配置 ========
COMPOSE_PROJECT_NAME=deer-flow

#======== API Keys ========
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

#======== 可选服务 ========
TAVILY_API_KEY=tvly-...
JINA_API_KEY=...

#======== 飞书配置 ========
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx

#======== Slack 配置 ========
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

#======== Telegram 配置 ========
TELEGRAM_BOT_TOKEN=123456:ABC...

#======== LangSmith ========
LANGCHAIN_API_KEY=...
```

## A.5 配置版本升级

DeerFlow 支持配置自动升级：

```bash
# 升级配置文件
make config-upgrade

# 将会：
# 1. 读取当前 config.yaml
# 2. 与 config.example.yaml 对比
# 3. 合并新增的字段
# 4. 保留原有配置
```

## A.6 SwarmMind 扩展配置

```yaml
# SwarmMind 企业配置扩展

swarmmind:
  # 多租户配置
  multi_tenant:
    enabled: true
    isolation_mode: strict
    default_plan: standard
  
  # RBAC 配置
  rbac:
    enabled: true
    default_role: member
    role_hierarchy:
      - tenant_admin
      - project_manager
      - member
      - viewer
      - external
  
  # 审计配置
  audit:
    enabled: true
    storage:
      type: s3
      bucket: swarmmind-audit
    retention_days: 2555
  
  # 企业知识库
  knowledge_base:
    enabled: true
    providers:
      - type: vector
        endpoint: http://kb-search:8080
      - type: graph
        endpoint: http://kb-graph:8080
  
  # Sandbox 企业增强
  sandbox:
    audit_commands: true
    resource_quotas:
      standard:
        cpu_limit: "2"
        memory_limit: "4Gi"
      premium:
        cpu_limit: "8"
        memory_limit: "16Gi"
```
