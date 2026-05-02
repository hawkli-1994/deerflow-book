# 第八章 · Sandbox 沙箱执行环境


> **本章目标**：
> 1. 掌握 Sandbox 的设计目标与安全边界
> 2. 理解本地沙箱与 Docker 沙箱的区别与适用场景
> 3. 了解沙箱工具、资源限制与执行审计的实现

> **本章目标**：
> 1. 掌握 Sandbox 的架构设计与 Provider 扩展机制
> 2. 理解 Host Bash 安全检查与命令白名单策略
> 3. 了解 K8s Provisioner 与企业级沙箱配置

## 8.1 设计目标

DeerFlow 的 Sandbox 系统解决一个核心问题：**如何在安全隔离的环境中执行 AI Agent 生成的代码？**

核心目标：
1. **隔离性** — 代码在独立环境中运行，不影响宿主
2. **可控性** — 可限制资源、访问权限
3. **一致性** — 不同执行环境结果相同
4. **可观测性** — 执行过程可追踪、可审计

## 8.2 三层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Sandbox Architecture                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │              SandboxProvider (抽象接口)                   │   │
│   │                                                          │   │
│   │   acquire() ──→ 获取沙箱实例                              │   │
│   │   release() ──→ 释放沙箱实例                              │   │
│   │   get() ─────→ 获取现有实例                               │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│          ┌───────────────────┼───────────────────┐              │
│          │                   │                   │              │
│          ▼                   ▼                   ▼              │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│   │    Local    │    │   Docker    │    │ Provisioner │        │
│   │  Sandbox    │    │  Sandbox    │    │   (K8s)     │        │
│   │             │    │             │    │             │        │
│   │  直接本地   │    │  容器隔离   │    │  Pod 隔离   │        │
│   │  执行       │    │  资源限制   │    │  按需创建   │        │
│   └─────────────┘    └─────────────┘    └─────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 8.3 Sandbox 接口定义

> **💡 最佳实践**：实现自定义 Sandbox Provider 时，务必正确处理 `release()` 的幂等性。同一 sandbox 被多次释放不应报错，也不应导致资源泄漏。

```python
# packages/harness/deerflow/sandbox/sandbox.py

class Sandbox(ABC):
    """
    Sandbox 抽象基类
    """
    
    @property
    @abstractmethod
    def id(self) -> str:
        """沙箱唯一标识"""
        pass
    
    @property
    @abstractmethod
    def type(self) -> str:
        """沙箱类型: local, docker, provisioner"""
        pass
    
    @abstractmethod
    async def execute_command(
        self,
        command: str,
        timeout: Optional[int] = None
    ) -> CommandResult:
        """
        执行命令
        """
        pass
    
    @abstractmethod
    async def read_file(
        self,
        path: str,
        start_line: Optional[int] = None,
        end_line: Optional[int] = None
    ) -> str:
        """
        读取文件
        """
        pass
    
    @abstractmethod
    async def write_file(
        self,
        path: str,
        content: str,
        append: bool = False
    ) -> None:
        """
        写入文件
        """
        pass
    
    @abstractmethod
    async def list_dir(
        self,
        path: str,
        max_depth: int = 2
    ) -> List[DirEntry]:
        """
        列出目录
        """
        pass


class SandboxProvider(ABC):
    """
    Sandbox 提供者抽象
    """
    
    @abstractmethod
    async def acquire(self) -> Sandbox:
        """
        获取沙箱实例
        """
        pass
    
    @abstractmethod
    async def release(self, sandbox: Sandbox) -> None:
        """
        释放沙箱实例
        """
        pass
    
    @abstractmethod
    async def get(self, sandbox_id: str) -> Optional[Sandbox]:
        """
        获取现有沙箱
        """
        pass
```python

## 8.4 Sandbox Provider 模式

### 8.4.1 SandboxProvider 抽象基类

```python
# packages/harness/deerflow/sandbox/sandbox_provider.py

from abc import ABC, abstractmethod
from deerflow.sandbox.sandbox import Sandbox


class SandboxProvider(ABC):
    """Abstract base class for sandbox providers"""

    @abstractmethod
    def acquire(self, thread_id: str | None = None) -> str:
        """Acquire a sandbox environment and return its ID.

        Returns:
            The ID of the acquired sandbox environment.
        """
        pass

    @abstractmethod
    def get(self, sandbox_id: str) -> Sandbox | None:
        """Get a sandbox environment by ID.

        Args:
            sandbox_id: The ID of the sandbox environment to retain.
        """
        pass

    @abstractmethod
    def release(self, sandbox_id: str) -> None:
        """Release a sandbox environment.

        Args:
            sandbox_id: The ID of the sandbox environment to destroy.
        """
        pass
```

### 8.4.2 Provider 注册和发现机制

DeerFlow 使用动态类解析机制实现 Provider 的注册和发现：

