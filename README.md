# 《DeerFlow 二次开发：理论、架构与源码剖析》

**面向硬核开发者的技术深度解析**

[![在线阅读](https://img.shields.io/badge/📖%20在线阅读-DeerFlow%20二次开发-blue?style=for-the-badge)](https://hawkli-1994.github.io/deerflow-book/)
[![GitHub](https://img.shields.io/badge/GitHub-仓库-black?style=for-the-badge&logo=github)](https://github.com/hawkli-1994/deerflow-book)

> 本书围绕 DeerFlow 2.0，从理论到源码，系统讲解如何进行二次开发。
> 
> 所有代码示例均基于真实源码，确保与 DeerFlow 实现保持一致。

---

## 🚀 开始阅读

| 📖 [在线阅读（推荐）](https://hawkli-1994.github.io/deerflow-book/) | 搜索、目录导航、代码高亮、响应式布局 |
|:---|:---|
| 📄 [GitHub 阅读](./chapters/01-introduction.md) | 适合直接浏览 Markdown 源码 |

---

## 📚 书籍特色

- **源码级解析** - 每一章都深入 DeerFlow 源码，不是简单的概念介绍
- **实战导向** - 提供完整的二次开发示例，可直接用于项目
- **架构思维** - 不仅讲 "怎么用"，更讲 "为什么这样设计"
- **持续更新** - 跟随 DeerFlow 版本迭代，保持内容最新

---

## 📖 目录结构

### 第一部分：理论基础

| 章节 | 内容亮点 |
|------|----------|
| [第一章 · 引言](./chapters/01-introduction.md) | DeerFlow 定位、核心特性、技术栈 |
| [第二章 · 核心概念](./chapters/02-core-concepts.md) | Skill vs Tool、Sub-Agent、Sandbox、Memory、Context Engineering |
| [第三章 · 架构总览](./chapters/03-architecture.md) | 系统架构图、LangGraph Server、Gateway API、中间件链 |

### 第二部分：源码剖析 ⭐️

| 章节 | 内容亮点 | 源码文件 |
|------|----------|----------|
| [第四章 · 项目结构](./chapters/04-project-structure.md) | 目录组织、模块职责、配置体系 | - |
| [第五章 · Agent 核心](./chapters/05-agent-core.md) ✅ | **ThreadState 类型系统**、**14+ 中间件详解**、**DeerFlowClient SDK** | `agents/thread_state.py`, `agents/middlewares/` |
| [第六章 · Skills 与 Tools](./chapters/06-skills-tools.md) ✅ | **Skill 安全扫描**、**历史管理**、**安装器实现** | `skills/security_scanner.py`, `skills/manager.py`, `skills/installer.py` |
| [第七章 · Sub-Agent 体系](./chapters/07-sub-agents.md) ✅ | **SubagentExecutor**、**任务状态机**、**背景任务管理** | `subagents/executor.py`, `subagents/config.py` |
| [第八章 · Sandbox 环境](./chapters/08-sandbox.md) ✅ | **Provider 模式**、**中间件生命周期**、**安全审计** | `sandbox/sandbox_provider.py`, `sandbox/middleware.py`, `sandbox/security.py` |
| [第九章 · Memory 系统](./chapters/09-memory.md) | Working Memory、Long-term Memory、Consolidation | `agents/memory/` |
| [第十章 · Context Engineering](./chapters/10-context-engineering.md) | 上下文压缩、RAG、Token 预算分配 | - |

### 第三部分：二次开发实战 ⭐️

| 章节 | 内容亮点 | 源码文件 |
|------|----------|----------|
| [第十一章 · MCP Server 集成](./chapters/11-mcp-server.md) ✅ | **OAuth 2.0 认证**、**工具缓存**、**多传输方式** (stdio/sse/http) | `mcp/oauth.py`, `mcp/cache.py`, `mcp/client.py` |
| [第十二章 · 自定义 Skill 开发](./chapters/12-custom-skill.md) | Skill 开发流程、打包发布、调试测试 | - |
| [第十三章 · Human-in-the-Loop](./chapters/13-human-in-the-loop.md) | 审批节点设计、审批中间件、审计日志 | - |
| [第十四章 · 企业级应用案例](./chapters/14-enterprise-cases.md) | 多租户隔离、RBAC、审计系统、知识库集成 | - |

### 附录

- [附录 A · 配置参考](./chapters/appendix-a-config.md) - 完整配置示例
- [附录 B · 贡献指南](./chapters/appendix-b-contributing.md) - 开发规范、PR 流程

> ✅ 标记表示本章已基于 DeerFlow 最新源码进行深度更新

---

## 🎯 阅读建议

### 不同读者的阅读路径

**🆕 Agent 开发新手**
```
第一章 → 第二章 → 第三章 → 第十二章 (快速上手 Skill 开发)
```

**🔧 二次开发工程师**
```
第四章 → 第五章 → 第六章 → 第七章 → 第十一章 (核心架构)
```

**🏢 企业级应用开发者**
```
第五章 → 第八章 → 第九章 → 第十三章 → 第十四章 (生产环境)
```

**🔬 源码贡献者**
```
通读全书 + 附录 B + 直接阅读 DeerFlow 源码
```

---

## 📋 阅读前置要求

- **Python 3.12+** - 熟悉类型注解、异步编程
- **LangChain / LangGraph** - 了解基本概念（Graph、State、Node）
- **Agent / LLM 应用开发** - 有实际项目经验更佳
- **Docker** - 理解容器基础（用于 Sandbox 章节）

---

## 🔄 最新更新

### 2026-04-09 重大更新

基于 DeerFlow 最新源码，对以下章节进行了深度更新：

| 章节 | 更新内容 |
|------|----------|
| **Chapter 05** | 新增 ThreadState 类型系统 (`NotRequired`/`Annotated`)、14+ 中间件完整列表、DeerFlowClient SDK |
| **Chapter 06** | 新增 Skill 安全扫描、历史管理、安装器实现 |
| **Chapter 07** | 新增 SubagentExecutor、任务状态机、背景任务管理 |
| **Chapter 08** | 新增 Sandbox Provider 模式、中间件生命周期、安全审计 |
| **Chapter 11** | 新增 OAuth 2.0 认证、MCP 工具缓存、多传输方式 |

---

## 🤝 参与贡献

本书是开源的，欢迎提交 PR：

1. **内容修正** - 发现与源码不符的地方
2. **章节补充** - 增加新的源码解析
3. **示例代码** - 提供更清晰的代码示例
4. **翻译** - 翻译成其他语言

详见 [附录 B · 贡献指南](./chapters/appendix-b-contributing.md)

---

## 📌 版本信息

- **DeerFlow 版本**: 2.0
- **书籍版本**: 2026.04
- **最后更新**: 2026-04-09

---

## 📄 许可证

本书采用 [MIT 许可证](./LICENSE) 开源。

 DeerFlow 是 ByteDance 的开源项目，本书为社区贡献的二次开发指南。
