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
| vLLM | 任意 OpenAI 兼容端点（`/v1/responses` 或 `/v1/chat/completions` 均可，codex 用 responses API） |
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
| `AUTO_COMPACT_TOKEN_LIMIT` | `212992` | 自动压缩阈值（≈ 92% 窗口） |
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
- **跨模型切换清洗**：同对话先用本地模型再切 GPT 模型时，本地 vLLM 产生的
  reasoning 项（无 `encrypted_content`）会被 ChatGPT 后端 400/404 拒绝。
  router 转发 ChatGPT 后端前剔除这类项；本地路由保留。
- **V2 远程压缩协议**：codex 对 openai provider 判定支持 V2 远程压缩，上下文快满时
  在 input 末尾追加 `compaction_trigger` 要求后端返回恰好一个
  `{"type":"compaction","encrypted_content":...}` 输出项（否则 fatal error）。
  本地 vLLM 满足不了；router 对本地路由**直接合成**该 SSE 响应——
  因为客户端 `build_v2_compacted_history` 在本地重建历史，`encrypted_content`
  对客户端只是不透明 token。后续请求带回的 compaction 项转发 vLLM 前剔除。
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

- 在 codex CLI 0.159.0 / 0.162.0 上验证。
- 内置 catalog 每次安装时用当前 codex 版本的 `codex debug models` 重新提取，
  升级 codex 后重跑 `./install.sh` 即可同步新模型列表。
- 若未来 codex 变更压缩协议或请求体编码，只需改 install.sh 内嵌的 router JS
  （行为说明见上文"router 关键行为"）。

## License

MIT
