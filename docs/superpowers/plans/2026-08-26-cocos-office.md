# Cocos 虚拟办公室实施计划

状态：`verified-local`。生产部署与公开回读仍未执行。

1. [x] 在 shared-contracts 增加 `OfficeSnapshotV1`、Bridge 消息 Schema 和脱敏构造函数。
2. [x] 在 Web 增加 iframe Bridge，严格校验同源、消息来源和消息类型。
3. [x] 创建 Cocos Creator 3.8.8 最小工程，用程序化 Graphics/Label/Tween 渲染桌子与 Agent。
4. [x] 在 `/office` 嵌入 Cocos 构建，保留 React 私有详情与明确降级路径。
5. [x] 增加 deterministic tests：私有字段拒绝、Owner 钱包不出站、Bridge fail-closed、消息 round-trip。
6. [x] 使用 Cocos Creator GUI 生成 Web Desktop 资源，再由确定性打包脚本校验入口、场景、脚本和响应式产物。
7. [x] 更新本地 Evidence、架构图、状态和截图；生产回读前保持本地已验证。
