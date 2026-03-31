# 第十二章 · 自定义 Skill 开发

## 12.1 Skill 开发流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    Skill Development Workflow                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 设计 ──→ 2. 实现 ──→ 3. 调试 ──→ 4. 打包 ──→ 5. 发布        │
│                                                                  │
│     │              │              │              │              │
│     ▼              ▼              ▼              ▼              │
│  需求分析      Python/JS       本地测试      .skill 文件     ClawHub │
│  能力定义      实现逻辑        Sandbox       + metadata       分享   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 12.2 Skill 文件结构

### 12.2.1 目录结构

```
skills/
└── custom/
    └── my-custom-skill/
        ├── SKILL.md           # Skill 定义（必需）
        ├── skill.yaml         # Skill 元数据（可选）
        ├── src/
        │   ├── __init__.py
        │   ├── executor.py    # 核心执行逻辑
        │   └── utils.py       # 工具函数
        ├── prompts/
        │   ├── system.md
        │   └── user_guidance.md
        └── tests/
            └── test_executor.py
```

### 12.2.2 SKILL.md 结构

```markdown
---
name: my-custom-skill
description: 技能描述，一句话说明这个 Skill 能做什么
version: 1.0.0
author: Your Name
tags: ["tag1", "tag2"]
compatibility: ">=2.0.0"
---

# Skill Name

## Overview

这里是技能的详细描述...

## Capabilities

- 能力 1
- 能力 2

## Usage

描述如何使用这个技能...

## Examples

提供使用示例...
```

## 12.3 Skill YAML 格式

### 12.3.1 完整格式

```yaml
# skill.yaml
name: enterprise-finance-analyst
version: 1.0.0
description: 企业财务分析 Skill，支持报表生成、指标计算、趋势分析

author: SwarmMind Team
compatibility: ">=2.0.0"

# 提示词配置
prompts:
  system: |
    你是一名资深企业财务分析师，专长于：
    - 财务报表深度解读
    - 财务指标计算与分析
    - 预算执行跟踪
    - 风险预警与建议
    
    使用企业财务工具集完成任务。

  user_guidance: |
    使用此 Skill 时：
    1. 明确分析目标和范围
    2. 收集相关财务数据
    3. 进行指标计算和分析
    4. 生成结构化分析报告

# 工具配置
tools:
  - name: query_financial_data
    description: 查询财务数据
    config:
      max_rows: 10000
      timeout: 30
    required_params:
      - sql
    optional_params:
      - start_date
      - end_date

  - name: calculate_metrics
    description: 计算财务指标
    config:
      metrics:
        - gross_margin
        - net_margin
        - roe
        - roa
        - debt_ratio

  - name: generate_report
    description: 生成分析报告
    config:
      format: markdown
      include_charts: true
      sections:
        - executive_summary
        - detailed_analysis
        - recommendations
        - appendix

# 依赖配置
dependencies:
  python_packages:
    - pandas>=1.5.0
    - numpy>=1.21.0
  mcp_servers:
    - enterprise-db

# 执行约束
constraints:
  max_execution_time: 300  # 5分钟
  requires_approval_above:
    amount: 100000  # 超过10万需要审批
  sensitive_data_handling: audit_required
```

## 12.4 Skill 实现

### 12.4.1 Python Executor

