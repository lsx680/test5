# codearts-req-mcp-server

华为云 CodeArts 需求管理（Req）的本地 **stdio** MCP Server，基于官方 `@modelcontextprotocol/sdk`，封装两个工具：

| 工具 | 能力 | 对应 API |
| --- | --- | --- |
| `create_project` | 创建项目 | `POST /v4/project` |
| `list_projects` | 查询项目列表 | `GET /v4/projects` |

鉴权采用 **AK/SK 签名**（`SDK-HMAC-SHA256` 算法），每个请求携带 `Authorization` 与 `X-Sdk-Date` 请求头。

## 目录结构

```
codearts-req-mcp-server/
├── server.mjs          # MCP Server 主文件（可直接运行，同时导出处理函数供测试）
├── server.test.mjs     # 配套测试（node:test，76 个用例）
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

## 一、安装依赖

要求 **Node.js ≥ 18**（推荐 20/22/24），仅一个运行时依赖：

```bash
cd codearts-req-mcp-server
npm install
```

网络较慢时可使用华为云镜像：

```bash
npm install --registry=https://repo.huaweicloud.com/repository/npm/
```

## 二、环境变量

| 变量名 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `CODEARTS_REQ_ENDPOINT` | 是 | CodeArts Req 终端节点，需以 `http://` 或 `https://` 开头 | `https://projectman-ext.cn-north-4.myhuaweicloud.com` |
| `CODEARTS_REQ_AK` | 是 | 华为云访问密钥 Access Key Id | 控制台「我的凭证 → 访问密钥」获取 |
| `CODEARTS_REQ_SK` | 是 | 华为云访问密钥 Secret Access Key | 与 AK 配对，创建时仅显示一次 |
| `CODEARTS_REQ_PROXY` | 否 | SOCKS5 代理，形如 `socks5://127.0.0.1:10808`；不配置则直连 | `socks5://127.0.0.1:10808` |

> AK/SK 为长期有效凭证，不会像 IAM Token 一样 24 小时过期，请妥善保管。

获取方式：登录华为云控制台 → 右上角头像 →「我的凭证」→「访问密钥」→「新增访问密钥」，下载 `credentials.csv` 后填入 AK 与 SK。

## 三、启动命令

Server 通过 **stdio** 与 MCP 客户端通信，标准输出仅用于 JSON-RPC，启动日志写入标准错误。

macOS / Linux / Git Bash：

```bash
export CODEARTS_REQ_ENDPOINT=https://projectman-ext.cn-north-4.myhuaweicloud.com
export CODEARTS_REQ_AK=<你的 Access Key Id>
export CODEARTS_REQ_SK=<你的 Secret Access Key>
node server.mjs
```

Windows PowerShell：

```powershell
$env:CODEARTS_REQ_ENDPOINT = "https://projectman-ext.cn-north-4.myhuaweicloud.com"
$env:CODEARTS_REQ_AK = "<你的 Access Key Id>"
$env:CODEARTS_REQ_SK = "<你的 Secret Access Key>"
node server.mjs
```

也可以使用 npm 脚本（环境变量需提前配置）：

```bash
npm start
```

> 注意：`npm start` 会先向**标准输出**打印两行脚本横幅（`> codearts-req-mcp-server@1.0.0 start`、`> node server.mjs`）。这不是 Server 的输出，但会干扰按行解析的 stdio 客户端。人工确认时可用 `npm start --silent`；作为 MCP 客户端的 `command` 启动时，请直接使用 `node server.mjs`，不要使用 `npm start`。

单独启动后终端保持等待输入、没有界面输出，这是正常现象；实际使用时由 MCP 客户端拉起进程并按协议通信。

## 四、码道（CodeArts）配置

编辑工作区的 `.codeartsdoer/mcp/mcp_settings.json`，在 `mcpServers` 中加入（路径替换为本机仓库绝对路径，Windows 建议使用正斜杠或双反斜杠）：

```json
{
  "mcpServers": {
    "codearts-req": {
      "command": "node",
      "args": [
        "C:/Users/<用户名>/codearts-case-basics-res-2/codearts-req-mcp-server/server.mjs"
      ],
      "env": {
        "CODEARTS_REQ_ENDPOINT": "https://projectman-ext.cn-north-4.myhuaweicloud.com",
        "CODEARTS_REQ_AK": "<你的 Access Key Id>",
        "CODEARTS_REQ_SK": "<你的 Secret Access Key>"
      },
      "disabled": false,
      "timeout": 30000
    }
  }
}
```

需要代理时在 `env` 中追加：

```json
"CODEARTS_REQ_PROXY": "socks5://127.0.0.1:10808"
```

保存后码道会重新加载 MCP 服务；若未生效，重启 IDE。工具在码道中的调用名通常带服务名前缀，即 `codearts-req_create_project` 与 `codearts-req_list_projects`。

> `command` 必须是 `node`，`args` 直接指向 `server.mjs`。不要写成 `npm` / `npm start`，否则 npm 的脚本横幅会混入 stdout，破坏 JSON-RPC 通信。

## 五、工具说明

### create_project

创建 CodeArts 需求管理项目。

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `project_name` | string | 是 | 1-128 字符 | 项目名称 |
| `project_type` | string | 是 | `scrum` / `normal` / `xboard` / `basic` / `phoenix` / `ipd` | 项目类型 |
| `description` | string | 否 | - | 项目描述 |
| `enterprise_id` | string | 否 | - | 企业项目 ID |
| `source` | string | 否 | 0-64 字符 | 来源标识 |
| `template_id` | integer | 否 | `10001` / `10002` / `10003` | IPD 模板 ID；`project_type=ipd` 时必传 |

