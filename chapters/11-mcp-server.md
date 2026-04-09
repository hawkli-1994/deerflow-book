# 第十一章 · MCP Server 集成

## 11.1 什么是 MCP

MCP（Model Context Protocol）是一个开放协议，用于将 AI 模型与外部工具和数据源连接。DeerFlow 原生支持 MCP Server，通过标准化的接口扩展 Agent 能力。

```
┌─────────────────────────────────────────────────────────────────┐
│                      MCP Architecture                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────┐        ┌──────────────┐      ┌────────────┐ │
│   │   DeerFlow   │───────→│  MCP Client  │──────→│ MCP Server │ │
│   │    Agent     │        │              │      │            │ │
│   └──────────────┘        └──────────────┘      └─────┬──────┘ │
│                                                        │         │
│                                                        ▼         │
│                                                ┌────────────┐   │
│                                                │  Local FS  │   │
│                                                │  GitHub    │   │
│                                                │  Slack     │   │
│                                                │  Database  │   │
│                                                └────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## 11.2 MCP 在 DeerFlow 中的位置

```
DeerFlow 请求处理流程：
━━━━━━━━━━━━━━━━━━━━━━

用户请求
    │
    ▼
Middleware Chain
    │
    ▼
Agent Core ──→ Model (LLM)
    │              │
    │              ├─→ 内置 Tools
    │              ├─→ Sandbox Tools
    │              ├─→ Community Tools
    │              └─→ MCP Tools  ◄─── 从这里加载
    │
    ▼
返回结果
```

## 11.3 MCP Server 配置

### 11.3.1 配置格式

```json
// extensions_config.json
{
  "mcp_servers": [
    {
      "name": "filesystem",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      "args": ["/tmp"],
      "env": {},
      "enabled": true
    },
    {
      "name": "github",
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "args": [],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN"
      },
      "enabled": true
    },
    {
      "name": "slack",
      "command": ["python", "-m", "mcp_server_slack"],
      "args": [],
      "env": {
        "SLACK_BOT_TOKEN": "$SLACK_BOT_TOKEN"
      },
      "enabled": false
    }
  ]
}
```

### 11.3.2 配置字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | Server 名称，唯一标识 |
| `command` | string[] | ✅ | 启动命令（数组） |
| `args` | string[] | ❌ | 命令参数 |
| `env` | object | ❌ | 环境变量 |
| `enabled` | boolean | ❌ | 默认 true |
| `timeout` | number | ❌ | 超时时间（ms） |
| `type` | string | ❌ | 传输类型：`stdio`/`sse`/`http`，默认 `stdio` |
| `url` | string | 条件 | HTTP/SSE 传输时的服务器 URL |
| `headers` | object | ❌ | HTTP/SSE 传输时的额外请求头 |
| `oauth` | object | ❌ | OAuth 认证配置（见 11.7 节） |

### 11.3.3 环境变量引用

```json
{
  "mcp_servers": [
    {
      "name": "custom-server",
      "command": ["python", "server.py"],
      "env": {
        // 直接值
        "DEBUG": "true",
        // 环境变量引用（以 $ 开头）
        "API_KEY": "$CUSTOM_API_KEY",
        "DB_URL": "$DATABASE_URL"
      }
    }
  ]
}
```

## 11.4 MCP 客户端实现

### 11.4.1 MCP Client 类

```python
# packages/harness/deerflow/mcp/client.py

class MCPClient:
    """
    MCP 客户端
    """
    
    def __init__(self, config: MCPServerConfig):
        self.config = config
        self.process: Optional[subprocess.Popen] = None
        self.stdin: Optional[asyncio.StreamWriter] = None
        self.stdout: Optional[asyncio.StreamReader] = None
        self._tools: Dict[str, MCPTool] = {}
    
    async def start(self):
        """启动 MCP Server"""
        # 1. 准备环境变量
        env = os.environ.copy()
        for key, value in self.config.env.items():
            if value.startswith("$"):
                env[key] = os.environ.get(value[1:], "")
            else:
                env[key] = value
        
        # 2. 启动进程
        self.process = await asyncio.create_subprocess_exec(
            *self.config.command,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        
        # 3. 初始化 stdio
        self.stdin = self.process.stdin
        self.stdout = self.process.stdout
        
        # 4. 发送初始化请求
        await self._send_initialize()
        
        # 5. 获取可用工具列表
        await self._fetch_tools()
    
    async def _send_initialize(self):
        """发送初始化请求"""
        request = {
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "clientInfo": {
                    "name": "deer-flow",
                    "version": "2.0"
                }
            }
        }
        
        await self._send(request)
        response = await self._recv()
        
        if response.get("error"):
            raise MCPError(f"Initialize failed: {response['error']}")
    
    async def _fetch_tools(self):
        """获取工具列表"""
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {}
        }
        
        await self._send(request)
        response = await self._recv()
        
        if "result" in response:
            for tool in response["result"]["tools"]:
                self._tools[tool["name"]] = MCPTool(
                    name=tool["name"],
                    description=tool.get("description", ""),
                    input_schema=tool.get("inputSchema", {})
                )
