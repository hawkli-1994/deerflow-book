# 第七章 · Sub-Agent 子代理体系


> **本章目标**：
> 1. 掌握 Sub-Agent 的配置定义与类型体系
> 2. 理解 SubagentExecutor 的执行流程与状态管理
> 3. 了解 Sub-Agent 的取消机制、并发控制与超时策略

> **本章目标**：
> 1. 理解 Sub-Agent 的设计哲学与执行模型
> 2. 掌握 Agent 调用机制与结果聚合策略
> 3. 了解 LangGraph 中的 Sub-Agent 实现与多 Agent 协同

## 7.1 设计理念

DeerFlow 的 Sub-Agent 体系是「分而治之」思想的体现。

**为什么需要 Sub-Agent？**

单一 Agent 的局限：
- Prompt 长度有限，不可能让一个 Agent 精通所有领域
- 任务耦合严重，代码审查和数据分析混在一起
- 上下文竞争，专业任务被通用 Agent 稀释

Sub-Agent 的优势：
- 专业化：每个 Agent 只做一个领域的事
- 解耦：独立开发、独立测试
- 可复用：一次开发，多次调用
- 可组合：多个 Agent 协同完成复杂任务

## 7.2 Sub-Agent 配置与类型

### 7.2.1 Sub-AgentConfig 配置定义

每个 Sub-Agent 通过 `SubagentConfig` 进行配置：

```python
from dataclasses import dataclass, field

@dataclass
class SubagentConfig:
    """Configuration for a subagent."""
    
    name: str                    # 唯一标识符
    description: str             # 委托时机说明（给主 Agent 看的）
    system_prompt: str           # 系统提示词
    tools: list[str] | None = None           # 允许使用的工具列表
    disallowed_tools: list[str] | None = field(
        default_factory=lambda: ["task"]    # 禁止使用的工具（默认禁止 task 防止嵌套）
    )
    model: str = "inherit"       # 模型选择，"inherit" 继承父 Agent 的模型
    max_turns: int = 50          # 最大交互轮数
    timeout_seconds: int = 900   # 执行超时时间（默认15分钟）
```

配置说明：
- `tools`: 白名单机制，为 `None` 时继承所有可用工具
- `disallowed_tools`: 黑名单机制，优先级高于 `tools`
- `model`: 支持指定具体模型或使用 `"inherit"` 继承父 Agent 配置

### 7.2.2 任务状态机

Sub-Agent 执行过程中会经历以下状态：

```python
from enum import Enum

class SubagentStatus(Enum):
    """Status of a subagent execution."""
    
    PENDING = "pending"         # 待执行
    RUNNING = "running"         # 执行中
    COMPLETED = "completed"     # 已完成
    FAILED = "failed"           # 执行失败
    CANCELLED = "cancelled"     # 已取消
    TIMED_OUT = "timed_out"     # 执行超时
```

状态流转：
```
PENDING → RUNNING → COMPLETED
              ↓
        ┌→ FAILED
        ├→ CANCELLED  (用户取消)
        └→ TIMED_OUT  (超时)
```

### 7.2.3 执行结果结构

```python
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class SubagentResult:
    """Result of a subagent execution."""
    
    task_id: str                    # 任务唯一标识
    trace_id: str                   # 分布式追踪 ID
    status: SubagentStatus          # 执行状态
    result: str | None = None       # 执行结果（成功时）
    error: str | None = None        # 错误信息（失败时）
    started_at: datetime | None = None      # 开始时间
    completed_at: datetime | None = None    # 完成时间
    ai_messages: list[dict] | None = None   # AI 消息记录（用于实时流）
    cancel_event: threading.Event = field(
        default_factory=threading.Event, 
        repr=False
    )  # 协作取消信号
```

### 7.2.4 内置 Sub-Agent 类型

DeerFlow 内置以下 Sub-Agent：

#### general-purpose（通用子代理）

用于复杂、多步骤任务，需要探索和行动结合的场景。

