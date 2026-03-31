# 第三章 · 架构总览

## 3.1 系统架构图

DeerFlow 采用典型的分层架构，通过 Nginx 统一入口：

```
┌──────────────────────────────────────────────────────────────────┐
│                        Client (Browser)                           │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Nginx (Port 2026)                               │
│                   Unified Reverse Proxy Entry Point                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  /api/langgraph/*  →  LangGraph Server (2024)              │  │
│  │  /api/*            →  Gateway API (8001)                   │  │
│  │  /*                →  Frontend (3000)                       │  │
│  └────────────────────────────────────────────────────────────┘  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
     ┌───────────────────────┼───────────────────────┐
     │                       │                       │
     ▼                       ▼                       ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ LangGraph Server│ │   Gateway API   │ │    Frontend     │
│   (Port 2024)   │ │   (Port 8001)   │ │   (Port 3000)   │
│                 │ │                 │ │                 │
│  Agent Runtime  │ │  Models API     │ │  Next.js App    │
│  Thread Mgmt    │ │  MCP Config     │ │  React UI       │
│  SSE Streaming  │ │  Skills Mgmt   │ │  Chat Interface │
│  Checkpointing  │ │  File Uploads   │ │                 │
│                 │ │  Artifacts      │ │                 │
└────────┬────────┘ └────────┬────────┘ └─────────────────┘
         │                   │
         │     ┌─────────────┘
         │     │
         ▼     ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Shared Configuration                           │
│  ┌────────────────────────┐  ┌────────────────────────────────┐ │
│  │      config.yaml       │  │   extensions_config.json       │ │
│  │  Models                │  │   MCP Servers                  │ │
│  │  Tools                 │  │   Skills State                 │ │
│  │  Sandbox               │  │                                │ │
│  │  Summarization         │  │                                │ │
│  └────────────────────────┘  └────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## 3.2 核心组件详解

### 3.2.1 LangGraph Server（Agent 运行时）

**职责：**
- Agent 创建与配置
- Thread 状态管理
- 中间件链执行
- Tool 执行编排
- SSE 流式响应

**入口点：**
```
packages/harness/deerflow/agents/lead_agent/agent.py:make_lead_agent
```

**配置文件：** `langgraph.json`

```json
{
  "agent": {
    "type": "agent",
    "path": "deerflow.agents:make_lead_agent"
  }
}
```

### 3.2.2 Gateway API

FastAPI 应用，提供非 Agent 操作的 REST 端点。

**路由划分：**

| 路由 | 端点 | 职责 |
|------|------|------|
| `models.py` | `/api/models` | 模型列表与详情 |
| `mcp.py` | `/api/mcp` | MCP Server 配置 |
| `skills.py` | `/api/skills` | Skills 管理 |
| `uploads.py` | `/api/threads/{id}/uploads` | 文件上传 |
| `threads.py` | `/api/threads/{id}` | Thread 数据清理 |
| `artifacts.py` | `/api/threads/{id}/artifacts` | 文件服务 |
| `suggestions.py` | `/api/threads/{id}/suggestions` | 后续建议生成 |

### 3.2.3 Frontend

Next.js 应用，提供 React UI。

## 3.3 Agent 架构详解

```
┌───────────────────────────────────────────────────────────────────┐
│                      make_lead_agent(config)                       │
└─────────────────────────────┬─────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│                         Middleware Chain                           │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ 1. ThreadDataMiddleware    - 初始化 workspace/uploads/outputs │  │
│  │ 2. UploadsMiddleware      - 处理上传文件                    │  │
│  │ 3. SandboxMiddleware      - 获取沙箱环境                    │  │
│  │ 4. SummarizationMiddleware - 上下文压缩（启用时）           │  │
│  │ 5. TitleMiddleware        - 自动生成标题                    │  │
│  │ 6. TodoListMiddleware     - 任务跟踪（plan_mode 时）        │  │
│  │ 7. ViewImageMiddleware    - Vision 模型支持                 │  │
│  │ 8. ClarificationMiddleware - 处理澄清请求                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────┬─────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│                            Agent Core                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │      Model       │  │      Tools       │  │   System Prompt  │ │
│  │   (from config)  │  │ (configured +    │  │   (with skills)  │ │
│  │                  │  │  MCP + builtin)  │  │                  │ │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

## 3.4 ThreadState 与 AgentState

`ThreadState` 扩展了 LangGraph 的 `AgentState`：