```python
# Provider 单例管理
_default_sandbox_provider: SandboxProvider | None = None


def get_sandbox_provider(**kwargs) -> SandboxProvider:
    """Get the sandbox provider singleton.

    Returns a cached singleton instance. Use `reset_sandbox_provider()` to clear
    the cache, or `shutdown_sandbox_provider()` to properly shutdown and clear.
    """
    global _default_sandbox_provider
    if _default_sandbox_provider is None:
        config = get_app_config()
        # 动态解析类路径，如：deerflow.sandbox.local:LocalSandboxProvider
        cls = resolve_class(config.sandbox.use, SandboxProvider)
        _default_sandbox_provider = cls(**kwargs)
    return _default_sandbox_provider


def reset_sandbox_provider() -> None:
    """Reset the sandbox provider singleton.

    This clears the cached instance without calling shutdown.
    The next call to `get_sandbox_provider()` will create a new instance.
    Useful for testing or when switching configurations.
    """
    global _default_sandbox_provider
    _default_sandbox_provider = None


def shutdown_sandbox_provider() -> None:
    """Shutdown and reset the sandbox provider.

    This properly shuts down the provider (releasing all sandboxes)
    before clearing the singleton. Call this when the application
    is shutting down or when you need to completely reset the sandbox system.
    """
    global _default_sandbox_provider
    if _default_sandbox_provider is not None:
        if hasattr(_default_sandbox_provider, "shutdown"):
            _default_sandbox_provider.shutdown()
        _default_sandbox_provider = None


def set_sandbox_provider(provider: SandboxProvider) -> None:
    """Set a custom sandbox provider instance.

    This allows injecting a custom or mock provider for testing purposes.
    """
    global _default_sandbox_provider
    _default_sandbox_provider = provider
```

### 8.4.3 多 Provider 支持

通过配置动态切换不同的 Provider 实现：

```yaml
# config.yaml - 本地沙箱
sandbox:
  use: deerflow.sandbox.local:LocalSandboxProvider
```




```yaml
# config.yaml - Docker 沙箱
sandbox:
  use: deerflow.community.aio_sandbox:AioSandboxProvider
  docker:
    image: deer-flow-sandbox:latest
    mem_limit: "2g"
```python

```python
# 动态类解析原理
def resolve_class(class_path: str, base_class: Type) -> Type:
    """
    解析类路径并返回类对象
    
    Args:
        class_path: 模块路径，格式为 "module.submodule:ClassName"
        base_class: 期望的基类，用于类型检查
    
    Returns:
        解析后的类对象
    """
    module_path, class_name = class_path.split(":")
    module = importlib.import_module(module_path)
    cls = getattr(module, class_name)
    
    if not issubclass(cls, base_class):
        raise TypeError(f"{cls} must inherit from {base_class}")
    
    return cls
```

Provider 发现机制的优势：
1. **解耦** — 核心代码不依赖具体 Provider 实现
2. **可扩展** — 第三方可自定义 Provider
3. **配置驱动** — 无需修改代码即可切换实现


## 8.5 Sandbox 中间件与生命周期

### 8.5.1 SandboxMiddleware 实现

```python
# packages/harness/deerflow/sandbox/middleware.py

import logging
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.thread_state import SandboxState, ThreadDataState
from deerflow.sandbox import get_sandbox_provider

logger = logging.getLogger(__name__)


class SandboxMiddlewareState(AgentState):
    """Compatible with the `ThreadState` schema."""

    sandbox: NotRequired[SandboxState | None]
    thread_data: NotRequired[ThreadDataState | None]


class SandboxMiddleware(AgentMiddleware[SandboxMiddlewareState]):
    """Create a sandbox environment and assign it to an agent.

    Lifecycle Management:
    - With lazy_init=True (default): Sandbox is acquired on first tool call
    - With lazy_init=False: Sandbox is acquired on first agent invocation (before_agent)
    - Sandbox is reused across multiple turns within the same thread
    - Sandbox is NOT released after each agent call to avoid wasteful recreation
    - Cleanup happens at application shutdown via SandboxProvider.shutdown()
    """

    state_schema = SandboxMiddlewareState

    def __init__(self, lazy_init: bool = True):
        """Initialize sandbox middleware.

        Args:
            lazy_init: If True, defer sandbox acquisition until first tool call.
                      If False, acquire sandbox eagerly in before_agent().
                      Default is True for optimal performance.
        """
        super().__init__()
        self._lazy_init = lazy_init

    def _acquire_sandbox(self, thread_id: str) -> str:
        provider = get_sandbox_provider()
        sandbox_id = provider.acquire(thread_id)
        logger.info(f"Acquiring sandbox {sandbox_id}")
        return sandbox_id
```python

### 8.5.2 lazy_init 机制

`lazy_init` 控制沙箱的初始化时机：

| 模式 | 初始化时机 | 适用场景 |
|------|-----------|---------|
| `lazy_init=True` (默认) | 首次工具调用时 | 多数 Agent 调用不需要沙箱，节省资源 |
| `lazy_init=False` | Agent 调用前 | 确定每次都需要沙箱，减少首次调用延迟 |

**延迟初始化（默认）：**
```python
@override
def before_agent(self, state: SandboxMiddlewareState, runtime: Runtime) -> dict | None:
    # Skip acquisition if lazy_init is enabled
    if self._lazy_init:
        return super().before_agent(state, runtime)
    
    # Eager initialization (original behavior)
    if "sandbox" not in state or state["sandbox"] is None:
        thread_id = (runtime.context or {}).get("thread_id")
        if thread_id is None:
            return super().before_agent(state, runtime)
        sandbox_id = self._acquire_sandbox(thread_id)
        logger.info(f"Assigned sandbox {sandbox_id} to thread {thread_id}")
        return {"sandbox": {"sandbox_id": sandbox_id}}
    return super().before_agent(state, runtime)
```

