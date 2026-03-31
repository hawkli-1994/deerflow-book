# 附录 B · 贡献指南

## B.1 DeerFlow 项目结构

```
deer-flow/
├── backend/
│   ├── packages/
│   │   └── harness/
│   │       └── deerflow/
│   │           ├── agents/          # Agent 系统
│   │           ├── sandbox/         # Sandbox 系统
│   │           ├── tools/          # 工具系统
│   │           ├── models/         # 模型工厂
│   │           ├── mcp/            # MCP 集成
│   │           ├── skills/         # Skills 系统
│   │           └── community/      # 社区工具
│   ├── app/
│   │   ├── gateway/                # FastAPI 网关
│   │   └── channels/              # IM 渠道集成
│   └── tests/                     # 测试
│
├── frontend/                     # Next.js 前端
│
├── skills/
│   ├── public/                   # 公共 Skills
│   └── custom/                   # 自定义 Skills
│
├── docs/                         # 文档
│
├── Makefile                      # 根构建脚本
├── config.example.yaml           # 配置模板
└── extensions_config.example.json # 扩展配置模板
```

## B.2 开发环境设置

### B.2.1 快速开始

```bash
# 1. Clone 仓库
git clone https://github.com/bytedance/deer-flow.git
cd deer-flow

# 2. 生成配置
make config

# 3. 配置 API Keys
# 编辑 .env 文件或 config.yaml

# 4. Docker 开发（推荐）
make docker-init
make docker-start

# 5. 本地开发（可选）
make check        # 检查依赖
make install      # 安装依赖
make dev          # 启动开发服务
```

### B.2.2 本地开发依赖

```bash
# Node.js 22+
node --version  # >= 22.0.0

# Python 3.12+
python --version  # >= 3.12

# pnpm
npm install -g pnpm

# uv (Python 包管理)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Docker (用于沙箱)
docker --version

# nginx
nginx -v
```

## B.3 代码规范

### B.3.1 Python (Backend)

```bash
# 格式化
cd backend
make format  # ruff check --fix && ruff format

# 类型检查
ruff check .
mypy .

# 测试
uv run pytest
```

**代码风格：**
- 使用 `ruff` 自动格式化
- 遵循 PEP 8
- 类型注解使用 `typing` 模块
- 异步函数使用 `async def`

**示例：**
```python
from typing import Dict, List, Optional
from dataclasses import dataclass

@dataclass
class MyClass:
    """类的文档字符串"""
    
    name: str
    value: int
    
    async def my_method(self, data: Dict) -> Optional[str]:
        """
        方法的文档字符串
        
        Args:
            data: 输入数据
            
        Returns:
            处理结果或 None
        """
        pass
```

### B.3.2 TypeScript (Frontend)

```bash
# 格式化
cd frontend
pnpm format:write

# 类型检查
pnpm check
```

**代码风格：**
- 使用 Prettier 格式化
- 遵循 ESLint 规则
- 显式类型注解

### B.3.3 提交规范

```bash
# 提交格式
<type>(<scope>): <subject>

# 类型
# feat: 新功能
# fix: 修复
# docs: 文档
# style: 格式（不影响代码）
# refactor: 重构
# test: 测试
# chore: 构建/工具

# 示例
feat(agent): 添加新的中间件支持
fix(sandbox): 修复 Docker 容器清理问题
docs(mcp): 更新 MCP Server 文档
```

## B.4 测试指南

### B.4.1 单元测试

```bash
# 运行所有测试
cd backend
uv run pytest

# 运行特定测试
uv run pytest tests/test_agent.py

# 带覆盖率
uv run pytest --cov=. --cov-report=html
```

### B.4.2 集成测试

```bash
# 启动完整环境
make docker-start

# 运行集成测试
uv run pytest tests/integration/

# 测试特定功能
uv run pytest tests/integration/test_mcp.py -v
```

### B.4.3 测试示例

