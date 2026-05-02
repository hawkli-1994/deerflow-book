# 第五章 · Agent 核心：LangGraph 编排逻辑


> **本章目标**：
> 1. 深入理解 make_lead_agent 工厂函数的初始化流程
> 2. 掌握 ThreadState 的字段定义与状态管理机制
> 3. 了解 LangGraph 节点编排、中间件链与工具路由的实现细节

> **本章目标**：
> 1. 深入理解 Lead Agent 的 LangGraph 编排逻辑
> 2. 掌握中间件链的设计模式与扩展方法
> 3. 了解 Client SDK 的使用与 Agent 缓存机制

## 5.1 核心入口：make_lead_agent

DeerFlow 的 Agent 核心入口是一个工厂函数：

```python
# 入口：packages/harness/deerflow/agents/lead_agent/agent.py
from deerflow.agents import make_lead_agent

agent = make_lead_agent(config)
```python

这个函数完成：
1. 动态模型选择（支持 thinking / vision）
2. 工具加载（Sandbox + Builtin + MCP + Community + Subagent）
3. 系统 Prompt 生成（包含 skills、memory、subagent 指令）
4. 中间件链组装

## 5.2 ThreadState：Agent 状态定义

```python
# packages/harness/deerflow/agents/thread_state.py
from typing import Annotated, NotRequired, TypedDict
from langchain.agents import AgentState


class SandboxState(TypedDict):
    """沙箱状态"""
    sandbox_id: NotRequired[str | None]


class ThreadDataState(TypedDict):
    """线程数据路径状态"""
    workspace_path: NotRequired[str | None]
    uploads_path: NotRequired[str | None]
    outputs_path: NotRequired[str | None]


class ViewedImageData(TypedDict):
    """已查看图片数据"""
    base64: str          # Base64 编码的图片数据
    mime_type: str       # MIME 类型 (如 image/png)


def merge_artifacts(existing: list[str] | None, new: list[str] | None) -> list[str]:
    """Reducer for artifacts list - merges and deduplicates artifacts."""
    if existing is None:
        return new or []
    if new is None:
        return existing
    # Use dict.fromkeys to deduplicate while preserving order
    return list(dict.fromkeys(existing + new))


def merge_viewed_images(
    existing: dict[str, ViewedImageData] | None,
    new: dict[str, ViewedImageData] | None
) -> dict[str, ViewedImageData]:
    """Reducer for viewed_images dict - merges image dictionaries.

    Special case: If new is an empty dict {}, it clears the existing images.
    This allows middlewares to clear the viewed_images state after processing.
    """
    if existing is None:
        return new or {}
    if new is None:
        return existing
    # Special case: empty dict means clear all viewed images
    if len(new) == 0:
        return {}
    # Merge dictionaries, new values override existing ones for same keys
    return {**existing, **new}


class ThreadState(AgentState):
    """DeerFlow Agent 状态定义
    
    继承自 LangGraph 的 AgentState，扩展 DeerFlow 特有字段。
    使用 NotRequired 标记可选字段，使用 Annotated + reducer 处理合并逻辑。
    """
    # 沙箱信息
    sandbox: NotRequired[SandboxState | None]
    
    # 线程工作目录路径
    thread_data: NotRequired[ThreadDataState | None]
    
    # 自动生成的对话标题
    title: NotRequired[str | None]
    
    # 生成的文件列表（使用 reducer 自动去重合并）
    artifacts: Annotated[list[str], merge_artifacts]
    
    # 任务跟踪（plan 模式）
    todos: NotRequired[list | None]
    
    # 上传的文件列表
    uploaded_files: NotRequired[list[dict] | None]
    
    # Vision 模型图片数据（使用 reducer 合并/清除）
    # 格式: {image_path -> {base64, mime_type}}
    viewed_images: Annotated[dict[str, ViewedImageData], merge_viewed_images]
```

**自定义 Reducer 说明：**

| Reducer | 功能 | 特殊行为 |
|---------|------|----------|
| `merge_artifacts` | 合并 artifacts 列表并去重 | 使用 `dict.fromkeys` 保持顺序去重 |
| `merge_viewed_images` | 合并 viewed_images 字典 | 传入空 `{}` 时清空所有图片（用于处理后清理）|

## 5.3 运行时配置（configurable）