```

### 11.4.2 工具调用

```python
class MCPClient:
    async def call_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any]
    ) -> MCPResult:
        """
        调用 MCP 工具
        """
        if tool_name not in self._tools:
            raise MCPError(f"Tool not found: {tool_name}")
        
        request = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }
        
        await self._send(request)
        response = await self._recv()
        
        if "error" in response:
            raise MCPError(f"Tool call failed: {response['error']}")
        
        result = response["result"]
        return MCPResult(
            content=result.get("content", []),
            is_error=result.get("isError", False)
        )
```

## 11.5 MCP 工具适配器

### 11.5.1 适配为 DeerFlow Tool

```python
# packages/harness/deerflow/mcp/adapter.py

class MCPToolAdapter:
    """
    MCP 工具适配器 - 将 MCP 工具转换为 DeerFlow Tool
    """
    
    def __init__(self, mcp_client: MCPClient):
        self.client = mcp_client
    
    def adapt(self, mcp_tool: MCPTool) -> BaseTool:
        """
        将 MCP 工具适配为 DeerFlow BaseTool
        """
        tool_name = f"mcp_{self.client.config.name}_{mcp_tool.name}"
        
        # 动态创建 Tool 类
        tool_class = self._create_tool_class(
            name=tool_name,
            description=mcp_tool.description,
            input_schema=mcp_tool.input_schema,
            mcp_client=self.client,
            mcp_tool_name=mcp_tool.name
        )
        
        return tool_class()
    
    def _create_tool_class(
        self,
        name: str,
        description: str,
        input_schema: Dict,
        mcp_client: MCPClient,
        mcp_tool_name: str
    ):
        """动态创建 Tool 类"""
        
        @tool(name=name, description=description)
        class MCPDynamicTool:
            def __enter__(self):
                return self
            
            @classmethod
            def func(cls, **kwargs) -> str:
                """同步调用入口（DeerFlow 要求）"""
                return asyncio.run(
                    mcp_client.call_tool(mcp_tool_name, kwargs)
                )
        
        return MCPDynamicTool
```

### 11.5.2 工具注册

```python
async def load_mcp_tools(
    config: ExtensionsConfig
) -> List[BaseTool]:
    """
    加载所有 MCP 工具
    """
    all_tools = []
    
    for server_config in config.mcp_servers:
        if not server_config.enabled:
            continue
        
        try:
            # 1. 启动 MCP Client
            client = MCPClient(server_config)
            await client.start()
            
            # 2. 适配每个工具
            adapter = MCPToolAdapter(client)
            for mcp_tool in client.list_tools():
                tool = adapter.adapt(mcp_tool)
                all_tools.append(tool)
            
            logger.info(
                f"Loaded {len(client.list_tools())} tools "
                f"from MCP server: {server_config.name}"
            )
            
        except Exception as e:
            logger.error(
                f"Failed to load MCP server {server_config.name}: {e}"
            )
            continue
    
    return all_tools
```

## 11.6 MCP Server 实现

### 11.6.1 Server 骨架

```python
# 示例：自定义 MCP Server

from mcp.server import Server
from mcp.types import Tool, TextContent
from pydantic import AnyUrl

server = Server("custom-server")

