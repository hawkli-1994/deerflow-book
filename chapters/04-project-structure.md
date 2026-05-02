# 第四章 · 项目结构与模块划分


> **本章目标**：
> 1. 熟悉 DeerFlow 的 monorepo 目录结构与各包职责
> 2. 掌握前端、后端、共享包的代码组织方式
> 3. 了解扩展配置（extensions_config.json）的加载机制

> **本章目标**：
> 1. 熟悉 DeerFlow 的目录结构与模块划分
> 2. 理解 SDK 入口、配置体系与二次开发路径
> 3. 掌握前后端分离的代码组织方式

## 4.1 整体目录结构

> **💡 最佳实践**：二次开发时，建议在 `skills/custom/` 目录下创建自己的 Skill，而不是直接修改 `skills/builtins/`，以避免版本升级时的合并冲突。

```
deer-flow/
├── config.example.yaml               # 主配置模板
├── extensions_config.example.json     # MCP、Skills 等扩展配置模板
├── Makefile                          # 根构建命令
│
├── scripts/
│   ├── docker.sh                     # Docker 管理脚本
│   ├── serve.sh                      # 本地服务启动脚本
│   ├── doctor.py                     # 环境诊断
│   └── wizard/                       # 配置向导
│
├── docker/
│   ├── docker-compose.yaml           # Docker Compose 配置
│   ├── docker-compose-dev.yaml       # 开发环境 Compose 配置
│   └── nginx/
│       ├── nginx.conf                # Docker 环境 Nginx 配置
│       └── nginx.local.conf          # 本地开发 Nginx 配置
│
├── backend/                         # 后端工程
│   ├── app/
│   │   ├── gateway/                 # FastAPI Gateway
│   │   └── channels/                # IM 渠道集成
│   ├── packages/
│   │   └── harness/
│   │       └── deerflow/            # DeerFlow Python 核心包
│   │           ├── agents/          # Lead Agent、状态、记忆与中间件
│   │           ├── subagents/       # 子代理注册与执行
│   │           ├── tools/           # 内置工具与工具搜索
│   │           ├── mcp/             # MCP 客户端、缓存与工具适配
│   │           ├── skills/          # Skill 加载、解析、安装与校验
│   │           ├── sandbox/         # Sandbox 抽象、本地实现与工具
│   │           ├── community/       # Tavily、Jina、Exa 等社区能力
│   │           ├── config/          # 配置模型与加载逻辑
│   │           ├── runtime/         # RunManager、Store、StreamBridge
│   │           ├── models/          # 模型工厂与供应商适配
│   │           ├── guardrails/      # 护栏实现
│   │           └── uploads/         # 上传文件管理
│   ├── tests/                       # 后端测试
│   ├── docs/                        # 后端文档
│   ├── langgraph.json               # LangGraph 运行配置
│   └── Makefile
│
├── frontend/                        # Next.js 前端应用
│   ├── src/
│   │   ├── app/                     # Next.js App Router
│   │   ├── components/              # React 组件
│   │   ├── core/                    # API、消息、线程、模型等业务核心
│   │   ├── hooks/                   # React Hooks
│   │   ├── server/                  # 服务端能力
│   │   └── styles/                  # 全局样式
│   ├── tests/                       # 前端测试
│   └── Makefile
│
└── skills/                          # Agent Skills
    └── public/                      # 内置公共 Skills
```

## 4.2 核心模块详解

### 4.2.1 Gateway API (`backend/app/gateway/`)

**职责：** 提供 RESTful API，处理非 Agent 操作。

**端口：** 8001

**路由：**

| 文件 | 路由 | 说明 |
|------|------|------|
| `routers/models.py` | `/api/models` | 模型列表与配置 |
| `routers/mcp.py` | `/api/mcp` | MCP Server 管理 |
| `routers/memory.py` | `/api/memory` | 全局记忆管理 |
| `routers/skills.py` | `/api/skills` | Skills 注册与状态 |
| `routers/uploads.py` | `/api/threads/{thread_id}/uploads` | 文件上传 |
| `routers/threads.py` | `/api/threads/{thread_id}` | Thread 文件系统数据清理 |
| `routers/artifacts.py` | `/api/threads/{thread_id}/artifacts` | 生成物服务 |
| `routers/suggestions.py` | `/api/threads/{thread_id}/suggestions` | 后续建议 |
| `routers/agents.py` | `/api/agents` | 自定义 Agent 配置 |
| `routers/runs.py` | `/api/runs` | 无状态 Run 执行 |
| `routers/thread_runs.py` | `/api/threads/{thread_id}/runs` | Thread 级 Run 生命周期 |
| `routers/channels.py` | `/api/channels` | IM 渠道管理 |

**关键设计：**
```python
# Gateway 删除流程现在是分阶段的
# 1. LangGraph 处理 DELETE /api/langgraph/threads/{thread_id}
#    → 删除 thread state
# 2. Gateway routers/threads.py
#    → 通过 Paths.delete_thread_dir() 清理文件系统数据
```python

