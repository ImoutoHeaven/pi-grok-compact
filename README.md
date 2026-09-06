# Pi Grok compaction

为 Pi 的 `grok-*` 模型提供原生 xAI 服务端压缩，以及免费 OAuth 或明确能力拒绝时的 Pi 内置摘要回退，使用 `openai-responses` transport。
支持 Pi 官方 xAI OAuth 登录、`pi-grok` 等第三方 OAuth 登录插件，以及 CLIProxyAPI 等 Responses 中转；provider 名称与认证来源由 Pi 配置决定。
采用 [MIT 许可](LICENSE)。

## 使用

选择 `grok-*` 模型并配置 `api: "openai-responses"`。
直接 OAuth 连接通过 `/login` 登录；API key 或中转连接使用对应的 `baseUrl` 和密钥。
CLIProxy 的本地地址示例为 `http://127.0.0.1:8317/v1`。

从此目录启动一次加载扩展的 Pi：

```sh
pi -e ./src/index.ts
```

Pi 的 `/compact` 与自动压缩事件均调用此扩展。自动触发时机由 Pi
`compaction.reserveTokens` 设置决定；应在模型上下文窗口内预留压缩空间。
可与仅处理 `gpt-*` 的 compaction 扩展同时加载；每个模型应由一个扩展负责压缩。

需要跨目录加载时，将本扩展的绝对路径加入 Pi 用户设置 `extensions` 数组，
例如 `/path/to/pi-grok-compaction/src/index.ts`，替换为实际安装路径。恢复已压缩会话时持续加载本扩展。

## OAuth 账户

通过 Pi 的 `/login` 登录官方 xAI provider 或第三方插件提供的 xAI provider。
登录、令牌存储和刷新由原 provider 管理。所选模型需使用 `api: "openai-responses"`；
Pi 0.84.2 的部分内置 Grok 模型默认使用 Chat Completions，需要配置其 Responses transport。

| 账户与连接方式 | 压缩 | 后续推理与恢复 |
| --- | --- | --- |
| 直接 OAuth，Free 或 X Basic | Pi 内置 prompt-summary | CLI chat proxy `/v1/responses`，回放可读摘要 |
| 直接 OAuth，付费账户 | 官方 xAI `/v1/responses/compact` | 携带原生 checkpoint 时使用官方 `/v1/responses`；普通请求沿用 provider 路由 |
| 直接 OAuth，等级未知 | 尝试官方 xAI `/v1/responses/compact` | 原生压缩成功后，checkpoint 恢复走官方 `/v1/responses` |
| API key 或第三方中转 | 当前端点 `/responses/compact` | 当前端点 `/responses` |

直接 OAuth 路由适用于 Pi 确认使用 OAuth，且模型端点是 `api.x.ai/v1` 或
`cli-chat-proxy.grok.com/v1` 的连接。中转的凭据与上游账户策略由中转管理。

账户等级取自 Pi 解析出的 OAuth JWT `tier`；Free 和 X Basic 进入摘要回退。
原生压缩的权限由服务端验证。免费账户的 CLI 请求使用 provider 提供的客户端版本，
或 `PI_XAI_CLIENT_VERSION`，默认 `0.2.101`。

Pi 内置 prompt-summary 通过普通 Responses 请求由远端模型生成可读摘要，
Pi 负责组织提示词、保存摘要和管理后续上下文。

checkpoint 使用 v2 格式，`authKind` 记录 Pi 的认证类型，包括自定义 OAuth 中转。

| checkpoint 状态 | 恢复条件 |
| --- | --- |
| v2，`authKind: "non-oauth"` | provider、模型和端点匹配 |
| v2，`authKind: "oauth"`，账户指纹已知 | OAuth 登录与账户指纹匹配 |
| v2，`authKind: "oauth"`，账户指纹未知 | OAuth 登录；每个会话、checkpoint 提示一次身份核对限制 |
| v1，含 `oauthAccount` | 按 OAuth 读取，要求账户指纹匹配 |
| v1，认证来源未知 | 阻止自动回放和再次压缩；通过 Pi `/tree` 选择压缩前节点后创建 v2 checkpoint |

native checkpoint 要求具备原生压缩权限的账户；免费账户使用可读摘要会话。
会话日志保留在磁盘上。

