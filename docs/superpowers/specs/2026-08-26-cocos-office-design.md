# Agent Market Cocos 虚拟办公室设计

## 1. 目标

在不改变 Agent Market 权威边界的前提下，为任务协作增加一个 Cocos Creator 3.8.8 实现的娱乐性可视化层：一个任务是一张桌子，被派单的 Agent 以 BabySteps 星宝衍生角色进入办公室、走到座位并按真实公开状态工作。视觉采用 WorkBuddy 式状态伙伴与温暖 2.5D Agent 办公室，而不是任务卡片看板。

## 2. 不做什么

- 不在 Cocos 中连接钱包、签名、发交易、修改 DAG、执行 Agent 或保存任务权威状态。
- 不实现聊天。
- 不向访客或 Cocos 发送钱包地址、节点 input/output、下载地址、API Key、Ollama 地址或私有 Prompt。
- 不把动画状态当作任务完成、链上成功或 Agent 在线的证据。

## 3. 权威边界

- React Web：身份、Owner/Visitor 视图、筛选、降级和下载入口。
- AWS 私有控制面：完整任务、DAG、节点输入输出和运行状态。
- Sepolia：任务、资金、押金、DAG 哈希与结算的链上权威。
- Cocos：只消费已经脱敏的 `OfficeSnapshotV2`，只输出 UI 选择事件。

## 4. 数据契约

`OfficeSnapshotV2` 只包含：

- `version`、`generatedAt`、`statusFilter`。
- 桌子的公开 `taskId`、标题、分类、tags、状态。
- 座位的公开 `agentId`、显示名、角色、评分和受限活动枚举。
- `isOwner` 布尔值，不携带 Owner 钱包。

Owner 节点 input/output 与下载结果继续留在 React 页面，绝不进入 iframe 消息。

## 5. Bridge

- Host -> Cocos：`agent-market.office.snapshot.v2`。
- Cocos -> Host：`agent-market.office.ready.v2`、`agent-market.office.select-desk.v2`。
- Host 只向同源 iframe 发送；接收时校验 `event.source`、`event.origin` 和 Zod Schema。
- Cocos 不接受任意命令，不持久化消息，不访问 localStorage/IndexedDB。

## 6. 场景与交互

- 使用原创星宝 4×8 角色图集与温暖 2.5D 办公室背景；Code、Judge/Research、Final Arbiter、Image 四类角色通过配件区分。
- 活动枚举映射到待机、行走、思考、执行、验收、等待、成功、失败与离线表现；任务状态驱动动画，动画不得自行改变任务状态。
- 进行中桌子使用琥珀色状态，已完成桌子使用绿色状态。
- Agent 会从休息区进入任务桌、呼吸、工作、验收和庆祝；串门只改变娱乐性位置，不改变派单。
- 点击桌子只回传 `taskId`，React 决定是否展示 Owner 私有详情。
- 375/390/430 使用单列桌面视口，1440/1920 使用多列布局。

## 7. 降级与证据

- Cocos 构建未加载、超时或脚本错误时，显示明确降级提示并保留现有 React 办公室。
- 本地 Gate 必须验证契约拒绝私有字段、Bridge 来源、Creator 构建产物、路由截图和无横向溢出。
- 在 Creator 构建与公开回读前只标 `implemented/pending-external`，不得标生产完成。