```python
GENERAL_PURPOSE_CONFIG = SubagentConfig(
    name="general-purpose",
    description="""A capable agent for complex, multi-step tasks.
    
Use this subagent when:
- The task requires both exploration and modification
- Complex reasoning is needed to interpret results
- Multiple dependent steps must be executed
- The task would benefit from isolated context management

Do NOT use for simple, single-step operations.""",
    system_prompt="""You are a general-purpose subagent working on a delegated task.

<guidelines>
- Focus on completing the delegated task efficiently
- Use available tools as needed to accomplish the goal
- Think step by step but act decisively
- Return a concise summary of what you accomplished
- Do NOT ask for clarification - work with the information provided
</guidelines>

<output_format>
When you complete the task, provide:
1. A brief summary of what was accomplished
2. Key findings or results
3. Any relevant file paths, data, or artifacts created
4. Issues encountered (if any)
5. Citations: Use `[citation:Title](URL)` format for external sources
</output_format>
""",
    tools=None,  # 继承所有工具
    disallowed_tools=["task", "ask_clarification", "present_files"],
    model="inherit",
    max_turns=100,
)
```

#### bash（命令执行代理）

专用于执行 Bash 命令序列，仅在允许 Host Bash 的环境中可用。

```python
BASH_AGENT_CONFIG = SubagentConfig(
    name="bash",
    description="""Command execution specialist for running bash commands.

Use this subagent when:
- You need to run a series of related bash commands
- Terminal operations like git, npm, docker, etc.
- Command output is verbose and would clutter main context
- Build, test, or deployment operations

Do NOT use for simple single commands - use bash tool directly instead.""",
    system_prompt="""You are a bash command execution specialist.

<guidelines>
- Execute commands one at a time when they depend on each other
- Use parallel execution when commands are independent
- Report both stdout and stderr when relevant
- Handle errors gracefully and explain what went wrong
- Use absolute paths for file operations
- Be cautious with destructive operations (rm, overwrite, etc.)
</guidelines>

<output_format>
For each command or group of commands:
1. What was executed
2. The result (success/failure)
3. Relevant output (summarized if verbose)
4. Any errors or warnings
</output_format>
""",
    tools=["bash", "ls", "read_file", "write_file", "str_replace"],
    disallowed_tools=["task", "ask_clarification", "present_files"],
    model="inherit",
    max_turns=60,
)
```

**注意**: `bash` subagent 仅在 Host Bash 被允许的环境中可用（通过 `is_host_bash_allowed()` 检查）。

#### Agent 类型汇总

| Sub-Agent | 用途 | 可用性 |
|----------|------|--------|
| `general-purpose` | 通用复杂任务 | 始终可用 |
| `bash` | 命令执行序列 | 仅 Host Bash 环境 |

## 7.3 Sub-AgentExecutor 执行引擎

### 7.3.1 类结构与初始化

`SubagentExecutor` 是执行 Sub-Agent 的核心引擎：

```python
class SubagentExecutor:
    """Executor for running subagents."""
    
    def __init__(
        self,
        config: SubagentConfig,           # Subagent 配置
        tools: list[BaseTool],            # 所有可用工具（会被过滤）
        parent_model: str | None = None,  # 父 Agent 的模型名称
        sandbox_state: SandboxState | None = None,  # 沙箱状态
        thread_data: ThreadDataState | None = None, # 线程数据
        thread_id: str | None = None,     # 线程 ID
        trace_id: str | None = None,      # 追踪 ID（用于分布式追踪）
    ):
        self.config = config
        self.parent_model = parent_model
        self.sandbox_state = sandbox_state
        self.thread_data = thread_data
        self.thread_id = thread_id
        self.trace_id = trace_id or str(uuid.uuid4())[:8]
        
        # 根据配置过滤工具
        self.tools = _filter_tools(
            tools,
            config.tools,           # 白名单
            config.disallowed_tools # 黑名单
        )
```

