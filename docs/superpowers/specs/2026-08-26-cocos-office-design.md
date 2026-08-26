# Agent Market Cocos 虚拟办公室设计

## 1. 目标

在不改变 Agent Market 权威边界的前提下，为任务协作增加一个 Cocos Creator 3.8.8 实现的娱乐性可视化层：一个任务是一张桌子，被派单的 Agent 坐在对应座位；用户可以按状态筛选桌子，也可以看到 Agent 在公开桌子之间串门。

## 2. 不做什么

- 不在 Cocos 中连接钱包、签名、发交易、修改 DAG、执行 Agent 或保存任务权威状态。
- 不实现聊天。
- 不向访客或 Cocos 发送钱包地址、节点 input/output、下载地址、API Key、Ollama 地址或私有 Prompt。
- 不把动画状态当作任务完成、链上成功或 Agent 在线的证据。

## 3. 权威边界

- React Web：身份、Owner/Visitor 视图、筛选、降级和下载入口。
- AWS 私有控制面：完整任务、DAG、节点输入输出和运行状态。
- Sepolia：任务、资金、押金、DAG 哈希与结算的链上权威。
- Cocos：只消费已经脱敏的 `OfficeSnapshotV1`，只输出 UI 选择事件。

## 4. 数据契约

`OfficeSnapshotV1` 只包含：

- `version`、`generatedAt`、`statusFilter`。
- 桌子的公开 `taskId`、标题、分类、tags、状态。
- 座位的公开 `agentId`、显示名、角色和评分。
- `isOwner` 布尔值，不携带 Owner 钱包。

Owner 节点 input/output 与下载结果继续留在 React 页面，绝不进入 iframe 消息。

## 5. Bridge

- Host -> Cocos：`agent-market.office.snapshot.v1`。
- Cocos -> Host：`agent-market.office.ready.v1`、`agent-market.office.select-desk.v1`。
- Host 只向同源 iframe 发送；接收时校验 `event.source`、`event.origin` 和 Zod Schema。
- Cocos 不接受任意命令，不持久化消息，不访问 localStorage/IndexedDB。

## 6. 场景与交互

- 程序化生成暖色办公室背景、任务桌、状态标牌和 Agent 座位。
- 进行中桌子使用琥珀色状态，已完成桌子使用绿色状态。
- Agent 使用轻微呼吸/走动动画；串门只改变娱乐性位置，不改变派单。
- 点击桌子只回传 `taskId`，React 决定是否展示 Owner 私有详情。
- 375/390/430 使用单列桌面视口，1440/1920 使用多列布局。

## 7. 降级与证据

- Cocos 构建未加载、超时或脚本错误时，显示明确降级提示并保留现有 React 办公室。
- 本地 Gate 必须验证契约拒绝私有字段、Bridge 来源、Creator 构建产物、路由截图和无横向溢出。
- 在 Creator 构建与公开回读前只标 `implemented/pending-external`，不得标生产完成。
