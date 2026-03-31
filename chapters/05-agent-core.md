# 第五章 · Agent 核心：LangGraph 编排逻辑

## 5.1 核心入口：make_lead_agent

DeerFlow 的 Agent 核心入口是一个工厂函数：

```python
# 入口：packages/harness/deerflow/agents/lead_agent/agent.py
from deerflow.agents import make_lead_agent

agent = make_lead_agent(config: RunnableConfig)
```

这个函数完成：
1. 动态模型选择（支持 thinking / vision）
2. 工具加载（Sandbox + Builtin + MCP + Community + Subagent）
3. 系统 Prompt 生成（包含 skills、memory、subagent 指令）
4. 中间件链组装

## 5.2 ThreadState：Agent 状态定义

```python
# packages/harness/deerflow/agents/thread_state.py

class ThreadState(AgentState):
    # 继承自 AgentState
    messages: list[BaseMessage]
    
    # DeerFlow 扩展字段
    sandbox: dict              # 沙箱信息 {sandbox_id}
    thread_data: dict          # {workspace, uploads, outputs} 路径
    title: str | None         # 自动生成的对话标题
    artifacts: list[str]       # 生成的文件列表（去重）
    todos: list[dict]          # 任务跟踪（plan 模式）
    uploaded_files: list       # 上传的文件
    viewed_images: dict        # Vision 模型图片数据（合并/清除）
```

**自定义 Reducer：**
```python
# artifacts 去重合并
merge_artifacts(existing, new) -> list

# viewed_images 合并后清除
merge_viewed_images(existing, new) -> dict
```

## 5.3 运行时配置（configurable）

通过 `config.configurable` 注入运行时参数：

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `thinking_enabled` | bool | 启用模型扩展思考 |
| `model_name` | str | 选择具体 LLM 模型 |
| `is_plan_mode` | bool | 启用 TodoList 中间件 |
| `subagent_enabled` | bool | 启用任务委托工具 |

```python
# 使用示例
config = RunnableConfig(
    configurable={
        "thinking_enabled": True,
        "model_name": "claude-sonnet-4-6",
        "subagent_enabled": True,
    }
)
result = await agent.ainvoke(input, config=config)
```

## 5.4 LangGraph 工作流结构

```
┌─────────────────────────────────────────────────────────────┐
│                    StateGraph<ThreadState>                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  START ──→  middleware_chain ──→  model_llm ──→  tools ──→ END
│                        ▲                  │
│                        │                  │
│                        └──────────────────┘
│                           (循环直到完成)
└─────────────────────────────────────────────────────────────┘
```

### 5.4.1 节点定义

DeerFlow 的核心节点：

| 节点 | 职责 |
|------|------|
| `middleware_chain` | 执行中间件链 |
| `model_llm` | 调用 LLM |
| `tools` | 执行工具调用 |

### 5.4.2 边与条件跳转

```python
from langgraph.graph import END

# 条件函数
def should_continue(state: ThreadState) -> str:
    """
    判断是否继续执行
    """
    last_message = state["messages"][-1]
    
    # 如果有工具调用 → 继续执行工具
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tools"
    
    # 如果是最终响应 → 结束
    return END

# 添加条件边
workflow.add_conditional_edges(
    "model_llm",
    should_continue,
    {
        "tools": "tools_node",
        END: END
    }
)
```

## 5.5 中间件链（Middleware Chain）

中间件是 DeerFlow 请求处理的核心机制，**按顺序执行，不可跳过**。

### 5.5.1 完整中间件顺序（12个）

```
┌─────────────────────────────────────────────────────────────────┐
│                    Middleware Chain (12个)                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. ThreadDataMiddleware        初始化工作目录                    │
│  2. UploadsMiddleware           处理上传文件                      │
│  3. SandboxMiddleware           获取沙箱环境                      │
│  4. DanglingToolCallMiddleware  补全缺失的工具响应               │
│  5. GuardrailMiddleware         工具调用前授权（可选）           │
│  6. SummarizationMiddleware     上下文压缩（可选）               │
│  7. TodoListMiddleware          任务跟踪（plan 模式）            │
│  8. TitleMiddleware             自动生成标题                     │
│  9. MemoryMiddleware            异步记忆更新                     │
│ 10. ViewImageMiddleware         Vision 模型图片注入               │
│ 11. SubagentLimitMiddleware     子任务数量限制（可选）           │
│ 12. ClarificationMiddleware     澄清请求拦截（必须最后）         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.5.2 中间件接口

```python
class Middleware(ABC):
    """
    中间件基类
    """
    
    async def process(
        self,
        state: ThreadState,
        messages: List[BaseMessage]
    ) -> MiddlewareResult:
        """
        处理中间件逻辑
        返回：continue（继续）/ suspend（暂停）/ interrupt（中断）
        """
        raise NotImplementedError
