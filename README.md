# dsh-subagent-cursor

DeepSeek Harness **0.2.2-rc.3** 的 Cursor CLI 子代理插件。复用官方 Codex 插件的 Provider / Run / Wire 分层、全局委派工具、共享 JSON-RPC transport 和受管进程生命周期。

固定行为：每次任务启动新的 Cursor ACP 进程和 session，启动参数带 **`--force`**；结束、失败或取消后的资源清理会先等待受管进程全部退出，再删除本次 session 的原生目录。

## 安装

可直接从 GitHub 安装：

```powershell
dsh plugin --profile desktop add github:AshenJyy/dsh-subagent-cursor
```

也可下载仓库 `dist/` 中的 [TGZ 安装包](https://github.com/AshenJyy/dsh-subagent-cursor/raw/refs/heads/main/dist/dsh-subagent-cursor-0.2.2-rc.3.tgz)。

交付的 `dsh-subagent-cursor-0.2.2-rc.3.tgz` 已包含编译后的 JavaScript，无需构建。把安装包放在可访问的路径后，用 Harness 的插件安装命令添加，例如：

```powershell
dsh plugin --profile desktop add 'C:\path\to\dsh-subagent-cursor-0.2.2-rc.3.tgz'
```

把 `desktop` 换成实际使用的 Profile（例如 `web`）。按照安装器提示重启对应 Profile。包会注册 `cursor` Provider 和 `subagent_cursor` 全局工具。

需要本机已有 Cursor CLI，并已通过原生 CLI 登录；插件不会打开登录浏览器。仅适用于与插件同一台机器上的本地 `dsh-subprocess-local`。不要配合远程 subprocess Provider 使用，因为 CLI 查找和 session 删除在本地进行。

Windows 默认从 `%LOCALAPPDATA%\cursor-agent\versions` 选择已安装的最新有效载荷，直接执行该版本 `node.exe + index.js`，不调用可能触发自动更新的 `.cmd/.ps1` 包装脚本。其他平台使用原生 `cursor-agent` / `agent`。不下载或安装 Cursor。

## 配置

安装 Bundle 后，可在插件配置中设置 `cliPath`、`model` 等字段。手工挂载时，Profile 的 `cordis.patch.yml` 可使用下面两行（已安装 Bundle 时不要重复插入）：

```yaml
- insert:
    - id: subagent-cursor
      name: dsh-subagent-cursor
      config:
        providerName: cursor
        cliPath: 'C:\Users\YOUR_USER\AppData\Local\cursor-agent'
        disposeGraceMs: 3000
        # model: 你的 Cursor 原生模型 ID
    - id: tool-subagent-cursor
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: cursor
        toolName: subagent_cursor
        maxDepth: provider-managed
```

如需手工挂载，使用包内 `cordis.patch.yml` 的两条 `insert` 行，给 Provider 行添加 `config` 即可。`cliPath` 可省略；也可指定某个固定版本目录。`model` 省略时沿用 Cursor 的原生模型选择。`providerName` 改名时，应同步修改工具行的 `provider`。

`env` 为显式子进程环境覆盖，应用于 Harness 的凭据过滤之后。需要环境变量认证时，必须在该字段显式提供 `CURSOR_API_KEY` 等值；不要将密钥放入命令行参数。配置和原生登录沿用 Cursor；插件不读取或复制凭据文件。

`--force` 始终启用，不提供关闭开关；不额外传入 `--sandbox disabled`，也不绕过 Cursor 本身的团队限制。仍到达 ACP 客户端的工具权限请求选择 `allow_once`，不写入永久授权；提问返回 `skipped`，计划创建返回 `accepted`。

## 生命周期与 session 删除

1. 通过 `ctx.subprocess.spawn()` 启动 `agent --force [--model MODEL] acp`。
2. ACP v1 `initialize`，然后 `session/new`；只有取得合法的新 session ID 后才发布 `SubagentRun`。
3. 单次 `session/prompt`，只收集该 session 的回答文本；思考、工具输入输出和原始 stderr 不进入父 Agent 的结果。
4. 以 `session/prompt` 的 `stopReason` 作为任务终点，映射到 Harness 的标准结果。
5. Harness 管理器调用幂等 `dispose()`，发送取消、关闭协议、终止受管进程范围并等待退出。
6. 删除 `CURSOR_CONFIG_DIR/acp-sessions/<本次 session UUID>`，包括该目录内的数据库文件；删除失败作为清理错误报告。

配置目录遵循 Cursor 原生优先级：`CURSOR_CONFIG_DIR`，其次 `XDG_CONFIG_HOME/cursor`，最后用户主目录下 `.cursor`。启动和清理使用同一个固定绝对路径。只删除本次返回且启动前不存在的 UUID 目录，拒绝路径越界和 session 目录符号链接；不清空 `acp-sessions`，不删除其他聊天和工作区文件。

若整个 Harness 被强制杀死、磁盘拒绝删除，或 Cursor 在返回新 session ID 之前崩溃，插件无法保证清理完成。不会通过扫描并删除其他会话来猜测归属。Cursor 的其他产品日志、计划文件或工作区修改不属于这里删除的 session 存储。

## 与官方 Codex 版一致及不同之处

- 保留 `NO_START_CAPABILITIES`、`inheritsParentContext: false`、`settleRunResult`、`subprocessRunHandle`、`JsonRpcLineTransport` 及 `maxDepth: provider-managed`。
- 每次新进程、新会话、单次任务；不续接、不池化、不继承父聊天记录。工作目录默认由 Harness 从父任务解析。
- 模型是 Provider 实例的固定配置；不暴露动态模型选择、父预设继承或结构化输出能力。
- Cursor ACP 没有 Codex 的 `final_answer` 阶段标记：按新工具调用及可选 message ID 分段，选择最后非空回答段。没有可靠分段事件时保留该轮聚合回答，不能保证与 Codex 的回答筛选字节级一致。
- 依赖本机 Cursor，无法像 Codex 原插件一样内置固定原生载荷。本次代码参考 Cursor `2026.11.11-b912975` 的 ACP 实现；固定某个版本目录可避免自动选到后续版本。

## 源码与打包

`src/index.ts` 注册 Provider；`src/run.ts` 管理运行和资源所有权；`src/wire.ts` 适配 ACP；`src/cli.ts` 定位已安装 CLI；`src/session.ts` 删除本次 session。

```powershell
node scripts/build.mjs
npm pack --ignore-scripts
```

构建器使用 Node.js 24+ 自带的 TypeScript 转换功能，无构建依赖；只转换类型语法，不做类型检查。包中的外部 DSH 依赖固定为 `0.2.2-rc.3`，Cordis / Schemastery 使用该标签对应的版本。

**按委托要求，本交付只进行了编码、转译和打包，没有运行测试、类型检查、插件加载或真实模型任务，也没有安装到运行中的 Harness。兼容性目标为 0.2.2-rc.3，运行行为尚未经测试验证。**