通过 `config.configurable` 注入运行时参数：

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `thinking_enabled` | bool | 启用模型扩展思考 |
| `model_name` | str | 选择具体 LLM 模型 |
| `is_plan_mode` | bool | 启用 TodoList 中间件 |
| `subagent_enabled` | bool | 启用任务委托工具 |

```python
async def run_agent():
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

> **⚠️ 注意**：自定义 State 的字段命名需避免与 LangGraph 内置字段冲突（如 `messages`、`is_last_step`），否则会导致不可预期的状态覆盖问题。

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

> **💡 最佳实践**：中间件的执行顺序至关重要。SecurityMiddleware 应尽可能靠前，SummarizationMiddleware 应放在消息生成之后。新增中间件时务必测试与其他中间件的交互。

中间件是 DeerFlow 请求处理的核心机制，**按顺序执行，不可跳过**。

### 5.5.1 完整中间件顺序（18 个）

```
┌─────────────────────────────────────────────────────────────────┐
│                    Middleware Chain (18 个)                      │
├─────────────────────────────────────────────────────────────────┤
│  【运行时基础中间件 - build_lead_runtime_middlewares】           │
│  1. ThreadDataMiddleware        初始化工作目录                    │
│  2. UploadsMiddleware           处理上传文件                      │
│  3. SandboxMiddleware           获取沙箱环境                      │
│  4. DanglingToolCallMiddleware  补全缺失的工具响应               │
│  5. LLMErrorHandlingMiddleware  LLM 错误处理与重试               │
│  6. GuardrailMiddleware         工具调用前授权（可选）           │
│  7. SandboxAuditMiddleware      沙箱命令安全审计                 │
│  8. ToolErrorHandlingMiddleware 工具错误处理                     │
│                                                                  │
│  【Lead Agent 专属中间件】                                       │
│  9. SummarizationMiddleware     上下文压缩（可选）               │
│ 10. TodoListMiddleware          任务跟踪（plan 模式可选）        │
│ 11. TokenUsageMiddleware        Token 使用统计（可选）           │
│ 12. TitleMiddleware             自动生成标题                     │
│ 13. MemoryMiddleware            异步记忆更新                     │
│ 14. ViewImageMiddleware         Vision 模型图片注入（可选）      │
│ 15. DeferredToolFilterMiddleware 延迟工具过滤（可选）            │
│ 16. SubagentLimitMiddleware     子任务数量限制（可选）           │
│ 17. LoopDetectionMiddleware     循环检测与阻断                   │
│ 18. ClarificationMiddleware     澄清请求拦截（必须最后）         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**注：** 基础中间件 8 个 + Lead Agent 专属 10 个 = 18 个（其中 6 个为可选配置，根据运行时配置动态加载）。

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
```python

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
        
        return MiddlewareResult(should_should_continue=True)
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
        
        return MiddlewareResult(should_should_continue=True)
```python

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
            return MiddlewareResult(should_should_continue=True)
        else:
            # 返回错误消息，中断执行
            return MiddlewareResult(
                should_continue=False,
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
                should_continue=True,
                metadata={"compressed": True}
            )
        
        return MiddlewareResult(should_should_continue=True)
```python

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
                        should_continue=False,
                        interrupt=True,
                        goto=END  # 结束当前轮次
                    )
        
        return MiddlewareResult(should_should_continue=True)
```

### 5.5.4 新增中间件详解

#### ToolErrorHandlingMiddleware

```python
class ToolErrorHandlingMiddleware(AgentMiddleware[AgentState]):
    """Convert tool exceptions into error ToolMessages so the run can continue."""

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        try:
            return handler(request)
        except GraphBubbleUp:
            # Preserve LangGraph control-flow signals (interrupt/pause/resume).
            raise
        except Exception as exc:
            # 构建错误 ToolMessage，让 Agent 可以继续执行
            return self._build_error_message(request, exc)
```python

**功能：**
- 捕获工具执行异常，避免整个 Agent 运行中断
- 将异常转换为包含错误信息的 `ToolMessage`
- 保留 LangGraph 控制流信号（interrupt/pause/resume）
- 错误信息截断至 500 字符，避免污染上下文

#### LoopDetectionMiddleware

```python
class LoopDetectionMiddleware(AgentMiddleware[AgentState]):
    """Detects and breaks repetitive tool call loops.

    Args:
        warn_threshold: 重复次数达到此值时注入警告。默认: 3。
        hard_limit: 重复次数达到此值时强制停止。默认: 5。
        window_size: 滑动窗口大小。默认: 20。
    """

    _DEFAULT_WARN_THRESHOLD = 3  # 3次警告
    _DEFAULT_HARD_LIMIT = 5      # 5次强制停止
```