@server.list_tools()
async def list_tools() -> List[Tool]:
    """列出可用工具"""
    return [
        Tool(
            name="query_database",
            description="执行数据库查询",
            inputSchema={
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "SQL 查询语句"
                    }
                },
                "required": ["sql"]
            }
        ),
        Tool(
            name="get_schema",
            description="获取数据库 Schema",
            inputSchema={
                "type": "object",
                "properties": {
                    "table": {
                        "type": "string",
                        "description": "表名"
                    }
                }
            }
        )
    ]

@server.call_tool()
async def call_tool(
    name: str,
    arguments: Dict[str, Any]
) -> List[TextContent]:
    """调用工具"""
    if name == "query_database":
        result = await query_database(arguments["sql"])
        return [TextContent(type="text", text=str(result))]
    
    elif name == "get_schema":
        result = await get_schema(arguments.get("table"))
        return [TextContent(type="text", text=str(result))]
    
    else:
        raise ValueError(f"Unknown tool: {name}")
```

### 11.6.2 多种传输方式配置

MCP 支持三种传输方式，通过 `type` 字段指定：

### stdio（标准输入输出）

默认传输方式，通过子进程启动 MCP Server：

```json
{
  "mcp_servers": [
    {
      "name": "filesystem",
      "type": "stdio",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      "args": ["/tmp"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  ]
}
```

### sse（Server-Sent Events）

连接到远程 SSE 服务器：

```json
{
  "mcp_servers": [
    {
      "name": "remote-sse-server",
      "type": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "X-API-Key": "$MCP_API_KEY"
      }
    }
  ]
}
```

### http（HTTP 直连）

直接通过 HTTP POST 调用：

```json
{
  "mcp_servers": [
    {
      "name": "http-api",
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer $API_TOKEN"
      }
    }
  ]
}
```

## 11.7 OAuth 认证支持

MCP HTTP/SSE 服务器支持 OAuth 2.0 认证，DeerFlow 提供完整的 Token 管理和自动刷新机制。

### 11.7.1 OAuthTokenManager 实现

```python
# packages/harness/deerflow/mcp/oauth.py

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

@dataclass
class _OAuthToken:
    """缓存的 OAuth Token"""
    access_token: str
    token_type: str
    expires_at: datetime


class OAuthTokenManager:
    """为 MCP 服务器获取/缓存/刷新 OAuth Token"""
    
    def __init__(self, oauth_by_server: dict[str, McpOAuthConfig]):
        self._oauth_by_server = oauth_by_server
        self._tokens: dict[str, _OAuthToken] = {}
        self._locks: dict[str, asyncio.Lock] = {
            name: asyncio.Lock() for name in oauth_by_server
        }
    
    @classmethod
    def from_extensions_config(cls, extensions_config: ExtensionsConfig) -> "OAuthTokenManager":
        """从配置创建 Token 管理器"""
        oauth_by_server: dict[str, McpOAuthConfig] = {}
        for server_name, server_config in extensions_config.get_enabled_mcp_servers().items():
            if server_config.oauth and server_config.oauth.enabled:
                oauth_by_server[server_name] = server_config.oauth
        return cls(oauth_by_server)
```

### 11.7.2 支持的授权模式

#### Client Credentials（客户端凭证模式）

适用于服务器间通信：

```json
{
  "mcp_servers": [
    {
      "name": "enterprise-api",
      "type": "http",
      "url": "https://api.company.com/mcp",
      "oauth": {
        "enabled": true,
        "grant_type": "client_credentials",
        "client_id": "$OAUTH_CLIENT_ID",
        "client_secret": "$OAUTH_CLIENT_SECRET",
        "token_url": "https://auth.company.com/oauth/token",
        "scope": "read write"
      }
    }
  ]
}
```

#### Refresh Token（刷新令牌模式）

适用于需要用户授权的场景：

```json
{
  "mcp_servers": [
    {
      "name": "user-service",
      "type": "sse",
      "url": "https://user-service.example.com/sse",
      "oauth": {
        "enabled": true,
        "grant_type": "refresh_token",
        "client_id": "$CLIENT_ID",
        "client_secret": "$CLIENT_SECRET",
        "refresh_token": "$REFRESH_TOKEN",
        "token_url": "https://oauth.example.com/token"
      }
    }
  ]
}
```

### 11.7.3 Token 自动刷新机制

```python
async def get_authorization_header(self, server_name: str) -> str | None:
    """获取授权头，自动处理 Token 刷新"""
    oauth = self._oauth_by_server.get(server_name)
    if not oauth:
        return None
    
    token = self._tokens.get(server_name)
    if token and not self._is_expiring(token, oauth):
        return f"{token.token_type} {token.access_token}"
    
    # 使用锁防止并发刷新
    lock = self._locks[server_name]
    async with lock:
        # 双重检查
        token = self._tokens.get(server_name)
        if token and not self._is_expiring(token, oauth):
            return f"{token.token_type} {token.access_token}"
        
        # 获取新 Token
        fresh = await self._fetch_token(oauth)
        self._tokens[server_name] = fresh
        logger.info(f"Refreshed OAuth token for MCP server: {server_name}")
        return f"{fresh.token_type} {fresh.access_token}"

