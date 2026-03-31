# 第六章 · Skills 与 Tools：能力扩展机制

## 6.1 概念区分：Skill vs Tool

DeerFlow 中 **Skill** 和 **Tool** 是两个不同层次的概念：

| 概念 | 层次 | 说明 |
|------|------|------|
| **Tool** | 原子操作 | 单一功能，如搜索、读文件、执行命令 |
| **Skill** | 复合能力 | 多个 Tool + Prompt + 逻辑的组合 |

```
┌──────────────────────────────────────────────────┐
│                    Skill                          │
│  ┌────────────────────────────────────────────┐ │
│  │  prompt: "你是一个专业的市场研究员..."       │ │
│  │                                             │ │
│  │  tools:                                      │ │
│  │    ├── web_search                          │ │
│  │    ├── data_analysis                       │ │
│  │    └── report_generator                    │ │
│  │                                             │ │
│  │  metadata:                                  │ │
│  │    name: market-researcher                  │ │
│  │    version: 1.0.0                          │ │
│  └────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

## 6.2 内置 Tools

DeerFlow 内置以下工具：

### 6.2.1 Sandbox Tools

| 工具 | 功能 | 示例 |
|------|------|------|
| `bash` | 执行 Shell 命令 | `bash(command="ls -la")` |
| `ls` | 目录列表 | `ls(path="/mnt/user-data")` |
| `read_file` | 读取文件 | `read_file(path="output.txt", start_line=1, end_line=100)` |
| `write_file` | 写入文件 | `write_file(path="result.md", content="...")` |
| `str_replace` | 编辑文件 | `str_replace(path="code.py", old="...", new="...")` |

### 6.2.2 Builtin Tools

| 工具 | 功能 |
|------|------|
| `present_files` | 展示生成的文件 |
| `ask_clarification` | 请求用户澄清问题 |
| `view_image` | 查看图片（Vision） |

### 6.2.3 Community Tools

来自社区的集成工具：

| 工具 | 来源 | 功能 |
|------|------|------|
| `tavily_search` | Tavily | 搜索 |
| `jina_reader` | Jina AI | 网页转 Markdown |
| `firecrawl_scrape` | Firecrawl | 网页抓取 |
| `image_search` | 图片搜索 | 搜索图片 |

## 6.3 Skills 系统架构

### 6.3.1 Skill 定义格式

DeerFlow Skill 使用标准格式（`.skill` 文件）：

```yaml
# skill.yaml
name: market-researcher
version: 1.0.0
description: 专业市场调研员，能够搜索、分析并生成报告

author: deer-flow
compatibility: ">=2.0.0"

prompts:
  system: |
    你是一名资深市场分析师，专长于：
    - 行业趋势分析
    - 竞品研究
    - 用户画像构建
    - 数据可视化
    
    使用提供的工具完成任务。
  
  user_guidance: |
    当用户要求进行市场调研时，按照以下步骤：
    1. 明确调研目标和范围
    2. 收集相关信息
    3. 分析数据
    4. 生成结构化报告

tools:
  - name: web_search
    config:
      max_results: 10
      include_domains: []
      
  - name: data_analysis
    config:
      chart_types: ["bar", "line", "pie"]
      
  - name: report_generator
    config:
      format: markdown
      sections: ["overview", "analysis", "recommendations"]

metadata:
  tags: ["research", "market", "analysis"]
  estimated_time: "30-60min"
```

### 6.3.2 Skill 加载流程

```
Skill Loader
     │
     ├── 1. 发现（Discovery）
     │       ↓
     │   从 skills/ 目录扫描 .skill 文件
     │   支持 public/ 和 custom/ 子目录
     │
     ├── 2. 解析（Parse）
     │       ↓
     │   解析 YAML 定义，验证 schema
     │   提取 prompts、tools、metadata
     │
     ├── 3. 验证（Validate）
     │       ↓
     │   检查 tool 依赖是否满足
     │   检查版本兼容性
     │
     ├── 4. 注册（Register）
     │       ↓
     │   存入 Skill Registry
     │   生成可调用的 Tool
     │
     └── 5. 就绪（Ready）
