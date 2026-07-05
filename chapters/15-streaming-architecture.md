# 第十五章 · 流式架构

> **本章目标**：
> 1. 理解 DeerFlow 端到端流式响应的分层架构（LangGraph Runtime → StreamBridge → Gateway SSE → Nginx → Frontend React Hook）
> 2. 掌握 StreamBridge 的抽象协议、事件缓冲与断线重连机制
> 3. 深入 SSE 事件格式、多 stream mode 协作，以及前端消息去重与状态合并策略

## 15.1 架构总览

DeerFlow 的流式架构是一个 **五层解耦** 的实时事件管道。每一层只关心自己的职责，通过标准化的 SSE（Server-Sent Events）协议串联：

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Browser (React / useStream)                    │
│  ┌───────────────┐  ┌───────────────┐  ┌──────────────────────┐    │
│  │ LangGraph SDK │→ │ useStream Hook│→ │ React State → UI     │    │
│  │ EventSource   │  │ 消息去重/合并  │  │ Streamdown 渲染      │    │
│  └───────────────┘  └───────────────┘  └──────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ SSE (text/event-stream)
                             │ Last-Event-ID 断线重连
┌────────────────────────────▼────────────────────────────────────────┐
│                      Nginx (Port 2026)                              │
│  proxy_buffering off; chunked_transfer_encoding on;                 │
│  /api/langgraph/* → rewrite → Gateway /api/*                       │
│  X-Accel-Buffering: no; timeout: 600s                              │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTP/1.1 keep-alive
┌────────────────────────────▼────────────────────────────────────────┐
│                 Gateway API (Port 8001) — FastAPI                   │
│  ┌──────────────────┐  ┌──────────────────┐                        │
│  │ POST /runs/stream│  │ sse_consumer()   │                        │
│  │ 创建 Run + Task  │→ │ 订阅 bridge      │→ StreamingResponse    │
│  └──────────────────┘  │ 格式化 SSE 帧    │                        │
│                        └──────────────────┘                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │ StreamBridge.subscribe()
┌────────────────────────────▼────────────────────────────────────────┐
│                      StreamBridge（事件中枢）                       │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ MemoryStreamBridge (默认) / RedisStreamBridge (多进程)   │       │
│  │ • 事件缓冲 (256 events/run)                              │       │
│  │ • Last-Event-ID O(1) 回溯                                │       │
│  │ • Heartbeat sentinel (15s)                                │       │
│  │ • End sentinel                                            │       │
│  └─────────────────────────────────────────────────────────┘       │
└────────────────────────────▲────────────────────────────────────────┘
                             │ StreamBridge.publish()
┌────────────────────────────┴────────────────────────────────────────┐
│                 Agent Worker（后台 asyncio.Task）                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐      │
│  │ run_agent()  │→ │ graph.astream│→ │ serialize + publish  │      │
│  │ 初始化/清理  │  │ LangGraph 流 │  │ 事件发射到 bridge    │      │
│  └──────────────┘  └──────────────┘  └──────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

**设计原则**：

| 原则 | 体现 |
|------|------|
| **生产者-消费者解耦** | Agent Worker（生产者）和 SSE 端点（消费者）通过 StreamBridge 完全解耦 |
| **零缓冲直通** | Nginx、FastAPI、StreamBridge 三层均禁用响应缓冲，事件实时到达浏览器 |
| **断线可恢复** | `Last-Event-ID` + 事件序号支持 O(1) 定位与回放 |
| **多部署形态** | 单进程用 MemoryStreamBridge，多 Worker 用 RedisStreamBridge |

## 15.2 后端：Agent Worker 事件生产

### 15.2.1 run_agent() 入口

流式管道的起点是 `run_agent()` 函数，它在一个独立的 `asyncio.Task` 中执行：

```python
# packages/harness/deerflow/runtime/runs/worker.py

async def run_agent(
    bridge: StreamBridge,
    run_manager: RunManager,
    record: RunRecord,
    *,
    ctx: RunContext,
    agent_factory: Any,
    graph_input: dict,
    config: dict,
    stream_modes: list[str] | None = None,
    stream_subgraphs: bool = False,
    ...
) -> None:
    """在后台执行 agent，将事件发布到 bridge。"""

    # 1. 标记运行状态
    await run_manager.set_status(run_id, RunStatus.running)

    # 2. 发布 metadata 事件（useStream 需要 run_id + thread_id）
    await bridge.publish(run_id, "metadata", {
        "run_id": run_id,
        "thread_id": thread_id,
    })

    # 3. 构建 agent 并开始流式执行
    agent = agent_factory(config)

    # 4. 消费 LangGraph astream，逐事件发布到 bridge
    async for mode, chunk in agent.astream(
        graph_input,
        stream_mode=["values", "messages", "custom"],
    ):
        sse_event = _lg_mode_to_sse_event(mode)
        await bridge.publish(run_id, sse_event, serialize(chunk, mode=mode))

    # 5. 发布结束信号
    await bridge.publish_end(run_id)
```

### 15.2.2 Stream Mode 映射

LangGraph 的 `graph.astream()` 支持多种 `stream_mode`，DeerFlow 将其映射为 SSE 事件名：

| LangGraph stream_mode | SSE event 名 | 数据内容 | 用途 |
|----------------------|-------------|---------|------|
| `values` | `values` | 完整状态快照（messages, artifacts, title, todos） | 状态同步 |
| `messages` | `messages` / `messages-tuple` | 单条消息的增量 delta（按 message.id 拼接） | 实时打字效果 |
| `updates` | `updates` | `{node_name: writes}` 节点级更新 | 中间件状态注入（标题、摘要） |
| `custom` | `custom` | 自定义事件（task_running, task_completed 等） | 子任务进度追踪 |
| `checkpoints` | `checkpoints` | Checkpoint 快照 | 调试 |
| `debug` | `debug` | 详细调试信息 | 开发调试 |

### 15.2.3 事件序列化

每个 LangGraph chunk 通过 `serialize()` 转为 JSON 安全格式后发布：

```python
# packages/harness/deerflow/runtime/serialization.py

def serialize(chunk, mode=None):
    """将 LangGraph chunk 序列化为 JSON 安全的 dict。
    
    处理 BaseMessage 对象、State dict、自定义事件等类型。
    使用 default=str 作为兜底序列化策略。
    """
```

### 15.2.4 事件生命周期

一次完整的 Agent 运行产生如下事件序列：

```
┌─ metadata ─────────── {run_id, thread_id}
│
├─ values ───────────── 初始状态快照
│
├─ messages ─────────── AI 文本 delta (streaming 打字)
├─ messages ─────────── AI 文本 delta ...
├─ messages ─────────── AI tool_call
│
├─ updates ──────────── 中间件注入 (title, summarization)
│
├─ custom ───────────── task_running (子任务进度)
├─ custom ───────────── task_completed (子任务完成)
│
├─ values ───────────── 中间状态快照
│
├─ messages ─────────── Tool 执行结果
├─ messages ─────────── AI 最终回复 delta ...
│
├─ values ───────────── 最终状态快照
│
└─ end ──────────────── 流结束信号
```

## 15.3 StreamBridge：事件中枢

### 15.3.1 抽象协议

StreamBridge 是流式架构的核心抽象，定义了生产者-消费者协议：

```python
# packages/harness/deerflow/runtime/stream_bridge/base.py

@dataclass(frozen=True)
class StreamEvent:
    """单条流事件。"""
    id: str       # 单调递增事件 ID，格式: "{timestamp_ms}-{seq}"
    event: str    # SSE 事件名: metadata, values, messages, custom, error, end
    data: Any     # JSON 可序列化的负载

# 哨兵对象
HEARTBEAT_SENTINEL = StreamEvent(id="", event="__heartbeat__", data=None)
END_SENTINEL = StreamEvent(id="", event="__end__", data=None)

class StreamBridge(abc.ABC):
    supports_cross_process: bool = False

    @abc.abstractmethod
    async def publish(self, run_id: str, event: str, data: Any) -> None:
        """生产者侧：将事件入队。"""

    @abc.abstractmethod
    async def publish_end(self, run_id: str) -> None:
        """信号：该 run_id 不再产生事件。"""

    @abc.abstractmethod
    def subscribe(
        self, run_id: str, *,
        last_event_id: str | None = None,
        heartbeat_interval: float = 15.0,
    ) -> AsyncIterator[StreamEvent]:
        """消费者侧：异步迭代事件流。
        
        - 超时未收到事件时 yield HEARTBEAT_SENTINEL
        - 生产者调用 publish_end 后 yield END_SENTINEL
        """

    @abc.abstractmethod
    async def cleanup(self, run_id: str, *, delay: float = 0) -> None:
        """释放该 run_id 的相关资源。"""
```

### 15.3.2 MemoryStreamBridge（默认实现）

```python
# packages/harness/deerflow/runtime/stream_bridge/memory.py

class MemoryStreamBridge(StreamBridge):
    """基于 asyncio.Condition 的进程内事件日志实现。"""

    def __init__(self, *, queue_maxsize: int = 256):
        self._streams: dict[str, _RunStream] = {}  # run_id -> 事件列表
        self._counters: dict[str, int] = {}         # run_id -> 序号计数器

    # 事件 ID 生成: "{timestamp_ms}-{sequence}"
    def _next_id(self, run_id: str) -> str:
        self._counters[run_id] += 1
        ts = int(time.time() * 1000)
        seq = self._counters[run_id] - 1
        return f"{ts}-{seq}"
```

**关键设计**：

```
            publish()                       subscribe()
               │                                │
               ▼                                ▼
┌─────────────────────────────────────────────────────────┐
│  _RunStream (per run_id)                                │
│                                                         │
│  events: [E0, E1, E2, ..., E255]  ← 有界缓冲 (256)     │
│           ↑                                             │
│  start_offset: 0  ← 被淘汰事件的全局偏移量               │
│  condition: asyncio.Condition  ← 唤醒等待的订阅者       │
│  ended: bool  ← publish_end() 后变为 True               │
└─────────────────────────────────────────────────────────┘
```

**Last-Event-ID 重连**（O(1) 复杂度）：

```python
def _resolve_start_offset(self, stream, last_event_id):
    # 事件 ID 嵌入了单调递增的序号，可以用算术方式 O(1) 定位
    seq = self._parse_event_seq(last_event_id)  # 解析 "{ts}-{seq}" 中的 seq
    if seq is not None:
        local_index = seq - stream.start_offset
        if 0 <= local_index < len(stream.events):
            if stream.events[local_index].id == last_event_id:
                return stream.start_offset + local_index + 1  # 从下一个事件开始
    # 回退到最早保留的事件
    return stream.start_offset
```

### 15.3.3 RedisStreamBridge（多进程部署）

当需要多 Gateway Worker 协同时，启用 Redis 实现：

```yaml
# config.yaml
stream_bridge:
  type: redis
  redis:
    url: redis://localhost:6379
```

RedisStreamBridge 基于 Redis Streams 实现跨进程事件共享，保持相同的心跳和重连语义。`supports_cross_process = True` 标记使得 `joinStream` 可以在不同 Worker 上消费另一个 Worker 产生的事件流。

## 15.4 Gateway：SSE 帧格式化与消费

### 15.4.1 SSE 端点

```python
# app/gateway/routers/thread_runs.py

@router.post("/{thread_id}/runs/stream")
async def stream_run(thread_id, body, request) -> StreamingResponse:
    """创建 Run 并通过 SSE 流式返回事件。"""
    bridge = get_stream_bridge(request)
    record = await start_run(body, thread_id, request)

    return StreamingResponse(
        sse_consumer(bridge, record, request, run_mgr),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            # LangGraph SDK 从此 header 提取 run_id
            "Content-Location": f"/api/threads/{thread_id}/runs/{record.run_id}",
        },
    )
```

> `start_run()` 内部通过 `asyncio.create_task(run_agent(...))` 启动后台任务，立即返回 `RunRecord`。SSE 响应在 Task 创建后马上开始，不等 Agent 执行完成。

### 15.4.2 SSE 帧格式

```python
# app/gateway/services.py

def format_sse(event: str, data: Any, *, event_id: str | None = None) -> str:
    """格式化单个 SSE 帧，对齐 LangGraph Platform 线上协议。"""
    payload = json.dumps(data, default=str, ensure_ascii=False)
    parts = [f"event: {event}", f"data: {payload}"]
    if event_id:
        parts.append(f"id: {event_id}")
    parts.append("")
    parts.append("")
    return "\n".join(parts)
```

实际 SSE 帧示例：

```
event: metadata
data: {"run_id":"abc-123","thread_id":"def-456"}
id: 1719000000000-0

event: values
data: {"messages":[...],"title":"","artifacts":[],"todos":[]}
id: 1719000000001-1

event: messages
data: [{"type":"ai","content":"Hello","id":"msg-1"},{"type":"AIMessageChunk"}]
id: 1719000000002-2

event: end
data: null

```

### 15.4.3 SSE 消费者与断线处理

```python
# app/gateway/services.py

async def sse_consumer(bridge, record, request, run_mgr):
    """异步生成器：从 bridge 消费事件并 yield SSE 帧。"""
    last_event_id = request.headers.get("Last-Event-ID")

    try:
        async for entry in bridge.subscribe(record.run_id, last_event_id=last_event_id):
            # 检测客户端断开
            if await request.is_disconnected():
                break

            if entry is HEARTBEAT_SENTINEL:
                yield ": heartbeat\n\n"     # SSE 注释帧，保活
                continue

            if entry is END_SENTINEL:
                yield format_sse("end", None)
                return

            yield format_sse(entry.event, entry.data, event_id=entry.id)
    finally:
        # on_disconnect 语义
        if record.on_disconnect == DisconnectMode.cancel:
            await run_mgr.cancel(record.run_id)   # 取消后台任务
        # 若 on_disconnect == continue，后台任务继续运行，事件被丢弃
```

**心跳机制**：StreamBridge 每 15 秒（可配置）在无事件时发送 `HEARTBEAT_SENTINEL`，消费者将其转为 SSE 注释帧 `": heartbeat\n\n"`。这使得：
1. Nginx 和中间代理不会因为空闲而断开连接
2. 消费者可以在心跳时检测客户端断开并触发 `on_disconnect`

## 15.5 Nginx：流式代理配置

Nginx 作为统一入口，需要特殊配置以支持 SSE 直通：

```nginx
# docker/nginx/nginx.conf

location /api/langgraph/ {
    # URL 改写: /api/langgraph/* → /api/*
    rewrite ^/api/langgraph/(.*) /api/$1 break;
    proxy_pass http://gateway:8001;

    # HTTP/1.1 (支持 keep-alive 和 chunked)
    proxy_http_version 1.1;

    # 关键：禁用所有缓冲
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header X-Accel-Buffering no;

    # 清空 Connection header，让 Nginx 管理连接
    proxy_set_header Connection '';

    # 长超时（Agent 运行可能耗时数分钟）
    proxy_connect_timeout 600s;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;

    # 启用分块传输
    chunked_transfer_encoding on;
}
```

**为什么每一层都必须禁用缓冲？**

```
Agent Event → StreamBridge → FastAPI StreamingResponse → Nginx → Browser
                                                          ↑
                                           若 Nginx 缓冲打开，
                                           事件会被攒批发送，
                                           用户看到的是"一段段跳出"
                                           而非"逐字流式"效果
```

| 配置项 | 作用 |
|--------|------|
| `proxy_buffering off` | 禁用 Nginx 的响应缓冲 |
| `X-Accel-Buffering: no` | 后端显式告知 Nginx 不要缓冲此响应 |
| `chunked_transfer_encoding on` | 允许不定长的分块流式传输 |
| `Connection: ''` | 空值让 Nginx 管理上下游 keep-alive |
| `proxy_read_timeout 600s` | Agent 运行最长 10 分钟不超时 |

## 15.6 前端：流式消费与状态管理

### 15.6.1 LangGraph SDK 客户端

前端通过 `@langchain/langgraph-sdk` 官方 SDK 连接后端：

```typescript
// core/api/api-client.ts

const client = new LangGraphClient({
  apiUrl: "/api/langgraph",    // → Nginx → Gateway
  onRequest: injectCsrfHeader, // 自动注入 X-CSRF-Token
});

// 包装 stream 方法，过滤不支持的 stream mode
client.runs.stream = (threadId, assistantId, payload) =>
  originalRunStream(threadId, assistantId, sanitizeRunStreamOptions(payload));

// 包装 joinStream，处理跨 Worker 重连
client.runs.joinStream = async function* (threadId, runId, options) {
  try {
    yield* originalJoinStream(threadId, runId, sanitizeRunStreamOptions(options));
  } catch (error) {
    if (isInactiveRunStreamError(error)) {
      clearReconnectRun(threadId, runId); // 清理 sessionStorage
      return;
    }
    throw error;
  }
};
```

### 15.6.2 Stream Mode 过滤

前端维护一份支持的 stream mode 白名单：

```typescript
// core/api/stream-mode.ts

const SUPPORTED_RUN_STREAM_MODES = new Set([
  "values",           // 完整状态快照
  "messages",         // 消息级增量
  "messages-tuple",   // 消息元组
  "updates",          // 节点更新
  "events",           // 事件流
  "debug",            // 调试
  "tasks",            // 任务
  "checkpoints",      // Checkpoint
  "custom",           // 自定义事件
]);

// 过滤掉不支持的 mode，避免后端报错
export function sanitizeRunStreamOptions(options) {
  const requested = options.streamMode;
  const sanitized = requested.filter(mode => SUPPORTED_RUN_STREAM_MODES.has(mode));
  if (sanitized.length < requested.length) {
    warnUnsupportedStreamModes(droppedModes);
  }
  return { ...options, streamMode: sanitized };
}
```

### 15.6.3 useThreadStream Hook 核心流程

这是前端流式消费的核心 Hook，基于 SDK 的 `useStream` 构建：

```typescript
// core/threads/hooks.ts

export function useThreadStream({ threadId, context, onFinish, ... }) {
  const thread = useStream<AgentThreadState>({
    client: getAPIClient(),
    assistantId: "lead_agent",
    threadId: onStreamThreadId,
    reconnectOnMount: true,              // 页面恢复时自动重连
    fetchStateHistory: { limit: 1 },     // 首次加载历史

    // 1. Run 创建回调 — 收到 metadata 事件后触发
    onCreated(meta) {
      handleStreamStart(meta.thread_id, meta.run_id);
      upsertThreadInSearchCache(queryClient, { thread_id: meta.thread_id, ... });
    },

    // 2. LangChain 事件回调 — tool 执行完成时通知
    onLangChainEvent(event) {
      if (event.event === "on_tool_end") {
        onToolEnd({ name: event.name, data: event.data });
      }
    },

    // 3. Updates 事件回调 — 处理中间件注入的状态更新
    onUpdateEvent(data) {
      // 处理 SummarizationMiddleware 的上下文压缩
      const summarizationMessages = getSummarizationMiddlewareMessages(data);
      if (summarizationMessages) {
        // 将被压缩掉的消息"救回来"归档到历史
        const movedMessages = computeSummarizationMovedMessages(...);
        pendingArchivedMessagesRef.current = [...rescueBuffer, ...movedMessages];
        appendMessages(movedMessages);
      }

      // 处理 TitleMiddleware 注入的标题更新
      for (const update of Object.values(data)) {
        if (update?.title) {
          // 实时更新侧边栏的 thread 标题
          updateThreadTitleInCache(queryClient, threadIdRef.current, update.title);
        }
      }
    },

    // 4. 自定义事件回调 — 子任务进度追踪
    onCustomEvent(event) {
      if (event.type === "task_running") {
        // 累积子任务步骤（不覆盖），构建完整的执行时间线
        updateSubtask({
          id: event.task_id,
          latestMessage: event.message,
          steps: [messageToStep(event.message, event.message_index)],
        });
      }
    },

    // 5. 流结束回调 — 刷新缓存
    onFinish(state) {
      onFinish?.(state.values);
      invalidateStoppedThreadCaches(queryClient, threadIdRef.current);
    },

    // 6. 错误处理 — toast 提示 + 清理乐观更新
    onError(error) {
      setOptimisticMessages([]);
      toast.error(getStreamErrorMessage(error));
    },
  });

  // 合并历史消息 + 实时消息 + 乐观消息
  const mergedMessages = mergeMessages(history, persistedMessages, optimisticMessages);
  return { thread: { ...thread, messages: mergedMessages }, sendMessage, ... };
}
```

### 15.6.4 消息去重策略

流式场景下，`values` 模式会发送完整状态快照，`messages` 模式会发送增量 delta。同一条消息可能在两种模式中出现，必须去重：

```typescript
// core/threads/hooks.ts

function dedupeMessagesByIdentity(messages: Message[]): Message[] {
  const lastIndexByIdentity = new Map<string, number>();

  messages.forEach((message, index) => {
    const identity = messageIdentity(message);
    // identity 格式: "message:{id}" 或 "tool:{tool_call_id}"
    if (identity) {
      lastIndexByIdentity.set(identity, index);
    }
  });

  // 保留每个 identity 的最后一次出现（最新版本）
  return messages.filter((message, index) => {
    const identity = messageIdentity(message);
    if (!identity) return true;
    return lastIndexByIdentity.get(identity) === index;
  });
}
```

**三路消息合并**：

```
historyMessages     threadMessages     optimisticMessages
(历史存档消息)       (实时流消息)        (乐观更新消息)
      │                   │                    │
      └───────────────────┼────────────────────┘
                          │
                   mergeMessages()
                          │
                    ┌─────▼──────┐
                    │ 去重 + 排序 │
                    │ 保留最新版本│
                    └─────┬──────┘
                          │
                  mergedMessages → UI 渲染
```

```typescript
export function mergeMessages(
  historyMessages: Message[],    // 来自 API 的历史消息
  threadMessages: Message[],     // 来自实时流的消息
  optimisticMessages: Message[], // 用户发送但尚未确认的消息
): Message[] {
  // 1. 计算历史与实时消息的重叠区间（连续后缀匹配）
  // 2. 截断重叠部分，保留 threadMessages 版本
  // 3. 拼接去重后返回
  return dedupeMessagesByIdentity([
    ...historyMessages.slice(0, cutoff),
    ...threadMessages,
    ...optimisticMessages,
  ]);
}
```

### 15.6.5 上下文摘要的消息拯救

当 `SummarizationMiddleware` 触发上下文压缩时，旧消息会被 `RemoveMessage(ALL)` 删除。前端通过 `computeSummarizationMovedMessages()` 将被删除的消息"拯救"到历史归档中，确保 UI 仍能显示完整对话：

```
Stream 前: [msg1, msg2, msg3, msg4, msg5]  ← 全部可见
                    │
          SummarizationMiddleware 触发
                    │
Stream 后: [summary, msg4, msg5]          ← msg1-3 被压缩
                    │
         前端: 将 msg1-3 拯救到 history
                    │
UI 渲染:   [msg1, msg2, msg3, msg4, msg5]  ← 用户看到完整对话
```

## 15.7 提交消息的完整数据流

以用户发送一条消息为例，追踪端到端的数据路径：

### Step 1：前端提交

```typescript
// useThreadStream → sendMessage()
await thread.submit(
  { messages: [{ type: "human", content: [{ type: "text", text }] }] },
  {
    threadId,
    streamSubgraphs: true,
    streamResumable: true,
    config: { recursion_limit: 1000 },
    context: {
      thinking_enabled: true,
      is_plan_mode: mode === "pro",
      model_name: "gpt-4",
    },
  },
);
```

### Step 2：Nginx 路由转发

```
POST /api/langgraph/threads/{id}/runs/stream
  → rewrite → POST /api/threads/{id}/runs/stream
  → proxy_pass → http://gateway:8001
```

### Step 3：Gateway 创建 Run

```python
# services.py::start_run()
record = await run_mgr.create_or_reject(thread_id, ...)

# 后台任务：asyncio.create_task(run_agent(...))
task = asyncio.create_task(run_agent(bridge, run_mgr, record, ...))
record.task = task

# 立即返回 StreamingResponse
return StreamingResponse(sse_consumer(bridge, record, request, run_mgr), ...)
```

### Step 4：后台 Agent 执行 + 事件发布

```python
# worker.py::run_agent()
await bridge.publish(run_id, "metadata", {"run_id": ..., "thread_id": ...})

async for mode, chunk in agent.astream(input, stream_mode=[...]):
    await bridge.publish(run_id, sse_event, serialize(chunk))

await bridge.publish_end(run_id)
```

### Step 5：SSE 帧到达浏览器

```
event: metadata
data: {"run_id":"abc","thread_id":"def"}
id: 1719000000000-0

event: messages
data: [{"type":"ai","content":"Hello","id":"msg-1"},...]
id: 1719000000001-1

event: values
data: {"messages":[...],"title":"New Chat","artifacts":[]}
id: 1719000000002-2

event: end
data: null
```

### Step 6：React 状态更新 → UI 渲染

```
useStream hook 消费 SSE 帧
  → onCreated: 更新 thread 缓存
  → messages 事件: 更新 thread.messages（增量拼接）
  → values 事件: 更新完整状态（去重合并）
  → onCustomEvent: 更新子任务进度
  → onFinish: 刷新缓存
  → React 重新渲染 → 用户看到流式输出
```

## 15.8 断线重连机制

### 15.8.1 重连流程

```
浏览器断线（网络波动 / 切标签页 / 电脑休眠）
    │
    ▼
useStream(reconnectOnMount: true)
    │
    ▼ 发起 joinStream 请求
    │ Header: Last-Event-ID: "1719000000042-42"
    │
    ▼ Nginx → Gateway
    │
    ▼ sse_consumer(bridge, record, request)
    │   bridge.subscribe(run_id, last_event_id="1719000000042-42")
    │
    ▼ MemoryStreamBridge._resolve_start_offset()
    │   解析 event_id → seq=42
    │   next_offset = 42 + 1 = 43
    │   从第 43 个事件开始回放
    │
    ▼ 浏览器收到漏掉的事件，状态恢复
```

### 15.8.2 边界情况处理

| 场景 | 处理方式 |
|------|---------|
| 事件已被淘汰（超出 256 缓冲） | 从最早保留的事件开始回放，日志 warning |
| Run 已在另一个 Worker 完成 | `isInactiveRunStreamError` → 清理 sessionStorage |
| Run 已结束且无留存流 | `_terminal_record_stream_missing` → 直接发送 END_SENTINEL |
| event_id 格式不匹配 | 回退到最早保留的事件 |

### 15.8.3 前端重连清理

```typescript
// api-client.ts
export function clearReconnectRun(threadId, runId) {
  const key = `lg:stream:${threadId}`;
  if (sessionStorage.getItem(key) === runId) {
    sessionStorage.removeItem(key);  // 清理重连标记
  }
}
```

## 15.9 自定义事件与子任务追踪

子任务（Sub-Agent）通过 `custom` 事件报告进度：

```json
{
  "event": "custom",
  "data": {
    "type": "task_running",
    "task_id": "subtask-xyz",
    "message": {
      "type": "ai",
      "content": "正在搜索相关文档...",
      "tool_calls": [{"name": "web_search", "args": {"query": "..."}}]
    },
    "message_index": 5
  }
}
```

前端通过 `onCustomEvent` 回调累积步骤：

```typescript
onCustomEvent(event) {
  if (event.type === "task_running") {
    updateSubtask({
      id: event.task_id,
      latestMessage: event.message,
      // 累积（不覆盖）步骤时间线
      steps: [messageToStep(event.message, event.message_index)],
    });
  }
}
```

子任务卡片展开时，通过 `fetchSubtaskSteps` 从 `/runs/{runId}/events?task_id=...&after_seq=...` 分页加载完整历史步骤。

## 15.10 配置参考

### StreamBridge 配置

```yaml
# config.yaml

# 单进程模式（默认）
stream_bridge:
  type: memory

# 多进程 / 多 Worker 模式
stream_bridge:
  type: redis
  redis:
    url: redis://localhost:6379
```

### Nginx 流式参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `proxy_buffering` | `off` | 禁用响应缓冲 |
| `proxy_cache` | `off` | 禁用缓存 |
| `proxy_read_timeout` | `600s` | Agent 运行最长超时 |
| `chunked_transfer_encoding` | `on` | 分块传输 |
| `X-Accel-Buffering` | `no` | 告知 Nginx 不缓冲 |

### 前端环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEXT_PUBLIC_LANGGRAPH_BASE_URL` | `/api/langgraph` | LangGraph API 基础 URL（通过 Nginx） |
| `NEXT_PUBLIC_BACKEND_BASE_URL` | `""` | Gateway REST API URL（通过 Nginx） |

## 15.11 关键源码索引

| 层级 | 文件路径 | 职责 |
|------|---------|------|
| Agent Worker | `packages/harness/deerflow/runtime/runs/worker.py` | 后台执行 Agent，事件发布 |
| StreamBridge 协议 | `packages/harness/deerflow/runtime/stream_bridge/base.py` | 抽象接口 + 哨兵定义 |
| Memory 实现 | `packages/harness/deerflow/runtime/stream_bridge/memory.py` | 进程内事件缓冲 |
| Redis 实现 | `packages/harness/deerflow/runtime/stream_bridge/redis.py` | 跨进程 Redis Streams |
| 序列化 | `packages/harness/deerflow/runtime/serialization.py` | LangGraph chunk → JSON |
| SSE 端点 | `app/gateway/routers/thread_runs.py` | HTTP 路由 + StreamingResponse |
| SSE 服务层 | `app/gateway/services.py` | SSE 帧格式化 + 消费者生成器 |
| Nginx 配置 | `docker/nginx/nginx.conf` | 反向代理 + 流式直通 |
| SDK 客户端 | `frontend/src/core/api/api-client.ts` | LangGraph SDK 封装 |
| Stream Mode | `frontend/src/core/api/stream-mode.ts` | Mode 白名单过滤 |
| 流式 Hook | `frontend/src/core/threads/hooks.ts` | useThreadStream 主逻辑 |
| 子任务步骤 | `frontend/src/core/tasks/steps.ts` | 步骤模型与去重 |
| Streamdown | `frontend/src/core/streamdown/` | 流式 Markdown 渲染 |

## 本章小结

DeerFlow 的流式架构体现了以下工程思想：

1. **分层解耦**：Agent Worker → StreamBridge → Gateway SSE → Nginx → Frontend，每层独立可替换。
2. **协议对齐**：SSE 帧格式严格对齐 LangGraph Platform 协议，前端使用官方 SDK 零修改消费。
3. **断线可恢复**：`Last-Event-ID` + 有界事件缓冲 + O(1) 定位，网络波动不丢事件。
4. **零缓冲直通**：Nginx / FastAPI / Bridge 三层全部禁用缓冲，事件毫秒级到达浏览器。
5. **多模式并行**：`values`（全量同步）+ `messages`（增量 delta）+ `custom`（业务事件）协同工作，前端通过去重合并消除冗余。
6. **弹性部署**：MemoryStreamBridge（单进程）和 RedisStreamBridge（多 Worker）同一接口，一行配置切换。

---

**下一步**：阅读附录 A，了解完整的配置参考。
