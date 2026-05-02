# 第三章 · 架构总览


> **本章目标**：
> 1. 掌握 DeerFlow 的分层架构（Client → Nginx → Gateway → LangGraph）
> 2. 理解 Gateway API 与 LangGraph Server 的职责边界
> 3. 了解 ThreadState 的状态流转与 AgentState 扩展机制

> **本章目标**：
> 1. 掌握 DeerFlow 的分层系统架构与各层职责
> 2. 理解 ThreadState 与 AgentState 的状态流转
> 3. 了解中间件链、Skill 加载与 Gateway 的协作机制

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
│  SSE Streaming  │ │  Skills Mgmt    │ │  Chat Interface │
│  Checkpointing  │ │  File Uploads   │ │                 │
│  Progressive    │ │  Artifacts      │ │                 │
│  Skill Loading  │ │                 │ │                 │
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

> **🏢 企业级建议**：Gateway API 作为统一入口，建议在其前面再部署一层企业级 API 网关（如 Kong、Apigee）以处理 SSO、WAF、DDoS 防护等更高级别的安全需求。

### 3.2.1 LangGraph Server（Agent 运行时）

**职责：**
- Agent 创建与配置
- Thread 状态管理
- 中间件链执行
- Tool 执行编排
- SSE 流式响应
- **渐进式 Skill 加载** — 按需动态加载 Skill，降低启动开销

**入口点：**
```text
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

### 前端架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Next.js Frontend (Port 3000)              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐   │
│  │   App Router    │  │   API Routes    │  │  Middleware│   │
│  │  (app/)         │  │  (app/api/)     │  │            │   │
│  ├─────────────────┤  ├─────────────────┤  └─────────────┘   │
│  │                 │  │                 │                    │
│  │ • /chat/[id]    │  │ • /api/models   │                    │
│  │ • /projects     │  │ • /api/threads    │                    │
│  │ • /settings     │  │ • /api/skills     │                    │
│  │ • /artifacts    │  │ • /api/uploads    │                    │
│  │                 │  │                 │                    │
│  └────────┬────────┘  └────────┬────────┘                    │
│           │                    │                             │
│           ▼                    ▼                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    React Components                      │ │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐    │ │
│  │  │ Chat UI    │  │ ThreadList │  │  Settings  │    │ │
│  │  │            │  │            │  │            │    │ │
│  │  │ - Message  │  │ - Search   │  │ - Models   │    │ │
│  │  │   Stream   │  │ - Filter   │  │ - Theme    │    │ │
│  │  │ - Input    │  │ - Sort     │  │ - Lang     │    │ │
│  │  │ - Toolbar  │  │            │  │            │    │ │
│  │  └────────────┘  └────────────┘  └────────────┘    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              SSE 流式消息处理 (EventSource)                │ │
│  │                                                          │ │
│  │  Gateway/LangGraph ──→ Server-Sent Events ──→ React State│ │
│  │  (实时推送 Agent 输出)                                     │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**核心页面：**

| 路由 | 页面 | 功能 |
|------|------|------|
| `/chat/[id]` | 对话页 | 消息流、工具调用展示、文件上传 |
| `/projects` | 项目管理 | 多 Agent 协作项目列表 |
| `/settings` | 设置页 | 模型选择、主题切换、语言设置 |
| `/artifacts` | 产物管理 | 查看/下载 Agent 生成的文件 |

**SSE 流式通信：**

前端通过 EventSource 连接到 LangGraph Server 的 SSE 端点，实时接收 Agent 的输出：

```typescript
// app/chat/hooks/useAgentStream.ts
const eventSource = new EventSource(`/api/langgraph/threads/${threadId}/runs/stream`);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // 处理消息类型：message/tool_call/artifact/error
  if (data.type === 'message') {
    appendMessage(data.content);
  } else if (data.type === 'tool_call') {
    showToolExecution(data.tool_name, data.status);
  }
};
```

**状态管理：**

- **React Context**：Thread 级别状态（messages、artifacts、loading）
- **SWR**：服务端数据缓存（model list、thread list、skill registry）
- **Zustand**：全局 UI 状态（theme、sidebar collapsed）

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

> **⚠️ 注意**：Local Sandbox 虽然部署简单，但在多租户场景下存在容器逃逸风险。生产环境务必使用 K8s Provisioner 或专用沙箱服务。

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
    │                         ├─→ Progressive Skill Loading（按需加载）
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

中间件是 DeerFlow 的请求处理链，每个中间件负责特定功能。DeerFlow 2.0 共包含 **18 个中间件**（详见第五章 5.5.1 节），按职责分为两大类：

| 类别 | 中间件 | 职责 |
|------|--------|------|
| **运行时基础** | ThreadDataMiddleware | 初始化每个 Thread 的工作目录 |
| | UploadsMiddleware | 处理用户上传的文件 |
| | SandboxMiddleware | 获取沙箱环境 |
| | DanglingToolCallMiddleware | 补全缺失的工具响应 |
| | LLMErrorHandlingMiddleware | LLM 错误处理与重试 |
| | GuardrailMiddleware | 工具调用前授权（可选） |
| | SandboxAuditMiddleware | 沙箱命令安全审计 |
| | ToolErrorHandlingMiddleware | 工具错误处理 |
| **Lead Agent 专属** | SummarizationMiddleware | 上下文压缩（可选） |
| | TodoListMiddleware | 任务跟踪（plan 模式可选） |
| | TokenUsageMiddleware | Token 使用统计（可选） |
| | TitleMiddleware | 自动生成标题 |
| | MemoryMiddleware | 异步记忆更新 |
| | ViewImageMiddleware | Vision 模型图片注入（可选） |
| | DeferredToolFilterMiddleware | 延迟工具过滤（可选） |
| | SubagentLimitMiddleware | 子任务数量限制（可选） |
| | LoopDetectionMiddleware | 循环检测与阻断 |
| | ClarificationMiddleware | 澄清请求拦截（必须最后） |

> 完整中间件接口定义、参数说明和源码解析，请参阅 **5.5.1 完整中间件顺序** 与 **5.5.3 核心中间件详解**。

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

## 3.9 渐进式 Skill 加载的架构位置

Progressive Skill Loading 是 DeerFlow 2.0 引入的核心特性，它在架构层面解决了 Skill 过多导致的启动延迟问题。

### 3.9.1 架构定位

```
┌───────────────────────────────────────────────────────────────────┐
│                    Progressive Skill Loading                      │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐           │
│  │  Skill      │    │  Lazy       │    │  On-Demand  │           │
│  │  Registry   │───→│  Loader     │───→│  Executor   │           │
│  │             │    │             │    │             │           │
│  │ - ClawHub   │    │ - 解析      │    │ - 初始化    │           │
│  │ - Local     │    │   依赖树    │    │ - 注入      │           │
│  │ - Builtin   │    │ - 按需拉取  │    │   工具集    │           │
│  └─────────────┘    └─────────────┘    └─────────────┘           │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**在 LangGraph Server 中的位置：**
- 位于 **Middleware Chain 之后、Model 之前**
- 拦截用户请求中的 Skill 引用（如 `@skill_name`）
- 动态解析 Skill 依赖树，按需加载到当前 Thread 的上下文中

