# 第十三章 · Human-in-the-Loop 人工审批机制


> **本章目标**：
> 1. 掌握 Human-in-the-Loop 的设计模式与交互流程
> 2. 理解审批中间件、Checkpoint 与断点恢复的实现
> 3. 了解企业级审批规则引擎与审计日志的设计

> **本章目标**：
> 1. 理解 Human-in-the-Loop 的设计哲学与审批状态模型
> 2. 掌握审批规则引擎与等待处理机制
> 3. 了解审批审计日志与二次开发指南

## 13.1 为什么需要 Human-in-the-Loop

企业级 Agent 系统不能完全「自治」，以下场景必须保留人工决策：

| 场景 | 原因 |
|------|------|
| **财务审批** | 超过预算的操作需主管确认 |
| **敏感数据访问** | 客户信息、员工隐私需要授权 |
| **外部系统操作** | 不可逆的操作需审批 |
| **高风险决策** | 涉及合规、法律风险需人工判断 |
| **异常处理** | Agent 无法处理的情况需要人工介入 |

## 13.2 审批节点设计

### 13.2.1 状态机扩展

DeerFlow 原生状态机：

```
START → PLANNING → EXECUTING → REVIEWING → END
```

企业级扩展：

```
START → PLANNING → EXECUTING → REVIEWING 
                          ↓
                    [PENDING_APPROVAL] ← 人工审批节点
                          ↓
              ┌─────────┴─────────┐
              ▼                   ▼
           APPROVED            REJECTED
              │                   │
              ▼                   ▼
         CONTINUE              REVISE
              │                   │
              └───────┬───────────┘
                      ▼
                    END
```

### 13.2.2 审批状态定义

```python
from enum import Enum

class ApprovalStatus(Enum):
    PENDING = "pending"           # 待审批
    APPROVED = "approved"       # 已批准
    REJECTED = "rejected"       # 已拒绝
    REVOKED = "revoked"         # 已撤销
    EXPIRED = "expired"         # 已过期

class ApprovalNode:
    """
    审批节点
    """
    def __init__(
        self,
        id: str,
        task_id: str,
        action: str,                 # 申请的操作
        reason: str,                  # 申请理由
        applicant: Agent,              # 申请 Agent
        approvers: List[User],         # 可审批人
        deadline: datetime,            # 审批截止时间
        urgency: str = "normal",      # urgent | normal | low
        metadata: dict = {},
    ):
        self.id = id
        self.task_id = task_id
        self.action = action
        self.reason = reason
        self.applicant = applicant
        self.approvers = approvers
        self.deadline = deadline
        self.urgency = urgency
        self.metadata = metadata
        
        self.status = ApprovalStatus.PENDING
        self.created_at = datetime.now()
        self.decided_at: Optional[datetime] = None
        self.decided_by: Optional[User] = None
        self.decision_comment: Optional[str] = None
```python

## 13.3 审批中间件

### 13.3.1 中间件实现

```python
class ApprovalMiddleware:
    """
    审批中间件 - 暂停 Agent 执行，等待人工审批
    """
    
    async def process(
        self,
        state: AgentState,
        action: AgentAction
    ) -> MiddlewareResult:
        """
        处理需要审批的动作
        """
        # 1. 检查是否需要审批
        if not self.requires_approval(action):
            return MiddlewareResult(should_continue=True)
        
        # 2. 创建审批请求
        approval = await self.create_approval_request(action, state)
        
        # 3. 暂停执行，通知审批人
        await self.notify_approvers(approval)
        
        # 4. 返回暂停状态
        return MiddlewareResult(
            should_continue=False,
            suspend=True,
            approval_id=approval.id,
            message=f"等待 {approval.approvers} 审批"
        )
    
    def requires_approval(self, action: AgentAction) -> bool:
        """
        判断动作是否需要审批
        """
        approval_rules = {
            # 高风险操作必须审批
            "delete_data": True,
            "send_external": True,
            "modify_budget": True,
            "access_sensitive": True,
            
            # 超过阈值必须审批
            "api_call": lambda a: a.cost > 1000,
            "file_operation": lambda a: a.size > 10 * 1024 * 1024,
            
            # 自定义规则
            "custom": self.custom_rules.check,
        }
        
        rule = approval_rules.get(action.type)
        if callable(rule):
            return rule(action)
        return rule or False
```

