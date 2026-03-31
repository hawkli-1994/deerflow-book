# 第九章 · Memory 记忆系统

## 9.1 记忆系统的必要性

长时任务的 Agent 面临的核心问题：**上下文窗口有限**。

随着对话历史增长：
- 早期的重要信息被稀释
- 模型容易「遗忘」用户的核心需求
- 多个子任务之间的状态难以保持一致

DeerFlow 的 Memory 系统旨在解决：如何在有限的上下文窗口内，保持 Agent 对任务、项目、协作历史的完整理解。

## 9.2 记忆分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Memory System                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │   Working       │    │    Long-term    │                │
│  │   Memory        │    │    Memory       │                │
│  │                 │    │                 │                │
│  │  (Current       │    │  (Persistent    │                │
│  │   Session)       │    │   Knowledge)    │                │
│  │                 │    │                 │                │
│  │  - messages     │    │  - facts        │                │
│  │  - context      │    │  - patterns     │                │
│  │  - artifacts   │    │  - preferences   │                │
│  └────────┬────────┘    └────────┬────────┘                │
│           │                       │                          │
│           └───────────┬───────────┘                          │
│                       ▼                                       │
│            ┌─────────────────┐                              │
│            │   Memory         │                               │
│            │   Controller     │                              │
│            │                 │                               │
│            │  - consolidation│                              │
│            │  - retrieval    │                              │
│            │  - compression  │                              │
│            └─────────────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

## 9.3 Working Memory（工作记忆）

### 9.3.1 LangGraph Checkpointing

DeerFlow 利用 LangGraph 的 Checkpointing 机制实现 Working Memory：

```python
from langgraph.checkpoint.memory import MemorySaver

# 创建带 checkpoint 的 Agent
checkpointer = MemorySaver()

agent = workflow.compile(
    checkpointer=checkpointer,
    store=store,  # 可选的持久化 store
)
```

### 9.3.2 Thread State 的状态管理

```python
class ThreadState(AgentState):
    # 当前会话的消息
    messages: list[BaseMessage]
    
    # 当前任务上下文
    current_task: str
    task_progress: float  # 0.0 - 1.0
    
    # 子任务状态
    subtasks: list[SubTask]
    completed_subtasks: list[str]
    
    # 生成物追踪
    artifacts: list[Artifact]
    
    # 沙箱状态
    sandbox: SandboxState
```

### 9.3.3 状态持久化

```python
# 检查点保存
async def save_checkpoint(
    thread_id: str,
    state: ThreadState
):
    """保存当前状态到持久化存储"""
    checkpoint = {
        "thread_id": thread_id,
        "state": serialize(state),
        "timestamp": datetime.now().isoformat(),
        "version": CHECKPOINT_VERSION,
    }
    
    await storage.write(
        f"checkpoints/{thread_id}",
        checkpoint
    )
```

## 9.4 Long-term Memory（长期记忆）

### 9.4.1 记忆存储结构

```python
class MemoryRecord(BaseModel):
    id: str
    content: str
    embedding: List[float]
    
    # 元数据
    source: str              # 来源 Agent 或 User
    memory_type: str         # "fact" | "preference" | "pattern"
    project_id: Optional[str]
    agent_id: Optional[str]
    
    # 时间戳
    created_at: datetime
    last_accessed: datetime
    access_count: int
    
    # 置信度
    confidence: float        # 0.0 - 1.0
    verified: bool           # 是否经过人工确认
```

### 9.4.2 记忆索引策略

```python
class MemoryIndex:
    """
    多维度记忆索引
    """
    def __init__(self):
        # 1. 向量索引 - 基于语义相似度
        self.vector_index: VectorStore = FAISS()
        
        # 2. 关键词索引 - 精确匹配
        self.keyword_index: InvertedIndex = {}
        
        # 3. 图索引 - 实体关系
        self.graph_index: GraphStore = NetworkX()
        
        # 4. 时间索引 - 时序检索
        self.temporal_index: BTree = {}
    
    async def add(self, memory: MemoryRecord):
        """添加记忆"""
        # 同步到所有索引
        await self.vector_index.add(memory)
        self.keyword_index.update(memory)
        self.graph_index.add_entity(memory)
        self.temporal_index.insert(memory.created_at, memory.id)
```