**检测策略：**
1. 对每次模型响应的工具调用计算哈希（name + args）
2. 在滑动窗口中跟踪最近的工具调用哈希
3. **警告阶段（≥3次）：** 注入 "你正在重复调用工具，请总结结果" 的提示
4. **强制停止（≥5次）：** 清空 tool_calls，强制模型生成最终文本回答

**特殊处理：**
- `read_file`：按 200 行分桶，避免行号微小差异导致误判
- `write_file`/`str_replace`：对完整参数哈希，区分不同内容写入
- 警告以 `HumanMessage` 形式注入（避免 Anthropic 系统消息位置限制）

#### TokenUsageMiddleware

```python
class TokenUsageMiddleware(AgentMiddleware):
    """Logs token usage from model response usage_metadata."""

    def _log_usage(self, state: AgentState) -> None:
        messages = state.get("messages", [])
        if not messages:
            return None
        last = messages[-1]
        usage = getattr(last, "usage_metadata", None)
        if usage:
            logger.info(
                "LLM token usage: input=%s output=%s total=%s",
                usage.get("input_tokens", "?"),
                usage.get("output_tokens", "?"),
                usage.get("total_tokens", "?"),
            )
```python

**功能：**
- 在 `after_model` 钩子中记录 Token 使用量
- 从 `usage_metadata` 提取 input/output/total tokens
- 仅在 `app_config.token_usage.enabled` 为 true 时加载

#### DeferredToolFilterMiddleware

```python
class DeferredToolFilterMiddleware(AgentMiddleware[AgentState]):
    """Remove deferred tools from request.tools before model binding.

    ToolNode still holds all tools (including deferred) for execution routing,
    but the LLM only sees active tool schemas — deferred tools are discoverable
    via tool_search at runtime.
    """

    def _filter_tools(self, request: ModelRequest) -> ModelRequest:
        registry = get_deferred_registry()
        if not registry:
            return request

        deferred_names = {e.name for e in registry.entries}
        active_tools = [t for t in request.tools 
                       if getattr(t, "name", None) not in deferred_names]
        return request.override(tools=active_tools)
```

**功能：**
- 在 `wrap_model_call` 中过滤延迟加载的工具 schema
- 减少发送给 LLM 的上下文 tokens
- 延迟工具可通过 `tool_search` 在运行时发现
- 仅在 `app_config.tool_search.enabled` 为 true 时加载

#### SandboxAuditMiddleware

```python
class SandboxAuditMiddleware(AgentMiddleware[ThreadState]):
    """Bash command security auditing middleware.

    1. Command classification: regex + shlex 分析命令风险等级
    2. Audit log: 每个 bash 调用记录为结构化 JSON
    3. High-risk commands 被阻断，返回错误 ToolMessage
    4. Medium-risk commands 执行但附加警告
    """
```

**风险分类规则：**

| 等级 | 触发模式 | 处理方式 |
|------|----------|----------|
| **Block** | `rm -rf /`, `curl \| bash`, `mkfs`, `dd if=`, `base64 -d \|`, `/dev/tcp/`, fork bomb 等 | 阻断执行，返回错误消息 |
| **Warn** | `chmod 777`, `pip install`, `apt install`, `sudo`, `PATH=` 等 | 执行并附加警告提示 |
| **Pass** | 其他命令 | 正常执行 |

**输入校验：**
- 最大命令长度：10,000 字符（超出则阻断）
- 禁止 null 字节
- 支持复合命令解析（`&&`, `||`, `;`）

#### LLMErrorHandlingMiddleware

```python
class LLMErrorHandlingMiddleware(AgentMiddleware[AgentState]):
    """Retry transient LLM errors and surface graceful assistant messages.

    可重试错误：APITimeoutError, APIConnectionError, InternalServerError,
    状态码 408/409/425/429/500/502/503/504, 服务繁忙提示等
    """

    retry_max_attempts: int = 3
    retry_base_delay_ms: int = 1000
    retry_cap_delay_ms: int = 8000
```

**错误分类与处理：**