工具过滤逻辑：
```python
def _filter_tools(
    all_tools: list[BaseTool],
    allowed: list[str] | None,      # 允许列表
    disallowed: list[str] | None,   # 禁止列表
) -> list[BaseTool]:
    filtered = all_tools
    
    # 先应用白名单
    if allowed is not None:
        allowed_set = set(allowed)
        filtered = [t for t in filtered if t.name in allowed_set]
    
    # 再应用黑名单（优先级更高）
    if disallowed is not None:
        disallowed_set = set(disallowed)
        filtered = [t for t in filtered if t.name not in disallowed_set]
    
    return filtered
```python

### 7.3.2 同步/异步执行方法

#### execute() - 同步执行

```python
def execute(
    self, 
    task: str, 
    result_holder: SubagentResult | None = None
) -> SubagentResult:
    """Execute a task synchronously.
    
    此方法支持两种执行路径：
    1. 无运行中的事件循环：使用 asyncio.run() 直接执行
    2. 有运行中的事件循环：在独立线程中执行，避免冲突
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None and loop.is_running():
        # 在独立线程中执行，避免与父事件循环冲突
        future = _isolated_loop_pool.submit(
            self._execute_in_isolated_loop, 
            task, 
            result_holder
        )
        return future.result()

    # 标准路径：使用 asyncio.run
    return asyncio.run(self._aexecute(task, result_holder))
```

#### _aexecute() - 异步执行核心

```python
async def _aexecute(
    self, 
    task: str, 
    result_holder: SubagentResult | None = None
) -> SubagentResult:
    """Execute a task asynchronously."""
    # 初始化结果对象
    if result_holder is not None:
        result = result_holder
    else:
        task_id = str(uuid.uuid4())[:8]
        result = SubagentResult(
            task_id=task_id,
            trace_id=self.trace_id,
            status=SubagentStatus.RUNNING,
            started_at=datetime.now(),
        )

    try:
        # 创建 Agent 实例
        agent = self._create_agent()
        state = self._build_initial_state(task)
        
        # 配置执行参数
        run_config: RunnableConfig = {
            "recursion_limit": self.config.max_turns,
        }
        if self.thread_id:
            run_config["configurable"] = {"thread_id": self.thread_id}

        # 执行并捕获实时输出
        final_state = None
        async for chunk in agent.astream(
            state, 
            config=run_config, 
            stream_mode="values"
        ):
            # 协作取消检查
            if result.cancel_event.is_set():
                result.status = SubagentStatus.CANCELLED
                result.error = "Cancelled by user"
                result.completed_at = datetime.now()
                return result
            
            final_state = chunk
            # 提取 AI 消息（用于实时流）
            self._extract_ai_messages(chunk, result)

        # 提取最终结果
        result.result = self._extract_final_result(final_state)
        result.status = SubagentStatus.COMPLETED
        result.completed_at = datetime.now()

    except Exception as e:
        result.status = SubagentStatus.FAILED
        result.error = str(e)
        result.completed_at = datetime.now()

    return result
```python

### 7.3.3 实时 AI 消息捕获 (astream)

SubagentExecutor 使用 `astream()` 实现实时消息捕获：

```python
async def stream_example():
    async for chunk in agent.astream(state, config=run_config, stream_mode="values"):
        # 检查取消信号
        if result.cancel_event.is_set():
            result.status = SubagentStatus.CANCELLED
            return result
        
        final_state = chunk
        messages = chunk.get("messages", [])
        
        if messages:
            last_message = messages[-1]
            if isinstance(last_message, AIMessage):
                message_dict = last_message.model_dump()
                
                # 去重检查（通过消息 ID）
                message_id = message_dict.get("id")
                is_duplicate = any(
                    msg.get("id") == message_id 
                    for msg in result.ai_messages
                ) if message_id else message_dict in result.ai_messages
                
                if not is_duplicate:
                    result.ai_messages.append(message_dict)
```

消息流可以用于：
- 实时显示 Sub-Agent 的思考过程
- 前端进度展示
- 调试和审计

### 7.3.4 协作取消机制

Sub-Agent 支持协作式取消（Cooperative Cancellation）：

