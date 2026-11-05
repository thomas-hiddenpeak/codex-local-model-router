# codex-local-model-router

一键为 [codex CLI](https://github.com/openai/codex) 添加**本地 vLLM 模型**，
让本地模型与 OpenAI/ChatGPT 模型出现在**同一个 TUI 模型选择器**里自由切换。

官方目前不支持多 provider 同 picker（[openai/codex#46484](https://github.com/openai/codex/issues/46484)），
本方案用一个零依赖的本地 HTTP 路由（node）实现：

```
codex CLI (单一 openai provider)
   │  openai_base_url = http://127.0.0.1:4141/v1
   ▼
codex-model-router (node, 127.0.0.1:4141, systemd user service)
   │  按请求体里的 model 名前缀路由
   ├── "RM-01*"  ──────────► 本地 vLLM (http://<vllm-host>:58000/v1, 免鉴权)
   └── 其他 (gpt-*, ...) ──► ChatGPT 后端 (透传登录态)
```

## 需求

| 组件 | 要求 |
|---|---|
| node | ≥ 23.8（需原生 `zlib.zstdDecompressSync`）。**缺失时自动安装**：PATH 已有 → 直接用；否则 nvm（若已装）→ 官方 tarball 到 `~/.codex/model-router/runtime/node`（免 root） |
| codex CLI | 较新版本（需 `codex debug models` 命令，0.159+ 已验证）。**缺失时自动 `npm install -g @openai/codex`**，必要时链接到 `~/.local/bin` |
| vLLM | 必须支持 `/v1/responses`；只有 `/v1/chat/completions` 的端点不能直接使用，本路由不转换两种协议 |
| 登录态 | `~/.codex/auth.json`（ChatGPT 登录，兜底路由 GPT 模型需要；仅用本地模型可无） |
| systemd | 可选；无 systemd user 时自动回退 nohup |
| 网络 | 自动安装时需要能访问 nodejs.org / npmjs.org（或配置代理） |

## 安装

```bash
git clone https://github.com/thomas-hiddenpeak/codex-local-model-router.git
cd codex-local-model-router

# 默认参数 (vLLM=http://192.168.0.159:58000/v1, 模型名="RM-01 VLM")
./install.sh

# 或按目标环境传参
VLLM_URL=http://10.0.0.5:8000/v1 \
MODEL_NAME="MY-LLM" \
CONTEXT_WINDOW=131072 \
./install.sh
```

脚本是**幂等**的，可重复执行（重跑会重启服务、刷新 catalog、合并 config）。

### 参数（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `VLLM_URL` | `http://192.168.0.159:58000/v1` | vLLM OpenAI 兼容端点 |
| `MODEL_NAME` | `RM-01 VLM` | picker 里显示的模型名 |
| `MODEL_MATCH` | `MODEL_NAME` 首个空白分隔 token | 路由前缀（`RM-01`） |
| `ROUTER_PORT` | `4141` | router 监听端口 |
| `CONTEXT_WINDOW` | `262144` | 模型上下文窗口 |
| `AUTO_COMPACT_TOKEN_LIMIT` | `212992` | 自动压缩阈值（默认窗口的 81.25%） |
| `CHATGPT_TARGET` | `https://chatgpt.com/backend-api/codex` | 兜底后端 |

### 安装后生效

config 与 catalog 只在 app-server 进程启动时加载一次：

```bash
# 退出当前 TUI, 杀掉旧 app-server, 重启
pkill -f 'codex.*app-server'; pkill -f code-mode-host
codex        # 或你的启动方式, 如 codex --yolo
```

## 脚本做了什么

1. **前置检查**：node zstd 支持、codex CLI、vLLM 可达、ChatGPT 登录态（缺失仅警告）、端口占用
2. **安装 router**：`~/.codex/model-router/codex-router.js`（零依赖 node，内嵌于 install.sh）
3. **安装服务**：systemd user service `codex-model-router`（日志落盘 `~/.codex/model-router/router.log`；无 systemd 回退 nohup；提示 `loginctl enable-linger`）
4. **生成合并 catalog**：`~/.codex/model-catalog.merged.json`
   = `CODEX_HOME=<空目录> codex debug models` 提取的**纯内置** GPT 条目（随 codex 版本自动更新）
   + 本地模型条目（reasoning 档 none/low/medium/xhigh、上下文窗口、压缩阈值等）
5. **更新 `~/.codex/config.toml`**（先备份）：
   `model` / `model_provider` / `openai_base_url` / `model_catalog_json` 四个顶层 key
   + `[model_providers.local_vlm]` 段（指向 router，防止 app-server 对部分模型绕过 router）
6. **验证**：router `/health` + 经 router 向本地模型发一次真实请求

## router 关键行为（踩坑记录）

这些行为都来自真实排障，移植到新环境时**不要删**：

- **请求体智能解压**：codex 客户端默认用 **zstd** 压缩请求体且不一定带
  `content-encoding` 头。router 依次探测 identity/zstd/brotli/gzip/deflate，
  以"能 JSON.parse"为准。只信头或只试 gzip 都会导致 model 解析失败 → 兜底路由 → 400。
- **WS upgrade 回 426**：codex 先试 WebSocket，router 一律回 `426 Upgrade Required`
  让它回退 HTTPS（上游均不走 ws）。日志里的 426 是预期行为。
- **本地 `include` 兼容**：启用 output token replay 的 Codex 会发送
  `include: ["reasoning.encrypted_content", "output.encrypted_content"]`。
  部分 vLLM 的 Responses schema 不接受第二项。router 仅在本地路由过滤
  `output.encrypted_content`，保留其他 selector；ChatGPT 路由继续透传。
  这处理的是可选的加密输出请求，不是改名为 reasoning 或改写模型输入。
- **跨模型切换清洗**：同对话先用本地模型再切 GPT 模型时，本地 vLLM 产生的
  reasoning 项（无 `encrypted_content`）会被 ChatGPT 后端 400/404 拒绝。
  router 转发 ChatGPT 后端前剔除这类项；本地路由保留。
- **V2 远程压缩协议**：codex 对 openai provider 判定支持 V2 远程压缩，上下文快满时
  在 input 末尾追加 `compaction_trigger` 要求后端返回恰好一个
  `{"type":"compaction","encrypted_content":...}` 输出项（否则 fatal error）。
  本地 vLLM 满足不了；router 对本地路由**直接合成占位 SSE 响应**。
  **该实现没有生成摘要，不能保证压缩后保留工作上下文。** Codex 在重建历史时
  会移除部分助手消息和工具历史，再附加 compaction 项；固定占位符无法补回
  被移除的信息，后续还会在转发 vLLM 前被剔除。此路径目前只解决协议校验，
  真正的语义压缩和跨后端恢复仍待实现，不能把它当作长任务连续性保证。
- **鉴权注入**：ChatGPT 后端路由若请求缺 `Authorization`（如 local_vlm 免鉴权
  provider 发出的请求），自动注入 `~/.codex/auth.json` 的 access_token。
- **调试落盘**：`CODEX_ROUTER_LOG=1` 每行请求日志；`CODEX_ROUTER_DUMP=<dir>`
  落盘完整请求/响应（`<ts>_<model>.req.json` / `.resp.<code>`）。

## 排查

```bash
systemctl --user status codex-model-router   # 服务状态
tail -f ~/.codex/model-router/router.log     # 请求日志
ls ~/.codex/model-router/dump/               # 完整请求/响应落盘
curl http://127.0.0.1:4141/health            # router 健康
codex doctor                                 # codex 侧诊断
```

常见错误对照：

| 现象 | 原因 |
|---|---|
| 所有请求 400 `{"detail":"Bad Request"}` | model 解析失败走了兜底路由；查 router.log 的 `decoded body` 行，确认 node zstd 支持 |
| 400 `body.include.1` / `output.encrypted_content` | vLLM schema 不支持客户端的加密输出 selector；更新本路由后再发请求 |
| 切 GPT 模型 400 `Unknown parameter: input[N].status` | 外来 reasoning 项未剔除（router 版本过旧） |
| `remote compaction v2 expected exactly one compaction output item` | router 未实现 V2 压缩合成（版本过旧） |
| 部分模型 401 | app-server 走了 local_vlm provider 直连；确认 `[model_providers.local_vlm].base_url` 指向 router |
| TUI 菜单不刷新 | app-server 未重启（config 只在进程启动时加载） |

## 卸载

```bash
./install.sh --uninstall
```

停服务、删 systemd unit 与 `~/.codex/model-router/`。`config.toml` 需手动移除
4 个 key + `[model_providers.local_vlm]` 段（脚本会打印清单；每次修改前都有
`config.toml.bak-<时间戳>` 备份可对照）。

## 版本兼容

- 早期安装记录在 codex CLI 0.159.0 / 0.162.0 上验证。
- 2026-11-06：codex CLI 0.164.0 环境中复现上述 `include` 错误，过滤后真实本地
  流式请求返回 HTTP 200 / `response.completed` / `OK`，原出错任务也已恢复。
  这验证了当前调用链，未覆盖长对话压缩、所有工具或所有模型切换组合。
- 内置 catalog 每次安装时用当前 codex 版本的 `codex debug models` 重新提取，
  重跑安装可以刷新列表，但也会覆盖 router、改写 config 并重启路由服务；
  应在相关任务退出后执行，不能用它热更新正在工作的会话。

### 近期版本与后续调整评估（2026-11-06）

官方最新稳定版为 [0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0)；
另有 0.167 / 0.168 预发布版本。以下区分源码核对和实机验证，不承诺未来版本兼容：

| 边界 | 评估与处理 |
|---|---|
| 加密输出 selector | 0.164 / 0.166 源码在 `output_token_replay` 启用且 provider 为 OpenAI 时添加第二项；本次修复仅过滤本地后端不支持的该项。无需全局关闭功能，也不应删除所有未知字段。 |
| 0.165 起的 reasoning effort 更新 | 本地 catalog 已设 `supports_reasoning_effort_updates: false`，继续用请求级参数，避免向不支持的后端发送 `configuration_update`。保留 `supports_reasoning_summary_parameter: false` 与 `use_responses_lite: false`，直到后端能力被验证。 |
| 0.166 的传输与 catalog | 源码仍明确支持 426 后回退 HTTP，因此目前不需要实现 WebSocket 转发。新增模型与 catalog 元数据需要随 CLI 更新；0.166 只完成源码核对，尚未安装验证。 |
| 长对话压缩：最高优先级 | 0.164 / 0.166 的历史重建会移除助手/工具项，依赖真正的 compaction 内容补回。应实现可恢复的真实摘要，或让本地会话使用 CLI 的本地压缩路径；固定占位符不能视为完成。验收必须检查压缩前的任务约束、文件修改和工具结果在压缩后仍可用。 |
| 同会话跨模型切换 | 已有本地→GPT reasoning 清洗；仍需覆盖 GPT→本地、压缩后切换、恢复会话等组合。跨后端的不透明加密内容需按来源恢复，不能仅凭存在 `encrypted_content` 就假定目标后端可解码。 |
| 登录态 | 新版本使用共享运行时鉴权，凭据也可能存在 keyring。优先透传 CLI 的 Authorization 与账号头；只读 `~/.codex/auth.json` 的补注入仅是兜底，不能当作通用登录态接口。 |
| 更新与回归 | 后续宜增加独立的 catalog 刷新命令和 CLI/后端版本诊断。升级前覆盖普通流式回复、工具调用、多轮、切换和压缩；通过后再更新工作环境。 |

核对依据：[0.164 请求构造](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/client.rs#L1075)、
[0.166 能力定义](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/protocol/src/openai_models.rs#L493)、
[0.166 历史重建及其测试](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/compact_remote_v2.rs#L480)、
[官方更新记录](https://learn.chatgpt.com/docs/changelog)。

另外检查了上游开发快照
[`119a547a3134`](https://github.com/openai/codex/tree/119a547a31342b0c64fb15d2f6782f303bc3a5b7)：
该快照仍有相同的加密 selector 条件，并新增可选 `prompt_cache_options`、媒体与待处理消息的
压缩保留逻辑、catalog 元数据等变化。它们属于开发中的协议演进，不等于已发布承诺。
应继续按后端实际 schema 和语义做定向适配，避免一律删除新字段。
原生多 provider 同 picker 的
[功能请求仍未关闭](https://github.com/openai/codex/issues/46484)，暂时没有据此移除路由器的依据。

### 离线回归检查

```bash
bash -n install.sh
node --test tests/router-compat.test.js
```

测试直接提取安装脚本实际发布的 router，覆盖五种请求编码、本地 selector 过滤、
ChatGPT 透传、鉴权边界、UTF-8 Content-Length 与旧请求兼容；不启动服务、不读取登录态、
不访问 GPU 或外部模型。安装末尾的真实请求也携带两个 selector，防止简单 ping 漏过此次问题。

## License

MIT