| 错误类型 | 识别模式 | 是否重试 | 用户提示 |
|----------|----------|----------|----------|
| Quota | `insufficient_quota`, `billing`, `credit`, `余额不足` | ❌ | "账户额度不足，请检查计费状态" |
| Auth | `authentication`, `unauthorized`, `invalid api key`, `未授权` | ❌ | "认证失败，请检查 API 密钥" |
| Busy | `server busy`, `overloaded`, `rate limit`, `服务繁忙` | ✅ | "服务暂时不可用，请稍后重试" |
| Transient | Timeout, ConnectionError, 5xx | ✅ | 指数退避重试 |

**重试机制：**
- 最大重试次数：3 次
- 退避策略：指数退避（1s → 2s → 4s），上限 8s
- 支持 `Retry-After` 响应头
- 发送 `llm_retry` 流式事件供前端展示

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

## 5.8 Client SDK：DeerFlowClient

DeerFlow 提供嵌入式 Python 客户端 `DeerFlowClient`，无需启动 LangGraph Server 或 Gateway API 即可直接调用 Agent 能力。

### 5.8.1 基本使用

```python
from deerflow.client import DeerFlowClient

# 创建客户端
client = DeerFlowClient()

# 简单对话
response = client.chat("分析这篇论文", thread_id="my-thread")
print(response)

# 流式输出
for event in client.stream("你好"):
    print(event.type, event.data)
```

### 5.8.2 初始化配置

```python
client = DeerFlowClient(
    config_path="config.yaml",           # 配置文件路径
    checkpointer=checkpointer,           # LangGraph checkpointer（多轮对话必需）
    model_name="claude-sonnet-4-6",      # 覆盖默认模型
    thinking_enabled=True,               # 启用扩展思考
    subagent_enabled=True,               # 启用子任务委托
    plan_mode=True,                      # 启用 TodoList 计划模式
    agent_name="my-agent",               # 指定自定义 Agent
    available_skills={"research", "code"}, # 限定可用 Skills
    middlewares=[custom_middleware],     # 注入自定义中间件
)
```

**重要提示：**
- 多轮对话需要传入 `checkpointer`，否则每次调用都是独立的（`thread_id` 仅用于文件隔离）
- Agent 在首次调用时延迟创建，配置参数变更时会自动重建
- 调用 `reset_agent()` 可强制刷新 Agent（如 Skill 更新后）

### 5.8.3 chat() 方法

```python
def chat(self, message: str, *, thread_id: str | None = None, **kwargs) -> str:
    """Send a message and return the final text response.

    这是 stream() 的便利包装，只返回最后一个 AI 文本消息。
    如果一轮中产生多段文本，中间段落会被丢弃。
    """
```

**使用示例：**
```python
# 简单调用
reply = client.chat("解释量子计算")

# 覆盖配置参数
reply = client.chat(
    "解释量子计算",
    thread_id="session-123",
    model_name="gpt-4o",
    thinking_enabled=False,
    plan_mode=True,
)
```

### 5.8.4 stream() 方法

```python
def stream(
    self,
    message: str,
    *,
    thread_id: str | None = None,
    **kwargs,
) -> Generator[StreamEvent, None, None]:
    """Stream a conversation turn, yielding events incrementally.

    事件类型与 LangGraph SSE 协议对齐，支持 HTTP 流式和嵌入式模式切换。
    """
```

**事件类型：**

| 事件类型 | 数据格式 | 说明 |
|----------|----------|------|
| `values` | `{title, messages, artifacts}` | 完整状态快照 |
| `messages-tuple` | `{type, content, id, ...}` | 单条消息更新 |
| `custom` | `{...}` | 自定义事件 |
| `end` | `{usage: {input_tokens, output_tokens, total_tokens}}` | 流结束 |

**使用示例：**
```python
for event in client.stream("分析数据", thread_id="thread-1"):
    if event.type == "messages-tuple":
        data = event.data
        if data.get("type") == "ai":
            print(f"AI: {data.get('content', '')}")
        elif data.get("type") == "tool":
            print(f"Tool {data.get('name')}: {data.get('content', '')[:100]}...")
    elif event.type == "values":
        print(f"Artifacts: {event.data.get('artifacts', [])}")
    elif event.type == "end":
        usage = event.data.get("usage", {})
        print(f"Tokens: {usage.get('total_tokens', 0)}")
```

### 5.8.5 Agent 缓存机制