**立即初始化：**
```python
# 配置 lazy_init=False
middleware = SandboxMiddleware(lazy_init=False)

# 工作流程：
# 1. Agent 被调用
# 2. before_agent() 立即获取沙箱
# 3. 工具执行使用已有沙箱
# 4. after_agent() 可选择释放或保留沙箱
```python

### 8.5.3 生命周期钩子

**before_agent() — Agent 执行前：**
```python
@override
def before_agent(self, state: SandboxMiddlewareState, runtime: Runtime) -> dict | None:
    if self._lazy_init:
        # 延迟模式：不获取沙箱，由工具调用时处理
        return super().before_agent(state, runtime)
    
    # 立即模式：检查并获取沙箱
    if "sandbox" not in state or state["sandbox"] is None:
        thread_id = (runtime.context or {}).get("thread_id")
        if thread_id is None:
            return super().before_agent(state, runtime)
        
        sandbox_id = self._acquire_sandbox(thread_id)
        logger.info(f"Assigned sandbox {sandbox_id} to thread {thread_id}")
        
        # 返回状态更新
        return {"sandbox": {"sandbox_id": sandbox_id}}
    
    return super().before_agent(state, runtime)
```

**after_agent() — Agent 执行后：**
```python
@override
def after_agent(self, state: SandboxMiddlewareState, runtime: Runtime) -> dict | None:
    # 从状态中释放沙箱
    sandbox = state.get("sandbox")
    if sandbox is not None:
        sandbox_id = sandbox["sandbox_id"]
        logger.info(f"Releasing sandbox {sandbox_id}")
        get_sandbox_provider().release(sandbox_id)
        return None

    # 从 runtime context 释放沙箱
    if (runtime.context or {}).get("sandbox_id") is not None:
        sandbox_id = runtime.context.get("sandbox_id")
        logger.info(f"Releasing sandbox {sandbox_id} from context")
        get_sandbox_provider().release(sandbox_id)
        return None

    # No sandbox to release
    return super().after_agent(state, runtime)
```

### 8.5.4 沙箱获取和释放时机

完整生命周期流程：

```
┌─────────────────────────────────────────────────────────────────┐
│                     Sandbox 生命周期流程                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  lazy_init=True (默认)                                           │
│  ───────────────────                                             │
│                                                                  │
│   Agent 调用 ──→ before_agent() ──→ 跳过获取                      │
│       │                                                          │
│       ▼                                                          │
│   工具调用 ──→ 检查沙箱状态                                        │
│       │                                                          │
│       ├── 无沙箱 ──→ acquire() ──→ 创建/获取沙箱                   │
│       │                                                          │
│       ▼                                                          │
│   工具执行 ◄────── 使用沙箱执行命令                                │
│       │                                                          │
│       ▼                                                          │
│   Agent 结束 ──→ after_agent() ──→ release() ──→ 释放沙箱         │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  lazy_init=False                                                 │
│  ───────────────                                                 │
│                                                                  │
│   Agent 调用 ──→ before_agent() ──→ acquire() ──→ 立即获取沙箱    │
│       │                                                          │
│       ▼                                                          │
│   工具调用 ──→ 直接使用已有沙箱                                   │
│       │                                                          │
│       ▼                                                          │
│   Agent 结束 ──→ after_agent() ──→ release() ──→ 释放沙箱         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```text

关键点：
1. **线程级别复用** — 同一线程内的多次工具调用共享同一个沙箱
2. **自动释放** — Agent 结束时自动调用 `release()`
3. **状态持久化** — 沙箱状态保存在 `ThreadState` 中


## 8.6 安全检查机制

### 8.6.1 SandboxSecurity 类

```python
# packages/harness/deerflow/sandbox/security.py

"""Security helpers for sandbox capability gating."""

from deerflow.config import get_app_config

_LOCAL_SANDBOX_PROVIDER_MARKERS = (
    "deerflow.sandbox.local:LocalSandboxProvider",
    "deerflow.sandbox.local.local_sandbox_provider:LocalSandboxProvider",
)

LOCAL_HOST_BASH_DISABLED_MESSAGE = (
    "Host bash execution is disabled for LocalSandboxProvider because it is not a secure "
    "sandbox boundary. Switch to AioSandboxProvider for isolated bash access, or set "
    "sandbox.allow_host_bash: true only in a fully trusted local environment."
)

LOCAL_BASH_SUBAGENT_DISABLED_MESSAGE = (
    "Bash subagent is disabled for LocalSandboxProvider because host bash execution is not "
    "a secure sandbox boundary. Switch to AioSandboxProvider for isolated bash access, or "
    "set sandbox.allow_host_bash: true only in a fully trusted local environment."
)
```

### 8.6.2 Host Bash 安全检查

