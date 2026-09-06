# Pi Grok compaction

为 Pi 的 `grok-*` 模型提供原生 xAI 服务端压缩和免费 OAuth 账户的 Pi 内置摘要回退，使用 `openai-responses` transport。
支持 Pi 官方 xAI OAuth 登录、`pi-grok` 等第三方 OAuth 登录插件，以及 CLIProxyAPI 等 Responses 中转；provider 名称与认证来源由 Pi 配置决定。
Checkpoint 投影使用会话摘要标记与保留消息指纹，相关衍生代码遵循 [MIT 许可](LICENSE) 中的版权声明。

## 使用

选择 `grok-*` 模型并配置 `api: "openai-responses"`。
直接 OAuth 连接通过 `/login` 登录；API key 或中转连接使用对应的 `baseUrl` 和密钥。
CLIProxy 的本地地址示例为 `http://127.0.0.1:8317/v1`。

从此目录启动一次加载扩展的 Pi：

```sh
pi -e ./src/index.ts
```

Pi 的 `/compact` 与自动压缩事件均调用此扩展。自动触发时机由现有 Pi
`compaction.reserveTokens` 设置决定；应在模型上下文窗口内预留压缩空间。
现有 GPT compaction 扩展可同时加载，分别处理 `gpt-*` 与 `grok-*`。

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
`cli-chat-proxy.grok.com/v1` 的连接。摘要回退适用于明确识别的直接免费 OAuth 账户；
中转的凭据与上游账户策略由中转管理。

账户等级取自 Pi 当前解析出的 OAuth JWT `tier`；Free 和 X Basic 进入摘要回退。
原生压缩的权限由服务端验证。免费账户的 CLI 请求使用 provider 已有的客户端版本，
或 `PI_XAI_CLIENT_VERSION`，默认 `0.2.101`。

Pi 内置 prompt-summary 通过普通 Responses 请求由远端模型生成可读摘要，
Pi 负责组织提示词、保存摘要和管理后续上下文。

OAuth 原生 checkpoint 在可获得账户标识时保存其哈希，并使用刷新后的凭据恢复。
切换账户、改用 API key 或降为免费账户后，已有的此类 checkpoint 要求恢复原付费登录；
会话保留在磁盘上。免费账户创建的摘要会话可正常继续。

## 请求和状态

- 原生压缩：根据上表选择 `POST /responses/compact`，提交 Responses `input`、
  模型 ID 和 Pi 会话 `prompt_cache_key`，认证使用 Pi 解析后的密钥与请求头。
- 压缩输出：验证完整 `output` 是单个含非空 `encrypted_content` 的 `compaction` 项，
  原样写入 Pi compaction entry 的 `details`，包括提供方附加字段。
- 原生恢复：根据上表选择 `/responses`，以完整 opaque output 为输入开头，随后发送当前
  system/developer 指令和新增消息。已进入压缩项的旧历史由 checkpoint 替换。
- 再次压缩：提交上次 opaque output 与之后累积的内容。
- 恢复范围：checkpoint 绑定 provider、模型 ID、Responses API 和规范化端点地址。
  切换路由时 Pi 显示提示及保留的近期消息；回到原路由可恢复 opaque 回放。
- 失败、取消或请求期间切换会话：取消本次压缩，保留原会话。
  请求超时为 5 分钟，响应上限为 8 MiB，失败后可手动重试 `/compact`。

原生压缩失败时保留历史并提示原因，区分凭据拒绝、权限不足、付费额度耗尽和免费用量耗尽。

## 离线验证

```sh
bash scripts/check.sh
```

脚本以只读方式挂载源码，在一次性 Node 24 Docker 容器中安装固定版本的开发依赖、
检查 TypeScript，并运行 Node 自带测试。Pi 版本为 0.84.2。
测试覆盖真实 Pi SessionManager 的 JSONL 写入与重开、Responses transport 请求重写、
重复压缩、工具消息配对、路由隔离、错误与取消，以及 OAuth 刷新、原生恢复路径、
免费账户的 Pi 内置摘要和第三方 provider 注册兼容性。模型响应使用本地测试数据。
当前验证范围为离线协议与 Pi 会话行为；真实订阅链路的端到端兼容性仍需实测确认。

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