```python
def _ensure_agent(self, config: RunnableConfig):
    """Create (or recreate) the agent when config-dependent params change."""
    cfg = config.get("configurable", {})
    key = (
        cfg.get("model_name"),
        cfg.get("thinking_enabled"),
        cfg.get("is_plan_mode"),
        cfg.get("subagent_enabled"),
        self._agent_name,
        frozenset(self._available_skills) if self._available_skills else None,
    )

    if self._agent is not None and self._agent_config_key == key:
        return  # 使用缓存的 Agent

    # 重建 Agent
    self._agent = create_agent(...)
    self._agent_config_key = key
```

**缓存 key 包含：**
- `model_name`：模型变更需重建
- `thinking_enabled`：思考模式影响模型创建
- `is_plan_mode`：影响中间件链
- `subagent_enabled`：影响工具集和中间件
- `agent_name`：影响 system prompt 和 memory
- `available_skills`：影响 system prompt

### 5.8.6 其他 API

```python
# 配置查询
client.list_models()           # 列出可用模型
client.list_skills()           # 列出可用 Skills
client.get_model(name)         # 获取指定模型配置
client.get_mcp_config()        # 获取 MCP 配置
client.update_mcp_config({...}) # 更新 MCP 配置

# Memory 管理
client.get_memory()            # 获取记忆数据
client.export_memory()         # 导出记忆
client.import_memory(data)     # 导入记忆
client.reload_memory()         # 重载记忆
client.clear_memory()          # 清空记忆
client.create_memory_fact("内容", category="context")
client.delete_memory_fact(fact_id)
client.update_memory_fact(fact_id, content="新内容")

# 文件上传
client.upload_files(thread_id, ["/path/to/file.pdf", "/path/to/image.png"])
client.list_uploads(thread_id)
client.delete_upload(thread_id, "file.pdf")

# Artifacts
client.get_artifact(thread_id, "mnt/user-data/outputs/result.txt")
```

## 5.9 DeerFlow 二次开发：自定义 Lead Agent

> **🏢 企业级建议**：自定义 Agent 工厂时，建议保留原始 `make_lead_agent` 的调用链作为 fallback，并通过特性开关（feature flag）控制新旧 Agent 的切换，降低上线风险。

### 5.9.1 扩展 ThreadState

```python
# 定制 ThreadState
class CustomThreadState(ThreadState):
    # 原有字段...
    
    # 新增：自定义字段
    project_id: Optional[str]        # 当前项目
    organization_id: Optional[str]   # 组织 ID
    user_role: Optional[str]         # 用户角色
    approval_queue: List[Approval]  # 待审批队列
    audit_context: AuditContext     # 审计上下文
```python

### 5.9.2 添加企业中间件

```python
class CustomMiddlewareChain:
    """
    定制中间件链
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

### 5.9.3 自定义 Agent 工厂

```python
def make_custom_agent(config: RunnableConfig) -> CompiledGraph:
    """
    定制 Agent 工厂
    """
    # 1. 构建中间件链
    middlewares = CustomMiddlewareChain.build()
    
    # 2. 创建 Agent
    workflow = StateGraph(CustomThreadState)
    
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

## 5.10 小结

DeerFlow Agent 核心要点：

| 组件 | 核心机制 |
|------|----------|
| **状态管理** | ThreadState 扩展 LangGraph AgentState |
| **中间件链** | 14+ 个中间件按序执行，可插拔 |
| **工具系统** | Sandbox/Builtin/MCP/Community/Subagent 五类 |
| **配置驱动** | configurable 运行时注入 |
| **Prompt 组装** | 动态拼接 Skills/Memory/Subagent |

开发者可在此基础上：
- 扩展 ThreadState 添加自定义字段
- 在中间件链中添加自定义中间件
- 自定义工具集满足特定需求


## 本章小结

本章深入解析了 DeerFlow Agent 核心的实现细节：

1. **make_lead_agent**：工厂函数完成模型选择、工具加载、Prompt 生成、中间件链组装四大初始化步骤。
2. **ThreadState 管理**：TypedDict 定义的状态结构，支持 SandboxState、ThreadDataState 等扩展，通过 Annotated 实现状态归约。
3. **LangGraph 编排**：节点（Node）定义执行单元，边（Edge）定义流转规则，条件边实现动态分支（如 should_continue）。
4. **中间件链**：Middleware 在请求前/后执行，支持日志、限流、审计等横切关注点，通过 MiddlewareResult 控制流程。

> **⚠️ 注意**：should_continue 返回值必须与节点名称精确匹配（区分大小写），否则会导致 LangGraph 运行时报错。

---

**下一步**：阅读第六章，掌握 Skill 与 Tool 的抽象层级与注册机制。

