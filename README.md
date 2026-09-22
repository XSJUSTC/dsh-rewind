# @xsj/dsh-rewind

[English](./README_EN.md) | 简体中文

DSH（[DeepSeek Harness](https://github.com/deepseek-ai)）会话回退插件。永久 bundle 插件：宿主机半 + Web 客户端半，零依赖、零构建步骤。

## 功能

- 每条用户消息的操作行（复制图标旁）出现 **↺ 回退** 图标。点击后：
  - 若模型正在思考/输出，**立即打断**当前回合；
  - 该消息及其后的所有内容在聊天视图中隐藏（如同从未发生）；
  - 该消息文本自动填入输入框，**未发送、可编辑**；
  - 该消息携带的**图片也会重新挂回输入框**（从会话日志读回原始字节，走官方附件入档流程，自动套用图片数量/大小限制）；
  - 下一次发送时，模型只看到截断后的历史（回退点之前）+ 新消息。
- 回退待发送期间：
  - 输入框上方出现提示横幅；
  - **发送按钮左侧出现 ✕「取消回溯」**：点击后恢复被隐藏的消息，草稿保持不变，不发送任何内容。
- 发送后（回退生效）：被隐藏的消息永远不再出现在聊天视图，也不再进入模型上下文。
- 仅用户消息可回退；DSH（助手）消息没有回退入口（Host 侧强制校验事件类型）。

## 版本兼容性

- **v2.4.0 实测支持 dsh 0.1.5-rc.2**，并保留对 0.1.x 早期版本的兼容——事件流读取优先官方 `snapshotEvents()` / `eventAt()`，旧宿主自动回退 `session.events`。
- **v2.4.0 修复「模型输出没有被隐藏」**（本版主要修复）：
  - **成因**：本插件只接管了 `conversation.chat.node` 的 `user` / `steering` 两个渲染器，因此只有这两类行会被打上 `data-xsj-seq` 标记；模型的 `assistant-step` 输出、工具调用、context 等行走官方渲染器，**从来没有标记**。此前隐藏判定对未标记的行一律「不隐藏」，于是提交区间后只藏住了提问、回答仍然留在屏幕上。
  - **修法**：未标记的行不再被放弃，而是按 DOM 顺序从**前一条已标记行**继承判定——它属于其所跟随的那一轮。仅对「前面完全没有证据」的前导行才回退到后方证据。这个前向归属是必须的：若改成「后面有隐藏就算隐藏」，区间**上方**那条回答会被误藏（开发过程中确实踩到，已由 `test/hiding.test.mjs` 覆盖）。
  - **驱动卸载时还原 DOM**：隐藏是直接写 DOM 的，此前 teardown 只清定时器与 observer。切换会话或 composer 重挂载会把隐藏行留给下一个视图（凭空出现空白行）。现在 teardown 会释放所有带本插件标记的行，且只释放这些行，不影响其他特性设置的 display。
  - **区分「没数据」与「没有区间」**：冷加载（刷新 / 切会话）时驱动先于 `/state` 返回而运行，此前二者无法区分，导致**每次加载都会闪现**已被回退掉的尾巴；若 `/state` 请求失败，则永久保持可见——界面看到的消息模型其实看不见。现在按会话记录 `fetched` / `fetchFailed`：未拿到答复时保持当前判定不动并重试，拿到后才据实隐藏；本地刚记录下的 mark 仍会立即生效。
  - **Host：`agent/disposed` 不再泄漏补丁**：`ensurePatched` 会在 session 实例上装一个闭包了 `st.ranges` 的 `deriveMessages` 覆盖，而 disposed 此前直接丢弃状态记录，使该覆盖无人可解——会话会**永久**继续按已回退的区间过滤模型上下文，且跨插件重载存活。现在与 `evictIfNeeded` 同规则，先解挂再丢弃。
  - **`ensurePatched` 改为自愈**：不再只信 `st.patched` 标志，而是比对实际安装的方法与记录的包装器，不一致就重新安装（幂等），避免标志与实际脱节后**静默停止**对模型隐藏。
  - **图片引用只缓存命中结果**：引用一旦进入 append-only 日志就不会消失，命中可长期有效；未命中则不然——缓存未命中会让 `/image` 对一个日志里确实存在的 id 返回 404，表现为回退时图片被静默丢弃。
- v2.3.0 变更：
  - **回退时同步回填图片**：Host 半新增 `/api/xsj-rewind/image` 端点，依 attachmentId 从会话日志读回原始字节；客户端构造成 `File` 后通过 composer 的隐藏文件输入重新入档，自动触发官方的图片数量/大小校验。
  - **修复图片消息的连锁渲染崩溃**：`@deepseek-ai/dsh-client-ui-attachment` 客户端半在 0.1.5-rc.2 只导出 `apply`/`inject`（不再有 `ImageGallery` 组件），此前引用它会让含图片的用户消息抛错，并被 React 错误边界放大到**前后相邻的整片消息**（表现为大范围回退按钮消失）。现改用官方同款 `renderMessageImages` prop（路由到 `conversation.message.images` 槽位）。
  - **加固槽位注册**：`slots` 服务改为防御性获取并逐席位 `try/catch`。此前任一次注册冲突（如客户端 HMR 重载竞态）都会中断整个 `apply()`，导致「样式已注入但渲染器全丢」。
  - **DOM 隐藏驱动更保守**：未打戳的行不继承相邻行的隐藏判定，避免刚发送的消息在打戳完成前被误隐藏。（**v2.4.0 修正**：该保守策略同时导致模型输出永远不被隐藏，见上方 v2.4.0 说明。）
  - **图片回填串行化**：多次回退不再争用同一个文件输入。
  - Host 半的 `attachments` 服务改为运行时解析（`ctx.get`），缺少附件 provider 时插件仍能正常挂载，仅图片端点降级返回 501。
  - 资源上限：会话状态表、图片引用缓存均设有容量上限；图片响应与 attachmentId 长度增加校验。
- v2.2.0 变更：
  - 适配 0.1.5-rc.2：`primitives.MessageText` 已被移除，用户气泡文本改用与官方相同的 `projectUserText()` 渲染（自动获得 @引用/会话 chip 高亮）；
  - 客户端 inject 声明更新：移除已废弃的 `@deepseek-ai/dsh-client-runtime`；
  - 清理冗余与调试残留代码（调试日志、无效的 fuzzy 会话解析、两处死代码）。
- 旧版（≤2.1.2）在 dsh 0.1.5-rc.2 上的已知症状：用户消息行渲染崩溃、回退按钮不出现——请升级到 ≥2.3.0。

## 安全说明

- 四个端点（`mark` / `cancel` / `state` / `image`）注册在 dsh 的 Web 服务器上，**遵循 dsh 自身的本地信任模型**：`dsh web` 默认只监听 `127.0.0.1`，因此端点仅本机可达、不经 dsh 的 API 鉴权层。若你把 dsh web 绑定到对外地址（如 `0.0.0.0`），这些端点会随之外露——此时请自行在网络层（防火墙 / 反向代理鉴权）加以限制。
- `/image` 端点的授权模型：只会返回**当前会话日志中确实引用过**的 attachment（按 attachmentId 在事件流中查找），不提供按路径或任意 id 读取的能力；字节读取由 dsh 的 `attachments.readImage` 完成，含完整性校验。
- 请求体上限 64 KB；attachmentId 长度上限 256；单张图片响应上限 64 MB。
- 插件不收集、不上报任何数据；所有状态都留在本地会话日志中。

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
- **UI 隐藏**：纯 DOM 实现——聊天行包裹元素带 `data-chat-flow-key`，客户端按行打 seq 戳
  并由 MutationObserver 驱动，对隐藏行内联 `display:none`；不依赖宿主 store 内部形状，
  取消/切换会话即还原，不改动任何既有渲染器。
  - 只有 `user` / `steering` 行**有 seq 可打**；其余行（模型输出、工具调用、context）
    走官方渲染器、无标记，因此按 DOM 顺序从前一条已标记行**前向归属**，前导无证据的行
    才回退到后方证据。不再采用「未打戳即不隐藏」。
  - 隐藏状态写的是活动 DOM，故驱动卸载时必须释放（且只释放带本插件标记的行）。
- **回退图标**：以优先级 `-1` 接管 `conversation.chat.node` 的 `user`/`steering`
  渲染器（槽位系统的原生遮蔽机制），行内复刻原生气泡（projectUserText / ImageGallery /
  Tooltip / writeClipboard），追加 ↺ 按钮。

## 移植

本插件无任何 npm 依赖：Host 半只用 Node 内置模块与注入服务，Client 半经
`window.__ModuleLoader__` 从外壳的冻结模块表取 `react` /
`@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-ui-attachment`。
克隆本仓库到任意机器后按「安装」一节操作即可。

## License

[MIT](./LICENSE)
