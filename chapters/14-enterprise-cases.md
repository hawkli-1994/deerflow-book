# 第十四章 · SwarmMind 企业级定制案例

## 14.1 案例背景：SwarmMind 需求分析

基于前文对 SwarmMind 产品规划的分析，本章聚焦 DeerFlow 二次开发的具体实现路径。

**核心需求映射：**

| SwarmMind 模块 | 二次开发重点 |
|---------------|--------------|
| Agent Teams | Sub-Agent 体系扩展 + 自定义 Agent 类型 |
| Memory | 企业知识库集成 + 项目级记忆 |
| Sandbox | 企业级沙箱（审计、配额） |
| Human-in-loop | 审批中间件 + 审计日志 |
| Context Engineering | 企业知识注入 + 合规过滤 |
| 多租户 | 租户隔离 + RBAC |

## 14.2 整体架构设计

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SwarmMind Architecture                           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Frontend (Next.js)                          │   │
│  │              Agent Chat │ Project Dashboard │ Admin           │   │
│  └─────────────────────────────────┬────────────────────────────┘   │
│                                    │                                   │
│                                    ▼                                   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Nginx (Port 2026)                           │   │
│  │                  统一入口 + 认证 + 限流                        │   │
│  └──────────┬─────────────────────┬──────────────────────────────┘   │
│             │                     │                                   │
│             ▼                     ▼                                   │
│  ┌─────────────────┐   ┌─────────────────────────────────────┐     │
│  │  Gateway API    │   │        LangGraph Server              │     │
│  │  (8001)         │   │        (2024)                        │     │
│  │                 │   │                                       │     │
│  │  - Auth         │   │  ┌─────────────────────────────────┐ │     │
│  │  - RBAC         │   │  │   SwarmMind Agent               │ │     │
│  │  - Tenant Mgmt  │   │  │                                 │ │     │
│  │  - Audit        │   │  │  - Middleware Chain (定制)      │ │     │
│  └─────────────────┘   │  │  - Agent Teams                  │ │     │
│                        │  │  - Skills (企业)                 │ │     │
│                        │  └─────────────────────────────────┘ │     │
│                        └────────────────────┬────────────────────┘     │
│                                             │                          │
│         ┌───────────────────────────────────┼───────────────────┐    │
│         │                                   │                    │    │
│         ▼                                   ▼                    ▼    │
│  ┌─────────────┐                ┌──────────────┐      ┌──────────┐ │
│  │  Corporate   │                │   Sandbox     │      │ Memory   │ │
│  │  Knowledge   │                │   (K8s)      │      │ System   │ │
│  │  Base        │                │              │      │          │ │
│  └─────────────┘                └──────────────┘      └──────────┘ │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## 14.3 多租户隔离实现

### 14.3.1 租户上下文

```python
# swarmmind/tenant/context.py

class TenantContext:
    """
    租户上下文 - ThreadLocal 存储
    """
    
    _local = threading.local()
    
    @classmethod
    def set(cls, tenant_id: str, user_id: str, role: str):
        cls._local.tenant_id = tenant_id
        cls._local.user_id = user_id
        cls._local.role = role
    
    @classmethod
    def get(cls) -> "TenantInfo":
        return TenantInfo(
            tenant_id=getattr(cls._local, 'tenant_id', None),
            user_id=getattr(cls._local, 'user_id', None),
            role=getattr(cls._local, 'role', None)
        )
    
    @classmethod
    def clear(cls):
        cls._local.tenant_id = None
        cls._local.user_id = None
        cls._local.role = None
```

### 14.3.2 租户中间件