@staticmethod
def _is_expiring(token: _OAuthToken, oauth: McpOAuthConfig) -> bool:
    """检查 Token 是否即将过期"""
    now = datetime.now(UTC)
    return token.expires_at <= now + timedelta(seconds=max(oauth.refresh_skew_seconds, 0))
```

### 11.7.4 OAuth 配置字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | boolean | ✅ | 是否启用 OAuth |
| `grant_type` | string | ✅ | 授权类型：`client_credentials` 或 `refresh_token` |
| `client_id` | string | 条件 | OAuth Client ID |
| `client_secret` | string | 条件 | OAuth Client Secret |
| `token_url` | string | ✅ | Token 端点 URL |
| `refresh_token` | string | 条件 | Refresh Token（refresh_token 模式必需） |
| `scope` | string | ❌ | 请求权限范围 |
| `audience` | string | ❌ | 目标受众标识 |
| `refresh_skew_seconds` | number | ❌ | 提前刷新时间（秒），默认 300 |
| `token_field` | string | ❌ | Token 字段名，默认 `access_token` |
| `token_type_field` | string | ❌ | Token 类型字段名，默认 `token_type` |
| `expires_in_field` | string | ❌ | 过期时间字段名，默认 `expires_in` |
| `default_token_type` | string | ❌ | 默认 Token 类型，默认 `Bearer` |
| `extra_token_params` | object | ❌ | 额外 Token 请求参数 |

## 11.8 MCP 工具缓存机制

为避免重复加载 MCP Server，DeerFlow 实现了多层级缓存机制。

### 11.8.1 缓存架构

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Tool Cache                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────┐ │
│  │  Memory Cache │───→│  Lazy Init   │───→│ Config Mtime│ │
│  │  (_mcp_tools) │    │   Support    │    │   Check    │ │
│  └──────────────┘    └──────────────┘    └────────────┘ │
│                                                          │
│  特性：                                                  │
│  • 应用级单例缓存                                        │
│  • 自动检测配置文件变更                                  │
│  • 支持同步/异步上下文懒加载                            │
│  • 线程安全的初始化                                      │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 11.8.2 MCPToolCache 实现

```python
# packages/harness/deerflow/mcp/cache.py

import asyncio
import os
from langchain_core.tools import BaseTool

# 全局缓存状态
_mcp_tools_cache: list[BaseTool] | None = None
_cache_initialized = False
_initialization_lock = asyncio.Lock()
_config_mtime: float | None = None


def _get_config_mtime() -> float | None:
    """获取配置文件修改时间"""
    from deerflow.config.extensions_config import ExtensionsConfig
    
    config_path = ExtensionsConfig.resolve_config_path()
    if config_path and config_path.exists():
        return os.path.getmtime(config_path)
    return None


def _is_cache_stale() -> bool:
    """检查缓存是否因配置文件变更而失效"""
    global _config_mtime
    
    if not _cache_initialized:
        return False
    
    current_mtime = _get_config_mtime()
    if _config_mtime is None or current_mtime is None:
        return False
    
    if current_mtime > _config_mtime:
        logger.info(f"MCP config modified, cache is stale")
        return True
    
    return False
```

### 11.8.3 工具初始化和懒加载

```python
async def initialize_mcp_tools() -> list[BaseTool]:
    """
    初始化并缓存 MCP 工具
    应在应用启动时调用一次
    """
    global _mcp_tools_cache, _cache_initialized, _config_mtime
    
    async with _initialization_lock:
        if _cache_initialized:
            logger.info("MCP tools already initialized")
            return _mcp_tools_cache or []
        
        from deerflow.mcp.tools import get_mcp_tools
        
        logger.info("Initializing MCP tools...")
        _mcp_tools_cache = await get_mcp_tools()
        _cache_initialized = True
        _config_mtime = _get_config_mtime()
        logger.info(f"MCP tools initialized: {len(_mcp_tools_cache)} tool(s)")
        
        return _mcp_tools_cache


