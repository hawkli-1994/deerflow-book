# 第七章 · Sub-Agent 子代理体系

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

## 7.2 DeerFlow 的 Agent 类型

DeerFlow 内置以下 Agent 类型：

| Agent | 类型 | 职责 |
|-------|------|------|
| `lead_agent` | 主控 | 协调者，理解用户输入，分发任务 |
| `planner` | 规划 | 任务分解，生成执行计划 |
| `researcher` | 研究 | 信息检索、汇总、分析 |
| `coder` | 编码 | 代码编写、调试 |
| `reviewer` | 审查 | 代码审查、质量评估 |

## 7.3 Agent 调用机制

### 7.3.1 状态共享

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
```

### 7.3.2 任务分发

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

### 7.3.3 结果聚合

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

## 7.4 LangGraph 中的 Sub-Agent 实现

### 7.4.1 节点定义

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

### 7.4.2 条件路由

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
```

### 7.4.3 节点实现

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

## 7.5 SwarmMind Agent Teams 设计

基于 DeerFlow 的 Sub-Agent 机制，SwarmMind 可以设计以下 Agent Teams：

### 7.5.1 企业专用 Agent 类型

```python
# SwarmMind Agent Types
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
```

### 7.5.2 项目级 Agent Team

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

### 7.5.3 多 Agent 协同流程

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

## 7.6 长期记忆集成

### 7.6.1 Agent 记忆分层

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
```

### 7.6.2 团队记忆共享

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

## 7.7 上下文管理

### 7.7.1 子 Agent 上下文构建

```python
def build_subagent_context(
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
```

### 7.7.2 上下文压缩

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

## 7.8 二次开发指南

### 7.8.1 添加新 Agent 类型

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
```

### 7.8.2 自定义 Agent 协作逻辑

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

## 7.9 小结

DeerFlow 的 Sub-Agent 体系核心要点：

| 概念 | 说明 |
|------|------|
| **专业化** | 每个 Agent 只做一个领域 |
| **状态共享** | 通过 AgentState 传递上下文 |
| **条件路由** | 根据任务类型动态选择 Agent |
| **结果聚合** | Lead Agent 整合子结果 |
| **记忆分层** | 短期/项目/长期记忆分离 |

SwarmMind 的 Agent Teams 可以在此基础上扩展：
- 增加企业专用 Agent 类型
- 实现项目级记忆共享
- 添加人工审批节点
- 完善合规审计能力