```python
# swarmmind/tenant/middleware.py

class TenantMiddleware:
    """
    租户隔离中间件
    """
    
    async def process(self, state: ThreadState) -> MiddlewareResult:
        # 1. 从请求中获取租户信息
        tenant_info = TenantContext.get()
        
        if not tenant_info.tenant_id:
            raise UnauthorizedError("Tenant ID required")
        
        # 2. 注入到 ThreadState
        state["tenant_id"] = tenant_info.tenant_id
        state["user_id"] = tenant_info.user_id
        state["user_role"] = tenant_info.role
        
        # 3. 设置资源配额
        quota = await self._get_quota(tenant_info)
        state["resource_quota"] = quota
        
        return MiddlewareResult(continue=True)
    
    async def _get_quota(self, tenant: TenantInfo) -> ResourceQuota:
        """获取租户资源配额"""
        plan = await self.tenant_service.get_plan(tenant.tenant_id)
        
        return ResourceQuota(
            max_concurrent_agents=plan.agent_limit,
            max_sandbox_cpu=plan.cpu_limit,
            max_sandbox_memory=plan.memory_limit,
            max_storage_gb=plan.storage_limit,
            max_api_calls_per_day=plan.api_rate_limit
        )
```

### 14.3.3 数据隔离策略

```python
class TenantDataIsolation:
    """
    租户数据隔离策略
    """
    
    # 每个租户独立的数据存储前缀
    @staticmethod
    def get_table_name(table: str, tenant_id: str) -> str:
        """逻辑隔离：表名加租户前缀"""
        return f"tenant_{tenant_id}_{table}"
    
    @staticmethod
    def get_file_path(base: str, tenant_id: str, *parts) -> str:
        """文件系统隔离：租户独立目录"""
        return os.path.join(base, f"tenants/{tenant_id}", *parts)
    
    @staticmethod
    def get_vector_namespace(tenant_id: str) -> str:
        """向量存储隔离：租户独立 namespace"""
        return f"tenant_{tenant_id}"
```

## 14.4 RBAC 权限控制

### 14.4.1 权限模型

```python
# swarmmind/auth/rbac.py

class Role(str, Enum):
    TENANT_ADMIN = "tenant_admin"      # 租户管理员
    PROJECT_MANAGER = "project_manager"  # 项目经理
    MEMBER = "member"                  # 普通成员
    VIEWER = "viewer"                  # 只读成员
    EXTERNAL = "external"              # 外部访客

class Permission(str, Enum):
    # Agent 操作
    AGENT_CREATE = "agent:create"
    AGENT_DELETE = "agent:delete"
    AGENT_VIEW = "agent:view"
    
    # 项目操作
    PROJECT_CREATE = "project:create"
    PROJECT_MANAGE = "project:manage"
    PROJECT_DELETE = "project:delete"
    
    # 审批操作
    APPROVAL_CREATE = "approval:create"
    APPROVAL_GRANT = "approval:grant"
    APPROVAL_VIEW_SENSITIVE = "approval:view_sensitive"
    
    # 数据操作
    DATA_READ = "data:read"
    DATA_WRITE = "data:write"
    DATA_DELETE = "data:delete"
    DATA_EXPORT = "data:export"
    
    # 管理操作
    USER_MANAGE = "user:manage"
    TENANT_SETTINGS = "tenant:settings"

# 角色-权限映射
ROLE_PERMISSIONS = {
    Role.TENANT_ADMIN: [
        Permission.AGENT_CREATE, Permission.AGENT_DELETE, Permission.AGENT_VIEW,
        Permission.PROJECT_CREATE, Permission.PROJECT_MANAGE, Permission.PROJECT_DELETE,
        Permission.APPROVAL_CREATE, Permission.APPROVAL_GRANT, Permission.APPROVAL_VIEW_SENSITIVE,
        Permission.DATA_READ, Permission.DATA_WRITE, Permission.DATA_DELETE, Permission.DATA_EXPORT,
        Permission.USER_MANAGE, Permission.TENANT_SETTINGS,
    ],
    Role.PROJECT_MANAGER: [
        Permission.AGENT_CREATE, Permission.AGENT_VIEW,
        Permission.PROJECT_CREATE, Permission.PROJECT_MANAGE,
        Permission.APPROVAL_CREATE, Permission.APPROVAL_GRANT,
        Permission.DATA_READ, Permission.DATA_WRITE,
    ],
    Role.MEMBER: [
        Permission.AGENT_VIEW,
        Permission.PROJECT_MANAGE,
        Permission.DATA_READ, Permission.DATA_WRITE,
    ],
    Role.VIEWER: [
        Permission.AGENT_VIEW,
        Permission.PROJECT_MANAGE,
        Permission.DATA_READ,
    ],
    Role.EXTERNAL: [
        Permission.AGENT_VIEW,
        Permission.DATA_READ,
    ],
}
```

