# 第十二章 · 自定义 Skill 开发


> **本章目标**：
> 1. 掌握自定义 Skill 的开发流程与结构规范
> 2. 理解 Skill 的 Prompt 工程、工具集成与测试方法
> 3. 了解 PPT、播客、图片、视频、看板等多模态 Skill 的实战案例

> **本章目标**：
> 1. 掌握 Skill 的文件结构与 YAML 格式规范
> 2. 理解 Skill 注册、加载、打包与发布流程
> 3. 了解多模态输出 Skill 的开发模式与企业级示例

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

> **💡 最佳实践**：SKILL.md 中的 `disallowed_tools` 列表应定期审视。随着 Skill 迭代，原本安全的工具可能变得危险（如新增了敏感数据访问路径）。

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
name: web-researcher
description: 自动搜索、抓取、分析网页内容，生成结构化研究报告
version: 1.0.0
author: DeerFlow Community
tags: ["research", "web", "analysis"]
compatibility: ">=2.0.0"
---

# Web Researcher Skill

## Overview

Web Researcher 是一个智能研究 Skill，能够根据用户查询自动执行多轮搜索、网页抓取和内容分析，最终生成带引用来源的结构化研究报告。

基于 DeerFlow 的 Progressive Skill Loading 机制，按需加载，不占用启动资源。

## Capabilities

- **智能搜索**：根据查询自动选择最优搜索引擎（Google/Bing/arxiv）
- **网页抓取**：绕过常见反爬机制，提取正文内容
- **内容分析**：使用 LLM 总结、分类、提取关键信息
- **报告生成**：输出 Markdown 格式的结构化研究报告
- **引用追踪**：自动记录信息来源，生成参考文献列表

## Usage

1. 在对话中引用 Skill：`@web-researcher 请研究 "DeerFlow 2.0 新特性"`
2. 提供研究范围和深度要求
3. 等待 Skill 自动完成搜索、抓取、分析
4. 查看生成的研究报告和引用来源

## Examples

**例 1：技术研究**
```
@web-researcher 请研究 "LangGraph 的 checkpoint 机制"，深度：技术细节级别，输出格式：Markdown 报告
```

**例 2：竞品分析**
```
@web-researcher 请对比分析 "AutoGen vs CrewAI vs DeerFlow"，关注：架构设计、社区活跃度、企业应用案例
```

**例 3：市场调查**
```
@web-researcher 请调查 "2026 年 AI Agent 框架市场格局"，来源限制：官方文档、技术博客、GitHub 仓库
```
```

## 12.3 Skill YAML 格式

### 12.3.1 完整格式

```yaml
# skill.yaml
name: enterprise-finance-analyst
version: 1.0.0
description: 企业财务分析 Skill，支持报表生成、指标计算、趋势分析

author: Enterprise Team
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

> **⚠️ 注意**：Skill 代码中避免使用 `eval()` 或 `exec()` 处理用户输入，即使输入经过 LLM 过滤。这是 Skill 安全扫描的重点检查项，一经发现会直接拒绝加载。

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
```python

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
```python

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

## 12.8 企业级 Skill 示例

> **🏢 企业级建议**：企业级 Skill 应实现完善的 `test()` 方法，覆盖正常路径、边界条件和错误路径。建议将 Skill 测试纳入 CI/CD 的必过项。

### 12.8.1 合规审查 Skill

```yaml
# skills/custom/enterprise-compliance-review/skill.yaml

name: enterprise/compliance-review
version: 1.0.0
description: 企业合规审查 Skill
author: Enterprise Team

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
author: Enterprise Team

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

## 12.9 多模态输出 Skill 开发

DeerFlow 2.0 引入了**多模态输出**能力，允许 Skill 生成 PPT、播客、图片、视频、看板等内容。本节讲解如何开发支持多模态输出的 Skill。

### 12.9.1 多模态输出概述

```
┌─────────────────────────────────────────────────────────────────┐
│                  Multimodal Output Skill Types                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │   PPT    │  │  播客    │  │   图片   │  │   视频   │        │
│  │ 生成     │  │ 生成     │  │  生成    │  │  生成    │        │
│  ├──────────┤  ├──────────┤  ├──────────┤  ├──────────┤        │
│  │python-pptx│  │TTS引擎   │  │DALL-E   │  │MoviePy  │        │
│  │markdown   │  │Coqui TTS │  │Stable   │  │FFmpeg   │        │
│  │→ slides   │  │→ MP3    │  │Diffusion│  │→ MP4    │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                  │
│  ┌──────────┐  ┌──────────┐                                     │
│  │  看板    │  │ 数据报告 │                                     │
│  │ 生成     │  │ 可视化   │                                     │
│  ├──────────┤  ├──────────┤                                     │
│  │React     │  │Plotly   │                                     │
│  │Mermaid   │  │Matplotlib│                                    │
│  │→ HTML   │  │→ SVG/PNG │                                     │
│  └──────────┘  └──────────┘                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 12.9.2 PPT 生成 Skill

