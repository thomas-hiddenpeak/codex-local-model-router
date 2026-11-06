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
- **本地思考展示**：将本地 vLLM 的明文 `reasoning_text` 转成带“思考过程”标题的
  `reasoning_summary_text` 事件与 `summary_text` 项，供桌面端按思考标题展示和折叠。
  标题是展示标签，后面保留完整原文；后续推理和压缩前会还原原始 reasoning。
  这不减少思考 token，也不增加摘要模型调用。正文、工具调用和云端响应保持原有语义；
  已保存的旧思考块不会被改写。具体默认展开状态仍由桌面端决定。
- **跨模型切换清洗**：同对话先用本地模型再切 GPT 模型时，本地 vLLM 产生的
  reasoning 项（无 `encrypted_content`）会被 ChatGPT 后端 400/404 拒绝。
  router 转发 ChatGPT 后端前剔除这类项；切回本地时移除云端加密 reasoning，
  保留可见消息与工具结果。跨后端不尝试解密对方的私有推理内容。
- **真实摘要与可恢复检查点**：收到 V2 `compaction_trigger` 或
  `/v1/responses/compact` 时，router 调用**当前选中的模型和后端**生成续接摘要。
  摘要覆盖任务目标、约束、文件修改、工具结果、验证状态和后续步骤。
  本地模型仅输出明文 reasoning 而未生成助手正文时，也会保留其可见分析；
  reasoning 中已有的可见摘要同样参与压缩，不向模型重放私有密文或 reasoning ID。
  长历史分块处理，合并前一轮摘要并保留重叠；不静默截断历史。
  每块最多 32,000 个字符，本地摘要初始输出预算为 8,192 token（包含推理 token）；
  仅在明确耗尽输出预算时，对同一块以 16,384 token 重试一次，并累计两次实际 usage。
  再次失败则保留原始历史，不将未完成正文写入检查点。
  成功后将摘要用 AES-256-GCM 加密为带版本的 compaction 项。
  后续转发到**任一后端**前，router 将检查点恢复为普通的历史摘要消息，
  因此本地→GPT→本地以及重复压缩都能携带摘要。恢复消息使用 user 角色并标明
  “历史数据”，不把历史中的不可信内容提升为系统指令。
  本地和 GPT 路由都使用这条摘要路径，避免新产生的检查点被锁定在某个后端。
  摘要生成会增加当前后端的推理调用和费用；返回的 usage 汇总实际生成调用。
- **失败保留历史**：空摘要、未完成响应、上游错误或超时不会返回成功检查点。
  长压缩每 10 秒发送进行中事件；若之后失败，发送带上游原因的 `response.failed`，
  让 Codex 识别真正的失败，避免将被忽略的通用 error 事件误报成流提前关闭。
  上游返回 SSE 但遗漏或误标 `Content-Type` 时，按实际事件帧识别流，仍要求明确的
  completed 终止事件；不能把 SSE 当作普通 JSON 解析。
  客户端取消时取消对应摘要请求。损坏、密钥不匹配或无法恢复的检查点返回 409，
  不会悄悄删掉后继续生成。
- **鉴权注入**：ChatGPT 后端路由若请求缺 `Authorization`（如 local_vlm 免鉴权
  provider 发出的请求），自动注入 `~/.codex/auth.json` 的 access_token。
- **调试落盘**：`CODEX_ROUTER_LOG=1` 每行请求日志；`CODEX_ROUTER_DUMP=<dir>`
  落盘完整请求/响应（`<ts>_<model>.req.json` / `.resp.<code>`）。

### 检查点恢复、备份和限制

- 默认密钥文件为 `~/.codex/model-router/state/summary-key`；首次创建的目录权限为
  0700，密钥文件为 0600。直接启动 router 时可用 `CODEX_ROUTER_STATE_DIR` 指定状态目录。
  检查点自身携带加密摘要，不依赖进程内缓存或额外的摘要数据库。
  这是路由器的私有检查点格式，恢复必须经过持有原密钥的 router，不能直接发往模型服务。
- 重启、重装覆盖脚本后，只要保留同一密钥就可以恢复已有检查点。
  迁移机器需要同时迁移会话及该状态目录。**备份状态目录；不要将密钥提交到 Git。**
  当前 `--uninstall` 会删除整个 router 目录，也会删除默认密钥；卸载前需要自行备份。