### 14.4.2 权限检查装饰器

```python
# swarmmind/auth/decorators.py

def require_permission(*permissions: Permission):
    """
    权限检查装饰器
    """
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            user = TenantContext.get()
            
            if not user:
                raise UnauthorizedError()
            
            user_permissions = ROLE_PERMISSIONS.get(user.role, [])
            
            # 检查是否有所需权限
            for permission in permissions:
                if permission not in user_permissions:
                    raise ForbiddenError(
                        f"Permission denied: {permission}"
                    )
            
            return await func(*args, **kwargs)
        
        return wrapper
    return decorator

# 使用示例
@router.post("/projects/{project_id}/approve")
@require_permission(Permission.APPROVAL_GRANT)
async def approve_action(project_id: str, ...):
    ...
```

## 14.5 审计日志系统

### 14.5.1 审计事件定义

```python
# swarmmind/audit/events.py

class AuditEventType(str, Enum):
    # 认证事件
    AUTH_LOGIN = "auth:login"
    AUTH_LOGOUT = "auth:logout"
    AUTH_FAILED = "auth:failed"
    
    # Agent 事件
    AGENT_CREATED = "agent:created"
    AGENT_TASK_STARTED = "agent:task_started"
    AGENT_TASK_COMPLETED = "agent:task_completed"
    AGENT_ERROR = "agent:error"
    
    # 数据事件
    DATA_READ = "data:read"
    DATA_WRITTEN = "data:written"
    DATA_DELETED = "data:deleted"
    DATA_EXPORTED = "data:exported"
    
    # 审批事件
    APPROVAL_REQUESTED = "approval:requested"
    APPROVAL_GRANTED = "approval:granted"
    APPROVAL_REJECTED = "approval:rejected"
    
    # Sandbox 事件
    SANDBOX_ACQUIRED = "sandbox:acquired"
    SANDBOX_RELEASED = "sandbox:released"
    SANDBOX_COMMAND_EXECUTED = "sandbox:command_executed"
    
    # 合规事件
    SENSITIVE_DATA_ACCESSED = "compliance:sensitive_data_accessed"
    POLICY_VIOLATION = "compliance:policy_violation"

@dataclass
class AuditEvent:
    """审计事件"""
    event_type: AuditEventType
    tenant_id: str
    user_id: str
    timestamp: datetime
    
    # 上下文
    project_id: Optional[str] = None
    agent_id: Optional[str] = None
    
    # 详情
    resource_type: Optional[str] = None
    resource_id: Optional[str] = None
    action: Optional[str] = None
    result: Optional[str] = None
    
    # 元数据
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    request_id: Optional[str] = None
    
    # 防篡改
    signature: Optional[str] = None
```

### 14.5.2 审计日志存储

