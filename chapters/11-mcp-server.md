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

### 11.6.2 OAuth 支持

MCP 支持 OAuth 认证流程：

```json
{
  "mcp_servers": [
    {
      "name": "google-drive",
      "command": ["npx", "-y", "@modelcontextprotocol/server-google-drive"],
      "args": [],
      "oauth": {
        "client_id": "$GOOGLE_CLIENT_ID",
        "client_secret": "$GOOGLE_CLIENT_SECRET",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "scopes": [
          "https://www.googleapis.com/auth/drive.readonly"
        ]
      }
    }
  ]
}
```

## 11.7 常用 MCP Servers

### 11.7.1 文件系统

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

### 11.7.2 GitHub

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

### 11.7.3 Slack

```python
# 需要 SLACK_BOT_TOKEN 环境变量
python -m mcp_server_slack
```

**工具：**
- `post_message` - 发送消息
- `search_messages` - 搜索消息
- `list_channels` - 列出频道
- `get_channel_history` - 获取频道历史

### 11.7.4 PostgreSQL

```bash
npx -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb
```

**工具：**
- `query` - 执行查询
- `execute` - 执行 DDL/DML
- `list_tables` - 列出表

## 11.8 二次开发：SwarmMind MCP 集成

### 11.8.1 企业数据库 MCP Server

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

### 11.8.2 企业内部 API MCP Server

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

## 11.9 小结

| 主题 | 说明 |
|------|------|
| **MCP 协议** | 标准化的 AI 与外部工具连接协议 |
| **DeerFlow 支持** | 原生集成，通过 extensions_config.json 配置 |
| **工具加载** | 动态发现、适配、注册 |
| **OAuth 支持** | 企业级认证（可选） |
| **常用 Servers** | 文件系统、GitHub、Slack、PostgreSQL |
| **SwarmMind 扩展** | 企业数据库、企业 API |

MCP 是 DeerFlow 扩展能力的核心途径，SwarmMind 可以通过自定义 MCP Server 无缝集成企业现有系统。