```python
def uses_local_sandbox_provider(config=None) -> bool:
    """Return True when the active sandbox provider is the host-local provider."""
    if config is None:
        config = get_app_config()

    sandbox_cfg = getattr(config, "sandbox", None)
    sandbox_use = getattr(sandbox_cfg, "use", "")
    
    if sandbox_use in _LOCAL_SANDBOX_PROVIDER_MARKERS:
        return True
    
    return sandbox_use.endswith(":LocalSandboxProvider") and \
           "deerflow.sandbox.local" in sandbox_use


def is_host_bash_allowed(config=None) -> bool:
    """Return whether host bash execution is explicitly allowed."""
    if config is None:
        config = get_app_config()

    sandbox_cfg = getattr(config, "sandbox", None)
    if sandbox_cfg is None:
        return True
    
    # 非本地 Provider，默认允许
    if not uses_local_sandbox_provider(config):
        return True
    
    # 本地 Provider，需要显式开启
    return bool(getattr(sandbox_cfg, "allow_host_bash", False))
```python

### 8.6.3 敏感路径访问控制

安全检查的应用场景：

```python
# bash 工具执行前检查
async def bash_tool(command: str) -> str:
    """执行 Bash 命令（带安全检查）"""
    
    # 检查是否允许 Host Bash
    if not is_host_bash_allowed():
        raise PermissionError(LOCAL_HOST_BASH_DISABLED_MESSAGE)
    
    # 继续执行命令...
    result = await sandbox.execute_command(command)
    return result


# bash subagent 检查
async def bash_subagent_task(command: str) -> str:
    """Bash Subagent 任务（带安全检查）"""
    
    if not is_host_bash_allowed():
        raise PermissionError(LOCAL_BASH_SUBAGENT_DISABLED_MESSAGE)
    
    # 继续执行...
```

### 8.6.4 命令白名单/黑名单

配置层面的安全控制：

```yaml
# config.yaml
sandbox:
  use: deerflow.sandbox.local:LocalSandboxProvider
  
  # 本地沙箱特殊配置
  allow_host_bash: false  # 默认禁用 Host Bash
  
  # 危险命令黑名单（可扩展）
  blocked_commands:
    - "rm -rf /"
    - "mkfs"
    - "dd if=/dev/zero"
    
  # 允许的命令白名单（可选）
  allowed_commands:
    - "ls"
    - "cat"
    - "grep"
    - "python"
```

安全检查决策流程：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Host Bash 安全检查流程                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   检查开始                                                        │
│       │                                                          │
│       ▼                                                          │
│   获取当前 Provider 类型                                          │
│       │                                                          │
│       ├── AioSandboxProvider (Docker) ──→ ✓ 允许执行             │
│       │                                                          │
│       └── LocalSandboxProvider                                    │
│               │                                                  │
│               ▼                                                  │
│           检查 allow_host_bash 配置                               │
│               │                                                  │
│               ├── true  ──→ ✓ 允许执行（开发环境）                │
│               │                                                  │
│               └── false ──→ ✗ 拒绝执行（默认，生产环境）          │
│                           返回 LOCAL_HOST_BASH_DISABLED_MESSAGE  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```text

安全最佳实践：
1. **生产环境** — 始终使用 Docker/K8s Provider，禁用 Local Provider
2. **开发环境** — 如需使用 Local Provider，谨慎开启 `allow_host_bash`
3. **审计追踪** — 结合 SandboxAuditMiddleware 记录所有命令
4. **最小权限** — 配置白名单，限制可执行命令范围


## 8.7 Local Sandbox

### 8.7.1 实现原理

```python
class LocalSandboxProvider(SandboxProvider):
    """
    本地沙箱提供者 - 单例模式
    直接在宿主机上执行命令
    """
    
    def __init__(self, path_mapping: Dict[str, str] = None):
        self._sandbox: Optional[LocalSandbox] = None
        self._path_mapping = path_mapping or {}
    
    async def acquire(self) -> LocalSandbox:
        if self._sandbox is None:
            self._sandbox = LocalSandbox(
                id="local",
                path_mapping=self._path_mapping
            )
        return self._sandbox
    
    async def release(self, sandbox: Sandbox) -> None:
        # Local Sandbox 不需要真正释放
        pass


class LocalSandbox(Sandbox):
    """
    本地沙箱实现
    """
    
    def __init__(
        self,
        id: str,
        path_mapping: Dict[str, str]
    ):
        self.id = id
        self.type = "local"
        self._path_mapping = path_mapping
    
    async def execute_command(
        self,
        command: str,
        timeout: Optional[int] = None
    ) -> CommandResult:
        # 路径转换
        command = replace_virtual_paths_in_command(command, self._path_mapping)
        
        # 直接执行
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            timeout=timeout,
            text=True
        )
        
        return CommandResult(
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.returncode
        )
```

### 8.7.2 使用场景

- **开发调试** — 快速迭代，无需容器开销
- **完全受控环境** — 确信代码安全
- **资源充足** — 不需要隔离

## 8.8 Docker Sandbox

### 8.8.1 AioSandboxProvider

```python
class AioSandboxProvider(SandboxProvider):
    """
    Docker 沙箱提供者
    基于 aio-sandbox 实现
    """
    
    def __init__(
        self,
        image: str = "deer-flow-sandbox",
        volumes: Dict[str, str] = None,
        network: str = None,
        **kwargs
    ):
        self.image = image
        self.volumes = volumes
        self.network = network
        self._container = None
        self._client = None
    
    async def acquire(self) -> DockerSandbox:
        # 1. 启动 Docker 容器
        self._container = await self._start_container()
        
        # 2. 等待容器就绪
        await self._wait_ready()
        
        # 3. 返回 Docker Sandbox 实例
        return DockerSandbox(
            id=self._container.id,
            container=self._container,
            client=self._client
        )