```python
# swarmmind/audit/storage.py

class AuditLogStorage:
    """
    审计日志存储 - 只追加，防篡改
    """
    
    def __init__(self, storage_backend: StorageBackend):
        self.storage = storage_backend
    
    async def append(self, event: AuditEvent):
        """追加审计事件"""
        # 生成签名
        event.signature = self._sign(event)
        
        # 序列化为 JSONL
        line = json.dumps(asdict(event), default=str)
        
        # 写入追加存储
        await self.storage.append(f"audit/{event.tenant_id}", line)
    
    def _sign(self, event: AuditEvent) -> str:
        """防篡改签名"""
        content = json.dumps(
            asdict(event),
            sort_keys=True,
            exclude={"signature"}
        )
        return hmac.new(
            self.secret_key,
            content.encode(),
            hashlib.sha256
        ).hexdigest()
    
    async def verify(self, tenant_id: str) -> bool:
        """验证审计日志完整性"""
        async for line in self.storage.read(f"audit/{tenant_id}"):
            event = json.loads(line)
            
            if not self._verify_signature(event):
                return False
        
        return True
    
    def _verify_signature(self, event: dict) -> bool:
        """验证单个事件签名"""
        stored_sig = event.pop("signature", None)
        if not stored_sig:
            return False
        
        computed_sig = self._sign_from_dict(event)
        return hmac.compare_digest(stored_sig, computed_sig)
```

### 14.5.3 审计中间件

```python
# swarmmind/audit/middleware.py

class AuditMiddleware:
    """
    审计中间件 - 自动记录关键操作
    """
    
    async def process(
        self,
        state: ThreadState,
        event_type: AuditEventType
    ) -> MiddlewareResult:
        """记录审计事件"""
        tenant = TenantContext.get()
        
        event = AuditEvent(
            event_type=event_type,
            tenant_id=tenant.tenant_id,
            user_id=tenant.user_id,
            timestamp=datetime.now(),
            project_id=state.get("project_id"),
            agent_id=state.get("agent_id"),
            ip_address=get_client_ip(),
            user_agent=get_user_agent(),
            request_id=get_request_id()
        )
        
        # 异步写入，不阻塞主流程
        asyncio.create_task(self.audit_storage.append(event))
        
        return MiddlewareResult(continue=True)
```

## 14.6 企业知识库集成

### 14.6.1 知识库客户端

```python
# swarmmind/knowledge/base.py

class CorporateKnowledgeBase(ABC):
    """
    企业知识库抽象接口
    """
    
    @abstractmethod
    async def search(
        self,
        query: str,
        filters: KnowledgeFilters,
        top_k: int
    ) -> List[KnowledgeEntry]:
        pass
    
    @abstractmethod
    async def get_document(self, doc_id: str) -> Document:
        pass
    
    @abstractmethod
    async def list_categories(self) -> List[str]:
        pass


class KnowledgeEntry(BaseModel):
    id: str
    title: str
    content: str
    source: str
    category: str
    department: Optional[str]
    sensitivity: SensitivityLevel
    created_at: datetime
    updated_at: datetime
    metadata: Dict[str, Any]


class KnowledgeFilters(BaseModel):
    categories: Optional[List[str]] = None
    departments: Optional[List[str]] = None
    sensitivity: Optional[List[SensitivityLevel]] = None
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    project_id: Optional[str] = None
```

### 14.6.2 知识检索中间件

```python
# swarmmind/knowledge/middleware.py

class KnowledgeRetrievalMiddleware:
    """
    企业知识检索中间件
    """
    
    def __init__(
        self,
        knowledge_base: CorporateKnowledgeBase,
        retriever: HybridRetriever
    ):
        self.kb = knowledge_base
        self.retriever = retriever
    
    async def process(self, state: ThreadState) -> MiddlewareResult:
        tenant = TenantContext.get()
        
        # 1. 提取查询
        query = self._extract_query(state)
        if not query:
            return MiddlewareResult(continue=True)
        
        # 2. 构建过滤器（基于租户权限）
        filters = KnowledgeFilters(
            departments=[tenant.department] if tenant.department else None,
            sensitivity=[SensitivityLevel.PUBLIC, SensitivityLevel.INTERNAL],
            project_id=state.get("project_id")
        )
        
        # 3. 检索知识
        results = await self.kb.search(query, filters, top_k=10)
        
        # 4. 注入上下文
        if results:
            context = self._build_context(results)
            state["knowledge_context"] = context
        
        return MiddlewareResult(continue=True)
    
    def _build_context(self, entries: List[KnowledgeEntry]) -> str:
        parts = ["## 企业知识库参考\n"]
        
        for entry in entries[:5]:
            parts.append(f"""
### {entry.title}
**来源**: {entry.source}
**分类**: {entry.category}

{entry.content}

---
""")
        
        return "\n".join(parts)
```