```

### 5.5.3 核心中间件详解

#### ThreadDataMiddleware

```python
class ThreadDataMiddleware:
    """
    为每个 Thread 创建独立的工作目录
    """
    
    async def process(self, state: ThreadState) -> MiddlewareResult:
        thread_id = state.get("thread_id")
        
        # 创建目录结构
        thread_data = {
            "workspace": f".deer-flow/threads/{thread_id}/user-data/workspace",
            "uploads": f".deer-flow/threads/{thread_id}/user-data/uploads",
            "outputs": f".deer-flow/threads/{thread_id}/user-data/outputs",
        }
        
        # 确保目录存在
        for path in thread_data.values():
            Path(path).mkdir(parents=True, exist_ok=True)
        
        # 注入到 state
        state["thread_data"] = thread_data
        
        return MiddlewareResult(continue=True)
```

#### SandboxMiddleware

```python
class SandboxMiddleware:
    """
    获取沙箱环境
    """
    
    async def process(self, state: ThreadState) -> MiddlewareResult:
        # 获取沙箱提供者
        sandbox_provider = get_sandbox_provider()
        
        # 获取沙箱实例
        sandbox = await sandbox_provider.acquire()
        
        # 将沙箱信息注入 state
        state["sandbox"] = {
            "sandbox_id": sandbox.id,
            "sandbox_type": sandbox.type,
        }
        
        return MiddlewareResult(continue=True)
```

#### GuardrailMiddleware

```python
class GuardrailMiddleware:
    """
    工具调用前授权检查
    """
    
    def __init__(self, guardrail_provider: GuardrailProvider):
        self.guardrail = guardrail_provider
    
    async def process(
        self,
        state: ThreadState,
        tool_call: ToolCall
    ) -> MiddlewareResult:
        """
        在工具执行前进行授权检查
        """
        # 调用 Guardrail Provider 评估
        decision = await self.guardrail.evaluate(tool_call, state)
        
        if decision.allowed:
            return MiddlewareResult(continue=True)
        else:
            # 返回错误消息，中断执行
            return MiddlewareResult(
                continue=False,
                interrupt=True,
                error_message=decision.reason
            )
```

#### SummarizationMiddleware

```python
class SummarizationMiddleware:
    """
    当上下文接近 token 限制时，触发压缩
    """
    
    async def process(self, state: ThreadState) -> MiddlewareResult:
        messages = state["messages"]
        
        # 计算当前 token 数
        current_tokens = count_tokens(messages)
        
        # 检查是否需要压缩
        if current_tokens > self.threshold:
            # 触发上下文压缩
            compressed = await self.summarizer.compress(messages)
            state["messages"] = compressed
            
            return MiddlewareResult(
                continue=True,
                metadata={"compressed": True}
            )
        
        return MiddlewareResult(continue=True)
```

#### ClarificationMiddleware

```python
class ClarificationMiddleware:
    """
    拦截澄清请求，必须放在最后
    """
    
    async def process(
        self,
        state: ThreadState,
        last_message: AIMessage
    ) -> MiddlewareResult:
        """
        检查是否是澄清请求
        """
        if last_message.tool_calls:
            for tool_call in last_message.tool_calls:
                if tool_call.name == "ask_clarification":
                    # 拦截并中断
                    return MiddlewareResult(
                        continue=False,
                        interrupt=True,
                        goto=END  # 结束当前轮次
                    )
        
        return MiddlewareResult(continue=True)
```

## 5.6 工具系统（Tools）

### 5.6.1 工具加载流程

```
get_available_tools()
       │
       ├── 1. Sandbox Tools (bash, ls, read, write, str_replace)
       ├── 2. Builtin Tools (present_files, ask_clarification, view_image)
       ├── 3. MCP Tools (从配置的 MCP Server 加载)
       ├── 4. Community Tools (tavily, jina_ai, firecrawl, image_search)
       └── 5. Subagent Tools (task delegation)
```

### 5.6.2 工具注册表

```python
class ToolRegistry:
    """
    工具注册表
    """
    
    def __init__(self):
        self._tools: Dict[str, BaseTool] = {}
    
    def register(self, name: str, tool: BaseTool):
        self._tools[name] = tool
    
    def get(self, name: str) -> Optional[BaseTool]:
        return self._tools.get(name)
    
    def list_all(self) -> List[BaseTool]:
        return list(self._tools.values())