### 13.3.2 审批等待处理

```python
async def handle_approval_wait(
    thread_id: str,
    approval_id: str
):
    """
    处理审批等待状态
    """
    # 1. 持久化暂停点
    await save_suspend_point(
        thread_id=thread_id,
        approval_id=approval_id,
        state_snapshot=await get_current_state(thread_id)
    )
    
    # 2. 通知所有审批人
    approval = await get_approval(approval_id)
    for approver in approval.approvers:
        await send_notification(
            user=approver,
            title=f"待审批请求：{approval.action}",
            body=approval.reason,
            actions=["approve", "reject", "comment"],
            deadline=approval.deadline
        )
    
    # 3. 启动超时检查
    asyncio.create_task(
        check_approval_timeout(approval_id, approval.deadline)
    )
```python

## 13.4 审批流程 API

### 13.4.1 审批接口

```python
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/approvals", tags=["approvals"])

@router.post("/{approval_id}/approve")
async def approve_action(
    approval_id: str,
    user: User = Depends(get_current_user),
    comment: Optional[str] = None
):
    """批准操作"""
    approval = await get_approval(approval_id)
    
    # 1. 验证权限
    if user not in approval.approvers:
        raise HTTPException(403, "无审批权限")
    
    # 2. 检查状态
    if approval.status != ApprovalStatus.PENDING:
        raise HTTPException(400, f"当前状态：{approval.status}")
    
    # 3. 执行批准
    approval.status = ApprovalStatus.APPROVED
    approval.decided_by = user
    approval.decided_at = datetime.now()
    approval.decision_comment = comment
    
    await approval.save()
    
    # 4. 恢复 Agent 执行
    await resume_agent_execution(approval.thread_id)
    
    return {"status": "approved"}

@router.post("/{approval_id}/reject")
async def reject_action(
    approval_id: str,
    user: User = Depends(get_current_user),
    reason: str = Body(..., embed=True)
):
    """拒绝操作"""
    approval = await get_approval(approval_id)
    
    if user not in approval.approvers:
        raise HTTPException(403, "无审批权限")
    
    approval.status = ApprovalStatus.REJECTED
    approval.decided_by = user
    approval.decided_at = datetime.now()
    approval.decision_comment = reason
    
    await approval.save()
    
    # 触发修订流程
    await notify_agent_revision_needed(approval.thread_id, reason)
    
    return {"status": "rejected"}
```

### 13.4.2 审批列表

```text
# ORM 伪代码示例
# 注意：以下使用 ORM 查询语法，非标准 Python
@router.get("/pending")
async def list_pending_approvals(
    user: User = Depends(get_current_user),
    page: int = 1,
    page_size: int = 20
):
    """获取当前用户的待审批列表"""
    approvals = await Approval.find(
        Approval.approvers contains user.id,
        Approval.status == ApprovalStatus.PENDING
    ).sort(-Approval.created_at).paginate(page, page_size)
    
    return {
        "items": [format_approval(a) for a in approvals],
        "total": await Approval.count(...),
        "page": page,
        "page_size": page_size
    }
```python

## 13.5 审批通知集成

### 13.5.1 多渠道通知