```

### 8.8.2 虚拟路径系统

Agent 在沙箱内看到的路径与宿主机不同：

| Agent 视角（虚拟） | 宿主机视角（物理） |
|-------------------|------------------|
| `/mnt/user-data/workspace` | `.deer-flow/threads/{thread_id}/user-data/workspace` |
| `/mnt/user-data/uploads` | `.deer-flow/threads/{thread_id}/user-data/uploads` |
| `/mnt/user-data/outputs` | `.deer-flow/threads/{thread_id}/user-data/outputs` |
| `/mnt/skills` | `deer-flow/skills/` |

```python
# 路径转换
VIRTUAL_PATH_PREFIX = "/mnt/user-data"

def replace_virtual_path(path: str, thread_id: str) -> str:
    """
    虚拟路径 → 物理路径
    """
    if path.startswith(VIRTUAL_PATH_PREFIX):
        return path.replace(
            VIRTUAL_PATH_PREFIX,
            f".deer-flow/threads/{thread_id}/user-data"
        )
    return path

def replace_virtual_paths_in_command(
    command: str,
    path_mapping: Dict[str, str]
) -> str:
    """
    替换命令中的所有虚拟路径
    """
    for virtual, physical in path_mapping.items():
        command = command.replace(virtual, physical)
    return command
```

## 8.9 Provisioner Sandbox（K8s）

### 8.9.1 架构

```
┌─────────────────────────────────────────────────────────────────┐
│              Provisioner Sandbox (Kubernetes)                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Agent 请求 ──→ LangGraph ──→ Provisioner ──→ K8s API ──→ Pod │
│                              │                    │               │
│                              │              ┌─────┴─────┐        │
│                              │              │  Sandbox   │        │
│                              │              │  Container │        │
│                              │              └───────────┘        │
│                              │                                   │
│                              ←──────────── 释放 ─────────────────│
└─────────────────────────────────────────────────────────────────┘
```

### 8.9.2 配置

```yaml
# config.yaml
sandbox:
  use: deerflow.community.aio_sandbox:AioSandboxProvider
  
  # Provisioner 模式
  provisioner:
    enabled: true
    provisioner_url: https://provisioner.example.com:8002
    kubeconfig: ~/.kube/config
    
    # 资源限制
    resources:
      cpu_limit: "2"
      memory_limit: "4Gi"
      timeout: 3600
```text

## 8.10 Sandbox Tools

沙箱提供一组内置工具供 Agent 使用：

### 8.10.1 bash 工具

```python
async def bash_tool(command: str) -> str:
    """
    执行 Bash 命令
    """
    result = await sandbox.execute_command(
        command=command,
        timeout=300  # 5分钟超时
    )
    
    if result.exit_code != 0:
        raise ToolExecutionError(
            f"Command failed: {result.stderr}"
        )
    
    return result.stdout
```

### 8.10.2 文件操作工具

```python
async def read_file_tool(
    path: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None
) -> str:
    """
    读取文件
    """
    content = await sandbox.read_file(path)
    
    lines = content.split("\n")
    if start_line is not None:
        lines = lines[start_line-1:]
    if end_line is not None:
        lines = lines[:end_line]
    
    return "\n".join(lines)


async def write_file_tool(
    path: str,
    content: str,
    append: bool = False
) -> str:
    """
    写入文件
    """
    await sandbox.write_file(path, content, append=append)
    return f"File written: {path}"


async def ls_tool(path: str, max_depth: int = 2) -> str:
    """
    列出目录
    """
    entries = await sandbox.list_dir(path, max_depth=max_depth)
    
    # 格式化为树形结构
    return format_as_tree(entries)
```python

## 8.11 Sandbox 中间件集成

```python
class SandboxMiddleware:
    """
    Sandbox 生命周期中间件
    """
    
    async def before_node(
        self,
        state: ThreadState,
        node_name: str
    ):
        """
        在节点执行前获取沙箱
        """
        if state.get("sandbox") is None:
            provider = get_sandbox_provider()
            sandbox = await provider.acquire()
            
            state["sandbox"] = {
                "id": sandbox.id,
                "type": sandbox.type,
                "provider": provider
            }
    
    async def after_node(
        self,
        state: ThreadState,
        node_name: str
    ):
        """
        在节点执行后处理沙箱
        """
        # 如果是结束，释放沙箱
        if node_name == END:
            sandbox_info = state.get("sandbox")
            if sandbox_info:
                provider = sandbox_info["provider"]
                sandbox = await provider.get(sandbox_info["id"])
                if sandbox:
                    await provider.release(sandbox)
```

## 8.12 Sandbox 审计中间件

### 8.12.1 SandboxAuditMiddleware 实现

```python
# packages/harness/deerflow/agents/middlewares/sandbox_audit_middleware.py