```python
async def stream_example():
    # 1. 请求取消（由外部调用）
    def request_cancel_background_task(task_id: str) -> None:
        with _background_tasks_lock:
            result = _background_tasks.get(task_id)
            if result is not None:
                result.cancel_event.set()  # 设置取消信号
    
    # 2. 执行过程中检查取消信号
    async for chunk in agent.astream(state, config=run_config, stream_mode="values"):
        if result.cancel_event.is_set():
            logger.info(f"Subagent {self.config.name} cancelled by parent")
            result.status = SubagentStatus.CANCELLED
            result.error = "Cancelled by user"
            result.completed_at = datetime.now()
            return result
```

**重要说明**：
- 取消是协作式的，在 `astream()` 迭代边界处检查
- 正在执行的长耗时工具调用不会被打断，直到下一次 yield
- 后台线程无法强制终止，只能通过信号协作退出

## 7.4 背景任务管理机制

### 7.4.1 ThreadPoolExecutor 双池架构

DeerFlow 使用双线程池架构管理后台任务：

```python
# 调度器线程池：负责任务调度和编排
_scheduler_pool = ThreadPoolExecutor(
    max_workers=3, 
    thread_name_prefix="subagent-scheduler-"
)

# 执行线程池：负责实际的 Subagent 执行
_execution_pool = ThreadPoolExecutor(
    max_workers=3, 
    thread_name_prefix="subagent-exec-"
)

# 隔离事件循环池：用于同步执行时隔离事件循环
_isolated_loop_pool = ThreadPoolExecutor(
    max_workers=3, 
    thread_name_prefix="subagent-isolated-"
)
```

架构设计理由：
- **调度器池**：轻量级，负责任务状态管理和超时监控
- **执行池**：重量级，执行实际的 AI Agent 调用
- **分离设计**：避免调度任务阻塞执行池，支持更细粒度的超时控制

### 7.4.2 后台任务提交与追踪

```python
# 全局任务存储
_background_tasks: dict[str, SubagentResult] = {}
_background_tasks_lock = threading.Lock()

def execute_async(self, task: str, task_id: str | None = None) -> str:
    """Start a task execution in the background."""
    task_id = task_id or str(uuid.uuid4())[:8]
    
    # 创建待执行结果
    result = SubagentResult(
        task_id=task_id,
        trace_id=self.trace_id,
        status=SubagentStatus.PENDING,
    )
    
    with _background_tasks_lock:
        _background_tasks[task_id] = result
    
    # 提交到调度器池
    def run_task():
        with _background_tasks_lock:
            _background_tasks[task_id].status = SubagentStatus.RUNNING
            _background_tasks[task_id].started_at = datetime.now()
            result_holder = _background_tasks[task_id]
        
        try:
            # 提交到执行池（带超时）
            execution_future = _execution_pool.submit(
                self.execute, task, result_holder
            )
            exec_result = execution_future.result(
                timeout=self.config.timeout_seconds
            )
            
            # 更新结果
            with _background_tasks_lock:
                _background_tasks[task_id].status = exec_result.status
                _background_tasks[task_id].result = exec_result.result
                _background_tasks[task_id].ai_messages = exec_result.ai_messages
                
        except FuturesTimeoutError:
            # 超时处理
            result_holder.cancel_event.set()
            execution_future.cancel()
            with _background_tasks_lock:
                _background_tasks[task_id].status = SubagentStatus.TIMED_OUT
                _background_tasks[task_id].error = f"Timeout after {self.config.timeout_seconds}s"
    
    _scheduler_pool.submit(run_task)
    return task_id
```python

### 7.4.3 任务状态查询与管理

```python
# 获取任务结果
def get_background_task_result(task_id: str) -> SubagentResult | None:
    with _background_tasks_lock:
        return _background_tasks.get(task_id)

# 列出所有任务
def list_background_tasks() -> list[SubagentResult]:
    with _background_tasks_lock:
        return list(_background_tasks.values())

# 清理已完成任务
def cleanup_background_task(task_id: str) -> None:
    with _background_tasks_lock:
        result = _background_tasks.get(task_id)
        if result is None:
            return
        
        # 仅清理终态任务，避免竞态条件
        is_terminal = result.status in {
            SubagentStatus.COMPLETED,
            SubagentStatus.FAILED,
            SubagentStatus.CANCELLED,
            SubagentStatus.TIMED_OUT,
        }
        if is_terminal:
            del _background_tasks[task_id]
```

