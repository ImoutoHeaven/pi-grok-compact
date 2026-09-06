# Pi Grok compaction

为 Pi 的 `grok-*` 模型提供 xAI 服务端压缩，使用 `openai-responses` transport。
支持通过 CLIProxyAPI 使用 SuperGrok 订阅，以及提供 xAI Responses compact endpoint 的其他服务；provider 名称与认证来源由 Pi 配置决定。
Checkpoint 投影使用会话摘要标记与保留消息指纹，相关衍生代码遵循 [MIT 许可](LICENSE) 中的版权声明。

## 使用

在 Pi 模型配置中为 Grok 设置当前 CLIProxy 的 `baseUrl`、密钥和 `api: "openai-responses"`。
例：`baseUrl` 为 `http://127.0.0.1:8317/v1`，模型 ID 为 `grok-4.6`。

从此目录启动一次加载扩展的 Pi：

```sh
pi -e ./src/index.ts
```

Pi 的 `/compact` 与自动压缩事件均调用此扩展。自动触发时机由现有 Pi
`compaction.reserveTokens` 设置决定；应在模型上下文窗口内预留压缩空间。
现有 GPT compaction 扩展可同时加载，分别处理 `gpt-*` 与 `grok-*`。

需要跨目录加载时，将本扩展的绝对路径加入 Pi 用户设置 `extensions` 数组，
例如 `/path/to/pi-grok-compaction/src/index.ts`，替换为实际安装路径。恢复已压缩会话时持续加载本扩展。

## 请求和状态

- 压缩：同一 `baseUrl` 下的 `POST /responses/compact`，提交 Responses `input`、
  模型 ID 和 Pi 会话 `prompt_cache_key`，认证使用 Pi 解析后的密钥与请求头。
- 压缩输出：验证完整 `output` 是单个含非空 `encrypted_content` 的 `compaction` 项，
  原样写入 Pi compaction entry 的 `details`，包括提供方附加字段。
- 后续推理：仍调用原 `/responses`，以完整 opaque output 为输入开头，随后发送当前
  system/developer 指令和新增消息。已进入压缩项的旧历史由 checkpoint 替换。
- 再次压缩：提交上次 opaque output 与之后累积的内容。
- 恢复范围：checkpoint 绑定 provider、模型 ID、Responses API 和规范化端点地址。
  切换路由时 Pi 显示提示及保留的近期消息；回到原路由可恢复 opaque 回放。
- 失败、取消或请求期间切换会话：取消本次压缩，保留原会话。
  请求超时为 5 分钟，响应上限为 8 MiB，失败后可手动重试 `/compact`。

CLIProxyAPI 负责订阅凭据及其上游分流，扩展通过标准 `/responses/compact` 请求执行压缩。

## 离线验证

```sh
bash scripts/check.sh
```

脚本以只读方式挂载源码，在一次性 Node 24 Docker 容器中安装固定版本的开发依赖、
检查 TypeScript，并运行 Node 自带测试。Pi 版本为 0.84.2。
测试覆盖真实 Pi SessionManager 的 JSONL 写入与重开、Responses transport 请求重写、
重复压缩、工具消息配对、路由隔离、错误与取消。模型响应使用本地测试数据。
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
