# dsh-portage

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的会话与
其他工具同步 —— **每个工具一个双向插件**。

DSH 永远是链路的一端。本项目不做两个非 DSH 工具之间的转换：既没有 `Codex → Kimi`
这种路径，API 上也构造不出来。

| 插件 | 方向 | 状态 |
| --- | --- | --- |
| [`dsh-portage-codex`](packages/codex) | Codex ↔ DSH | 导入可用，导出已搭骨架 |
| `dsh-portage-kimi` | Kimi ↔ DSH | 计划中 |

## 安装

```bash
dsh plugin --profile web add dsh-portage-codex
```

`dsh plugin add` 会在你的 profile 里跑 pnpm，并因为这个包声明了
`dsh.bundle.patch` 而自动把包名加进 `dsh.profile.bundles`。**装完要重启
`dsh web`**：运行中的进程无法替换已加载的插件模块（Node 按 URL 缓存 ES 模块），
新的一行只在下次启动生效。

之后只需要在 `~/.dsh/profiles/web/cordis.patch.yml` 里写配置（insert 行由包自带）：

```yaml
- id: portage-codex
  config:
    import:
      sinceDays: 7                  # 只同步最近 7 天动过的 rollout（0 = 全部）
      autoCreateWorkspaces: false   # 只导入已有 workspace 的项目
```

## 插件做什么

一个插件拥有一个外部工具，以及它与 DSH 之间的两个方向：

```
            ┌────────────── dsh-portage-codex ──────────────┐
            │  src/codex/read.js      src/codex/write.js  │   拥有 Codex 格式
            └────────┬───────────────────────────┬────────┘
                 IR  │                           │  IR
        core/src/dsh/write.js           core/src/dsh/read.js    拥有 DSH 侧
              （导入 X → DSH）                （导出 DSH → X）
```

`dsh-portage-core` 拥有共用流水线：内部转录表示、增量扫描、持久进度、DSH 会话写入器。

### 导入（X → DSH）

- 只导入**已完成的 turn**；正在写入的 turn 留在字节偏移之外，下一轮再读。
- 每个源会话对应一个 DSH 会话（`session-codex-<源 id>`），按字节偏移增量追加，
  重复运行不会产生重复历史。
- 通过 `sessionPersistence` 写入，因此产物布局、压缩、seq 连续性、写锁和未来的格式
  迁移都由 DSH 负责。
- 把会话挂到它记录的 `cwd` 所属的 workspace。
- 导入后折叠一次投影，使标题立刻出现在侧栏，而不是回落成 workspace 名。
- 跳过内部 subagent rollout、被拒绝的目录，以及（关闭 `autoCreateWorkspaces` 时）
  没有 workspace 的项目 —— 后者每 `deferRetryMs` 复查一次。
- **永不写入源工具的存储。**

### 导出（DSH → X）

已搭好骨架：配置面、状态命名空间、防回环规则都在，`export.enabled` 默认 `false`。
`dsh-portage-codex` 将通过 Codex 的外部会话导入路径写回。

防回环是设计的一部分：

1. 导入产生的会话不会被导出回它自己的来源。
2. 这类会话在 DSH 里继续对话后，只导出导入水位之后的 turn。
3. 导出在目标工具里写**新会话**，而不是改写源产物。

## 命名约定

贡献时必须保持一致 —— 插件永远不按方向拆分。

| 层 | 约定 | 例 |
| --- | --- | --- |
| 仓库 | `dsh-portage` | — |
| npm 包 | `dsh-portage-<tool>`，共用核心 `dsh-portage-core` | `dsh-portage-codex` |
| 插件行 id | 包名去掉 `dsh-` 前缀 | `portage-codex` |
| 入口 | 单入口，两个方向都在里面 | `lib/index.js` |
| 配置 | 方向作为嵌套段 | `config.import.*` / `config.export.*` |
| 外部适配器 | `src/<tool>/read.js`、`src/<tool>/write.js` | `src/codex/read.js` |
| DSH 侧 | `core/src/dsh/{read,write}.js` | — |
| 进度文件 | `$DSH_HOME/dsh-portage/<tool>.json` | `dsh-portage/codex.json` |
| 文档措辞 | 写明两端：「Codex → DSH」 | — |

## 开发

```bash
pnpm install
pnpm -r test      # 20 个测试：解析器、流水线、插件装配、真实 DSH 往返
pnpm checkjs      # 对 JSDoc 类型跑 tsc --noEmit
```

集成测试会把**真实的** JSONL 持久化后端跑在临时目录里，完整导入一遍，再用
`Session.fromRestore(...).deriveMessages()` 读回来 —— 与 harness 自身同一条路径，
所以「产出的会话不合法」会在 CI 里失败，而不是在你的侧栏里失败。

完整文档见 [README.md](README.md)（英文）。

## 许可

MIT，见 [LICENSE](LICENSE)。
