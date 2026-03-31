# 第四章 · 项目结构与模块划分

## 4.1 整体目录结构

```
deer-flow/
├── config.example.yaml              # 配置模板
├── extensions_config.example.json    # MCP & Skills 配置模板
├── Makefile                         # 构建命令
│
├── scripts/
│   └── docker.sh                   # Docker 管理脚本
│
├── docker/
│   ├── docker-compose-dev.yaml     # Docker Compose 配置
│   └── nginx/
│       ├── nginx.conf              # Docker 环境 Nginx 配置
│       └── nginx.local.conf        # 本地开发 Nginx 配置
│
├── backend/                        # 后端应用
│   ├── src/
│   │   ├── gateway/               # Gateway API (8001)
│   │   ├── agents/               # LangGraph Agents (2024)
│   │   ├── mcp/                  # MCP 集成
│   │   ├── skills/               # Skills 系统
│   │   └── sandbox/              # Sandbox 执行
│   ├── docs/                     # 后端文档
│   └── Makefile
│
├── frontend/                      # 前端应用
│   └── Makefile
│
└── skills/                        # Agent Skills
    ├── public/                   # 公共 Skills
    └── custom/                   # 自定义 Skills
```

## 4.2 核心模块详解

### 4.2.1 Gateway API (`backend/src/gateway/`)

**职责：** 提供 RESTful API，处理非 Agent 操作。

**端口：** 8001

**路由：**

| 文件 | 路由 | 说明 |
|------|------|------|
| `models.py` | `/api/models` | 模型列表与配置 |
| `mcp.py` | `/api/mcp` | MCP Server 管理 |
| `skills.py` | `/api/skills` | Skills 注册与状态 |
| `uploads.py` | `/api/threads/{id}/uploads` | 文件上传 |
| `threads.py` | `/api/threads/{id}` | Thread 数据清理 |
| `artifacts.py` | `/api/threads/{id}/artifacts` | 生成物服务 |
| `suggestions.py` | `/api/threads/{id}/suggestions` | 后续建议 |

**关键设计：**
```python
# Gateway 删除流程现在是分阶段的
# 1. LangGraph 处理 DELETE /api/langgraph/threads/{thread_id}
#    → 删除 thread state
# 2. Gateway threads.py router
#    → 通过 Paths.delete_thread_dir() 清理文件系统数据
```

### 4.2.2 Agents (`backend/src/agents/`)

**职责：** LangGraph Agent 运行时核心。

**入口：** `packages/harness/deerflow/agents/lead_agent/agent.py:make_lead_agent`

**核心组件：**
```
agents/
├── lead_agent/          # 主控 Agent
│   ├── agent.py         # make_lead_agent() 入口
│   ├── nodes/           # 节点定义
│   └── prompts/         # Prompt 模板
├── sub_agents/          # 子代理
└── shared/             # 共享组件
```

### 4.2.3 Skills (`backend/src/skills/`)

**职责：** Skill 系统的核心实现。

```
skills/
├── skill_loader.py      # Skill 加载器
├── skill_registry.py    # Skill 注册表
└── executors/           # Skill 执行器
```

### 4.2.4 Sandbox (`backend/src/sandbox/`)

**职责：** 代码执行隔离环境。

```
sandbox/
├── local.py             # 本地执行器
├── docker.py            # Docker 容器执行器
├── provisioner.py       # K8s Provisioner
└── base.py              # 抽象基类
```

## 4.3 前端结构 (`frontend/`)

```
frontend/
├── src/
│   ├── app/             # Next.js App Router
│   ├── components/      # React 组件
│   ├── hooks/           # 自定义 Hooks
│   └── lib/             # 工具库
└── public/              # 静态资源
```

## 4.4 开发命令

```bash
# 后端测试
cd backend
uv run pytest

# 前端检查
cd frontend
pnpm check

# 格式化
cd backend && make format    # ruff
cd frontend && pnpm format:write  # prettier
```

## 4.5 配置体系

### config.yaml - 主配置
```yaml
models:
  - name: gpt-4
    use: langchain_openai:ChatOpenAI
    model: gpt-4

sandbox:
  use: deerflow.community.aio_sandbox:AioSandboxProvider
```

### extensions_config.json - 扩展配置
```json
{
  "mcp_servers": [...],
  "skills": {...}
}
```

## 4.6 SwarmMind 二次开发建议

基于 DeerFlow 结构，SwarmMind 可以在以下位置扩展：

| 扩展点 | 位置 | 说明 |
|--------|------|------|
| **Agent 类型** | `agents/sub_agents/` | 新增专业 Agent |
| **Skill** | `skills/` | 企业专用能力 |
| **Middleware** | `agents/lead_agent/` | 添加审批、检查逻辑 |
| **Memory** | 需新增 | 企业知识库对接 |
| **Channel** | `gateway/` | 企业 IM 集成 |

## 4.7 小结

DeerFlow 的项目结构清晰，分层明确：
- **Gateway** 负责非实时 API
- **Agents** 负责核心推理
- **Skills** 负责能力扩展
- **Sandbox** 负责安全执行

这种分层使得二次开发可以聚焦在特定层，无需理解全部代码。