```

### 5.6.3 内置工具

| 工具 | 功能 |
|------|------|
| `bash` | 执行 Shell 命令 |
| `ls` | 目录列表（树形，最大2层） |
| `read_file` | 读取文件内容（支持行范围） |
| `write_file` | 写入/追加文件 |
| `str_replace` | 字符串替换编辑 |
| `present_files` | 展示生成的文件 |
| `ask_clarification` | 请求用户澄清 |
| `view_image` | 查看图片 |

## 5.7 系统 Prompt 生成

```python
def apply_prompt_template(
    base_template: str,
    skills: List[Skill],
    memory_context: str,
    subagent_instructions: str,
    config: RunnableConfig
) -> str:
    """
    组装完整的系统 Prompt
    """
    parts = [base_template]
    
    # 1. Skills 指令
    if skills:
        skills_section = "\n\n## Available Skills\n"
        for skill in skills:
            skills_section += f"- **{skill.name}**: {skill.description}\n"
            skills_section += f"  Usage: {skill.usage}\n"
        parts.append(skills_section)
    
    # 2. Memory 上下文
    if memory_context:
        parts.append(f"\n\n## Memory Context\n{memory_context}\n")
    
    # 3. Subagent 指令
    if subagent_instructions:
        parts.append(f"\n\n## Subagent Delegation\n{subagent_instructions}\n")
    
    return "\n".join(parts)
```

## 5.8 SwarmMind 二次开发：自定义 Lead Agent

### 5.8.1 扩展 ThreadState

```python
# SwarmMind 定制 ThreadState
class SwarmMindThreadState(ThreadState):
    # 原有字段...
    
    # 新增：企业级字段
    project_id: Optional[str]        # 当前项目
    organization_id: Optional[str]   # 组织 ID
    user_role: Optional[str]         # 用户角色
    approval_queue: List[Approval]  # 待审批队列
    audit_context: AuditContext     # 审计上下文
```

### 5.8.2 添加企业中间件

```python
class SwarmMindMiddlewareChain:
    """
    SwarmMind 定制中间件链
    """
    
    @staticmethod
    def build() -> List[Middleware]:
        return [
            ThreadDataMiddleware(),           # 1. 原有
            RBACMiddleware(),                  # 2. 新增：权限检查
            UploadsMiddleware(),              # 3. 原有
            SandboxMiddleware(),              # 4. 原有
            ApprovalMiddleware(),             # 5. 新增：审批检查
            GuardrailMiddleware(),            # 6. 原有
            SummarizationMiddleware(),        # 7. 原有
            AuditLoggerMiddleware(),          # 8. 新增：审计日志
            TodoListMiddleware(),              # 9. 原有
            TitleMiddleware(),                # 10. 原有
            MemoryMiddleware(),               # 11. 原有
            ViewImageMiddleware(),            # 12. 原有
            SubagentLimitMiddleware(),        # 13. 原有
            ClarificationMiddleware(),        # 14. 原有
        ]
```

### 5.8.3 自定义 Agent 工厂

```python
def make_swarmmind_agent(config: RunnableConfig) -> CompiledGraph:
    """
    SwarmMind 定制 Agent 工厂
    """
    # 1. 构建中间件链
    middlewares = SwarmMindMiddlewareChain.build()
    
    # 2. 创建 Agent
    workflow = StateGraph(SwarmMindThreadState)
    
    # 3. 添加节点
    workflow.add_node("middlewares", run_middleware_chain(middlewares))
    workflow.add_node("model", model_node)
    workflow.add_node("tools", tools_node)
    
    # 4. 添加边
    workflow.add_edge(START, "middlewares")
    workflow.add_edge("middlewares", "model")
    workflow.add_conditional_edges("model", should_continue, {...})
    workflow.add_edge("tools", "model")
    
    # 5. 编译
    return workflow.compile()
```

## 5.9 小结

DeerFlow Agent 核心要点：

| 组件 | 核心机制 |
|------|----------|
| **状态管理** | ThreadState 扩展 LangGraph AgentState |
| **中间件链** | 12 个中间件按序执行，可插拔 |
| **工具系统** | Sandbox/Builtin/MCP/Community/Subagent 五类 |
| **配置驱动** | configurable 运行时注入 |
| **Prompt 组装** | 动态拼接 Skills/Memory/Subagent |

SwarmMind 可在此基础上：
- 扩展 ThreadState 添加企业字段
- 在中间件链中添加 RBAC、审批、审计
- 自定义工具集满足企业需求
