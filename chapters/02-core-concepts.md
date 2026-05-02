# 第二章 · 核心概念与设计哲学


> **本章目标**：
> 1. 深入理解 DeerFlow 的「解耦」设计哲学
> 2. 掌握 Skill、Sub-Agent、Sandbox、Memory 四大核心概念的区别与联系
> 3. 了解 LangGraph 在 DeerFlow 中的编排角色

> **本章目标**：
> 1. 掌握 Skill、Tool、Agent、Sandbox、Memory 五大核心概念
> 2. 理解 DeerFlow 的状态图工作流模型
> 3. 建立 DeerFlow 与 LangGraph 的关系认知

## 2.1 设计哲学：解耦与可扩展

> **💡 最佳实践**：解耦不仅发生在代码层，也应体现在团队分工上。建议让 Prompt 工程师负责 SKILL.md，后端工程师负责 Tool 实现，DevOps 负责 Sandbox 配置。

DeerFlow 的设计遵循一个核心原则：**将「能力」与「执行」分离**。

传统 AI 应用往往把 Prompt、工具、执行逻辑耦合在一起，导致：
- 难以复用
- 难以测试
- 难以扩展

DeerFlow 的解法：

```
┌─────────────────────────────────────────────────┐
│                  Agent Harness                  │
├─────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ Skills  │  │ Memory  │  │ Sandbox │        │
│  └────┬────┘  └────┬────┘  └────┬────┘        │
│       │            │            │              │
│       └────────────┼────────────┘              │
│                    ▼                           │
│            ┌───────────┐                       │
│            │ LangGraph │ ← 工作流编排核心       │
│            │   Agent   │                       │
│            └───────────┘                       │
└─────────────────────────────────────────────────┘
```

**Skill** 定义「能做什么」
**Sandbox** 定义「在哪里执行」
**Memory** 定义「记住什么」
**LangGraph** 定义「如何协作」

## 2.2 核心概念

### 2.2.1 Skill（技能）

> **⚠️ 注意**：Skill 的 prompt 模板中避免使用过于具体的业务术语，否则当业务变更时，需要修改的 Skill 数量会急剧膨胀。保持 prompt 的抽象层级与业务层解耦。

Skill 是 DeerFlow 的基本能力单元。它定义了一个「可以完成特定任务的能力」。

**与 Tool 的区别：**
- **Tool**：单一操作（如搜索、计算、访问 URL）
- **Skill**：复合能力，可能包含多个 Tool 和 Prompt

**Skill 的结构：**
```yaml
skill:
  name: web-researcher
  description: 在互联网上搜索并整理信息
  tools:
    - web_search
    - web_fetch
    - scrape
  prompt: |
    你是一个专业的研究员...
```

**内置 Skills：**
- `deer-flow-skills/recursive-summarizer` — 递归摘要
- `deer-flow-skills/quick-searcher` — 快速搜索
- `deer-flow-skills/in-depth-researcher` — 深度研究

### 2.2.2 Sub-Agent（子代理）

Sub-Agent 是 DeerFlow 的协作单元。与单一 Agent 不同，Sub-Agent 允许将复杂任务分解给多个专业化 Agent。

**使用模式：**
```python
# 主 Agent 调用子 Agent
async def run_subagent():
    result = await sub_agent.run(
        task="分析竞品技术架构",
        agent_type="researcher",
        context=current_context
    )
    return result
```

**子代理类型：**
| 类型 | 用途 |
|------|------|
| `lead_agent` | 主控 Agent |
| `planner` | 任务规划 |
| `researcher` | 研究搜索 |
| `coder` | 代码编写 |
| `reviewer` | 代码审查 |

### 2.2.3 Sandbox（沙箱）

Sandbox 是 DeerFlow 的执行环境隔离层。代码执行必须在沙箱中进行，保证宿主安全。

**三种模式：**

| 模式 | 适用场景 | 隔离级别 |
|------|----------|----------|
| `local` | 开发调试 | 无 |
| `docker` | 单机部署 | 容器级 |
| `provisioner` | 生产 K8s | Pod 级 |

**核心原理：**
```python
# 代码执行流程
async def execute_in_sandbox(code: str, language: str):
    sandbox = get_sandbox_provider()
    container = await sandbox.acquire()
    try:
        result = await container.run(code, language)
    finally:
        await sandbox.release(container)
```

### 2.2.4 Memory（记忆）

Memory 是 DeerFlow 的知识持久化层。