"""SandboxAuditMiddleware - bash command security auditing."""

import json
import logging
import re
import shlex
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import override

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from deerflow.agents.thread_state import ThreadState

logger = logging.getLogger(__name__)
```

### 8.12.2 审计事件类型

SandboxAuditMiddleware 拦截并审计所有 `bash` 工具调用：

```
┌─────────────────────────────────────────────────────────────────┐
│                     审计事件类型                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Tool Call Request                                               │
│       │                                                          │
│       ▼                                                          │
│  wrap_tool_call() / awrap_tool_call()                            │
│       │                                                          │
│       ├── 非 bash 工具 ──→ 直接执行，跳过审计                    │
│       │                                                          │
│       └── bash 工具                                              │
│               │                                                  │
│               ▼                                                  │
│           _pre_process()                                         │
│               │                                                  │
│               ├── 输入验证 ──→ 空命令/过长/空字节检测            │
│               │                                                  │
│               ├── 命令分类 ──→ block / warn / pass               │
│               │                                                  │
│               └── 审计日志 ──→ JSON 格式结构化日志               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 8.12.3 三级分类：block/warn/pass

**命令分类规则：**

```python
# 高风险模式 —— 直接阻断
_HIGH_RISK_PATTERNS: list[re.Pattern[str]] = [
    # 递归删除根目录或系统目录
    re.compile(r"rm\s+-[^\s]*r[^\s]*\s+(/\*?|~/?\*?|/home\b|/root\b)\s*$"),
    # 磁盘格式化
    re.compile(r"dd\s+if="),
    re.compile(r"mkfs"),
    # 读取敏感文件
    re.compile(r"cat\s+/etc/shadow"),
    # 写入系统配置
    re.compile(r">+\s*/etc/"),
    # pipe to sh/bash
    re.compile(r"\|\s*(ba)?sh\b"),
    # 命令替换执行
    re.compile(r"[`$]\(?\s*(curl|wget|bash|sh|python|ruby|perl|base64)"),
    # base64 解码后执行
    re.compile(r"base64\s+.*-d.*\|"),
    # 覆盖系统二进制文件
    re.compile(r">+\s*(/usr/bin/|/bin/|/sbin/)"),
    # 覆盖 shell 启动文件
    re.compile(r">+\s*~/?\.(bashrc|profile|zshrc|bash_profile)"),
    # 读取进程环境变量
    re.compile(r"/proc/[^/]+/environ"),
    # 动态链接器劫持
    re.compile(r"\b(LD_PRELOAD|LD_LIBRARY_PATH)\s*="),
    # bash 内置网络
    re.compile(r"/dev/tcp/"),
    # fork bomb
    re.compile(r"\S+\(\)\s*\{[^}]*\|\s*\S+\s*&"),
    re.compile(r"while\s+true.*&\s*done"),
]

# 中风险模式 —— 警告但允许执行
_MEDIUM_RISK_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"chmod\s+777"),
    re.compile(r"pip3?\s+install"),
    re.compile(r"apt(-get)?\s+install"),
    re.compile(r"\b(sudo|su)\b"),
    re.compile(r"\bPATH\s*="),
]
```

**分类决策流程：**

```python
def _classify_command(command: str) -> str:
    """Return 'block', 'warn', or 'pass'.

    Strategy:
    1. First scan the *whole* raw command against high-risk patterns. This
       catches structural attacks like ``while true; do bash & done`` or
       ``:(){ :|:& };:`` that span multiple shell statements.
    2. Then split compound commands and classify each sub-command independently.
       The most severe verdict wins.
    """
    # Pass 1: whole-command high-risk scan
    normalized = " ".join(command.split())
    for pattern in _HIGH_RISK_PATTERNS:
        if pattern.search(normalized):
            return "block"

    # Pass 2: per-sub-command classification
    sub_commands = _split_compound_command(command)
    worst = "pass"
    for sub in sub_commands:
        verdict = _classify_single_command(sub)
        if verdict == "block":
            return "block"
        if verdict == "warn":
            worst = "warn"
    return worst
```python

**分类结果处理：**

| 分类 | 处理方式 | 响应 |
|------|---------|------|
| **block** | 阻止执行 | 返回错误 ToolMessage，提示使用更安全的替代方案 |
| **warn** | 允许执行 | 在结果后追加警告信息，提醒 LLM 注意 |
| **pass** | 正常执行 | 无额外处理 |

### 8.12.4 审计日志格式

**结构化 JSON 日志：**

```python
def _write_audit(self, thread_id: str | None, command: str, verdict: str, *, truncate: bool = False) -> None:
    """Write audit log entry."""
    audited_command = command
    if truncate and len(command) > self._AUDIT_COMMAND_LIMIT:
        audited_command = f"{command[: self._AUDIT_COMMAND_LIMIT]}... ({len(command)} chars)"
    
    record = {
        "timestamp": datetime.now(UTC).isoformat(),
        "thread_id": thread_id or "unknown",
        "command": audited_command,
        "verdict": verdict,
    }
    logger.info("[SandboxAudit] %s", json.dumps(record, ensure_ascii=False))