## 14.7 Human-in-the-Loop 审批实现

### 14.7.1 审批规则引擎

```python
# swarmmind/approval/engine.py

class ApprovalRuleEngine:
    """
    审批规则引擎
    """
    
    def __init__(self, rules: List[ApprovalRule]):
        self.rules = rules
    
    async def check_requires_approval(
        self,
        action: AgentAction,
        context: ActionContext
    ) -> ApprovalRequirement:
        """
        检查动作是否需要审批
        """
        for rule in self.rules:
            if await rule.matches(action, context):
                return ApprovalRequirement(
                    required=True,
                    rule=rule,
                    approvers=await rule.get_approvers(action, context),
                    urgency=rule.get_urgency(action, context)
                )
        
        return ApprovalRequirement(required=False)
    
    async def execute_approval_flow(
        self,
        action: AgentAction,
        requirement: ApprovalRequirement
    ) -> ApprovalResult:
        """
        执行审批流程
        """
        # 1. 创建审批请求
        approval = await self.approval_store.create(
            action=action,
            approvers=requirement.approvers,
            urgency=requirement.urgency
        )
        
        # 2. 通知审批人
        await self.notifier.notify(approval)
        
        # 3. 暂停 Agent，等待审批
        return ApprovalResult(
            status=ApprovalStatus.PENDING,
            approval_id=approval.id
        )


class ActionContext(BaseModel):
    tenant_id: str
    user_id: str
    project_id: Optional[str]
    role: Role
    sandbox_id: Optional[str]


# 内置审批规则
class FinancialApprovalRule(ApprovalRule):
    """财务操作审批规则"""
    
    async def matches(self, action: AgentAction, ctx: ActionContext) -> bool:
        return (
            action.type == "financial_operation" and
            action.amount >= ctx.approval_threshold
        )
    
    async def get_approvers(self, action, ctx) -> List[User]:
        if action.amount >= 100000:
            return await self.user_service.get_directors()
        else:
            return await self.user_service.get_managers()


class SensitiveDataApprovalRule(ApprovalRule):
    """敏感数据访问审批规则"""
    
    async def matches(self, action: AgentAction, ctx: ActionContext) -> bool:
        return (
            action.type == "data_access" and
            action.data_sensitivity == SensitivityLevel.CONFIDENTIAL
        )
```

### 14.7.2 飞书审批卡片

```python
# swarmmind/approval/feishu.py

class FeishuApprovalNotifier:
    """
    飞书审批通知
    """
    
    def __init__(self, feishu_client: FeishuClient):
        self.client = feishu_client
    
    async def notify(self, approval: Approval):
        """发送飞书审批卡片"""
        for approver in approval.approvers:
            card = self._build_approval_card(approval)
            
            await self.client.send_interactive_card(
                open_id=approver.feishu_open_id,
                card=card
            )
    
    def _build_approval_card(self, approval: Approval) -> dict:
        """构建审批卡片"""
        return {
            "msg_type": "interactive",
            "card": {
                "header": {
                    "title": {
                        "tag": "plain_text",
                        "content": f"🔔 待审批: {approval.action.title}"
                    },
                    "template": "orange" if approval.urgency == "urgent" else "blue"
                },
                "elements": [
                    {
                        "tag": "div",
                        "text": {
                            "tag": "lark_md",
                            "content": self._format_action_details(approval)
                        }
                    },
                    {
                        "tag": "hr"
                    },
                    {
                        "tag": "note",
                        "elements": [
                            {
                                "tag": "plain_text",
                                "content": f"申请人: {approval.applicant.name}"
                            },
                            {
                                "tag": "plain_text",
                                "content": f"截止: {approval.deadline.strftime('%Y-%m-%d %H:%M')}"
                            }
                        ]
                    },
                    {
                        "tag": "action",
                        "actions": [
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "✅ 批准"},
                                "type": "primary",
                                "value": {
                                    "approval_id": approval.id,
                                    "action": "approve"
                                }
                            },
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "❌ 拒绝"},
                                "type": "danger",
                                "value": {
                                    "approval_id": approval.id,
                                    "action": "reject"
                                }
                            }
                        ]
                    }
                ]
            }
        }
```