```python
# src/executor.py

from typing import Dict, Any, List, Optional
from dataclasses import dataclass
from enum import Enum

class ExecutionStatus(Enum):
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL = "partial"
    PENDING_APPROVAL = "pending_approval"

@dataclass
class ExecutionContext:
    """执行上下文"""
    skill_name: str
    skill_version: str
    config: Dict[str, Any]
    tools: Dict[str, Any]  # 可用工具
    user_id: str
    tenant_id: str
    project_id: Optional[str]
    session_id: str

@dataclass
class ExecutionResult:
    """执行结果"""
    status: ExecutionStatus
    output: Any
    metadata: Dict[str, Any]
    errors: List[str]
    artifacts: List[str]  # 生成的文件

class FinanceSkillExecutor:
    """
    财务分析 Skill 执行器
    """
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.tools = {}
    
    def register_tools(self, tools: Dict[str, Any]):
        """注册可用工具"""
        self.tools = tools
    
    async def execute(
        self,
        context: ExecutionContext,
        task: str,
        params: Dict[str, Any]
    ) -> ExecutionResult:
        """
        执行财务分析任务
        """
        try:
            # 1. 解析任务类型
            task_type = self._classify_task(task)
            
            # 2. 执行相应分析
            if task_type == "report_generation":
                return await self._generate_financial_report(context, params)
            
            elif task_type == "indicator_calculation":
                return await self._calculate_indicators(context, params)
            
            elif task_type == "trend_analysis":
                return await self._analyze_trends(context, params)
            
            elif task_type == "budget_tracking":
                return await self._track_budget(context, params)
            
            else:
                return ExecutionResult(
                    status=ExecutionStatus.FAILED,
                    output=None,
                    metadata={},
                    errors=[f"Unknown task type: {task_type}"],
                    artifacts=[]
                )
        
        except Exception as e:
            return ExecutionResult(
                status=ExecutionStatus.FAILED,
                output=None,
                metadata={},
                errors=[str(e)],
                artifacts=[]
            )
    
    def _classify_task(self, task: str) -> str:
        """分类任务"""
        task_lower = task.lower()
        
        if "报告" in task or "report" in task_lower:
            return "report_generation"
        elif "指标" in task or "indicator" in task_lower:
            return "indicator_calculation"
        elif "趋势" in task or "trend" in task_lower:
            return "trend_analysis"
        elif "预算" in task or "budget" in task_lower:
            return "budget_tracking"
        else:
            return "general_analysis"
    
    async def _generate_financial_report(
        self,
        context: ExecutionContext,
        params: Dict[str, Any]
    ) -> ExecutionResult:
        """生成财务报告"""
        
        # 1. 获取数据
        sql = params.get("sql", self._build_default_query(params))
        data = await self.tools["query_financial_data"].execute(
            sql=sql,
            start_date=params.get("start_date"),
            end_date=params.get("end_date")
        )
        
        # 2. 计算指标
        metrics = await self._calculate_indicators_internal(data)
        
        # 3. 生成报告
        report_config = self.config.get("generate_report", {})
        report_format = report_config.get("format", "markdown")
        
        report = await self._render_report(
            format=report_format,
            data=data,
            metrics=metrics,
            config=report_config
        )
        
        # 4. 保存报告
        report_path = await self._save_report(
            context=context,
            report=report,
            filename=params.get("filename", "financial_report.md")
        )
        
        return ExecutionResult(
            status=ExecutionStatus.SUCCESS,
            output=report,
            metadata={
                "task_type": "report_generation",
                "data_rows": len(data),
                "metrics_calculated": len(metrics)
            },
            errors=[],
            artifacts=[report_path]
        )
    
    async def _calculate_indicators_internal(
        self,
        data: List[Dict]
    ) -> Dict[str, float]:
        """计算财务指标"""
        import pandas as pd
        
        df = pd.DataFrame(data)
        
        indicators = {}
        
        # 毛利率
        if "revenue" in df.columns and "cost" in df.columns:
            indicators["gross_margin"] = (
                (df["revenue"].sum() - df["cost"].sum()) / df["revenue"].sum()
            ) * 100
        
        # 净利率
        if "revenue" in df.columns and "expense" in df.columns:
            indicators["net_margin"] = (
                (df["revenue"].sum() - df["expense"].sum()) / df["revenue"].sum()
            ) * 100
        
        # ROE (净资产收益率)
        if "net_income" in df.columns and "equity" in df.columns:
            indicators["roe"] = (
                df["net_income"].sum() / df["equity"].mean()
            ) * 100
        
        return indicators
```

### 12.4.2 工具封装