```

**日志示例：**

```text
// 正常命令
{
  "timestamp": "2025-01-15T08:30:45.123456+00:00",
  "thread_id": "thread_abc123",
  "command": "ls -la /workspace",
  "verdict": "pass"
}

// 中风险命令
{
  "timestamp": "2025-01-15T08:31:12.654321+00:00",
  "thread_id": "thread_abc123",
  "command": "pip install requests",
  "verdict": "warn"
}

// 高风险命令（被阻断）
{
  "timestamp": "2025-01-15T08:32:01.987654+00:00",
  "thread_id": "thread_abc123",
  "command": "rm -rf /",
  "verdict": "block"
}
```text

**输入验证与边界保护：**

```python
# 命令长度限制（防止 payload 注入）
_MAX_COMMAND_LENGTH = 10_000

def _validate_input(self, command: str) -> str | None:
    """Return None if command is acceptable, else a rejection reason."""
    if not command.strip():
        return "empty command"
    if len(command) > self._MAX_COMMAND_LENGTH:
        return "command too long"
    if "\x00" in command:
        return "null byte detected"
    return None
```

**错误响应构建：**

```python
def _build_block_message(self, request: ToolCallRequest, reason: str) -> ToolMessage:
    """Build error message for blocked commands."""
    tool_call_id = str(request.tool_call.get("id") or "missing_id")
    return ToolMessage(
        content=f"Command blocked: {reason}. Please use a safer alternative approach.",
        tool_call_id=tool_call_id,
        name="bash",
        status="error",
    )

def _append_warn_to_result(self, result: ToolMessage | Command, command: str) -> ToolMessage | Command:
    """Append warning note to tool result for medium-risk commands."""
    if not isinstance(result, ToolMessage):
        return result
    
    warning = f"\n\n⚠️ Warning: `{command}` is a medium-risk command that may modify the runtime environment."
    
    if isinstance(result.content, list):
        new_content = list(result.content) + [{"type": "text", "text": warning}]
    else:
        new_content = str(result.content) + warning
    
    return ToolMessage(
        content=new_content,
        tool_call_id=result.tool_call_id,
        name=result.name,
        status=result.status,
    )
```python

### 8.12.5 中间件集成

```python
# 在 Agent 配置中添加审计中间件
from deerflow.agents.middlewares.sandbox_audit_middleware import SandboxAuditMiddleware

agent = create_react_agent(
    model=model,
    tools=tools,
    middlewares=[
        SandboxMiddleware(lazy_init=True),
        SandboxAuditMiddleware(),  # 添加审计中间件
    ],
)
```

审计中间件执行顺序：

```
┌─────────────────────────────────────────────────────────────────┐
│                   中间件执行顺序                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   1. SandboxMiddleware.before_agent()                           │
│       └── 获取/创建沙箱                                          │
│                                                                  │
│   2. Agent 推理                                                  │
│       └── 生成工具调用                                           │
│                                                                  │
│   3. SandboxAuditMiddleware.wrap_tool_call()                    │
│       ├── 输入验证                                               │
│       ├── 命令分类 (block/warn/pass)                            │
│       ├── 写入审计日志                                           │
│       └── 根据分类处理（阻断/警告/放行）                          │
│                                                                  │
│   4. 工具执行（如通过审计）                                       │
│                                                                  │
│   5. SandboxMiddleware.after_agent()                            │
│       └── 释放沙箱                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```


## 8.13 安全考虑

### 8.13.1 资源限制

```yaml
sandbox:
  docker:
    # 内存限制
    mem_limit: "2g"
    
    # CPU 限制
    cpu_period: 100000
    cpu_quota: 200000
    
    # 网络隔离
    network_disabled: true
    
    # 只读文件系统（除指定目录外）
    read_only: true
    binds:
      - "/path/to/workspace:/mnt/user-data:rw"
```python

### 8.13.2 执行超时

```python
async def execute_with_timeout(
    sandbox: Sandbox,
    command: str,
    timeout: int = 300
):
    """
    带超时的命令执行
    """
    try:
        result = await asyncio.wait_for(
            sandbox.execute_command(command),
            timeout=timeout
        )
        return result
    except asyncio.TimeoutError:
        raise ToolExecutionError(
            f"Command execution timeout after {timeout}s"
        )
```

### 8.13.3 中间件配置

**lazy_init 配置：**

```yaml
# config.yaml
sandbox:
  use: deerflow.sandbox.local:LocalSandboxProvider
  
  # 中间件配置
  middleware:
    # 延迟初始化：首次工具调用时才获取沙箱（默认 true，推荐）
    lazy_init: true
    
    # 立即初始化：Agent 调用前获取沙箱（适合确定需要沙箱的场景）
    # lazy_init: false
```python

```python
# 代码中配置
from deerflow.sandbox.middleware import SandboxMiddleware

# 延迟初始化（默认）- 性能最优
lazy_middleware = SandboxMiddleware(lazy_init=True)

