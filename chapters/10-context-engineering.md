# 第十章 · Context Engineering 上下文工程


> **本章目标**：
> 1. 掌握上下文工程的核心理念（注入、过滤、压缩）
> 2. 理解系统 Prompt 的动态生成与 Token 预算管理
> 3. 了解多轮对话中的上下文窗口优化策略

> **本章目标**：
> 1. 掌握 Context Engineering 的核心问题与 Token 预算分配
> 2. 理解上下文分层、递归摘要与记忆检索增强
> 3. 了解 RAG 实现与 DeerFlow 中的上下文管理

## 10.1 为什么 Context Engineering 重要

LLM 的能力受限于 **context window**（上下文窗口）：

```
┌────────────────────────────────────────────────────────┐
│                    Context Window (200K tokens)         │
├────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ System Prompt (20K)                              │  │
│  ├──────────────────────────────────────────────────┤  │
│  │ Conversation History (100K)                      │  │
│  ├──────────────────────────────────────────────────┤  │
│  │ Available for NEW Input (80K)                    │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
└────────────────────────────────────────────────────────┘
```

**Context Engineering 的核心问题：**
1. 如何在有限窗口内塞入最多「有用」信息？
2. 如何避免重要信息被稀释？
3. 如何在长对话中保持一致性？

## 10.2 Context 管理策略

### 10.2.1 分层管理

```
┌─────────────────────────────────────────────────────────────┐
│                    Context Layering                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1: System Context (静态)                              │
│  ├── System Prompt                                          │
│  ├── Skill Definitions                                       │
│  └── Tool Descriptions                                       │
│                                                              │
│  Layer 2: Session Context (线程级)                          │
│  ├── Conversation History                                   │
│  ├── Thread Metadata                                        │
│  └── Loaded Memories                                         │
│                                                              │
│  Layer 3: Turn Context (单轮)                               │
│  ├── Current User Input                                     │
│  ├── Recent Tool Results                                    │
│  └── Generated Response                                     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 10.2.2 Token 预算分配

```python
class ContextBudget:
    """
    Context Token 预算分配
    """
    
    def __init__(
        self,
        max_tokens: int = 200000,
        system_reserve: float = 0.15,      # System 预留 15%
        session_reserve: float = 0.60,     # Session 预留 60%
        turn_reserve: float = 0.25,        # Turn 预留 25%
    ):
        self.max_tokens = max_tokens
        self.system_tokens = int(max_tokens * system_reserve)
        self.session_tokens = int(max_tokens * session_reserve)
        self.turn_tokens = int(max_tokens * turn_reserve)
    
    def allocate(
        self,
        system_used: int,
        session_used: int,
        turn_available: int
    ) -> "AllocationResult":
        """
        分配并检查预算
        """
        issues = []
        
        if system_used > self.system_tokens:
            issues.append(f"System prompt exceeds budget: {system_used} > {self.system_tokens}")
        
        if session_used > self.session_tokens:
            issues.append(f"Session context exceeds budget: {session_used} > {self.session_tokens}")
        
        return AllocationResult(
            valid=len(issues) == 0,
            issues=issues,
            remaining_for_turn=self.max_tokens - system_used - session_used
        )
```python

## 10.3 上下文压缩技术

> **⚠️ 注意**：递归摘要会丢失细节。对于代码审查、法律文档等「每个字都重要」的场景，不建议使用递归摘要，而应使用分块检索（chunked retrieval）。

### 10.3.1 Summarization Middleware

DeerFlow 使用中间件自动压缩上下文：

```python
class SummarizationMiddleware:
    """
    上下文压缩中间件
    触发条件：消息 token 超过阈值
    """
    
    def __init__(
        self,
        threshold_tokens: int = 80000,
        compression_ratio: float = 0.5,
        summarizer: Summarizer = None
    ):
        self.threshold_tokens = threshold_tokens
        self.compression_ratio = compression_ratio
        self.summarizer = summarizer or RecursiveSummarizer()
    
    async def process(self, state: ThreadState) -> MiddlewareResult:
        messages = state["messages"]
        
        # 计算当前 token 数
        current_tokens = count_tokens(messages)
        
        # 检查是否需要压缩
        if current_tokens > self.threshold_tokens:
            # 执行压缩
            compressed = await self._compress_context(messages)
            state["messages"] = compressed
            
            return MiddlewareResult(
                should_continue=True,
                metadata={
                    "compressed": True,
                    "before_tokens": current_tokens,
                    "after_tokens": count_tokens(compressed)
                }
            )
        
        return MiddlewareResult(should_continue=True)