## 7.5 Agent 调用机制

> **⚠️ 注意**：Sub-Agent 与 Lead Agent 共享同一个 `thread_id` 时，会产生消息流交叉。如果 Sub-Agent 的处理逻辑依赖消息历史，务必确认历史消息的隔离性设计。

### 7.5.1 状态共享

Sub-Agent 之间通过 `AgentState` 共享状态：

```python
class AgentState(TypedDict):
    messages: List[BaseMessage]           # 对话历史
    context: Dict[str, Any]              # 上下文变量
    current_task: Optional[str]          # 当前任务
    
    # Sub-Agent 专用
    pending_subagent_tasks: List[Task]   # 待执行的子任务
    completed_subagent_results: Dict    # 已完成的子任务结果
    
    sandbox: dict                        # 沙箱环境
    artifacts: list[str]                 # 生成的文件
```python

### 7.5.2 任务分发

```python
# 主 Agent 调用子 Agent
async def call_subagent(
    agent_type: str,           # "researcher", "coder", etc.
    task: str,                 # 具体任务描述
    context: dict              # 传递给子 Agent 的上下文
) -> str:
    """
    调用指定类型的子 Agent 执行任务
    """
    subagent = get_subagent(agent_type)
    
    # 构建子 Agent 的输入
    subagent_input = {
        "task": task,
        "context": context,
        "messages": []
    }
    
    # 执行子 Agent
    result = await subagent.ainvoke(subagent_input)
    
    return result["output"]
```

### 7.5.3 结果聚合

```python
async def aggregate_results(
    results: Dict[str, Any]
) -> str:
    """
    聚合多个子 Agent 的结果
    """
    prompt = f"""
    整合以下来自不同专业 Agent 的结果，生成综合报告：
    
    {results}
    
    要求：
    1. 消除矛盾信息
    2. 保持专业术语一致性
    3. 突出关键发现
    """
    
    aggregator = get_lead_agent()
    return await aggregator.ainvoke({"messages": [HumanMessage(prompt)]})
```

## 7.6 LangGraph 中的 Sub-Agent 实现

### 7.6.1 节点定义

```python
# 节点定义
workflow.add_node("researcher", research_node)
workflow.add_node("coder", code_node)
workflow.add_node("reviewer", review_node)

# 边定义
workflow.add_edge("lead", "researcher")  # lead → researcher
workflow.add_edge("researcher", "coder")  # researcher → coder
workflow.add_edge("coder", "reviewer")    # coder → reviewer
```

### 7.6.2 条件路由

```python
from langgraph.graph import END

def should_call_subagent(state: AgentState) -> str:
    """判断是否需要调用子 Agent"""
    task = state.get("current_task", "")
    
    if "research" in task.lower():
        return "researcher"
    elif "code" in task.lower():
        return "coder"
    elif "review" in task.lower():
        return "reviewer"
    else:
        return END

workflow.add_conditional_edges(
    "lead",
    should_call_subagent,
    {
        "researcher": "researcher",
        "coder": "coder", 
        "reviewer": "reviewer",
        END: END
    }
)
```python

### 7.6.3 节点实现

```python
async def research_node(state: AgentState) -> AgentState:
    """
    研究节点：从多个来源检索信息
    """
    task = state["current_task"]
    
    # 使用研究相关的 Tools
    search_results = await tool_manager.invoke("web_search", {"query": task})
    deep_results = await tool_manager.invoke("in_depth_research", {"topic": task})
    
    # 整合结果
    research_report = await synthesize_results([search_results, deep_results])
    
    return {
        "messages": state["messages"] + [
            HumanMessage(content=research_report)
        ],
        "completed_subagent_results": {
            **state.get("completed_subagent_results", {}),
            "researcher": research_report
        }
    }
```