# 立即初始化 - 首次调用延迟最低
eager_middleware = SandboxMiddleware(lazy_init=False)
```

**配置对比：**

| 配置项 | lazy_init=true | lazy_init=false |
|--------|---------------|-----------------|
| 初始化时机 | 首次工具调用 | Agent 调用前 |
| 首次 Agent 调用开销 | 低（跳过沙箱获取） | 高（需要获取沙箱） |
| 首次工具调用开销 | 高（包含沙箱获取） | 低（沙箱已就绪） |
| 适用场景 | 多数调用不需要沙箱 | 每次都需要沙箱 |

### 8.13.4 网络配置

**Docker 网络隔离：**

```yaml
# config.yaml
sandbox:
  use: deerflow.community.aio_sandbox:AioSandboxProvider
  
  docker:
    # 完全禁用网络
    network_disabled: true
    
    # 或使用隔离网络
    network_mode: "none"
    
    # 或使用自定义桥接网络
    network: "deerflow-sandbox-network"
    
    # 限制 DNS 解析
    dns:
      - "8.8.8.8"
      - "8.8.4.4"
    
    # 限制外部访问（通过 iptables）
    extra_hosts:
      - "internal.service:127.0.0.1"
```

**网络策略：**

```yaml
# 完全隔离（最安全）
sandbox:
  docker:
    network_disabled: true

# 只允许特定出口
sandbox:
  docker:
    network_mode: "bridge"
    # 配合防火墙规则限制出口

# 代理模式（受控访问）
sandbox:
  docker:
    network: "sandbox-proxy-network"
    # 所有流量经过代理审查
```

### 8.13.5 资源限制细化

**Docker 资源限制：**

```yaml
# config.yaml
sandbox:
  docker:
    # 内存限制
    mem_limit: "2g"
    memswap_limit: "2g"  # 禁用 swap
    
    # CPU 限制
    cpu_period: 100000
    cpu_quota: 200000    # 2 核
    cpu_shares: 1024
    
    # 进程数限制
    pids_limit: 100
    
    # 文件描述符限制
    ulimits:
      - "nofile:1024:2048"
    
    # 存储限制
    storage_opt:
      size: "10G"
    
    # 设备访问控制
    devices: []  # 空列表表示禁止访问所有设备
    
    #  capabilities 限制
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
```

**K8s Provisioner 资源限制：**

```yaml
# config.yaml
sandbox:
  provisioner:
    enabled: true
    provisioner_url: https://provisioner.example.com:8002
    
    resources:
      # 请求资源
      requests:
        cpu: "500m"
        memory: "512Mi"
      
      # 限制资源
      limits:
        cpu: "2"
        memory: "4Gi"
        ephemeral_storage: "10Gi"
      
      # Pod 超时
      timeout: 3600
      
      # 最大重启次数
      max_restarts: 3
```

### 8.13.6 安全配置检查清单

生产环境部署前检查：

```markdown
□ Provider 选择
  □ 使用 Docker/K8s Provider（禁用 Local Provider）
  □ 验证 Provider 配置正确加载

□ 资源限制
  □ 内存限制已配置
  □ CPU 限制已配置
  □ 超时时间已设置
  □ 进程数限制已配置

□ 网络隔离
  □ 网络已禁用或严格限制
  □ DNS 配置正确
  □ 无法访问内部网络

□ 文件系统
  □ 只读文件系统（除工作目录外）
  □ 敏感路径已隔离
  □ 临时文件定期清理

□ 审计与监控
  □ SandboxAuditMiddleware 已启用
  □ 审计日志可收集
  □ 异常行为告警已配置

□ 命令安全
  □ 高危命令已被阻断
  □ 中危命令产生警告
  □ 命令长度限制生效
```

## 8.14 小结

| 组件 | 说明 |
|------|------|
| **Sandbox 接口** | 抽象出 execute/read/write/list 操作 |
| **Provider 模式** | Local/Docker/Provisioner 三种实现，支持动态注册和发现 |
| **虚拟路径** | Agent 视角与宿主机视角隔离 |
| **中间件生命周期** | `before_agent()`/`after_agent()` 自动管理沙箱获取与释放 |
| **延迟初始化** | `lazy_init` 机制优化性能，按需获取沙箱 |
| **安全检查** | Host bash 安全检查、敏感路径控制、命令白名单/黑名单 |
| **审计中间件** | 三级分类（block/warn/pass）+ 结构化 JSON 审计日志 |
| **资源限制** | 内存、CPU、网络、文件系统隔离 |
| **执行超时** | 防止长时间运行的命令阻塞系统 |


## 本章小结

本章系统讲解了 DeerFlow Sandbox 的设计与安全机制：

1. **安全边界**：Sandbox 是 Agent 代码执行的唯一合法环境，通过进程/容器隔离保护宿主系统。
2. **两种模式**：LocalSandbox 适合开发调试（低延迟），DockerSandbox 适合生产环境（强隔离、资源可控）。
3. **资源限制**：CPU、内存、磁盘、网络配额通过 cgroups/namespace 强制执行，防止恶意或失控代码。
4. **审计日志**：所有沙箱操作记录时间戳、命令、执行结果，支持事后追溯与合规审计。

> **⚠️ 注意**：永远不要关闭沙箱的输入验证——即使是「可信」的 Agent 生成的代码，也可能因 Prompt 注入或模型幻觉包含危险指令。

---

**下一步**：阅读第九章，了解 DeerFlow 的记忆分层模型与 Recall 机制。

