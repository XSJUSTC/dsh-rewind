# @xsj/dsh-rewind

[English](./README_EN.md) | 简体中文

DSH（[DeepSeek Harness](https://github.com/deepseek-ai)）会话回退插件。永久 bundle 插件：宿主机半 + Web 客户端半，零依赖、零构建步骤。

## 功能

- 每条用户消息的操作行（复制图标旁）出现 **↺ 回退** 图标。点击后：
  - 若模型正在思考/输出，**立即打断**当前回合；
  - 该消息及其后的所有内容在聊天视图中隐藏（如同从未发生）；
  - 该消息文本自动填入输入框，**未发送、可编辑**；
  - 下一次发送时，模型只看到截断后的历史（回退点之前）+ 新消息。
- 回退待发送期间：
  - 输入框上方出现提示横幅；
  - **发送按钮左侧出现 ✕「取消回溯」**：点击后恢复被隐藏的消息，草稿保持不变，不发送任何内容。
- 发送后（回退生效）：被隐藏的消息永远不再出现在聊天视图，也不再进入模型上下文。
- 仅用户消息可回退；DSH（助手）消息没有回退入口（Host 侧强制校验事件类型）。

## 日志与可恢复性

- 会话日志（append-only 事件流）**从不删除任何原始消息**。
- 每次状态变化追加一条 `hook/invoked` 事件，负载为
  `{ source: 'xsj.rewind', phase: 'mark' | 'cancel' | 'commit', targetSeq, hiddenFrom?, hiddenTo?, preview? }`。
  该事件类型属于本构建的已知保留词条（无读写方），重载安全。
- 进程重启后打开会话，Host 半会回放这些记录重建隐藏区间：模型侧与 UI 侧的隐藏状态跨重启保持一致。
- 「轨迹」视图不渲染该保留事件类型；审计请直接查看会话 JSONL 日志。

## 安装

```powershell
# 在任意目录执行（路径指向本仓库克隆位置）：
dsh plugin --profile web add <本仓库目录的绝对路径>

# 重启 DSH 进程，并刷新浏览器页面
```

该命令会把包登记进 profile（`~/.dsh/profiles/<name>/package.json` 的
`dependencies` + `dsh.profile.bundles`），profile 启动时合并本包的
`cordis.patch.yml` 插入宿主机插件行，Web 客户端扫描自动加载 `lib/client.js`。

## 卸载

```powershell
dsh plugin --profile web remove @xsj/dsh-rewind
# 重启 DSH。会话日志中的 rewind 记录无害保留（hook/invoked 为已知类型）。
```

## 实现要点

- **模型侧截断**：按需修补 live `Session` 对象的 `deriveMessages()`，按已提交区间过滤
  surface 节点（带签名缓存）。请求构建、`llm/stream` 重放不变量、图片检查全部走同一入口，天然一致。
  日志不增删改任何消息事件。
- **打断**：mark 时若代理正在运行，`agent.cancel({ kind: 'user' }, { keepInbox: true })`
  中断当前回合；排队消息保留，随后从截断点继续。
- **生效点**：`agent/pre-step` 瀑布中，待回退会话一旦有新输入消息进入步骤即提交隐藏区间
  `[targetSeq, 当前日志末尾]`；新消息在此之后追加，不受影响。
- **UI 隐藏**：聊天行包裹元素带 `data-chat-flow-key`，插件按隐藏集合动态维护一条
  `display:none` 样式；取消/切换会话即还原，不改动任何既有渲染器。
- **回退图标**：以 priority `-1` 接管 `conversation.chat.node` 的 `user`/`steering`
  渲染器（槽位系统的原生遮蔽机制），行内复刻原生气泡（MessageText / ImageGallery /
  Tooltip / writeClipboard），追加 ↺ 按钮。

## 移植

本插件无任何 npm 依赖：Host 半只用 Node 内置模块与注入服务，Client 半经
`window.__ModuleLoader__` 从外壳的冻结模块表取 `react` /
`@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-ui-attachment`。
克隆本仓库到任意机器后按「安装」一节操作即可。

## License

[MIT](./LICENSE)