### 9.4.3 记忆检索

```python
async def retrieve_memories(
    query: str,
    project_id: Optional[str] = None,
    memory_type: Optional[str] = None,
    top_k: int = 10,
) -> List[MemoryRecord]:
    """
    检索相关记忆
    """
    results = []
    
    # 1. 向量相似度检索
    vector_results = await vector_index.search(
        query=query,
        top_k=top_k,
        filter={"project_id": project_id}
    )
    results.extend(vector_results)
    
    # 2. 关键词精确匹配
    keyword_results = keyword_index.search(query)
    results.extend(keyword_results[:3])
    
    # 3. 图关系扩展
    related = graph_index.find_related(results)
    results.extend(related)
    
    # 4. 去重 + 排序
    return deduplicate_and_rank(results, query)
```

## 9.5 记忆 Consolidation（整合）

### 9.5.1 什么时候整合

```python
# 触发条件
CONSOLIDATION_TRIGGERS = {
    "token_threshold": 8000,      # 上下文 token 超过阈值
    "task_complete": True,          # 任务完成时
    "session_end": True,            # 会话结束时
    "manual": True,                 # 手动触发
}
```

### 9.5.2 整合流程

```python
async def consolidate(
    thread_id: str,
    trigger: str
):
    """
    记忆整合流程
    """
    # 1. 获取当前所有 Working Memory
    current_state = await checkpointer.get(thread_id)
    messages = current_state["messages"]
    
    # 2. 识别值得保留的信息
    important_info = await extract_key_information(messages)
    
    # 3. 与已有 Long-term Memory 合并
    existing_memories = await memory_index.get_related(important_info)
    merged = await merge_memories(important_info, existing_memories)
    
    # 4. 生成摘要（如果太长）
    if len(merged) > MAX_MEMORY_SIZE:
        merged = await summarize_memories(merged)
    
    # 5. 写入长期记忆
    for memory in merged:
        await memory_index.add(memory)
    
    # 6. 清理 Working Memory 中的冗余信息
    await trim_working_memory(thread_id, keep_recent=True)
```

### 9.5.3 递归摘要

当单个记忆超出容量时，使用递归摘要：

```python
async def recursive_summarize(
    content: str,
    max_tokens: int = 2000
) -> str:
    """
    递归摘要，直到满足长度要求
    """
    if count_tokens(content) <= max_tokens:
        return content
    
    # 分块
    chunks = split_into_chunks(content, max_tokens // 2)
    
    # 分别摘要每个块
    summarized_chunks = []
    for chunk in chunks:
        summary = await llm.summarize(chunk)
        summarized_chunks.append(summary)
    
    # 合并后递归摘要
    return await recursive_summarize(
        "\n".join(summarized_chunks),
        max_tokens
    )
```

## 9.6 SwarmMind 记忆系统设计

### 9.6.1 企业知识库集成

```python
class SwarmMindMemorySystem:
    """
    SwarmMind 的企业级记忆系统
    """
    
    def __init__(self, kb_client: KnowledgeBaseClient):
        self.kb = kb_client
        
        # 企业知识库
        self.corporate_memory: VectorStore
        
        # 项目级记忆
        self.project_memories: Dict[str, ProjectMemory]
        
        # 个人偏好记忆
        self.user_preferences: Dict[str, UserPreference]
    
    async def search_corporate_knowledge(
        self,
        query: str,
        department: Optional[str] = None
    ) -> List[KnowledgeEntry]:
        """
        搜索企业知识库
        """
        # 1. 基础向量搜索
        results = await self.corporate_memory.search(
            query=query,
            top_k=20
        )
        
        # 2. 部门权限过滤
        if department:
            results = [r for r in results if r.department == department]
        
        # 3. 时效性加权
        results = self.re_rank_by_recency(results)
        
        return results[:10]
```

### 9.6.2 项目级记忆