认证与 checkpoint 检查使用每次请求的会话数据。`/reload`、会话关闭和恢复时，
扩展管理自身的 transport 包装，保留 provider 的登录与刷新配置。

## 能力拒绝与摘要回退

直接 OAuth 账户尚无 native checkpoint 时，明确的 compact entitlement 拒绝或
endpoint 不支持会交给 Pi 内置摘要。未知等级先尝试 native；能力拒绝只影响压缩策略。
摘要请求沿用 provider 的普通推理路径，已识别的免费账户使用 CLI chat proxy。

能力拒绝缓存限定在会话、模型、端点和访问凭据，保留 5 分钟。
凭据变化、会话切换或 `/reload` 可重新探测；缓存只保存凭据哈希，存放在内存中。

持有 native checkpoint 时，能力拒绝会取消压缩并保留会话。凭据拒绝、额度耗尽、速率限制、
普通访问拒绝、模型不存在、传输失败和响应损坏同样保留错误，供用户处理后重试。

## 请求和状态

- 原生压缩：根据上表选择 `POST /responses/compact`，提交 Responses `input`、
  模型 ID 和 Pi 会话 `prompt_cache_key`，认证使用 Pi 解析后的密钥与请求头。
- 压缩输出：验证完整 `output` 是单个含非空 `encrypted_content` 的 `compaction` 项，
  原样写入 Pi compaction entry 的 `details`，包括提供方附加字段。
- 原生恢复：根据上表选择 `/responses`，以完整 opaque output 为输入开头，随后发送当前
  system/developer 指令和新增消息。checkpoint 替代已经压缩的对话内容。
- 再次压缩：提交上次 opaque output 与之后累积的内容。
- 恢复范围：checkpoint 绑定 provider、模型 ID、Responses API 和规范化端点地址。
  切换路由时 Pi 显示提示及保留的近期消息；回到原路由可恢复 opaque 回放。
- 失败、取消或请求期间切换会话：取消本次压缩，保留原会话。
  请求超时为 5 分钟，响应上限为 8 MiB，失败后可手动重试 `/compact`。

## 离线验证

```sh
bash scripts/check.sh
```

脚本以只读方式挂载源码，在一次性 Node 24 Docker 容器中安装固定版本的开发依赖、
检查 TypeScript，并运行 Node 自带测试。Pi 版本为 0.84.2。
测试覆盖真实 Pi SessionManager 的 JSONL 写入与重开、Responses transport 请求重写、
重复压缩、工具消息配对、路由隔离、错误与取消，以及 OAuth 刷新、原生恢复路径、
免费账户的 Pi 内置摘要、能力拒绝缓存、认证来源保护、v1/v2 校验和第三方 provider
注册兼容性，以及 Pi runner 失效后的重载、fork 与恢复。自动化脚本的模型响应使用测试数据。

付费 OAuth 的真实接口验证覆盖普通推理、原生压缩、`/reload` 后恢复和新 session ID
恢复；恢复请求以原样 opaque checkpoint 承载早期验证信息。免费账户与第三方中转的
验证范围为离线协议和 Pi 会话行为。

## 协议依据

- [xAI Context Compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction)：
  opaque output 替换旧会话，并作为下一次请求的开头。
- [CLIProxyAPI compact handler](https://github.com/router-for-me/CLIProxyAPI/blob/c76dfd4e0edabab9000628b1560ab8ab379eadb8/sdk/api/handlers/openai/openai_responses_handlers.go#L560)：
  非流式 `/responses/compact` 转交模型执行器。
- [CLIProxyAPI xAI compact executor](https://github.com/router-for-me/CLIProxyAPI/blob/c76dfd4e0edabab9000628b1560ab8ab379eadb8/internal/runtime/executor/xai_executor_execute.go#L139)：
  使用 xAI compact 地址与代理管理的凭据。
- [CLIProxyAPI xAI 路由](https://github.com/router-for-me/CLIProxyAPI/blob/c76dfd4e0edabab9000628b1560ab8ab379eadb8/internal/runtime/executor/xai_executor_request.go#L226)：
  普通订阅推理和官方 compact 上游分别选择地址。
- [Grok Build 账户分类](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/tier.rs)：
  Free 与 X Basic 为受限账户等级。
- [Sub2API 账户等级映射](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/xai/subscription_tier.go)：
  JWT 数字等级与账户名称的对应关系。