```

### 10.3.2 递归摘要（Recursive Summarization）

当单次摘要仍超出限制时，使用递归：

```python
class RecursiveSummarizer:
    """
    递归摘要器
    """
    
    def __init__(self, llm: ChatModel, max_chunk_tokens: int = 4000):
        self.llm = llm
        self.max_chunk_tokens = max_chunk_tokens
    
    async def summarize(
        self,
        content: str,
        target_tokens: int = 2000
    ) -> str:
        """
        递归摘要直到满足目标长度
        """
        current_tokens = count_tokens(content)
        target = target_tokens
        
        # 如果已经满足要求，直接返回
        if current_tokens <= target:
            return content
        
        # 分块
        chunks = self._split_into_chunks(content)
        
        # 逐块摘要
        summaries = []
        for chunk in chunks:
            summary = await self._single_summarize(chunk)
            summaries.append(summary)
        
        # 合并摘要
        merged = "\n".join(summaries)
        
        # 如果合并后仍超限，递归摘要
        if count_tokens(merged) > target:
            return await self.summarize(merged, target)
        
        return merged
    
    async def _single_summarize(self, chunk: str) -> str:
        """单次摘要"""
        prompt = f"""
        请简洁地摘要以下内容，保留关键信息：
        
        {chunk}
        
        摘要：
        """
        
        response = await self.llm.ainvoke([HumanMessage(prompt)])
        return response.content
```python

### 10.3.3 选择性保留

并非所有消息都值得保留：

```python
async def selective_compress(
    messages: List[BaseMessage],
    max_tokens: int
) -> List[BaseMessage]:
    """
    基于重要性选择性压缩
    """
    # 1. 给每条消息评分
    scored = []
    for msg in messages:
        importance = await rate_message_importance(msg)
        scored.append((importance, msg))
    
    # 2. 按重要性排序
    scored.sort(key=lambda x: x[0], reverse=True)
    
    # 3. 从高到低选择，直到满足 token 限制
    selected = []
    current_tokens = 0
    
    for importance, msg in scored:
        msg_tokens = count_tokens(msg)
        
        if current_tokens + msg_tokens <= max_tokens:
            selected.append(msg)
            current_tokens += msg_tokens
        else:
            # 重要消息用摘要替代
            if importance > 0.7:
                summary = await summarize_message(msg)
                selected.append(
                    Message(
                        content=f"[摘要] {summary}",
                        importance=importance
                    )
                )
    
    # 4. 恢复时间顺序
    selected.sort(key=lambda x: x.timestamp)
    
    return selected
```

## 10.4 记忆检索增强

### 10.4.1 上下文感知的记忆检索

```python
async def retrieve_relevant_memories(
    query: str,
    current_context: Dict,
    top_k: int = 5,
    min_relevance: float = 0.7
) -> List[MemoryRecord]:
    """
    基于当前上下文检索相关记忆
    """
    # 1. 向量检索
    vector_results = await memory_index.search(
        query=query,
        top_k=top_k * 2  # 先多取一些，后面过滤
    )
    
    # 2. 时效性过滤
    recency_weight = 0.3
    time_decay = lambda m: math.exp(
        -recency_weight * days_since(m.created_at)
    )
    
    # 3. 相关性 + 时效性 综合评分
    scored = []
    for memory in vector_results:
        relevance = memory.embedding_score
        recency = time_decay(memory)
        combined = relevance * 0.7 + recency * 0.3
        
        if combined >= min_relevance:
            scored.append((combined, memory))
    
    # 4. 取 top_k
    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for _, m in scored[:top_k]]