返回字段：`project_id`、`project_num_id`、`project_name`、`project_type`、`user_num_id`。
响应缺少这些字段时原样返回接口数据，避免丢失信息。

示例（码道中输入）：

> 在 CodeArts 创建一个名为「支付网关重构」的 scrum 项目，描述为「2026 Q4 重构项目」

### list_projects

查询项目列表。

| 参数 | 类型 | 必填 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `offset` | integer | 否 | 0 | 0-10000，须为 `limit` 的整数倍 | 分页偏移量 |
| `limit` | integer | 否 | 10 | 1-1000 | 每页数量 |
| `search` | string | 否 | - | - | 项目名称搜索关键字 |
| `project_type` | string | 否 | - | `scrum` / `normal` / `xboard` | 项目类型 |
| `sort` | string | 否 | - | `字段:asc` 或 `字段:desc`，逗号分隔，最多 4 组 | 排序 |
| `archive` | boolean | 否 | - | - | 是否查询已归档项目 |
| `query_type` | string | 否 | - | `domain_projects` / `absent` | 查询范围 |

返回：`projects` 数组与 `total` 总数。

示例：

> 查询 CodeArts 中 scrum 类型的前 20 个项目，按名称升序

## 六、错误处理

所有错误均返回 `isError: true` 的结构化中文提示，不会静默吞错，也不会导致进程崩溃：

| `error_code` | 触发条件 |
| --- | --- |
| `INVALID_ARGUMENTS` | 参数缺失、类型错误、越界或枚举不匹配 |
| `MISSING_CONFIG` | 缺少 `CODEARTS_REQ_ENDPOINT` / `CODEARTS_REQ_AK` / `CODEARTS_REQ_SK`，或终端节点非法 |
| `NETWORK_ERROR` | 网络异常、请求超时、代理异常、响应体为空或不是合法 JSON |
| 接口返回的 `error_code` | 华为云 API 报错时原样透传，同时附带 `error_msg`、`http_status` |
| `INTERNAL_ERROR` | 处理过程中的未预期异常（兜底，保证服务不崩溃） |

错误响应示例：

```json
{
  "error": true,
  "error_code": "INVALID_ARGUMENTS",
  "error_msg": "参数校验失败：\n1. project_name 必填，且为 1-128 字符的字符串"
}
```

API 报错示例（HTTP 400）：

```json
{
  "error": true,
  "error_code": "PM.00000001",
  "error_msg": "param error",
  "http_status": 400,
  "api_response": {
    "error_code": "PM.00000001",
    "error_msg": "param error"
  }
}
```

## 七、签名实现说明

签名流程与华为云官方 SDK 完全一致：

1. 规范化 URI：按 `/` 分段编码后拼接，并补全结尾 `/`（如 `/v4/project/`）。
2. 规范化查询串：参数名与值按 RFC 3986 编码（与 SDK 一致保留 `+`），按键、值字典序排序。
3. 规范化请求头：仅签 `host;x-sdk-date`，`host` 包含非默认端口。
4. 请求体哈希：对 JSON 字符串做 SHA-256；GET 为空串哈希。
5. 待签字符串：`SDK-HMAC-SHA256\n{X-Sdk-Date}\n{SHA256(CanonicalRequest)}`，用 SK 做 HMAC-SHA256。
6. 请求头：`Authorization: SDK-HMAC-SHA256 Access={AK}, SignedHeaders=host;x-sdk-date, Signature={签名}`、`X-Sdk-Date: YYYYMMDDTHHmmssZ`。

签名结果已与 `@huaweicloud/huaweicloud-sdk-core` 的 `AKSKSigner` 逐字节比对通过（覆盖 GET、POST、中文与空格参数、带端口场景）。

## 八、测试

```bash
npm test
```

使用 Node.js 内置 `node:test`，共 76 个用例，覆盖：

- 两个工具的参数边界、默认值、枚举与 `ipd` 模板校验
- 配置缺失、端点格式非法
- AK/SK 签名构造（URI/查询串规范化、`host` 端口、请求体参与签名）
- API 成功、API 错误透传、非 JSON 错误响应、空响应
- 网络异常、超时、代理配置非法
- 工具路由与工具清单 schema

## 九、常见问题

| 现象 | 排查方向 |
| --- | --- |
| `error_code` 为 `401` / `APIGW.0301` | AK/SK 填错、AK 与 SK 不配对，或系统时间偏差超过 15 分钟 |
| `error_code` 为 `403` | 账号无 CodeArts Req 权限，或未开通需求管理服务 |
| `NETWORK_ERROR` 且提示域名解析失败 | `CODEARTS_REQ_ENDPOINT` 区域写错，或需要配置代理 |
| 客户端提示无法连接 MCP Server | `args` 中的 `server.mjs` 绝对路径不正确，或 `node` 不在 PATH |
| `npm start` 启动后 stdout 出现两行 `> ...` | npm 自身的脚本横幅，不是 Server 输出；客户端配置请改用 `node server.mjs`，人工启动可用 `npm start --silent` |
| 工具列表为空 | 配置文件 JSON 格式错误，或修改后码道未重载 |

## 十、安全提示

- AK/SK 属于长期凭证，切勿提交到 Git、写入代码或粘贴到公开文档
- 建议为本实践单独创建最小权限的 IAM 用户与访问密钥，用完及时停用
- `.gitignore` 已排除 `node_modules/`、`.env` 与本地账号文件