## 7.7 DeerFlow Agent Teams 设计

> **🏢 企业级建议**：多 Agent 协同团队在生产环境中建议引入「协调员 Agent」作为中央调度器，避免 Agent 间的调用关系演变为难以调试的网状结构。

基于 DeerFlow 的 Sub-Agent 机制，可以设计以下 Agent Teams：

### 7.7.1 企业专用 Agent 类型

```python
# DeerFlow Agent Types
AGENT_TYPES = {
    # 基础能力
    "lead": LeadAgent,           # 主控 Agent
    
    # 调研能力
    "financial_analyst": FinancialAnalystAgent,    # 财务分析
    "market_researcher": MarketResearchAgent,      # 市场调研
    "document_review": DocumentReviewAgent,        # 文档审查
    
    # 执行能力
    "code_assistant": CodeAssistantAgent,          # 代码助手
    "data_processor": DataProcessorAgent,          # 数据处理
    
    # 审批能力
    "compliance_checker": ComplianceCheckerAgent,   # 合规检查
    "human_approver": HumanApproverAgent,          # 人工审批
}
```python

### 7.7.2 项目级 Agent Team

```python
class ProjectAgentTeam:
    """
    项目级 Agent 团队
    """
    def __init__(self, project_id: str, members: List[AgentType]):
        self.project_id = project_id
        self.members = members
        self.shared_context = {}  # 共享上下文
        self.task_queue = []      # 任务队列
    
    async def execute(self, goal: str) -> ProjectResult:
        """
        执行项目目标
        """
        # 1. 目标分解
        plan = await self.planner.decompose(goal)
        
        # 2. 并行/串行执行子任务
        for sub_task in plan.tasks:
            result = await self._execute_task(sub_task)
            self.shared_context.update(result)
        
        # 3. 聚合结果
        return self._aggregate_results()
    
    async def _execute_task(self, task: Task) -> Dict:
        # 选择合适的 Agent
        agent = self._select_agent(task.type)
        return await agent.execute(task, self.shared_context)
```

### 7.7.3 多 Agent 协同流程

```
用户请求
    │
    ▼
Lead Agent (理解意图)
    │
    ├─→ Financial Analyst (财务分析)
    ├─→ Market Researcher (市场调研)
    └─→ Compliance Checker (合规检查)
            │
            ▼
    结果聚合 (Lead Agent)
            │
            ▼
    Human Approver (人工审批) ← 可选
            │
            ▼
    输出最终报告
```

## 7.8 长期记忆集成

### 7.8.1 Agent 记忆分层

```python
class AgentMemory:
    """
    Agent 记忆系统
    """
    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        
        # 1. 短期记忆：当前会话
        self.working_memory: List[Message] = []
        
        # 2. 项目记忆：当前项目上下文
        self.project_memory: Dict = {}
        
        # 3. 长期记忆：跨项目知识
        self.long_term_memory: VectorStore = None
    
    async def remember(self, key: str, value: Any):
        """存储记忆"""
        # 短 → 长，逐级沉淀
        if len(self.working_memory) > 10:
            await self._consolidate()
    
    async def recall(self, query: str) -> List[Memory]:
        """检索记忆"""
        # 向量检索
        return await self.long_term_memory.search(query)
```python

### 7.8.2 团队记忆共享

```python
class TeamMemory:
    """
    团队共享记忆
    """
    def __init__(self, team_id: str):
        self.team_id = team_id
        self.shared_knowledge: GraphStore = GraphStore()
        self.project_context: Dict = {}
    
    async def share_finding(
        self, 
        agent_id: str, 
        finding: Dict
    ):
        """
        Agent 之间共享发现
        """
        # 添加到共享知识图谱
        await self.shared_knowledge.add(
            subject=agent_id,
            predicate="found",
            object=finding
        )
```

## 7.9 上下文管理

### 7.9.1 子 Agent 上下文构建