```

### 6.3.3 Skill Registry

```python
class SkillRegistry:
    """
    Skill 注册表 - 单例模式
    """
    
    _instance = None
    
    def __init__(self):
        self._skills: Dict[str, Skill] = {}
        self._tool_bindings: Dict[str, Tool] = {}
    
    @classmethod
    def get_instance(cls) -> "SkillRegistry":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
    
    def register(self, skill: Skill):
        """注册 Skill"""
        self._skills[skill.name] = skill
        
        # 为每个 tool 配置生成可调用的 Tool
        for tool_config in skill.tools:
            tool = self._create_tool(skill, tool_config)
            self._tool_bindings[f"{skill.name}.{tool_config.name}"] = tool
    
    def get(self, name: str) -> Optional[Skill]:
        return self._skills.get(name)
    
    def list_all(self) -> List[Skill]:
        return list(self._skills.values())
    
    def get_tools(self, skill_name: str) -> List[Tool]:
        """获取某 Skill 的所有 Tool"""
        skill = self._skills.get(skill_name)
        if not skill:
            return []
        
        prefix = f"{skill_name}."
        return [
            t for name, t in self._tool_bindings.items()
            if name.startswith(prefix)
        ]
```

## 6.4 Skill 与 Tool 的绑定

### 6.4.1 动态 Tool 创建

```python
class SkillToolFactory:
    """
    Skill Tool 工厂 - 根据 Skill 定义动态创建 Tool
    """
    
    def create(
        self,
        skill: Skill,
        tool_config: ToolConfig
    ) -> BaseTool:
        """
        根据 skill 和 tool 配置创建可执行的 Tool
        """
        tool_name = f"{skill.name}.{tool_config.name}"
        
        # 创建 Tool 类
        tool_class = self._determine_tool_type(tool_config)
        
        # 实例化 Tool
        tool = tool_class(
            name=tool_name,
            description=tool_config.description or f"Tool from skill {skill.name}",
            args_schema=tool_config.args_schema,
            config=tool_config.config,
            skill=skill,  # 持有 Skill 引用
        )
        
        return tool
```

### 6.4.2 Tool 调用流程

```
Agent 调用 Tool
       │
       ▼
SkillRegistry 查找 Tool
       │
       ▼
获取 Tool 绑定的 Skill
       │
       ▼
Skill.prepare_context(config)
       │
       ├── 注入 System Prompt
       ├── 注入工具配置
       └── 注入元数据
       │
       ▼
调用 Skill 内部逻辑
       │
       ├── 可能调用多个子 Tool
       └── 可能调用 LLM
       │
       ▼
返回结果
```

## 6.5 内置 Skills

DeerFlow 自带以下 Skills：

### 6.5.1 recursive-summarizer（递归摘要）

```yaml
name: deer-flow-skills/recursive-summarizer
description: 递归摘要工具，用于压缩长文本
version: 1.0.0

tools:
  - name: summarize
    config:
      max_tokens: 2000
      compression_ratio: 0.5
```

**用途：** 当 context 超过限制时，递归压缩对话历史

### 6.5.2 quick-searcher（快速搜索）

```yaml
name: deer-flow-skills/quick-searcher
description: 快速搜索工具
version: 1.0.0

tools:
  - name: search
    config:
      max_results: 5
      include_snippets: true
```

**用途：** 快速获取搜索结果，用于信息收集

### 6.5.3 in-depth-researcher（深度研究）

```yaml
name: deer-flow-skills/in-depth-researcher
description: 深度研究工具，支持多轮搜索和分析
version: 1.0.0

tools:
  - name: research
    config:
      max_iterations: 5
      follow_depth: 3
      synthesis: true
```

**用途：** 复杂研究任务，多角度分析

## 6.6 Skill 安装与更新

### 6.6.1 安装命令

```bash
# 通过 Gateway API 安装
POST /api/skills/install

# 请求体
{
  "source": "https://example.com/skills/market-researcher.skill",
  "name": "market-researcher"
}
```

### 6.6.2 Skill 安装流程

```python
async def install_skill(source: str, name: str) -> Skill:
    """
    安装 Skill
    """
    # 1. 下载 .skill 文件
    skill_file = await download_skill(source)
    
    # 2. 解析 Skill 定义
    skill = SkillParser.parse(skill_file)
    
    # 3. 验证依赖
    await validate_dependencies(skill)
    
    # 4. 下载依赖资源（如有）
    await download_resources(skill)
    
    # 5. 注册到本地
    registry.register(skill)
    
    # 6. 保存到本地存储
    await save_skill_to_disk(skill, name)
    
    return skill
```

### 6.6.3 Skill 更新

```python
async def update_skill(name: str, version: Optional[str] = None):
    """
    更新 Skill
    """
    skill = registry.get(name)
    if not skill:
        raise SkillNotFoundError(name)
    
    # 检查最新版本
    latest = await check_latest_version(skill, version)
    
    if latest > skill.version:
        # 下载新版本
        new_skill = await download_skill(latest.url)
        
        # 替换
        registry.unregister(name)
        registry.register(new_skill)
        
        return new_skill
    
    return skill  # 已是最新