```yaml
# skills/custom/ppt-generator/skill.yaml

name: multimodal/ppt-generator
version: 1.0.0
description: 根据内容自动生成 PPT 演示文稿
author: DeerFlow Team

prompts:
  system: |
    你是一名专业的 PPT 设计专家，擅长：
    - 根据内容大纲设计幻灯片结构
    - 选择合适的配色方案和版式
    - 生成简洁有力的标题和要点
    - 使用 python-pptx 库创建高质量 PPT

  user_guidance: |
    使用 PPT 生成 Skill：
    1. 提供主题和大纲（Markdown 格式）
    2. 指定页数范围（默认 5-15 页）
    3. 选择风格（business/academic/creative）
    4. 生成 .pptx 文件到 outputs 目录

tools:
  - name: generate_ppt
    description: 生成 PowerPoint 文件
    config:
      engine: python-pptx
      templates_dir: ./templates
      default_style: business
      max_slides: 20

  - name: extract_content_structure
    description: 从 Markdown/文本提取内容结构
    config:
      heading_levels: [1, 2, 3]
      max_bullet_points: 5

dependencies:
  python_packages:
    - python-pptx>=0.6.21
    - Pillow>=9.0.0
```

**核心实现（精简版）：**

```python
# src/ppt_generator.py
from pptx import Presentation
from pptx.util import Pt

class PPTGenerator:
    def __init__(self, style: str = "business"):
        self.prs = Presentation()
        self.style = self._load_style(style)

    def generate(self, content: dict, max_slides: int = 15) -> str:
        # 1. 创建标题页
        self._add_title_slide(content["title"], content.get("subtitle", ""))
        # 2. 创建内容页
        for section in content["sections"][:max_slides - 1]:
            self._add_content_slide(section)
        # 3. 保存
        output_path = f"outputs/{content['filename']}.pptx"
        self.prs.save(output_path)
        return output_path
```