### 3.9.2 加载时机

| 触发时机 | 行为 | 性能影响 |
|----------|------|----------|
| Thread 创建 | 加载 `extensions_config.json` 中 `enabled: true` 的 Skill | 基础开销 |
| 用户显式引用 | 解析 `@skill_name`，懒加载对应 Skill | 首次延迟 |
| Skill 依赖解析 | 递归加载被引用的子 Skill | 级联加载 |
| 热更新 | 检测到 Skill 版本变更时重新加载 | 运行时更新 |

### 3.9.3 与其他组件的协作

**与 Middleware Chain 的协作：**
```
Middleware Chain
    │
    ├─→ ThreadDataMiddleware（初始化目录）
    ├─→ UploadsMiddleware（处理上传）
    ├─→ SandboxMiddleware（获取沙箱）
    ├─→ ProgressiveSkillMiddleware ← 新增：解析并加载 Skill
    │      │
    │      ▼
    │   Skill Registry → Lazy Loader → Tool Injection
    │
    └─→ SummarizationMiddleware（上下文压缩）
```

**与 Gateway API 的协作：**
- Gateway 的 `/api/skills` 端点提供 Skill 元数据查询
- Progressive Loader 通过内部 API 获取 Skill 的依赖关系和加载策略

### 3.9.4 设计优势

1. **启动加速**：Agent 启动时无需加载全部 Skill，仅加载必需的基础集合
2. **内存优化**：未使用的 Skill 不占用运行时内存
3. **依赖自治**：Skill 声明自己的依赖，Loader 自动解析依赖树
4. **热插拔**：支持运行时更新 Skill 而不重启 Agent

## 3.10 小结

DeerFlow 的架构设计体现了以下原则：

| 原则 | 体现 |
|------|------|
| **分层解耦** | Nginx → Gateway/LangGraph → Services |
| **中间件编排** | 请求经过可插拔的中间件链 |
| **配置驱动** | 双配置文件机制 |
| **可扩展性** | MCP Server、Custom Skills 支持 |
| **安全隔离** | Sandbox 多层架构 |

理解这些架构设计，是后续深入源码的前提。


## 本章小结

本章梳理了 DeerFlow 的系统架构与模块交互：

1. **分层网关**：Nginx (2026) → Gateway API (8001) / LangGraph Server (2024) / Frontend (3000)，统一入口、职责分离。
2. **Gateway API**：FastAPI 应用，负责非 Agent 操作（认证、模型列表、租户管理），与 LangGraph Server 解耦。
3. **LangGraph Server**：核心 Agent 编排服务，处理对话流、工具调用、状态管理，通过 ThreadState 维护会话上下文。
4. **ThreadState 扩展**：在 LangGraph AgentState 基础上扩展了 sandbox、artifacts、thread_data 等企业级字段。

> **🏢 企业级建议**：生产环境中建议为 Gateway API 和 LangGraph Server 配置独立的负载均衡与健康检查。

---

**下一步**：阅读第四章，熟悉 DeerFlow 的 monorepo 目录结构与项目组织方式。