```

## 6.7 MCP Server 集成

MCP（Model Context Protocol）是 DeerFlow 连接外部工具的标准协议。

### 6.7.1 MCP 配置

```json
// extensions_config.json
{
  "mcp_servers": [
    {
      "name": "filesystem",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      "args": ["/tmp"],
      "env": {}
    },
    {
      "name": "github",
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "args": [],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN"
      }
    }
  ]
}
```

### 6.7.2 MCP 工具调用

```python
class MCPToolAdapter:
    """
    MCP Tool 适配器
    """
    
    def __init__(self, mcp_client: MCPClient):
        self.client = mcp_client
    
    async def call_tool(
        self,
        tool_name: str,
        arguments: dict
    ) -> ToolResult:
        """
        调用 MCP 工具
        """
        # 发送工具调用请求
        response = await self.client.call_tool(
            name=tool_name,
            arguments=arguments
        )
        
        # 转换结果格式
        return ToolResult(
            content=response.content,
            is_error=response.is_error,
            metadata=response.metadata
        )
```

## 6.8 二次开发：自定义 Skill

### 6.8.1 企业定制 Skill 示例

```yaml
# enterprise-document-review.skill
name: enterprise/document-review
version: 1.0.0
description: 企业文档审查 Skill
author: SwarmMind

prompts:
  system: |
    你是一名企业合规审查专家，负责：
    - 检查文档是否符合公司政策
    - 识别敏感信息泄露风险
    - 提出修改建议
    
  user_guidance: |
    使用文档审查 Skill 时：
    1. 首先阅读完整文档
    2. 根据审查清单逐项检查
    3. 生成审查报告

tools:
  - name: read_policy
    description: 读取公司政策文档
    config:
      policy_category: ["hr", "finance", "legal", "security"]
  
  - name: check_sensitive
    description: 检测敏感信息
    config:
      patterns:
        - type: pii
          items: ["身份证", "手机号", "邮箱"]
        - type: confidential
          keywords: ["机密", "秘密", "内部"]
  
  - name: generate_report
    description: 生成审查报告
    config:
      format: markdown
      include_suggestions: true

metadata:
  tags: ["enterprise", "compliance", "document"]
  approval_required: true
```

### 6.8.2 Skill 实现代码

```python
# skills/custom/enterprise-document-review/skill.py

class DocumentReviewSkill:
    """
    文档审查 Skill 实现
    """
    
    name = "enterprise/document-review"
    version = "1.0.0"
    
    def __init__(self, config: SkillConfig):
        self.config = config
    
    async def execute(
        self,
        context: ExecutionContext,
        document_path: str
    ) -> ReviewResult:
        """
        执行文档审查
        """
        # 1. 读取文档
        content = await context.tools.read_file(document_path)
        
        # 2. 读取相关政策
        policies = await self._load_relevant_policies(context)
        
        # 3. 合规检查
        compliance_issues = await self._check_compliance(content, policies)
        
        # 4. 敏感信息检测
        sensitive_findings = await self._scan_sensitive(content)
        
        # 5. 生成报告
        report = await self._generate_report(
            document_path=document_path,
            compliance=compliance_issues,
            sensitive=sensitive_findings
        )
        
        return ReviewResult(
            passed=len(compliance_issues) == 0 and len(sensitive_findings) == 0,
            issues=compliance_issues + sensitive_findings,
            report=report
        )
    
    async def _check_compliance(
        self,
        content: str,
        policies: List[Policy]
    ) -> List[ComplianceIssue]:
        """检查合规性"""
        issues = []
        
        for policy in policies:
            if not policy.matches(content):
                issues.append(ComplianceIssue(
                    policy_id=policy.id,
                    severity=policy.severity,
                    description=f"文档不符合策略: {policy.name}"
                ))
        
        return issues
```

### 6.8.3 Skill 注册

```python
# 在 DeerFlow 初始化时注册
from deerflow.skills import SkillRegistry

async def register_enterprise_skills():
    registry = SkillRegistry.get_instance()
    
    # 加载自定义 Skill
    custom_skill = DocumentReviewSkill(config)
    registry.register(custom_skill)
    
    # 或者从文件加载
    await registry.load_from_file("enterprise-document-review.skill")
```

## 6.9 小结

| 组件 | 说明 |
|------|------|
| **Tool** | 原子操作，Sandbox/Builtin/Community 三类 |
| **Skill** | 复合能力 = Prompt + Tools + 逻辑 |
| **Registry** | 单例注册表，管理 Skill 和 Tool 绑定 |
| **MCP** | 外部工具连接的标准协议 |
| **安装** | 支持远程 .skill 文件安装 |

SwarmMind 可通过自定义 Skills 实现：
- 企业文档审查能力
- 合规检查自动化
- 财务报表分析
- 代码安全扫描