```python
# src/tools.py

class FinancialDataTool:
    """
    财务数据查询工具
    """
    
    def __init__(self, db_client: DatabaseClient):
        self.db = db_client
    
    async def execute(
        self,
        sql: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        max_rows: int = 10000
    ) -> List[Dict]:
        """
        执行财务数据查询
        """
        # 参数化查询，防止 SQL 注入
        params = []
        if start_date:
            sql = sql.replace("{start_date}", "%s")
            params.append(start_date)
        if end_date:
            sql = sql.replace("{end_date}", "%s")
            params.append(end_date)
        
        # 添加行数限制
        sql = f"{sql} LIMIT {max_rows}"
        
        result = await self.db.query(sql, *params)
        
        return [dict(row) for row in result]


class ReportGeneratorTool:
    """
    报告生成工具
    """
    
    def __init__(self, template_engine: TemplateEngine):
        self.template = template_engine
    
    async def execute(
        self,
        data: Dict[str, Any],
        format: str = "markdown",
        template_name: str = "financial_report"
    ) -> str:
        """
        生成报告
        """
        if format == "markdown":
            return self._generate_markdown(data, template_name)
        elif format == "html":
            return self._generate_html(data, template_name)
        elif format == "pdf":
            return await self._generate_pdf(data, template_name)
        else:
            raise ValueError(f"Unsupported format: {format}")
    
    def _generate_markdown(self, data: Dict, template: str) -> str:
        """生成 Markdown 报告"""
        template_str = self.template.get(template)
        
        rendered = template_str.render(
            title=data.get("title", "Financial Report"),
            date=data.get("date", ""),
            summary=data.get("summary", {}),
            details=data.get("details", []),
            metrics=data.get("metrics", {}),
            charts=data.get("charts", [])
        )
        
        return rendered
```

## 12.5 Skill 注册与加载

### 12.5.1 本地加载

```python
# skill.py

from pathlib import Path
import yaml

class SkillLoader:
    """
    Skill 加载器
    """
    
    def __init__(self, skills_dir: Path):
        self.skills_dir = skills_dir
        self.registry: Dict[str, Skill] = {}
    
    async def load_all(self):
        """加载所有 Skill"""
        custom_dir = self.skills_dir / "custom"
        
        for skill_path in custom_dir.iterdir():
            if skill_path.is_dir():
                await self.load_skill(skill_path)
    
    async def load_skill(self, skill_path: Path):
        """加载单个 Skill"""
        # 1. 读取 SKILL.md
        skill_md = (skill_path / "SKILL.md").read_text()
        
        # 2. 解析 frontmatter
        metadata = self._parse_frontmatter(skill_md)
        
        # 3. 检查 skill.yaml（可选）
        skill_yaml_path = skill_path / "skill.yaml"
        if skill_yaml_path.exists():
            with open(skill_yaml_path) as f:
                yaml_config = yaml.safe_load(f)
            metadata.update(yaml_config)
        
        # 4. 导入执行器
        executor = self._import_executor(skill_path)
        
        # 5. 创建 Skill 对象
        skill = Skill(
            name=metadata["name"],
            version=metadata.get("version", "1.0.0"),
            description=metadata.get("description", ""),
            executor=executor,
            metadata=metadata
        )
        
        # 6. 注册
        self.registry[skill.name] = skill
        
        return skill
    
    def _import_executor(self, skill_path: Path):
        """导入执行器模块"""
        import importlib.util
        
        executor_path = skill_path / "src" / "executor.py"
        if not executor_path.exists():
            return None
        
        spec = importlib.util.spec_from_file_location(
            "executor", executor_path
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        
        return module.SkillExecutor
    
    def get(self, name: str) -> Optional[Skill]:
        """获取 Skill"""
        return self.registry.get(name)
    
    def list_all(self) -> List[Skill]:
        """列出所有 Skill"""
        return list(self.registry.values())
```

## 12.6 Skill 打包

### 12.6.1 打包命令

```bash
# 打包单个 Skill
cd skills/custom/my-custom-skill
zip -r ../my-custom-skill.zip . -x "*.pyc" -x "__pycache__/*" -x "tests/*"

# 或者使用打包脚本
python scripts/package_skill.py my-custom-skill
```

### 12.6.2 .skill 文件格式

`.skill` 文件本质上是一个 ZIP 包：

```
my-custom-skill.skill
├── SKILL.md           # Skill 定义
├── skill.yaml         # 元数据
├── src/
│   ├── __init__.py
│   └── executor.py
└── prompts/
    └── system.md
```

### 12.6.3 发布到 ClawHub

```bash
# 1. 登录
clawhub login

# 2. 发布
clawhub publish ./my-custom-skill \
  --slug my-custom-skill \
  --name "My Custom Skill" \
  --version 1.0.0 \
  --changelog "Initial release"

# 3. 更新
clawhub update my-custom-skill --version 1.1.0
```

## 12.7 Skill 调试

### 12.7.1 本地测试