```python
class ThreadState(AgentState):
    # 来自 AgentState 的核心状态
    messages: list[BaseMessage]

    # DeerFlow 扩展字段
    sandbox: dict              # 沙箱环境信息
    artifacts: list[str]       # 生成的文件路径
    thread_data: dict          # {workspace, uploads, outputs} 路径
    title: str | None          # 自动生成的对话标题
    todos: list[dict]          # 任务跟踪（plan 模式）
    viewed_images: dict        # Vision 模型图片数据
```

## 3.5 Sandbox 系统架构

```
┌───────────────────────────────────────────────────────────────────┐
│                        Sandbox Architecture                       │
└───────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐
│     Local       │  │     Docker      │  │   Provisioner       │
│   Executor      │  │   Container     │  │   (K8s Pod)         │
│                 │  │                 │  │                     │
│ - 直接本地执行   │  │ - 容器隔离      │  │ - K8s Pod 隔离      │
│ - 无额外开销    │  │ - 镜像预拉取    │  │ - 按需创建/销毁     │
│ - 开发/调试用   │  │ - 资源限制      │  │ - 生产环境推荐      │
└─────────────────┘  └─────────────────┘  └─────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐
│  Code Interpreter│  │  Web Fetch      │  │   Skill Executor    │
│  (Python/JS)    │  │  + Search       │  │                     │
└─────────────────┘  └─────────────────┘  └─────────────────────┘
```

## 3.6 请求处理流程

```
用户请求
    │
    ▼
Nginx (2026)
    │
    ├─→ /api/langgraph/* → LangGraph Server
    │                         │
    │                         ▼
    │                      Agent Runtime
    │                         │
    │                         ├─→ Middleware Chain
    │                         ├─→ Model (LLM)
    │                         ├─→ Tools
    │                         ├─→ Sub-Agents
    │                         └─→ Sandbox
    │
    ├─→ /api/* → Gateway API
    │              │
    │              ▼
    │           REST Endpoints
    │
    └─→ /* → Frontend (Static)
```

## 3.7 中间件链详解

中间件是 DeerFlow 的请求处理链，每个中间件负责特定功能：

### ThreadDataMiddleware
```python
# 初始化每个 Thread 的工作目录
thread_data = {
    "workspace": "/tmp/deer-flow/threads/{thread_id}/workspace",
    "uploads": "/tmp/deer-flow/threads/{thread_id}/uploads", 
    "outputs": "/tmp/deer-flow/threads/{thread_id}/outputs"
}
```

### UploadsMiddleware
```python
# 处理用户上传的文件
# - 解析文件类型
# - 存储到 uploads 目录
# - 将路径注入 context
```

### SandboxMiddleware
```python
# 获取沙箱环境
sandbox = await sandbox_provider.acquire()
# 将 sandbox 对象注入 state
state["sandbox"] = sandbox
```

### SummarizationMiddleware
```python
# 当 context 超过阈值时，触发摘要压缩
if count_tokens(messages) > summarization_threshold:
    messages = await summarizer.compress(messages)
```

### TodoListMiddleware
```python
# plan_mode 时，跟踪任务列表
# 解析 LLM 输出，更新 todos 列表
```

## 3.8 配置体系

DeerFlow 使用双配置文件：

### config.yaml
主配置文件，定义模型、工具、沙箱等核心设置。

```yaml
models:
  - name: gpt-4
    display_name: GPT-4
    use: langchain_openai:ChatOpenAI
    model: gpt-4
    api_key: $OPENAI_API_KEY

sandbox:
  use: deerflow.community.aio_sandbox:AioSandboxProvider
  provisioner_url: https://...
```

### extensions_config.json
扩展配置文件，管理 MCP Servers 和 Skills。

```json
{
  "mcp_servers": [
    {
      "name": "filesystem",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      "args": ["/tmp"]
    }
  ],
  "skills": {
    "deer-flow-skills/recursive-summarizer": {
      "enabled": true
    }
  }
}
```

## 3.9 小结

DeerFlow 的架构设计体现了以下原则：

| 原则 | 体现 |
|------|------|
| **分层解耦** | Nginx → Gateway/LangGraph → Services |
| **中间件编排** | 请求经过可插拔的中间件链 |
| **配置驱动** | 双配置文件机制 |
| **可扩展性** | MCP Server、Custom Skills 支持 |
| **安全隔离** | Sandbox 多层架构 |

理解这些架构设计，是后续深入源码的前提。