```python
# tests/test_agent.py

import pytest
from deerflow.agents import make_lead_agent

@pytest.fixture
def config():
    return RunnableConfig(
        configurable={
            "model_name": "gpt-4",
            "thinking_enabled": True,
        }
    )

@pytest.mark.asyncio
async def test_agent_creation(config):
    """测试 Agent 创建"""
    agent = make_lead_agent(config)
    assert agent is not None
    assert isinstance(agent, CompiledGraph)

@pytest.mark.asyncio
async def test_agent_execution(config):
    """测试 Agent 执行"""
    agent = make_lead_agent(config)
    
    result = await agent.ainvoke(
        {"messages": [HumanMessage(content="Hello")]},
        config=config
    )
    
    assert "messages" in result
    assert len(result["messages"]) > 1
```

## B.5 文档贡献

### B.5.1 文档更新政策

**关键规则：每次代码变更后必须更新文档：**

| 代码变更类型 | 必须更新的文档 |
|-------------|--------------|
| 功能变更 | `README.md`（用户面向）|
| 开发变更 | `CLAUDE.md`（开发者面向）|
| 配置变更 | `docs/CONFIGURATION.md` |
| 新增 API | API 路由文件注释 |
| 新增工具 | `docs/SKILLS.md` |

### B.5.2 文档格式

```markdown
# 文档标题

简要说明。

## 详细说明

详细描述...

### 示例

```python
# 代码示例
```

## 相关文档

- [相关文档链接](./other-doc.md)
```

## B.6 Pull Request 流程

### B.6.1 创建 PR

```bash
# 1. 创建功能分支
git checkout -b feature/my-new-feature

# 2. 开发并提交
git add .
git commit -m "feat(scope): description"

# 3. 推送
git push origin feature/my-new-feature

# 4. 在 GitHub 创建 PR
```

### B.6.2 PR 检查清单

- [ ] 代码格式化通过 (`make format`)
- [ ] 测试通过 (`uv run pytest`)
- [ ] 新功能有对应测试
- [ ] 文档已更新
- [ ] Commit message 符合规范
- [ ] 无 Console.log / Debug 代码

### B.6.3 CI/CD

每个 PR 都会自动运行：

```yaml
# .github/workflows/backend-unit-tests.yml

name: Backend Tests

on:
  pull_request:
    paths:
      - 'backend/**'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Install dependencies
        run: make install
      - name: Format check
        run: make format
      - name: Run tests
        run: uv run pytest
```

## B.7 Issue 报告

### B.7.1 Bug 报告模板

```markdown
## Bug 描述
清晰描述问题...

## 复现步骤
1. 导航到...
2. 点击...
3. 滚动到...
4. 看到错误

## 期望行为
描述期望...

## 实际行为
描述实际...

## 环境信息
- OS: [e.g. macOS 14.0]
- Python: [e.g. 3.12.0]
- DeerFlow: [e.g. 2.0.0]

## 日志
```
相关日志...
```
```

### B.7.2 功能请求模板

```markdown
## 功能描述
描述请求的功能...

## 使用场景
描述使用场景...

## 解决方案
如果有建议的解决方案...

## 替代方案
如果有替代方案...
```

## B.8 许可证

DeerFlow 使用 MIT 许可证。贡献的代码必须遵守此许可证。

```text
MIT License

Copyright (c) 2024 ByteDance

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
```

## B.9 获取帮助

- **GitHub Issues**: https://github.com/bytedance/deer-flow/issues
- **Discussions**: https://github.com/bytedance/deer-flow/discussions
- **文档**: https://docs.deerflow.tech

## B.10 SwarmMind 贡献

如果基于 DeerFlow 开发 SwarmMind，建议：

1. **保持 Fork 同步**：定期从上游 DeerFlow 合并
2. **差异化文档**：维护独立的开发文档
3. **测试覆盖**：确保企业功能有完整测试
4. **安全审计**：企业代码建议进行安全审计
5. **合规检查**：确保符合相关法规要求