> 完整代码（含字体、配色、版式细节）见 [附录 C.1](./appendix-c-code-samples.md#c1-ppt-生成-skill-完整代码)。

### 12.9.3 播客生成 Skill

```yaml
# skills/custom/podcast-generator/skill.yaml

name: multimodal/podcast-generator
version: 1.0.0
description: 将文本内容转换为播客音频（MP3）
author: DeerFlow Team

prompts:
  system: |
    你是一名播客制作人，擅长：
    - 将技术文章转化为对话式播客脚本
    - 设计开场白、主体内容、结尾的结构
    - 控制节奏和语气，保持听众注意力
    - 使用 TTS 引擎生成自然语音

  user_guidance: |
    使用播客生成 Skill：
    1. 提供原始文本或文章链接
    2. 指定播客时长（5/15/30 分钟）
    3. 选择风格（单口/对话/访谈）
    4. 生成 MP3 文件到 outputs 目录

tools:
  - name: generate_podcast_script
    description: 生成播客脚本
    config:
      max_words: 5000
      style: conversational
      segments: [intro, main, outro]

  - name: text_to_speech
    description: 文本转语音
    config:
      engine: coqui_tts
      voice: default
      speed: 1.0
      format: mp3
      bitrate: 128k

dependencies:
  python_packages:
    - TTS>=0.21.0
    - pydub>=0.25.0
```

**核心实现（精简版）：**

```python
# src/podcast_generator.py
from TTS.api import TTS
from pydub import AudioSegment

class PodcastGenerator:
    def __init__(self, voice_model: str = "tts_models/en/vctk/vits"):
        self.tts = TTS(model_name=voice_model)

    async def generate(self, content: str, style: str = "single", duration_minutes: int = 15) -> str:
        # 1. 生成播客脚本
        script = self._generate_script(content, style, duration_minutes)
        # 2. 分段 TTS
        segments = [await self._synthesize_segment(s) for s in script["segments"]]
        # 3. 合并音频
        final_audio = self._merge_segments(segments)
        # 4. 保存
        output_path = f"outputs/podcast_{script['title']}.mp3"
        final_audio.export(output_path, format="mp3", bitrate="128k")
        return output_path
```

> 完整代码（含语音合成、音频合并细节）见 [附录 C.2](./appendix-c-code-samples.md#c2-播客生成-skill-完整代码)。

### 12.9.4 图片生成 Skill

```yaml
# skills/custom/image-generator/skill.yaml

name: multimodal/image-generator
version: 1.0.0
description: 根据描述生成图片（支持多种模型）
author: DeerFlow Team

prompts:
  system: |
    你是一名 AI 图像生成专家，擅长：
    - 优化提示词（Prompt Engineering）
    - 选择合适的生成模型和参数
    - 控制风格、构图、色彩
    - 生成高质量图片用于演示和文档

  user_guidance: |
    使用图片生成 Skill：
    1. 提供详细的图片描述
    2. 指定风格（写实/插画/3D/像素）
    3. 选择分辨率（512/1024/2048）
    4. 生成 PNG/JPG 到 outputs 目录

tools:
  - name: generate_image
    description: 生成图片
    config:
      supported_models:
        - dalle-3
        - stable-diffusion-xl
        - midjourney-api
      default_resolution: 1024x1024
      max_batch_size: 4

dependencies:
  python_packages:
    - openai>=1.0.0
    - Pillow>=9.0.0
```

**核心实现（精简版）：**

```python
# src/image_generator.py
from openai import AsyncOpenAI

class ImageGenerator:
    def __init__(self, api_key: str, default_model: str = "dall-e-3"):
        self.client = AsyncOpenAI(api_key=api_key)
        self.default_model = default_model

    async def generate(self, prompt: str, style: str = "vivid", size: str = "1024x1024", n: int = 1) -> list[str]:
        # 1. 优化提示词
        optimized_prompt = self._enhance_prompt(prompt, style)
        # 2. 调用 API
        response = await self.client.images.generate(
            model=self.default_model, prompt=optimized_prompt, size=size, n=n
        )
        # 3. 下载并保存
        paths = []
        for i, img_data in enumerate(response.data):
            image_bytes = await self._download(img_data.url)
            output_path = f"outputs/generated_image_{i}.png"
            with open(output_path, "wb") as f:
                f.write(image_bytes)
            paths.append(output_path)
        return paths
```

> 完整代码（含提示词增强、多模型适配）见 [附录 C.3](./appendix-c-code-samples.md#c3-图片生成-skill-完整代码)。

### 12.9.5 视频生成 Skill

```yaml
# skills/custom/video-generator/skill.yaml

name: multimodal/video-generator
version: 1.0.0
description: 将图片、文本合成为短视频
author: DeerFlow Team

prompts:
  system: |
    你是一名视频制作人，擅长：
    - 将静态内容转化为动态视频
    - 设计分镜和转场效果
    - 添加字幕、配乐、配音
    - 使用 MoviePy 和 FFmpeg 合成视频

  user_guidance: |
    使用视频生成 Skill：
    1. 提供素材（图片/文本/音频）
    2. 指定时长和分辨率
    3. 选择模板（解说/演示/宣传）
    4. 生成 MP4 到 outputs 目录

tools:
  - name: compose_video
    description: 合成视频
    config:
      engine: moviepy
      default_resolution: 1920x1080
      default_fps: 30
      max_duration: 300  # 5分钟

dependencies:
  python_packages:
    - moviepy>=1.0.3
    - Pillow>=9.0.0
    - numpy>=1.21.0
```

**核心实现（精简版）：**

```python
# src/video_generator.py
from moviepy.editor import ImageClip, TextClip, concatenate_videoclips
from moviepy.video.fx.all import fadein, fadeout

class VideoGenerator:
    def __init__(self, resolution: tuple = (1920, 1080), fps: int = 30):
        self.resolution = resolution
        self.fps = fps

    async def generate(self, scenes: list[dict], audio_path: str = None) -> str:
        clips = []
        for scene in scenes:
            clip = ImageClip(scene.get("image_path", "templates/blank_bg.png"))
            clip = clip.set_duration(scene["duration"])
            clip = fadein(clip, 0.5)
            clip = fadeout(clip, 0.5)
            clips.append(clip)
        # 合并场景
        final_video = concatenate_videoclips(clips, method="compose")
        # 添加音频
        if audio_path:
            from moviepy.editor import AudioFileClip
            audio = AudioFileClip(audio_path).subclip(0, final_video.duration)
            final_video = final_video.set_audio(audio)
        # 保存
        output_path = "outputs/generated_video.mp4"
        final_video.write_videofile(output_path, fps=self.fps, codec="libx264", audio_codec="aac")
        return output_path
```

> 完整代码（含文字场景、字幕样式）见 [附录 C.4](./appendix-c-code-samples.md#c4-视频生成-skill-完整代码)。

### 12.9.6 看板生成 Skill

```yaml
# skills/custom/kanban-generator/skill.yaml

name: multimodal/kanban-generator
version: 1.0.0
description: 将任务列表转化为可视化看板（HTML/React）
author: DeerFlow Team

prompts:
  system: |
    你是一名项目管理专家，擅长：
    - 将任务数据转化为看板视图
    - 设计敏捷开发的工作流（To Do / In Progress / Done）
    - 生成交互式 HTML 看板或静态图片
    - 使用 React + DnD 实现可拖拽看板

  user_guidance: |
    使用看板生成 Skill：
    1. 提供任务列表（JSON/CSV/Markdown）
    2. 指定看板列（默认：Backlog/To Do/In Progress/Done）
    3. 选择输出格式（HTML/PNG/PDF）
    4. 生成看板文件到 outputs 目录

tools:
  - name: generate_kanban_html
    description: 生成 HTML 看板
    config:
      framework: react
      theme: default
      drag_and_drop: true

  - name: generate_kanban_image
    description: 生成看板图片
    config:
      engine: html_to_image
      resolution: 1920x1080

dependencies:
  python_packages:
    - jinja2>=3.0.0
    - html2image>=2.0.0
```

**核心实现（精简版）：**

```python
# src/kanban_generator.py
from jinja2 import Template

class KanbanGenerator:
    def __init__(self, template_dir: str = "templates"):
        self.template_dir = template_dir

    def generate_html(self, tasks: list[dict], columns: list[str] = None) -> str:
        if columns is None:
            columns = ["Backlog", "To Do", "In Progress", "Done"]
        # 按状态分组
        grouped = {col: [] for col in columns}
        for task in tasks:
            status = task.get("status", "Backlog")
            if status in grouped:
                grouped[status].append(task)
        # 渲染模板
        template = Template(self._load_template("kanban.html"))
        html = template.render(columns=columns, tasks=grouped, title="Project Kanban")
        # 保存
        output_path = "outputs/kanban.html"
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(html)
        return output_path

    def generate_image(self, html_path: str) -> str:
        from html2image import Html2Image
        hti = Html2Image(size=(1920, 1080))
        output_path = "outputs/kanban.png"
        hti.screenshot(html_file=html_path, save_as=output_path)
        return output_path
```

> 完整代码见 [附录 C.5](./appendix-c-code-samples.md#c5-看板生成-skill-完整代码)。

### 12.9.7 多模态 Skill 通用模式

所有多模态输出 Skill 共享以下设计模式：

```python
# src/base_multimodal.py
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

@dataclass
class MultimodalOutput:
    """多模态输出统一格式"""
    
    type: str           # "ppt" | "podcast" | "image" | "video" | "kanban"
    file_path: str      # 输出文件路径
    format: str         # "pptx" | "mp3" | "png" | "mp4" | "html"
    size_bytes: int
    metadata: dict      # 生成参数、模型信息、版权信息
    preview_url: str    # 预览链接（可选）

class BaseMultimodalSkill(ABC):
    """多模态 Skill 基类"""
    
    @abstractmethod
    async def generate(self, input_data: Any) -> MultimodalOutput:
        """生成多模态内容"""
        pass
    
    @abstractmethod
    def validate_input(self, input_data: Any) -> bool:
        """验证输入数据"""
        pass
    
    def save_to_artifacts(self, output: MultimodalOutput) -> str:
        """保存到 Thread 的 artifacts"""
        # 注册到 state.artifacts
        # 返回下载链接
        return f"/api/threads/{self.thread_id}/artifacts/{output.file_path}"
```

## 12.10 小结

| 环节 | 说明 |
|------|------|
| **设计** | 明确 Skill 能力、工具、约束 |
| **实现** | Python Executor + 工具封装 |
| **调试** | 本地测试 + DeerFlow 集成测试 |
| **打包** | .skill 文件格式（ZIP） |
| **发布** | ClawHub 分享 |
| **企业定制** | 继承基础框架，扩展企业能力 |

Skill 是 DeerFlow 能力扩展的核心方式，通过企业级 Skill 可以快速构建差异化竞争力。


## 本章小结

本章通过实战案例讲解了自定义 Skill 的开发流程：

1. **开发规范**：Skill 需包含 skill.yaml（元数据）、prompt.md（指令）、tools/（工具实现）、tests/（单元测试）。
2. **Prompt 工程**：系统 Prompt 应明确角色、输入格式、输出规范、错误处理，避免模糊指令导致模型行为不可控。
3. **多模态 Skill**：PPT、播客、图片、视频、看板等 Skill 展示了 DeerFlow 在多模态内容生成领域的扩展能力。
4. **测试与发布**：单元测试覆盖正常路径与边界条件，集成测试验证与 Agent 编排的兼容性。

> **🏢 企业级建议**：自定义 Skill 应遵循 Semantic Versioning，重大变更（如 Prompt 重写）需升级主版本号并通知下游用户。

---

**下一步**：阅读第十三章，掌握 Human-in-the-Loop 的设计模式与审批机制。