def get_cached_mcp_tools() -> list[BaseTool]:
    """
    获取缓存的 MCP 工具（支持懒加载）
    自动处理配置文件变更检测和重新初始化
    """
    global _cache_initialized
    
    # 检查缓存是否失效
    if _is_cache_stale():
        logger.info("MCP cache is stale, resetting...")
        reset_mcp_tools_cache()
    
    if not _cache_initialized:
        logger.info("MCP tools not initialized, lazy loading...")
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # 在运行中的事件循环中（如 LangGraph Studio）
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as executor:
                    future = executor.submit(asyncio.run, initialize_mcp_tools())
                    future.result()
            else:
                loop.run_until_complete(initialize_mcp_tools())
        except RuntimeError:
            asyncio.run(initialize_mcp_tools())
        except Exception as e:
            logger.error(f"Failed to lazy-initialize MCP tools: {e}")
            return []
    
    return _mcp_tools_cache or []


def reset_mcp_tools_cache() -> None:
    """重置 MCP 工具缓存（用于测试或强制重载）"""
    global _mcp_tools_cache, _cache_initialized, _config_mtime
    _mcp_tools_cache = None
    _cache_initialized = False
    _config_mtime = None
    logger.info("MCP tools cache reset")
```

### 11.8.4 缓存失效策略

缓存会在以下情况下自动失效并重载：

1. **配置文件修改**：检测到 `extensions_config.json` 文件修改时间变化
2. **手动重置**：调用 `reset_mcp_tools_cache()`
3. **进程重启**：应用重启后重新初始化

```
Gateway API（进程 A）        LangGraph（进程 B）
       │                           │
       │  修改 extensions_config   │
       │──────────────────────────→│
       │                           │
       │                           ▼
       │                    检测 mtime 变化
       │                           │
       │                           ▼
       │                    自动重置缓存
       │                           │
       │                           ▼
       │                    下次调用时重载
```

## 11.9 工具名前缀处理

为避免不同 MCP Server 之间的工具名冲突，DeerFlow 自动为工具名添加前缀。

### 11.9.1 前缀格式

```
{server_name}_{original_tool_name}

示例：
• filesystem_read_file
• github_search_repositories
• slack_post_message
```

### 11.9.2 配置方式

在 `get_mcp_tools()` 中启用前缀：

```python
# packages/harness/deerflow/mcp/tools.py

client = MultiServerMCPClient(
    servers_config, 
    tool_interceptors=tool_interceptors, 
    tool_name_prefix=True  # 启用工具名前缀
)
```

如果不需要前缀（确保无冲突时），可以禁用：

```python
client = MultiServerMCPClient(
    servers_config,
    tool_name_prefix=False
)
```

## 11.10 错误处理和重试

### 11.10.1 连接错误处理

```python
# packages/harness/deerflow/mcp/tools.py

async def get_mcp_tools() -> list[BaseTool]:
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        logger.warning("langchain-mcp-adapters not installed")
        return []
    
    extensions_config = ExtensionsConfig.from_file()
    servers_config = build_servers_config(extensions_config)
    
    if not servers_config:
        logger.info("No enabled MCP servers configured")
        return []
    
    try:
        client = MultiServerMCPClient(servers_config, ...)
        tools = await client.get_tools()
        logger.info(f"Successfully loaded {len(tools)} tool(s)")
        return tools
    except Exception as e:
        logger.error(f"Failed to load MCP tools: {e}", exc_info=True)
        return []  # 优雅降级：返回空列表而非抛出异常