```python

### 10.4.2 记忆注入策略

```python
def build_memory_context(
    memories: List[MemoryRecord],
    max_tokens: int
) -> str:
    """
    将记忆构建为可注入的上下文
    """
    context_parts = ["## 相关记忆\n"]
    current_tokens = count_tokens("\n".join(context_parts))
    
    for memory in memories:
        memory_text = f"""
### {memory.memory_type}: {memory.source}
{memory.content}
"""
        memory_tokens = count_tokens(memory_text)
        
        if current_tokens + memory_tokens <= max_tokens:
            context_parts.append(memory_text)
            current_tokens += memory_tokens
        else:
            break
    
    return "\n".join(context_parts)
```

## 10.5 RAG（检索增强生成）

> **🏢 企业级建议**：企业知识库的 RAG 系统应接入权限系统，确保用户只能检索到其有权访问的文档。向量数据库本身不处理权限，需在检索后增加过滤层。

### 10.5.1 混合检索

```python
class HybridRetriever:
    """
    混合检索器：向量 + 关键词 + 图
    """
    
    def __init__(
        self,
        vector_store: VectorStore,
        keyword_index: InvertedIndex,
        graph_store: GraphStore
    ):
        self.vector = vector_store
        self.keyword = keyword_index
        self.graph = graph_store
    
    async def retrieve(
        self,
        query: str,
        filters: Dict = None,
        top_k: int = 10
    ) -> List[Document]:
        # 1. 向量检索
        vector_results = await self.vector.search(
            query=query,
            top_k=top_k * 2,
            filters=filters
        )
        
        # 2. 关键词检索
        keyword_results = await self.keyword.search(
            query=query,
            top_k=top_k
        )
        
        # 3. 图关系扩展
        graph_results = []
        for doc in vector_results[:5]:
            related = await self.graph.find_related(doc.id)
            graph_results.extend(related)
        
        # 4. RRF 融合
        fused = self._rrf_fusion([
            vector_results,
            keyword_results,
            graph_results
        ], k=60)
        
        return fused[:top_k]
    
    def _rrf_fusion(
        self,
        result_lists: List[List],
        k: int = 60
    ) -> List:
        """
        Reciprocal Rank Fusion
        """
        scores = {}
        
        for results in result_lists:
            for rank, doc in enumerate(results):
                if doc.id not in scores:
                    scores[doc.id] = 0
                scores[doc.id] += 1 / (k + rank + 1)
        
        sorted_docs = sorted(
            scores.items(),
            key=lambda x: x[1],
            reverse=True
        )
        
        return [doc for doc_id, _ in sorted_docs]
```python

### 10.5.2 上下文窗口扩展

对于超长文档，使用「上下文窗口」技术：

```python
class ContextWindowExpander:
    """
    上下文窗口扩展
    将文档分成多个窗口，逐窗口处理
    """
    
    def __init__(
        self,
        window_size: int = 4000,  # 每窗口 token 数
        overlap: int = 500        # 窗口重叠 token 数
    ):
        self.window_size = window_size
        self.overlap = overlap
    
    def create_windows(self, document: str) -> List[TextWindow]:
        """
        创建文本窗口
        """
        tokens = tokenize(document)
        windows = []
        
        start = 0
        while start < len(tokens):
            end = min(start + self.window_size, len(tokens))
            
            window = TextWindow(
                content=tokens[start:end],
                start_token=start,
                end_token=end,
                doc_id=document.id
            )
            windows.append(window)
            
            # 滑动窗口
            start = end - self.overlap
        
        return windows
    
    async def retrieve_with_context(
        self,
        query: str,
        windows: List[TextWindow],
        top_k: int = 3
    ) -> List[ContextSnippet]:
        """
        检索相关窗口，并扩展上下文
        """
        # 1. 检索相关窗口
        scores = []
        for window in windows:
            score = await compute_relevance(query, window)
            scores.append((score, window))
        
        scores.sort(reverse=True)
        top_windows = [w for _, w in scores[:top_k]]
        
        # 2. 扩展上下文（包含相邻窗口）
        expanded = []
        for window in top_windows:
            context = self._expand_window(window, windows)
            expanded.append(context)
        
        return expanded
```

## 10.6 DeerFlow 中的实现

### 10.6.1 中间件集成

DeerFlow 在中间件链中集成上下文管理：

```
Middleware Chain 中的上下文管理：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