## 14.8 项目级长程任务管理

### 14.8.1 项目状态机

```python
# swarmmind/project/state_machine.py

class ProjectState(str, Enum):
    PLANNING = "planning"
    ACTIVE = "active"
    PAUSED = "paused"
    PENDING_APPROVAL = "pending_approval"
    COMPLETED = "completed"
    ARCHIVED = "archived"


class ProjectStateMachine:
    """
    项目状态机
    """
    
    def __init__(self):
        self.transitions = {
            ProjectState.PLANNING: [ProjectState.ACTIVE],
            ProjectState.ACTIVE: [
                ProjectState.PAUSED,
                ProjectState.PENDING_APPROVAL,
                ProjectState.COMPLETED
            ],
            ProjectState.PAUSED: [ProjectState.ACTIVE],
            ProjectState.PENDING_APPROVAL: [
                ProjectState.ACTIVE,
                ProjectState.PAUSED
            ],
            ProjectState.COMPLETED: [ProjectState.ARCHIVED],
        }
    
    def can_transition(self, from_state: ProjectState, to_state: ProjectState) -> bool:
        return to_state in self.transitions.get(from_state, [])
    
    async def transition(
        self,
        project: Project,
        to_state: ProjectState,
        user: User,
        reason: str = None
    ) -> Project:
        """执行状态转换"""
        if not self.can_transition(project.state, to_state):
            raise InvalidTransitionError(
                f"Cannot transition from {project.state} to {to_state}"
            )
        
        # 记录转换
        await self.audit_log.log(
            event_type=AuditEventType.PROJECT_STATE_CHANGED,
            resource_id=project.id,
            action=f"{project.state} -> {to_state}",
            reason=reason,
            user_id=user.id
        )
        
        # 更新状态
        project.state = to_state
        project.updated_at = datetime.now()
        project.state_history.append(StateTransition(
            from_state=project.previous_state,
            to_state=to_state,
            changed_by=user.id,
            reason=reason,
            timestamp=datetime.now()
        ))
        
        await self.project_store.save(project)
        
        # 触发后续逻辑
        await self._on_transition(project, to_state)
        
        return project
```

### 14.8.2 多 Agent 任务分解

```python
# swarmmind/project/task_decomposition.py

class TaskDecomposer:
    """
    任务分解器 - LLM 驱动
    """
    
    def __init__(self, llm: ChatModel):
        self.llm = llm
    
    async def decompose(
        self,
        goal: str,
        project: Project,
        available_agents: List[AgentType]
    ) -> List[SubTask]:
        """
        将项目目标分解为可执行的子任务
        """
        prompt = f"""
        项目: {project.name}
        目标: {goal}
        
        可用的 Agent 类型:
        {', '.join([a.name for a in available_agents])}
        
        请将目标分解为具体的子任务，每个子任务应该：
        1. 有明确的交付物
        2. 可由单个 Agent 完成
        3. 有清晰的验收标准
        
        返回 JSON 格式:
        {{
            "tasks": [
                {{
                    "title": "任务标题",
                    "description": "任务描述",
                    "agent_type": "需要的 Agent 类型",
                    "dependencies": ["前置任务ID"],
                    "estimated_duration": "预计时长",
                    "checkpoints": ["检查点1", "检查点2"]
                }}
            ]
        }}
        """
        
        response = await self.llm.ainvoke([
            HumanMessage(content=prompt)
        ])
        
        # 解析响应
        result = json.loads(response.content)
        tasks = [SubTask(**t) for t in result["tasks"]]
        
        # 设置依赖关系
        for i, task in enumerate(tasks):
            task.index = i
            task.project_id = project.id
        
        return tasks
```