```python
class ApprovalNotifier:
    """
    审批通知 - 支持多种渠道
    """
    
    async def notify(
        self,
        approval: Approval,
        channels: List[str] = ["in_app", "email", "feishu"]
    ):
        tasks = []
        
        if "in_app" in channels:
            tasks.append(self._notify_in_app(approval))
        
        if "email" in channels:
            tasks.append(self._notify_email(approval))
        
        if "feishu" in channels:
            tasks.append(self._notify_feishu(approval))
        
        if "sms" in channels:
            tasks.append(self._notify_sms(approval))
        
        await asyncio.gather(*tasks)
    
    async def _notify_feishu(self, approval: Approval):
        """飞书通知"""
        message = self._build_feishu_card(approval)
        
        for approver in approval.approvers:
            await feishu_client.send_card(
                open_id=approver.feishu_open_id,
                card=message
            )
    
    def _build_feishu_card(self, approval: Approval) -> dict:
        """构建飞书交互卡片"""
        return {
            "msg_type": "interactive",
            "card": {
                "header": {
                    "title": {"tag": "plain_text", "content": "🔔 待审批请求"},
                    "template": "orange" if approval.urgency == "urgent" else "blue"
                },
                "elements": [
                    {
                        "tag": "div",
                        "text": {
                            "tag": "lark_md",
                            "content": f"**操作：** {approval.action}\n**理由：** {approval.reason}"
                        }
                    },
                    {
                        "tag": "action",
                        "actions": [
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "✅ 批准"},
                                "type": "primary",
                                "value": {"approval_id": approval.id, "action": "approve"}
                            },
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "❌ 拒绝"},
                                "type": "danger",
                                "value": {"approval_id": approval.id, "action": "reject"}
                            }
                        ]
                    }
                ]
            }
        }
```

## 13.6 审批审计日志

> **🏢 企业级建议**：审计日志的存储应满足合规要求的保留期限（如金融行业通常要求 7 年）。建议使用对象存储（S3、OSS）而非数据库长期保存原始日志。

### 13.6.1 日志记录

```python
class ApprovalAuditLogger:
    """
    审批审计日志 - 防篡改记录
    """
    
    async def log(
        self,
        event: str,
        approval: Approval,
        user: Optional[User] = None,
        metadata: dict = {}
    ):
        """
        记录审批相关事件
        """
        log_entry = {
            "event": event,
            "approval_id": approval.id,
            "task_id": approval.task_id,
            "action": approval.action,
            "applicant_id": approval.applicant.id,
            "approver_id": user.id if user else None,
            "timestamp": datetime.now().isoformat(),
            "ip_address": get_client_ip(),
            "user_agent": get_user_agent(),
            "metadata": metadata,
            
            # 签名，防止篡改
            "signature": self._sign(log_entry)
        }
        
        # 写入只追加的日志存储
        await self.audit_store.append(log_entry)
    
    def _sign(self, entry: dict) -> str:
        """生成防篡改签名"""
        content = json.dumps(entry, sort_keys=True, default=str)
        return hmac.new(
            self.secret_key,
            content.encode(),
            hashlib.sha256
        ).hexdigest()
    
    async def verify(self, approval_id: str) -> List[dict]:
        """
        验证某审批的所有日志完整性
        """
        logs = await self.audit_store.read(approval_id)
        
        for log in logs:
            if not self._verify_signature(log):
                raise AuditException(f"日志 {log} 已被篡改")
        
        return logs
```python

### 13.6.2 合规报告生成

```python
@router.get("/audit/report")
async def generate_audit_report(
    project_id: str,
    start_date: datetime,
    end_date: datetime,
    user: User = Depends(require_admin),
    format: str = "pdf"
):
    """
    生成审计报告
    """
    # 1. 收集所有审批记录
    approvals = await Approval.find(
        Approval.task_id.in_(project_id),
        Approval.created_at >= start_date,
        Approval.created_at <= end_date
    )
    
    # 2. 获取完整审计日志
    audit_logs = []
    for approval in approvals:
        logs = await audit_logger.verify(approval.id)
        audit_logs.extend(logs)
    
    # 3. 生成统计
    stats = {
        "total": len(approvals),
        "approved": len([a for a in approvals if a.status == ApprovalStatus.APPROVED]),
        "rejected": len([a for a in approvals if a.status == ApprovalStatus.REJECTED]),
        "avg_decision_time": calculate_avg_time(approvals),
        "by_approver": group_by_approver(approvals),
    }
    
    # 4. 生成报告
    if format == "pdf":
        return await generate_pdf_report(stats, audit_logs)
    elif format == "excel":
        return await generate_excel_report(stats, audit_logs)
```