```python
async def build_subagent_context(
    task: Task,
    team_context: TeamContext,
    agent_memory: AgentMemory
) -> Context:
    """
    为子 Agent 构建执行上下文
    """
    return {
        # 任务描述
        "task": task.description,
        "constraints": task.constraints,
        
        # 团队共享信息
        "project_info": team_context.project_info,
        "relevant_documents": team_context.documents,
        
        # Agent 个体记忆
        "agent_experience": await agent_memory.recall(task.type),
        
        # 工具列表
        "available_tools": task.required_tools,
    }
```python

### 7.9.2 上下文压缩

当子 Agent 返回大量结果时，需要压缩：

```python
async def compress_if_needed(
    content: str,
    max_tokens: int = 4000
) -> str:
    """上下文压缩"""
    if count_tokens(content) <= max_tokens:
        return content
    
    # 使用递归摘要
    summarizer = get_skill("recursive-summarizer")
    return await summarizer.execute({
        "content": content,
        "max_tokens": max_tokens
    })
```

## 7.10 二次开发指南

### 7.10.1 添加新 Agent 类型

```python
# 1. 定义 Agent 类
class FinancialAnalystAgent(BaseAgent):
    name = "financial_analyst"
    description = "财务分析专家"
    
    def get_system_prompt(self) -> str:
        return """
        你是一名资深财务分析师，专长于：
        - 财务报表分析
        - 预算编制与跟踪
        - 成本控制建议
        - 财务风险评估
        """
    
    def get_tools(self) -> List[Tool]:
        return [
            financial_search,
            data_extraction,
            ratio_analysis,
        ]

# 2. 注册 Agent
AGENT_REGISTRY.register("financial_analyst", FinancialAnalystAgent)

# 3. 在工作流中使用
workflow.add_node("financial_analyst", financial_analyst_node)
```python

### 7.10.2 自定义 Agent 协作逻辑

```python
async def custom_coordination(
    state: AgentState,
    available_agents: List[Agent]
) -> str:
    """
    自定义协调逻辑
    """
    task = state["current_task"]
    
    # 使用 LLM 判断应该调用哪些 Agent
    coordination_prompt = f"""
    任务：{task}
    可用 Agent：{[a.name for a in available_agents]}
    
    分析任务，决定：
    1. 需要哪些 Agent 参与？
    2. 它们的执行顺序？
    3. 如何聚合结果？
    """
    
    decision = await llm.ainvoke(coordination_prompt)
    return parse_coordination_plan(decision)
```

## 7.11 小结

DeerFlow 的 Sub-Agent 体系核心要点：

| 概念 | 说明 |
|------|------|
| **专业化** | 每个 Agent 只做一个领域 |
| **状态共享** | 通过 AgentState 传递上下文 |
| **条件路由** | 根据任务类型动态选择 Agent |
| **结果聚合** | Lead Agent 整合子结果 |
| **记忆分层** | 短期/项目/长期记忆分离 |

DeerFlow 的 Agent Teams 可以在此基础上扩展：
- 增加企业专用 Agent 类型
- 实现项目级记忆共享
- 添加人工审批节点
- 完善合规审计能力


## 本章小结

本章深入解析了 Sub-Agent 子代理体系的设计与实现：

1. **SubagentConfig**：通过 dataclass 定义配置，支持 tools/disallowed_tools 黑白名单、model 继承、max_turns 与 timeout 限制。
2. **执行流程**：SubagentExecutor 负责生命周期管理（初始化 → 执行 → 状态跟踪 → 清理），通过 astream() 实现实时消息捕获。
3. **协作机制**：Sub-Agent 支持串行、并行、混合模式，通过 TeamContext 实现信息共享与上下文隔离。
4. **取消与超时**：Cooperative Cancellation 通过 cancel_event 实现优雅终止，timeout_seconds 防止无限阻塞。

> **🏢 企业级建议**：生产环境中务必设置 disallowed_tools=["task"] 防止 Sub-Agent 嵌套调用导致资源耗尽。

---

**下一步**：阅读第八章，掌握 Sandbox 的安全隔离与执行环境设计。