- 旧版固定占位符 `router_local_compaction_v1` 原本就没有摘要，无法事后恢复。
  遇到它默认明确报错，需要从压缩前的原始会话记录恢复，不能靠生成新密钥修复。
  若任务压缩后反复从查看仓库、阅读同一批文档开始，应核对保存的 compaction
  是否仍是该占位符。重新达到 token 阈值不等于压缩接口重试；可能是丢失进展后
  重复探索。升级前应先保留原始会话记录，已有空检查点不会随升级自动补出摘要。
  暂停受影响的会话、备份原始记录并人工核对续接摘要后，可显式执行：

  ```bash
  node tools/recover-legacy.js --state-dir ~/.codex/model-router/state \
    --thread-id THREAD_ID --summary-file /absolute/path/summary.txt \
    --source-file /absolute/path/original-rollout.jsonl
  ```

  工具生成加密恢复文件并记录原始记录的 SHA256，拒绝覆盖已有恢复文件。
  router 仅在请求的 thread/session ID 与该文件一致时恢复旧占位符；其他会话仍然拒绝。
  后续成功压缩产生普通新版检查点后，不再依赖这份会话专用恢复文件。
- 既有的云端原生 compaction 只能由原云端解码。可在原云端模型上通过新版 router
  再压缩一次，转换为可跨后端恢复的检查点；直接切到本地会返回 409。
  若不能在云端重放，可由维护者备份并审阅原始未压缩记录、重建续接摘要后，使用上面的
  恢复命令加 `--native-checkpoint-file /absolute/path/native-item.json`。
  这会建立仅对指定 thread ID 和该密文 SHA256 生效的本地恢复记录，绝不解密云端内容、
  不修改原会话，也不对其他云端检查点放行。摘要是人工核对后的语义重建；缺少完整原始
  记录时不能据此声称无损恢复。该会话在本地成功压缩一次后便使用普通可恢复检查点。
- 压缩需要完整 `input`，不支持只凭 `previous_response_id` 获取隐含历史。
  图片会作为历史附件交给当前后端；音频/文件压缩尚未支持，会明确拒绝。
- 这是模型生成的语义摘要，不是无损转录或加密 token 重放。摘要质量依赖所选模型；
  测试覆盖协议、保存恢复和上下文传递，并不保证任意模型都能保留每个细节。

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
| `remote compaction v2 expected exactly one compaction output item` | 检查 router 的压缩响应；新版仅在摘要成功后返回一个 compaction 输出项 |
| 409 checkpoint/key/legacy placeholder | 检查点损坏、密钥缺失/不匹配，或旧占位符无法恢复；恢复原状态目录或压缩前的会话记录 |
| Summary backend / incomplete / empty 错误 | 摘要没有完成，不会产生成功检查点；保留原历史，排查模型后端后重试 |
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
| 长对话压缩 | 已用真实模型请求替代固定占位符，增加加密检查点与持久密钥。隔离测试验证任务约束、助手记录和工具结果在压缩、重启后可恢复；实际模型的摘要质量仍需在工作端点空闲时验证。 |
| 同会话跨模型切换 | 新检查点由 router 恢复为历史文本，覆盖本地→GPT→本地、重复压缩和恢复会话。既有云端原生检查点需在原云端转换，不能直接交给本地解码。 |
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

### 隔离回归检查

```bash
bash -n install.sh
node --test tests/*.test.js
# 可选：同时使用已安装的真实 Codex CLI 验证压缩、模型切换和会话恢复
CODEX_TEST_BINARY="$(command -v codex)" node --test tests/*.test.js
```

测试直接提取安装脚本实际发布的 router，使用临时端口、临时状态目录与确定性的本地
模拟后端。覆盖五种请求编码、鉴权边界、分块摘要、损坏/丢失检查点、失败/取消、长时间
压缩的 SSE 进度，以及本地/GPT 双向切换和重启恢复。

CLI 测试使用独立 `CODEX_HOME`，通过实际 `app-server` 发起工具调用、压缩、切换和恢复，
唯一工具命令是固定的 `printf`。它检查助手新增的记录和工具实际输出在旧历史被过滤后
仍然到达下一模型。不会连接生产模型、读取真实登录态或修改当前服务；临时产物位于
忽略的 `.q3x-work/`，测试结束清理。

2026-11-06 使用 Codex CLI 0.164.0 完成该隔离验证。它验证实际 CLI 与路由器的协议和
上下文恢复，不构成真实 vLLM/GPT 推理质量的实测；为避免影响正在运行的任务，本轮没有
部署或调用工作中的模型端点。安装末尾的真实请求也携带两个 selector，防止简单 ping
漏过此前的 `include` 问题。

## License

MIT