## 13.7 二次开发指南

### 13.7.1 添加自定义审批规则

```python
class CustomApprovalRule(ApprovalRule):
    """
    自定义审批规则示例：金额阈值审批
    """
    
    name = "amount_threshold"
    description = "超过阈值的金额操作需要审批"
    
    async def check(self, action: AgentAction, context: dict) -> bool:
        """
        检查是否需要审批
        """
        if action.type != "financial_operation":
            return False
        
        amount = action.metadata.get("amount", 0)
        threshold = context.get("approval_threshold", 10000)
        
        return amount >= threshold
    
    async def get_approvers(
        self,
        action: AgentAction,
        context: dict
    ) -> List[User]:
        """
        确定审批人
        """
        amount = action.metadata.get("amount", 0)
        
        if amount >= 100000:
            # 超过10万，需要总监审批
            return await user_service.get_directors()
        elif amount >= 10000:
            # 超过1万，需要经理审批
            return await user_service.get_managers()
        else:
            return await user_service.get_leads()
```python

### 13.7.2 集成到 DeerFlow 中间件链

```python
# 在 DeerFlow Agent 初始化时添加审批中间件

from deerflow.middleware import MiddlewareChain

async def create_enterprise_agent(config: Config):
    # 1. 创建基础 Agent
    agent = make_lead_agent(config)
    
    # 2. 添加审批中间件
    approval_middleware = ApprovalMiddleware(
        rules=[
            CustomApprovalRule(),
            SensitivityApprovalRule(),
            ExternalActionApprovalRule(),
        ],
        notification_channels=["feishu", "email"],
        audit_logger=EnterpriseAuditLogger(),
    )
    
    # 3. 注册到中间件链
    chain = MiddlewareChain.from_agent(agent)
    chain.add_middleware(approval_middleware, position=3)  # 插入到第3位
    
    return chain.compile()
```

## 13.8 小结

Human-in-the-Loop 是企业级 Agent 的必备能力：

| 模块 | 核心功能 |
|------|----------|
| **审批节点** | 状态机扩展，暂停执行 |
| **审批规则** | 可配置的条件触发 |
| **通知系统** | 多渠道实时通知 |
| **审计日志** | 防篡改，完整追溯 |
| **合规报告** | 自动生成审计报告 |

通过 DeerFlow 中间件机制，可以在不影响原有架构的情况下，优雅地添加人工审批能力，兼顾 AI 效率和人工控制。


## 本章小结

本章深入解析了 Human-in-the-Loop（HITL）的设计与实现：

1. **设计模式**：Approval（事前审批）、Intervention（事中干预）、Review（事后审查）三种模式覆盖不同管控粒度。
2. **审批中间件**：通过自定义 Middleware 在关键节点插入审批检查，支持规则引擎（条件表达式）与人工审批双模式。
3. **Checkpoint 机制**：在审批点保存完整状态快照，支持拒绝后的断点恢复与重试，确保任务不丢失。
4. **审计日志**：所有人工干预操作记录操作人、时间、原因、结果，满足合规要求。

> **⚠️ 注意**：审批节点的超时设置应平衡用户体验与系统安全——过短导致频繁中断，过长增加风险敞口。建议默认值 5 分钟，关键操作可延长至 30 分钟。

---

**下一步**：阅读第十四章，了解企业级 DeerFlow 的架构设计与部署实践。