## 14.9 部署架构

### 14.9.1 Kubernetes 部署

```yaml
# k8s/deployment.yaml

apiVersion: apps/v1
kind: Deployment
metadata:
  name: swarmmind-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: swarmmind-gateway
  template:
    spec:
      containers:
        - name: gateway
          image: swarmmind/gateway:latest
          ports:
            - containerPort: 8001
          env:
            - name: TENANT_DB_URL
              valueFrom:
                secretKeyRef:
                  name: swarmmind-secrets
                  key: tenant-db-url
            - name: AUDIT_STORAGE_KEY
              valueFrom:
                secretKeyRef:
                  name: swarmmind-secrets
                  key: audit-signing-key
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2000m"
              memory: "4Gi"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: swarmmind-langgraph
spec:
  replicas: 5
  selector:
    matchLabels:
      app: swarmmind-langgraph
  template:
    spec:
      containers:
        - name: langgraph
          image: swarmmind/langgraph:latest
          ports:
            - containerPort: 2024
          env:
            - name: SANDBOX_MODE
              value: "provisioner"
            - name: PROVISIONER_URL
              value: "http://swarmmind-provisioner:8002"
```

### 14.9.2 配置管理

```yaml
# config/swarmmind-config.yaml

swarmmind:
  # 多租户配置
  multi_tenant:
    enabled: true
    isolation_mode: "strict"  # strict | relaxed
    
  # RBAC 配置
  rbac:
    default_role: member
    role_hierarchy:
      - tenant_admin
      - project_manager
      - member
      - viewer
      - external
  
  # 审计配置
  audit:
    enabled: true
    storage:
      type: s3
      bucket: swarmmind-audit-logs
    retention_days: 2555  # 7年，合规要求
  
  # 知识库配置
  knowledge:
    providers:
      - type: vector
        endpoint: http://knowledge-search:8080
      - type: graph
        endpoint: http://knowledge-graph:8080
    default_top_k: 10
  
  # Sandbox 配置
  sandbox:
    mode: provisioner
    provisioner:
      url: http://swarmmind-provisioner:8002
      kubeconfig_path: /etc/kube/config
    defaults:
      cpu_limit: "2"
      memory_limit: "4Gi"
      timeout_seconds: 3600
```

## 14.10 小结

本章展示了基于 DeerFlow 构建 SwarmMind 的完整开发路径：

| 模块 | 实现方式 |
|------|----------|
| **多租户隔离** | ThreadLocal + 中间件 + 数据层隔离 |
| **RBAC** | 角色-权限映射 + 装饰器检查 |
| **审计日志** | 事件驱动 + 防篡改签名 |
| **企业知识库** | 抽象接口 + 检索中间件 |
| **Human-in-loop** | 规则引擎 + 飞书卡片通知 |
| **长程任务** | 状态机 + LLM 驱动的任务分解 |

核心原则：
1. **复用 DeerFlow** — Sub-Agent、Skills、Sandbox 能力直接复用
2. **中间件扩展** — 通过中间件链注入企业逻辑
3. **独立服务** — 租户、RBAC、审计作为独立模块
4. **配置驱动** — 通过 config.yaml 管理企业参数

这样既能享受 DeerFlow 快速迭代的红利，又能满足企业级安全与合规要求。