### 4.2.2 Agents (`backend/packages/harness/deerflow/agents/`)

**职责：** LangGraph Agent 运行时核心。

**入口：** `packages/harness/deerflow/agents/lead_agent/agent.py:make_lead_agent`

**核心组件：**
```
agents/
├── factory.py           # create_deerflow_agent() SDK 级入口
├── features.py          # RuntimeFeatures 声明
├── thread_state.py      # ThreadState 状态模型
├── lead_agent/          # 主控 Agent
│   ├── agent.py         # make_lead_agent() 应用入口
│   └── prompt.py        # Prompt 模板
├── middlewares/         # 记忆、总结、沙箱、工具错误处理等中间件
├── memory/              # 记忆存储、摘要与更新
└── checkpointer/        # LangGraph checkpoint provider
```

子代理已经从旧的 `agents/sub_agents/` 拆到独立包：

```
subagents/
├── config.py            # 子代理配置模型
├── executor.py          # 子代理执行器
├── registry.py          # 子代理注册表
└── builtins/            # 内置子代理
```

### 4.2.3 Skills (`backend/packages/harness/deerflow/skills/`)

**职责：** Skill 系统的核心实现。

```
skills/
├── loader.py            # Skill 加载器
├── parser.py            # SKILL.md 解析
├── manager.py           # Skill 管理
├── installer.py         # Skill 安装
├── validation.py        # Skill 校验
├── security_scanner.py  # 安全扫描
└── types.py             # 类型定义
```

### 4.2.4 Sandbox (`backend/packages/harness/deerflow/sandbox/`)

**职责：** 代码执行隔离环境。

```
sandbox/
├── sandbox.py           # Sandbox 抽象
├── sandbox_provider.py  # SandboxProvider 抽象
├── middleware.py        # Agent Sandbox 中间件
├── tools.py             # 沙箱工具
├── search.py            # 沙箱内搜索
├── security.py          # 安全策略
└── local/               # 本地 Sandbox 实现
    ├── local_sandbox.py
    └── local_sandbox_provider.py
```

远程沙箱供应商（例如 AIO Sandbox）位于 `backend/packages/harness/deerflow/community/aio_sandbox/`。

## 4.3 前端结构 (`frontend/`)

```
frontend/
├── src/
│   ├── app/             # Next.js App Router
│   ├── components/      # React 组件
│   ├── core/            # API、业务状态、消息、线程、Skills 等核心逻辑
│   ├── hooks/           # 自定义 Hooks
│   ├── server/          # 服务端功能
│   ├── styles/          # 样式
│   └── lib/             # 通用工具
├── tests/               # 前端测试
└── public/              # 静态资源
```bash

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

> **🏢 企业级建议**：生产环境避免使用 `.env` 文件管理 secrets，建议使用 Vault、AWS Secrets Manager 或 Kubernetes Secrets 等专用 secret 管理工具。

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
```text
{
  "mcp_servers": [...],
  "skills": {...}
}
```

## 4.6 DeerFlow 二次开发建议

基于 DeerFlow 结构，可以在以下位置扩展：

| 扩展点 | 位置 | 说明 |
|--------|------|------|
| **Agent 类型** | `backend/packages/harness/deerflow/subagents/` | 新增专业 Agent |
| **Skill** | `skills/` | 企业专用能力 |
| **Middleware** | `backend/packages/harness/deerflow/agents/middlewares/` | 添加审批、检查逻辑 |
| **Memory** | `backend/packages/harness/deerflow/agents/memory/` | 企业知识库对接 |
| **Channel** | `backend/app/channels/` 与 `backend/app/gateway/routers/channels.py` | 企业 IM 集成 |

## 4.7 小结

DeerFlow 的项目结构清晰，分层明确：
- **Gateway** 负责非实时 API
- **Agents** 负责核心推理
- **Skills** 负责能力扩展
- **Sandbox** 负责安全执行

这种分层使得二次开发可以聚焦在特定层，无需理解全部代码。


## 本章小结

本章介绍了 DeerFlow 的 monorepo 目录结构与开发规范：

1. **五包结构**：frontend（Next.js）、backend（FastAPI）、harness（核心库）、schemas（数据模型）、skills-registry（技能仓库），边界清晰。
2. **Harness 核心**：packages/harness/deerflow/ 包含 agents、skills、sandbox、memory、mcp 等模块，是二次开发的主战场。
3. **扩展配置**：extensions_config.json 支持动态加载 Community Tools 和 MCP Servers，无需修改核心代码。
4. **开发工具链**：ruff（格式化）、mypy（类型检查）、pytest（测试）、Renovate（依赖更新），确保代码质量。

> **💡 最佳实践**：自定义 Skill 建议放在独立的 Git 仓库（如 deer-flow-skills/your-skill），通过 skills-registry 加载，避免污染主仓库。

---

**下一步**：阅读第五章，深入理解 Agent 核心的 LangGraph 编排逻辑。