```

### 11.10.2 工具调用错误处理

```python
def _make_sync_tool_wrapper(coro: Callable[..., Any], tool_name: str) -> Callable[..., Any]:
    """为异步工具创建同步包装器，包含错误处理"""
    
    def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        
        try:
            if loop is not None and loop.is_running():
                # 使用线程池避免嵌套事件循环问题
                future = _SYNC_TOOL_EXECUTOR.submit(asyncio.run, coro(*args, **kwargs))
                return future.result()
            else:
                return asyncio.run(coro(*args, **kwargs))
        except Exception as e:
            logger.error(f"Error invoking MCP tool '{tool_name}': {e}", exc_info=True)
            raise  # 抛出具体错误供上层处理
    
    return sync_wrapper
```

### 11.10.3 配置验证错误

```python
# packages/harness/deerflow/mcp/client.py

def build_server_params(server_name: str, config: McpServerConfig) -> dict[str, Any]:
    transport_type = config.type or "stdio"
    
    if transport_type == "stdio":
        if not config.command:
            raise ValueError(f"MCP server '{server_name}' with stdio transport requires 'command' field")
        # ...
    elif transport_type in ("sse", "http"):
        if not config.url:
            raise ValueError(f"MCP server '{server_name}' with {transport_type} transport requires 'url' field")
        # ...
    else:
        raise ValueError(f"MCP server '{server_name}' has unsupported transport type: {transport_type}")
```

### 11.10.4 错误处理策略总结

| 错误类型 | 处理方式 | 日志级别 |
|----------|----------|----------|
| 依赖缺失 | 返回空列表，记录警告 | WARNING |
| 配置错误 | 抛出异常，阻止启动 | ERROR |
| 连接失败 | 记录错误，跳过该服务器 | ERROR |
| 工具调用失败 | 抛出异常，由 Agent 处理 | ERROR |
| Token 刷新失败 | 抛出异常，中断请求 | ERROR |

## 11.11 常用 MCP Servers

### 11.11.1 文件系统

```bash
npx -y @modelcontextprotocol/server-filesystem /path/to/allowed/directory
```

**工具：**
- `read_file` - 读取文件
- `read_multiple_files` - 批量读取
- `write_file` - 写入文件
- `edit_file` - 编辑文件
- `create_directory` - 创建目录
- `list_directory` - 列出目录

### 11.11.2 GitHub

```bash
npx -y @modelcontextprotocol/server-github
# 需要 GITHUB_PERSONAL_ACCESS_TOKEN 环境变量
```

**工具：**
- `search_repositories` - 搜索仓库
- `get_file_contents` - 获取文件内容
- `create_or_update_file` - 创建/更新文件
- `list_pull_requests` - 列出 PR
- `create_pull_request` - 创建 PR

### 11.11.3 Slack

```python
# 需要 SLACK_BOT_TOKEN 环境变量
python -m mcp_server_slack
```

**工具：**
- `post_message` - 发送消息
- `search_messages` - 搜索消息
- `list_channels` - 列出频道
- `get_channel_history` - 获取频道历史

### 11.11.4 PostgreSQL

```bash
npx -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb
```

**工具：**
- `query` - 执行查询
- `execute` - 执行 DDL/DML
- `list_tables` - 列出表

## 11.12 二次开发：SwarmMind MCP 集成

### 11.12.1 企业数据库 MCP Server

```python
# swarmmind/mcp/enterprise_db.py

from mcp.server import Server
from mcp.types import Tool, TextContent
import asyncpg

server = Server("enterprise-db")

class EnterpriseDBServer:
    """
    企业数据库 MCP Server
    支持：
    - 租户隔离
    - SQL 审计
    - 权限控制
    """
    
    def __init__(self, tenant_resolver: TenantResolver):
        self.tenant_resolver = tenant_resolver
        self.pool: asyncpg.Pool = None
    
    async def connect(self, dsn: str):
        """建立连接池"""
        self.pool = await asyncpg.create_pool(
            dsn,
            min_size=5,
            max_size=20
        )
    
    @server.list_tools()
    async def list_tools(self) -> List[Tool]:
        return [
            Tool(
                name="query",
                description="执行只读查询",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "sql": {
                            "type": "string",
                            "description": "SELECT 查询语句"
                        },
                        "params": {
                            "type": "array",
                            "description": "查询参数"
                        }
                    },
                    "required": ["sql"]
                }
            ),
            Tool(
                name="get_table_info",
                description="获取表结构信息",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "schema": {"type": "string"},
                        "table": {"type": "string"}
                    },
                    "required": ["schema", "table"]
                }
            )
        ]
    
    @server.call_tool()
    async def call_tool(
        self,
        name: str,
        arguments: Dict[str, Any]
    ) -> List[TextContent]:
        tenant = self.tenant_resolver.get_current()
        
        async with self.pool.acquire() as conn:
            # 注入租户过滤
            if name == "query":
                sql = self._add_tenant_filter(
                    arguments["sql"],
                    tenant.tenant_id
                )
                
                # 审计日志
                await self.audit_log.log(
                    event_type=AuditEventType.DATA_READ,
                    sql=sql,
                    tenant_id=tenant.tenant_id
                )
                
                results = await conn.fetch(sql, *arguments.get("params", []))
                return [TextContent(type="text", text=json.dumps(results))]
            
            elif name == "get_table_info":
                # 仅返回有权限的表信息
                allowed = await self._get_allowed_tables(tenant)
                schema = arguments["schema"]
                table = arguments["table"]
                
                if table not in allowed.get(schema, []):
                    raise PermissionError(f"No access to {schema}.{table}")
                
                info = await self._fetch_table_info(conn, schema, table)
                return [TextContent(type="text", text=json.dumps(info))]