**架构：**
```
┌─────────────────────────────────┐
│        Memory System            │
├─────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐      │
│  │Working  │  │ Long-   │      │
│  │Memory   │  │ Term    │      │
│  │(Context)│  │ Memory  │      │
│  └─────────┘  └─────────┘      │
│         │           │           │
│         ▼           ▼           │
│    (当前会话)   (持久化存储)     │
└─────────────────────────────────┘
```

**存储后端：**
- Working Memory: LangGraph Checkpointing
- Long-term Memory: SQLite / PostgreSQL / 自定义

### 2.2.5 Context Engineering

Context Engineering 是 DeerFlow 的核心竞争力之一：如何高效管理上下文。

**核心问题：**
1. Context 长度限制（模型 max_tokens）
2. 早期信息丢失（context 窗口的中间部分）
3. 检索效率与质量的平衡

**DeerFlow 的解法：**

```python
class ContextManager:
    def __init__(self, max_tokens: int):
        self.max_tokens = max_tokens
        self.compressor = RecursiveSummarizer()
    
    async def build_context(self, task: str, memories: list):
        # 1. 检索相关记忆
        relevant = await self.retrieve(task, memories)
        
        # 2. 递归压缩（如果超长）
        if self.count_tokens(relevant) > self.max_tokens:
            relevant = await self.compressor.compress(relevant)
        
        # 3. 构建最终上下文
        return self.assemble(task, relevant)
```

## 2.3 工作流模型

DeerFlow 基于 LangGraph 构建工作流，采用**状态机**模型。

**核心状态：**
```python
class AgentState(TypedDict):
    messages: List[BaseMessage]           # 对话历史
    context: Dict[str, Any]               # 上下文变量
    current_task: Optional[str]          # 当前任务
    pending_subagent_tasks: List[Task]   # 待执行的子任务
    completed_subagent_results: Dict     # 已完成的子任务结果
    memory_snapshot: Optional[str]       # 记忆快照
    sandbox_results: Optional[Dict]      # 沙箱执行结果
```

**状态转换：**
```
START → PLANNING → EXECUTING → (SUBAGENT_CALL)? → (SANDBOX_RUN)? → REVIEWING → END
                      ↑                              │
                      └──────────────────────────────┘
```

## 2.4 与 LangGraph 的关系

DeerFlow 2.0 的核心改变：完全基于 LangGraph 重写。

**为什么选择 LangGraph：**

1. **图的表达能力**：Agent 流程天然适合用图来表达
2. **状态管理**：内置 Checkpointing，支持回溯
3. **可观测性**：与 LangSmith 无缝集成
4. **生态丰富**：LangChain 工具链直接可用

**DeerFlow 在 LangGraph 上的封装：**
```python
# DeerFlow 的 Agent 本质上是一个 LangGraph StateGraph
from langgraph.graph import StateGraph

workflow = StateGraph(AgentState)

# 添加节点
workflow.add_node("planner", plan_node)
workflow.add_node("executor", execute_node)
workflow.add_node("reviewer", review_node)

# 添加边
workflow.add_edge("planner", "executor")
workflow.add_edge("executor", "reviewer")
workflow.add_conditional_edges(
    "reviewer",
    should_continue,  # 判断是否需要继续或结束
    {"continue": "executor", "end": END}
)

# 编译
agent = workflow.compile()
```

## 2.5 小结

DeerFlow 的设计哲学可以总结为：

| 原则 | 实践 |
|------|------|
| **解耦** | Skills/Tools/Memory 独立可替换 |
| **可扩展** | MCP Server、Custom Skills 支持 |
| **安全** | Sandbox 多层隔离 |
| **可观测** | LangSmith 完整链路追踪 |
| **生产级** | IM 渠道、高可用部署 |

理解这些核心概念，是后续源码剖析的基础。


## 本章小结

本章深入解析了 DeerFlow 的四大核心概念与设计哲学：

1. **解耦与可扩展**：将「能力」（Skill）与「执行」（Sandbox）分离，Prompt 与工具解耦，确保每个组件可独立演进。
2. **Skill ≠ Tool**：Skill 是复合能力（Prompt + 多工具），Tool 是单一操作。Skill 是面向业务的能力封装，Tool 是面向系统的原子操作。
3. **Sub-Agent 的分而治之**：通过专业化 Agent 分解复杂任务，避免 Prompt 长度瓶颈和上下文稀释。
4. **LangGraph 编排核心**：所有组件通过 LangGraph 的节点与边进行工作流编排，实现状态驱动的 Agent 协作。

> **⚠️ 注意**：不要将 Sub-Agent 嵌套过深（建议 ≤ 3 层），否则会导致上下文膨胀和调试困难。

---

**下一步**：阅读第三章，了解 DeerFlow 的系统架构与模块职责边界。