6. SummarizationMiddleware ──→ 上下文超限时压缩
8. TitleMiddleware ──────────→ 生成对话标题（便于后续检索）
9. MemoryMiddleware ─────────→ 异步写入记忆
```

### 10.6.2 Thread State 中的上下文

```python
class ThreadState(AgentState):
    # ...原有字段
    
    # Context Engineering 相关
    memory_context: Optional[str]      # 注入的长期记忆
    system_context: Optional[str]      # 系统级上下文
    project_context: Optional[str]     # 项目级上下文
    compressed: bool = False           # 是否已压缩
    last_compress_at: Optional[int]    # 上次压缩时间戳
```python

## 10.7 二次开发：企业级上下文优化

### 10.7.1 企业知识库注入

```python
class CorporateKnowledgeMiddleware:
    """
    企业知识库上下文注入中间件
    """
    
    def __init__(
        self,
        knowledge_base: CorporateKB,
        retriever: HybridRetriever
    ):
        self.kb = knowledge_base
        self.retriever = retriever
    
    async def process(self, state: ThreadState) -> MiddlewareResult:
        # 1. 提取当前任务
        task = state.get("current_task", "")
        project_id = state.get("project_id")
        
        # 2. 检索相关企业知识
        knowledge = await self.retriever.retrieve(
            query=task,
            filters={
                "project_id": project_id,
                "type": ["policy", "document", "faq"]
            },
            top_k=5
        )
        
        # 3. 构建上下文
        knowledge_context = self._build_knowledge_context(knowledge)
        
        # 4. 注入 state
        state["corporate_knowledge"] = knowledge_context
        
        return MiddlewareResult(should_continue=True)
    
    def _build_knowledge_context(
        self,
        knowledge: List[KnowledgeEntry]
    ) -> str:
        parts = ["## 企业知识库\n"]
        
        for entry in knowledge:
            parts.append(f"""
### {entry.title} ({entry.source})
{entry.content}

""")
        
        return "\n".join(parts)
```

### 10.7.2 项目上下文管理

```python
class ProjectContextMiddleware:
    """
    项目级上下文管理
    """
    
    async def process(self, state: ThreadState) -> MiddlewareResult:
        project_id = state.get("project_id")
        
        if not project_id:
            return MiddlewareResult(should_continue=True)
        
        # 1. 获取项目元数据
        project = await self.project_store.get(project_id)
        
        # 2. 获取项目历史摘要
        history = await self._get_project_history(project_id)
        
        # 3. 获取相关决策
        decisions = await self._get_relevant_decisions(project_id)
        
        # 4. 构建项目上下文
        context = f"""
## 项目: {project.name}
当前阶段: {project.current_phase}
目标: {project.objective}

### 历史进度
{history}

### 关键决策
{decisions}
"""
        
        state["project_context"] = context
        
        return MiddlewareResult(should_continue=True)
```

## 10.8 小结

| 技术 | 说明 |
|------|------|
| **分层管理** | System/Session/Turn 三层分离 |
| **Token 预算** | 固定分配 + 动态检查 |
| **递归摘要** | 压缩超出限制时的处理 |
| **选择性保留** | 基于重要性评分保留关键信息 |
| **RAG** | 混合检索（向量+关键词+图） |
| **上下文窗口** | 超长文档的分块处理 |

企业级 Context Engineering 优化：
- **企业知识库注入** — 实时检索公司政策、文档
- **项目上下文** — 保持长周期项目的状态一致
- **角色感知** — 根据用户角色过滤上下文
- **合规优先** — 敏感信息自动过滤


## 本章小结

本章系统讲解了 DeerFlow 的上下文工程技术：

1. **上下文注入**：通过 Prompt 模板、记忆召回、动态变量三种方式将外部信息注入 Agent 推理上下文。
2. **Token 预算**：系统根据模型上下文窗口（如 128K）动态计算可用 Token，优先保留核心指令，压缩或丢弃次要信息。
3. **上下文过滤**：相关性评分、时效性检查、隐私合规过滤三层机制确保注入信息的质量与合规性。
4. **多轮优化**：滑动窗口、摘要压缩、关键点提取等技术解决长对话中的上下文膨胀问题。

> **⚠️ 注意**：过度压缩上下文可能导致关键信息丢失——建议在压缩前后对核心事实进行一致性校验。

---

**下一步**：阅读第十一章，了解 MCP Server 的协议规范与 DeerFlow 集成方式。

