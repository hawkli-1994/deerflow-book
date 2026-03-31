# 第八章 · Sandbox 沙箱执行环境

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
```

## 8.4 Local Sandbox

### 8.4.1 实现原理

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

### 8.4.2 使用场景

- **开发调试** — 快速迭代，无需容器开销
- **完全受控环境** — 确信代码安全
- **资源充足** — 不需要隔离

## 8.5 Docker Sandbox

### 8.5.1 AioSandboxProvider

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

### 8.5.2 虚拟路径系统

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

## 8.6 Provisioner Sandbox（K8s）

### 8.6.1 架构

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

### 8.6.2 配置

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
```

## 8.7 Sandbox Tools

沙箱提供一组内置工具供 Agent 使用：

### 8.7.1 bash 工具

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

### 8.7.2 文件操作工具

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
```

## 8.8 Sandbox 中间件

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

## 8.9 安全考虑

### 8.9.1 资源限制

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
```

### 8.9.2 执行超时

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

## 8.10 二次开发：SwarmMind Sandbox 定制

### 8.10.1 企业级沙箱需求

SwarmMind 场景下，Sandbox 需要：

1. **更严格的隔离** — 防止数据泄露
2. **审计追踪** — 所有操作记录在案
3. **资源配额** — 按项目/用户限制资源
4. **网络控制** — 限制访问内部系统

### 8.10.1 自定义沙箱提供者

```python
class SwarmMindSandboxProvider(SandboxProvider):
    """
    SwarmMind 企业级沙箱提供者
    """
    
    def __init__(
        self,
        config: SwarmMindSandboxConfig,
        audit_logger: AuditLogger
    ):
        self.config = config
        self.audit_logger = audit_logger
        self._containers: Dict[str, SwarmMindSandbox] = {}
    
    async def acquire(
        self,
        project_id: str = None,
        user_id: str = None
    ) -> SwarmMindSandbox:
        """
        获取沙箱实例，带项目和用户上下文
        """
        # 1. 检查资源配额
        await self._check_quota(user_id)
        
        # 2. 创建沙箱
        container = await self._create_container(
            project_id=project_id,
            user_id=user_id
        )
        
        # 3. 记录审计日志
        await self.audit_logger.log(
            event="sandbox_acquired",
            container_id=container.id,
            project_id=project_id,
            user_id=user_id
        )
        
        sandbox = SwarmMindSandbox(
            container=container,
            audit_logger=self.audit_logger
        )
        
        self._containers[container.id] = sandbox
        return sandbox
    
    async def _check_quota(self, user_id: str):
        """检查用户资源配额"""
        usage = await self._get_usage(user_id)
        quota = await self._get_quota(user_id)
        
        if usage >= quota:
            raise QuotaExceededError(f"User {user_id} quota exceeded")
```

### 8.10.2 沙箱审计包装

```python
class SwarmMindSandbox(Sandbox):
    """
    带审计功能的沙箱包装
    """
    
    def __init__(
        self,
        container: Container,
        audit_logger: AuditLogger
    ):
        self._container = container
        self.audit_logger = audit_logger
    
    async def execute_command(
        self,
        command: str,
        timeout: Optional[int] = None
    ) -> CommandResult:
        """
        执行命令，带完整审计
        """
        # 1. 记录命令
        await self.audit_logger.log(
            event="command_execute",
            command=command,
            sandbox_id=self.id
        )
        
        # 2. 执行
        result = await self._container.execute_command(command, timeout)
        
        # 3. 记录结果
        await self.audit_logger.log(
            event="command_result",
            command=command,
            exit_code=result.exit_code,
            sandbox_id=self.id
        )
        
        return result
    
    async def read_file(
        self,
        path: str,
        **kwargs
    ) -> str:
        """读取文件，带审计"""
        await self.audit_logger.log(
            event="file_read",
            path=path,
            sandbox_id=self.id
        )
        
        return await self._container.read_file(path, **kwargs)
```

## 8.11 小结

| 组件 | 说明 |
|------|------|
| **Sandbox 接口** | 抽象出 execute/read/write/list 操作 |
| **Provider 模式** | Local/Docker/Provisioner 三种实现 |
| **虚拟路径** | Agent 视角与宿主机视角隔离 |
| **中间件** | 自动获取/释放沙箱生命周期 |
| **安全** | 资源限制、执行超时、网络隔离 |

SwarmMind 的企业级扩展：
- 资源配额控制
- 完整操作审计
- 项目级隔离
- 网络访问控制