```python
class ProjectMemory:
    """
    项目级记忆 - 追踪项目全生命周期
    """
    
    def __init__(self, project_id: str):
        self.project_id = project_id
        
        # 项目配置
        self.config: ProjectConfig
        
        # 任务历史
        self.task_history: List[TaskExecution]
        
        # 决策记录
        self.decisions: List[Decision]
        
        # 团队交互历史
        self.team_interactions: List[Interaction]
        
        # 关键产出物
        self.artifacts: List[Artifact]
    
    async def record_task_execution(
        self,
        task: Task,
        result: TaskResult,
        agent_id: str
    ):
        """记录任务执行"""
        execution = TaskExecution(
            task=task,
            result=result,
            agent_id=agent_id,
            timestamp=datetime.now(),
        )
        self.task_history.append(execution)
        
        # 如果任务涉及决策，记录决策点
        if task.requires_decision:
            await self._record_decision_point(task, result)
    
    async def get_context_summary(self) -> str:
        """获取项目上下文摘要"""
        return f"""
        项目：{self.config.name}
        阶段：{self.config.current_phase}
        已完成任务：{len([t for t in self.task_history if t.status == 'completed'])}
        进行中任务：{len([t for t in self.task_history if t.status == 'in_progress'])}
        关键决策：{len(self.decisions)}
        """
```

### 9.6.3 记忆权限控制

```python
class MemoryAccessControl:
    """
    记忆访问控制 - 实现数据隔离
    """
    
    def can_access(
        subject: Agent | User,
        memory: MemoryRecord,
        project: Project
    ) -> bool:
        """
        判断主体是否可以访问某条记忆
        """
        # 1. 检查项目权限
        if memory.project_id:
            if memory.project_id != project.id:
                return False
        
        # 2. 检查敏感标记
        if memory.sensitivity == "confidential":
            if subject.role not in ["admin", "owner"]:
                return False
        
        # 3. 检查部门权限
        if memory.department:
            if subject.department != memory.department:
                if subject.role not in ["admin", "cross_department"]:
                    return False
        
        return True
```

## 9.7 上下文压缩实战

### 9.7.1 基于重要性的压缩

```python
async def importance_based_compress(
    messages: List[Message],
    max_tokens: int
) -> List[Message]:
    """
    基于重要性保留关键消息
    """
    # 1. 评分每条消息
    scored = []
    for msg in messages:
        score = await rate_message_importance(msg)
        scored.append((score, msg))
    
    # 2. 按重要性排序
    scored.sort(key=lambda x: x[0], reverse=True)
    
    # 3. 保留最重要的
    result = []
    current_tokens = 0
    
    for score, msg in scored:
        msg_tokens = count_tokens(msg)
        if current_tokens + msg_tokens <= max_tokens:
            result.append(msg)
            current_tokens += msg_tokens
        else:
            # 用摘要替代
            if score > 0.5:  # 重要消息才保留摘要
                summary = await llm.summarize(msg.content)
                result.append(Message(content=f"[摘要] {summary}"))
    
    # 4. 保持时间顺序
    result.sort(key=lambda x: x.timestamp)
    
    return result
```

### 9.7.2 对话式压缩

```python
async def conversational_compress(
    messages: List[Message]
) -> List[Message]:
    """
    将连续的用户/助手对话压缩为「要点」
    """
    # 1. 识别对话轮次
    turns = extract_conversation_turns(messages)
    
    # 2. 每轮生成摘要
    summarized_turns = []
    for turn in turns:
        summary = await summarize_turn(turn)
        summarized_turns.append(summary)
    
    # 3. 合并相邻相似摘要
    merged = merge_adjacent_summaries(summarized_turns)
    
    return merged
```

## 9.8 小结

DeerFlow 的 Memory 系统核心要点：

| 组件 | 功能 |
|------|------|
| **Working Memory** | LangGraph Checkpointing，当前会话状态 |
| **Long-term Memory** | 向量+图+关键词多索引持久化 |
| **Consolidation** | 自动触发记忆整合，防止上下文膨胀 |
| **Retrieval** | 多策略检索，相关记忆召回 |

SwarmMind 的企业级记忆扩展方向：
- **知识库集成**：对接企业文档、FAQ、标准操作程序
- **项目级记忆**：长周期项目的状态追踪
- **权限控制**：基于 RBAC 的记忆访问隔离
- **审计追溯**：记忆的创建、修改历史完整记录

这些能力是企业 Agent 的核心竞争力，也是 DeerFlow 二次开发的重要方向。
