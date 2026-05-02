# 第一章 · 引言：什么是 DeerFlow


> **本章目标**：
> 1. 理解 DeerFlow 的设计哲学与核心定位（Agent 2.0 时代的中间件）
> 2. 掌握 DeerFlow 的四大核心概念（Skill、Sub-Agent、Sandbox、Memory）
> 3. 了解本书的阅读路径与实战导向的学习方法

> **本章目标**：
> 1. 理解 DeerFlow 的核心定位与架构组成
> 2. 掌握 Agent Harness 的设计哲学与扩展机制
> 3. 了解 DeerFlow 与其他 Agent 框架的差异

## 1.1 DeerFlow 是什么

> **💡 最佳实践**：DeerFlow 的「Harness」定位意味着它更适合作为基础设施层使用，而非直接面向终端用户的应用层。在选型时，如果你的团队需要深度定制 Agent 行为，DeerFlow 比封装更紧密的框架更合适。

DeerFlow（**D**eep **E**xploration and **E**fficient **R**esearch **Flow**）是字节跳动开源的 **Super Agent Harness**。

一个「Agent Harness」的本质是：提供一个可扩展的框架，把大模型能力（LLM）、外部工具（Tools）、记忆（Memory）、子代理（Sub-Agents）和执行环境（Sandbox）组织起来，让 AI Agent 能够完成复杂的长时任务。

DeerFlow 2.0 于 2026 年 2 月 28 日发布后登上 GitHub Trending 第一名，是一次彻底的重写——与 v1 版本零代码共用。

**官方定位：**
```
DeerFlow = Sub-Agents + Memory + Sandbox + Extensible Skills + Message Gateway
```

## 1.2 核心特性一览

| 特性 | 说明 |
|------|------|
| **Sub-Agents** | 支持多子代理协同工作 |
| **Progressive Skill Loading** | 技能按需加载，不一次性全部注入上下文 |
| **Skills & Tools** | 可扩展的能力单元 |
| **Sandbox** | Docker/K8s 隔离执行环境 |
| **Memory** | 长期记忆系统 |
| **Context Engineering** | 上下文管理与优化 |
| **IM Channels** | Feishu / Slack / Telegram 渠道接入 |
| **InfoQuest** | BytePlus 自研智能搜索与爬取工具集 |
| **多模态输出** | Markdown / HTML / PPT / 播客 / 图片 / 视频 |
| **LangSmith** | 完整链路追踪 |
| **MCP Server** | Model Context Protocol 支持，含 OAuth 认证 |

## 1.3 技术栈

```
前端:     React + TypeScript
后端:     Python 3.12+ (FastAPI / LangGraph)
Agent:    LangChain + LangGraph
沙箱:     Docker / Kubernetes
消息:     WebSocket / SSE
部署:     Docker Compose / K8s
```

## 1.4 为什么选择 DeerFlow 做二次开发

### 1.4.1 适合的场景

- **企业级 AI 应用开发**：需要可控的 Agent 执行环境
- **长时任务自动化**：Research、Code、Creation 一体化
- **多 Agent 协同**：复杂工作流需要子代理分工
- **安全沙箱需求**：代码执行必须在隔离环境
- **IM 渠道集成**：需要接入飞书/Slack/Telegram

### 1.4.2 二次开发的价值

DeerFlow 的设计哲学是「Harness」——它提供了完整的执行骨架，开发者可以在以下层面定制：

1. **Skill 层**：添加自定义工具和能力
2. **Agent 层**：定制 Prompt、工作流编排逻辑
3. **Memory 层**：接企业知识库、实现个性化记忆
4. **Sandbox 层**：适配企业私有化部署环境
5. **Channel 层**：对接企业内部 IM 系统

## 1.5 本书结构

本书分为三部分：

**第一部分：理论基础**
- 核心概念、设计哲学、架构思想

**第二部分：源码剖析**
- 按模块逐行解析 DeerFlow 2.0 核心代码
- LangGraph Agent 编排
- Skills/Tools 扩展机制
- Sandbox 执行模型
- Memory 系统

**第三部分：二次开发实战**
- MCP Server 集成
- 自定义 Skill 开发
- IM 渠道对接
- 企业级定制案例

## 1.6 环境准备

### 必要依赖

```bash
# Node.js 22+
node --version  # >= 22.0.0

# Python 3.12+
python --version  # >= 3.12

# Docker (for sandbox)
docker --version

# pnpm
npm install -g pnpm

# uv (Python 包管理)
curl -LsSf https://astral.sh/uv/install.sh | sh
```bash

### 快速启动

```bash
# Clone
git clone https://github.com/bytedance/deer-flow.git
cd deer-flow

# 生成本地配置
make config

# 配置模型 (编辑 config.yaml)
# 编辑 .env 设置 API Keys

# Docker 启动
make docker-init
make docker-start

# 访问 http://localhost:2026
```

## 1.7 小结

> **⚠️ 注意**：DeerFlow 目前处于快速迭代期，API 和配置格式可能在版本间有变动。生产环境部署前，建议锁定具体版本号并阅读 Release Notes。

DeerFlow 是一个设计精良的 Super Agent 框架，2.0 版本在架构上做了彻底重构，核心亮点在于：

1. **LangGraph 原生集成**：用图结构表达 Agent 工作流
2. **可扩展 Skills 体系**：解耦能力单元，灵活插拔
3. **多层 Sandbox**：本地→Docker→K8s 按需切换
4. **完整的企业特性**：IM 渠道、链路追踪、MCP 支持

接下来的章节，我们将深入每个模块，从理论到源码，逐一剖析。


## 本章小结

本章介绍了 DeerFlow 的定位、设计哲学与核心概念：

1. **Agent 2.0 中间件**：DeerFlow 不是又一个对话框架，而是面向生产环境的 AI Agent 中间件，解决「能力复用、安全隔离、记忆持久化」三大痛点。
2. **四大核心概念**：Skill（能力单元）、Sub-Agent（协作单元）、Sandbox（执行环境）、Memory（记忆系统）通过 LangGraph 编排协同工作。
3. **解耦设计**：Prompt、工具、执行逻辑分层解耦，确保可测试、可扩展、可维护。

> **💡 最佳实践**：在深入代码之前，先画出你的 Agent 协作图——明确哪些任务需要 Sub-Agent、哪些需要 Sandbox、记忆如何流转。

---

**下一步**：阅读第二章，深入理解 DeerFlow 的设计哲学与核心概念的实现细节。