```python
# tests/test_executor.py

import pytest
from src.executor import FinanceSkillExecutor, ExecutionContext

@pytest.fixture
def executor():
    return FinanceSkillExecutor(config={
        "max_rows": 1000,
        "metrics": ["gross_margin", "net_margin"]
    })

@pytest.fixture
def mock_context():
    return ExecutionContext(
        skill_name="test-skill",
        skill_version="1.0.0",
        config={},
        tools={},
        user_id="test-user",
        tenant_id="test-tenant",
        project_id=None,
        session_id="test-session"
    )

@pytest.mark.asyncio
async def test_report_generation(executor, mock_context):
    result = await executor.execute(
        context=mock_context,
        task="生成月度财务报告",
        params={
            "start_date": "2024-01-01",
            "end_date": "2024-01-31",
            "department": "sales"
        }
    )
    
    assert result.status == ExecutionStatus.SUCCESS
    assert len(result.output) > 0
    assert "report" in result.metadata["task_type"]
```

### 12.7.2 DeerFlow 集成测试

```bash
# 1. 安装 Skill 到本地
cp -r my-custom-skill skills/custom/

# 2. 启动 DeerFlow
make dev

# 3. 通过 API 测试
curl -X POST http://localhost:8001/api/skills/install \
  -H "Content-Type: application/json" \
  -d '{"source": "/path/to/my-custom-skill"}'

# 4. 调用 Skill
curl -X POST http://localhost:2024/runs \
  -H "Content-Type: application/json" \
  -d '{
    "skill": "my-custom-skill",
    "input": {
      "task": "生成报告",
      "params": {}
    }
  }'
```

## 12.8 SwarmMind 企业 Skill 示例

### 12.8.1 合规审查 Skill

```yaml
# skills/custom/enterprise-compliance-review/skill.yaml

name: enterprise/compliance-review
version: 1.0.0
description: 企业合规审查 Skill
author: SwarmMind

prompts:
  system: |
    你是一名企业合规审查专家，负责：
    - 检查业务流程是否符合公司政策
    - 识别潜在合规风险
    - 提出整改建议
    - 生成合规审查报告

  user_guidance: |
    合规审查 Skill 使用流程：
    1. 明确审查范围和标准
    2. 收集相关政策和流程文档
    3. 进行合规检查
    4. 生成审查报告

tools:
  - name: read_policy
    description: 读取公司政策
    config:
      categories: ["hr", "finance", "legal", "security"]

  - name: check_compliance
    description: 执行合规检查
    config:
      check_items:
        - privacy
        - security
        - financial
        - operational

  - name: generate_review_report
    description: 生成审查报告
    config:
      format: markdown
      include_recommendations: true

constraints:
  sensitive_data_handling: strict_audit
  requires_approval: threshold_based
```

### 12.8.2 代码审查 Skill

```yaml
# skills/custom/enterprise-code-review/skill.yaml

name: enterprise/code-review
version: 1.0.0
description: 企业代码审查 Skill
author: SwarmMind

prompts:
  system: |
    你是一名企业代码审查专家，负责：
    - 检查代码质量和规范
    - 识别安全漏洞
    - 评估性能问题
    - 提出改进建议

  user_guidance: |
    代码审查 Skill 使用流程：
    1. 接收代码审查请求
    2. 获取代码变更
    3. 执行多维度审查
    4. 生成审查报告

tools:
  - name: fetch_code_changes
    description: 获取代码变更
    config:
      vcs: git
      supported_providers: ["github", "gitlab"]

  - name: run_static_analysis
    description: 运行静态分析
    config:
      tools: ["eslint", "ruff", "bandit"]

  - name: check_security
    description: 安全检查
    config:
      checks:
        - sql_injection
        - xss
        - secrets
        - dependencies

  - name: generate_review_summary
    description: 生成审查摘要
    config:
      format: markdown
      severity_levels: ["critical", "major", "minor", "info"]

dependencies:
  python_packages:
    - ruff>=0.1.0
    - bandit>=1.7.0

constraints:
  max_file_size: 1MB
  scan_timeout: 300
```

## 12.9 小结

| 环节 | 说明 |
|------|------|
| **设计** | 明确 Skill 能力、工具、约束 |
| **实现** | Python Executor + 工具封装 |
| **调试** | 本地测试 + DeerFlow 集成测试 |
| **打包** | .skill 文件格式（ZIP） |
| **发布** | ClawHub 分享 |
| **企业定制** | 继承基础框架，扩展企业能力 |

Skill 是 DeerFlow 能力扩展的核心方式，SwarmMind 通过企业级 Skill 可以快速构建差异化竞争力。