```

### 11.12.2 企业内部 API MCP Server

```python
# swarmmind/mcp/corporate_api.py

class CorporateAPIServer:
    """
    企业内部 API MCP Server
    """
    
    def __init__(
        self,
        api_base: str,
        auth_handler: CorporateAuth
    ):
        self.api_base = api_base
        self.auth = auth_handler
    
    @server.list_tools()
    async def list_tools(self) -> List[Tool]:
        return [
            Tool(
                name="search_documents",
                description="搜索企业文档",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "filters": {
                            "type": "object",
                            "properties": {
                                "department": {"type": "string"},
                                "doc_type": {"type": "string"}
                            }
                        }
                    },
                    "required": ["query"]
                }
            ),
            Tool(
                name="get_employee",
                description="查询员工信息",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "employee_id": {"type": "string"}
                    }
                }
            ),
            Tool(
                name="submit_expense",
                description="提交报销申请",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "amount": {"type": "number"},
                        "category": {"type": "string"},
                        "description": {"type": "string"},
                        "receipts": {"type": "array"}
                    },
                    "required": ["amount", "category"]
                }
            )
        ]
    
    @server.call_tool()
    async def call_tool(
        self,
        name: str,
        arguments: Dict[str, Any]
    ) -> List[TextContent]:
        tenant = self.tenant_resolver.get_current()
        token = await self.auth.get_token(tenant)
        
        headers = {
            "Authorization": f"Bearer {token}",
            "X-Tenant-ID": tenant.tenant_id
        }
        
        async with aiohttp.ClientSession() as session:
            if name == "search_documents":
                resp = await session.post(
                    f"{self.api_base}/documents/search",
                    json=arguments,
                    headers=headers
                )
            
            elif name == "get_employee":
                resp = await session.get(
                    f"{self.api_base}/employees/{arguments['employee_id']}",
                    headers=headers
                )
            
            elif name == "submit_expense":
                resp = await session.post(
                    f"{self.api_base}/expenses",
                    json=arguments,
                    headers=headers
                )
            
            data = await resp.json()
            return [TextContent(type="text", text=json.dumps(data))]
```

## 11.13 小结

| 主题 | 说明 |
|------|------|
| **MCP 协议** | 标准化的 AI 与外部工具连接协议 |
| **DeerFlow 支持** | 原生集成，通过 extensions_config.json 配置 |
| **传输方式** | 支持 stdio、sse、http 三种传输 |
| **OAuth 认证** | 支持 client_credentials 和 refresh_token 模式，自动刷新 |
| **工具缓存** | 内存缓存 + 配置文件变更检测 + 懒加载 |
| **工具名前缀** | 自动添加 `{server_name}_` 前缀避免冲突 |
| **错误处理** | 优雅降级、详细日志、配置验证 |
| **常用 Servers** | 文件系统、GitHub、Slack、PostgreSQL |
| **SwarmMind 扩展** | 企业数据库、企业 API |

MCP 是 DeerFlow 扩展能力的核心途径。通过完善的 OAuth 支持、缓存机制和错误处理，SwarmMind 可以稳定、高效地集成各类 MCP Server，实现与企业现有系统的无缝连接。
