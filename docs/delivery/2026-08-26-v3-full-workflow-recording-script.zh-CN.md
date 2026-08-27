# Agent Market V3 全流程录屏执行剧本

状态：`pending-recording`  
录制方式：外置 Chrome，全屏录制后只裁切浏览器窗口；推荐 1920×1080。  
前置条件：V3 Sepolia、AWS V2 与所有本地 Gate 均已通过。前置条件未满足时禁止把旧录屏标记为最终 Evidence。

## 录制安全边界

- 关闭密码管理器、通知、邮件、终端、开发者工具和无关标签页。
- 只显示公开地址的必要缩写；不展示私钥、助记词、API Key、Cookie、AWS 账号、Profile、ARN、内部路径或原始 Prompt。
- MetaMask 只使用 Sepolia 与用户指定的 Account 1；每次签名前停留并说明动作、金额、合约和测试网属性。
- 任何请求失败都展示真实错误与降级，不剪成成功；无 receipt/event 不说成功。
- 页面只展示进行中或已完成任务；演示数据必须保留“演示数据”标签。

## 录制前确定性 Gate

1. 合约、Transaction Engine、Web、GraphQL、Repository Policy、构建与双语可视化 Gate 全绿。
2. `docs/evidence/deployment/sepolia-workflow-v3.json` 存在且 deployment/configuration receipts 回读成功。
3. `docs/evidence/deployment/2026-08-26-aws-v2-performance-closure.json` 存在且证明同一 `request_id` 全链与重新暂停。
4. Code/Image owner-trained Smoke、四类 GraphQL 终态、Cocos Office 与 180 个视觉组合 Evidence 存在。
5. 旧录屏保持 `superseded-local`，新录屏账本尚未标记 verified。

## 镜头 01：主页与语言

1. 打开生产或最终 Preview 首页。
2. 展示 Sepolia/Test YD/无真实财务收益提示。
3. 点击中文与 EN 各一次，确认标题、副标题、描述、按钮和状态说明完整切换。
4. 展示主导航和明确的降级/在线状态，不遮挡页面。

验收：没有横向滚动、空按钮、残留整句错误语言或图片加载失败。

## 镜头 02：连接钱包

1. 进入 `/tasks/new`，点击“连接 MetaMask”。
2. 在 MetaMask 确认站点与 Account 1，不展示完整账号资料。
3. 若网络不是 Sepolia，按页面引导切换并确认。
4. 回到页面，展示地址缩写、网络、会话状态与 YD 余额回读。

验收：连接按钮有等待、成功或明确失败反馈；页面不直接保存可复用签名凭据。

## 镜头 03：用户创建并维护 Agent

1. 进入 `/agents/new`。
2. 选择本地 Ollama 或 Provider API 类型，填写显示名、模型 Tag、能力、分类、License 与定价类型。
3. 展示免费 Agent 可进入市场；付费 Agent 必须先通过平台 Smoke 才公开。
4. 保存 Agent，进入公开资料页和 Owner 管理页。
5. 展示 Owner-only 本地 Agent 默认仅本人可选、心跳在线后自动接单；页面不展示 Key 或 `11434`。

验收：Agent 清单标注 ownership、provider、capability、license、health、readiness 与验证状态。

## 镜头 04：发布任务与 6% 平台押金

1. 返回 `/tasks/new`，填写标题、分类、Tags、预算、验收标准、截止时间和专家类型下拉框。
2. 点击“验证草稿”，展示字段级反馈。
3. 点击“预览交易状态”，展示待授权金额：任务预算 + 固定 6% 不返还平台发布押金。
4. 点击 YD approve，在 MetaMask 核对 Sepolia、合约与金额后确认。
5. 回到页面等待真实 approve receipt。
6. 点击发布任务，确认 `createTask` 交易。
7. 展示交易哈希缩写、block、status=1、目标合约与 `TaskCreated` 事件回读。

验收：任务未上链或押金未到账时不得开始分配 Agent。

## 镜头 05：Queen 生成 DAG，用户修改后确认

1. 打开新任务 Workspace，展示系统监听任务哈希与托管到账。
2. Queen 根据需求生成节点数量不固定的 DAG。
3. 每个节点按 Tags + 分类 + License + capability + health + 指数衰减滑动评分生成四个候选，并选出三个不同模型候选。
4. 展示新 Agent 初始 30 分和探索加成；低分旧模型的淘汰状态。
5. 用户按顺序修改一个节点的 Agent；未选择前一个时后一个保持锁定。
6. 确认完整 DAG 后，展示 `workflowId + dagHash + version` 锚定回执。
7. 说明执行开始后已有节点不可修改；Repair/Red Team 可按规则追加并产生新版本。

验收：Judge 与 Final Arbiter 必须上下文隔离且不能由执行 Agent 自审；同一节点候选不能是相同模型。

## 镜头 06：自动接单与真实 GraphQL 执行

1. 展示进入市场的 Agent 只靠心跳确认可用，无需 Owner 手动接单。
2. 启动 `/agent/graphql` 工作流。
3. 展示 LangGraph 的节点状态、并行边界、超时、补救和取消控制；不展示内部 Prompt 正文。
4. 完成一个真实成功任务，展示执行 Agent 输出、独立 Judge、独立 Final Arbiter 与最终交付。
5. 展示可下载的当前用户任务结果。

验收：LangGraph 是状态图和恢复边界；LangChain 只包装节点内模型/Tool，不出现 Mastra。

## 镜头 07：失败、超时与取消

1. 进入 Evidence 或受控演示入口，分别触发 provider failure、runtime timeout、user cancel。
2. 展示三条任务进入各自真实终态，并且不会被标成成功。
3. 展示 retry/repair/fallback reason code，不展示原始敏感内容。
4. 对照成功终态，共四种终态全部有 `request_id/run_id`。

验收：输出失败不影响控制面；重复事件幂等；取消后不再继续调用 Provider。

## 镜头 08：平台最终仲裁与 Agent 份额

1. 打开任务争议页，展示用户提交异议。
2. 打开 `/committee`，明确 V3 为单一平台最终仲裁人；旧 V2 委员会仅历史说明。
3. 使用 Account 1 核对任务、DAG 哈希、Judge Evidence 与风险，再选择裁决结果。
4. MetaMask 确认 `resolveTask`，回读 status=1 与匹配事件。
5. 展示 Agent 使用 TaskStakeReceipt 领取/退回份额；用户自己的 Agent 份额在任务完成后返还用户。

验收：Receipt 是领取份额的唯一链上凭证；争议期间资金冻结。

## 镜头 09：网页质押、解押与收益领取

1. 进入 `/staking`，先展示测试 YD、6% 按秒线性单利、向下取整与奖励池边界。
2. 输入质押金额，执行 YD approve 并回读 receipt。
3. 执行 stake，回读 `Staked`、principal、earned 与 rewardReserve。
4. 执行部分 unstake，回读 `Unstaked` 和剩余 principal。
5. 执行 claimYield，回读 `YieldClaimed`、earned=0 或新的 checkpoint 状态、rewardReserve 扣减。
6. 如奖励池不足，保留真实失败提示，不伪造领取成功。

验收：unstake 只退本金；收益必须单独 claim；全部是 Sepolia 测试资产。

## 镜头 10：Cocos 虚拟办公室

1. 进入 `/office`，展示 WorkBuddy/OpenClaw 式动画办公室。
2. 当前用户的每个任务是一张桌子，按“全部/进行中/异议/已完成”切换。
3. 展示受雇 Agent 坐在当前任务桌旁，Agent 角色采用星宝方向，透明底，最终尺寸 76×76。
4. 展示当前用户 Agent 到其他用户任务桌区域“串门”的娱乐性动效；不加入聊天功能。
5. 点击桌子回到对应任务 Workspace。

验收：Cocos 与 Web 路由互通，不遮挡、无横向溢出、没有假在线状态。

## 镜头 11：AWS 性能全链与可逆暂停

1. 打开 `/ops` 或 Evidence 的 AWS V2 区域。
2. 展示一条新浏览器 Web Vitals 样本的 UUIDv7 `request_id`。
3. 依次展示 Edge、API Gateway、Lambda、SNS、SQS、ECS 与 PostgreSQL 的同 ID 脱敏回读。
4. 展示公开 Evidence 回读。
5. 展示验证后 Event Source Mapping Disabled、ECS running=0 与 DLQ 状态。

验收：只展示项目资源与脱敏标识，不显示 AWS 账号、ARN 或无关资源。

## 镜头 12：Evidence 总结

1. 打开 `/evidence` 顶部，播放刚录制的视频。
2. 展示八项闭环总表：所有 pending 已关闭；本地证据与生产证据仍分级展示。
3. 展示 V3 架构图、时序图、GraphQL 终态、双模型 Smoke、Cocos、双语视觉回归、Sepolia 与 AWS 回读。
4. 切换中文/EN，确认 Evidence 标题、副标题、描述、图内文本和状态完整翻译。
5. 打开一个不存在的路由，展示真实 404 后返回 Evidence。

## 录制后处理

1. 仅裁切浏览器区域，不剪掉真实等待、签名、失败或回读过程。
2. 输出 MP4、时长、分辨率、文件大小与 SHA-256。
3. 生成 `apps/web/public/evidence/2026-08-26-v3-full-workflow-recording.json`，记录每个镜头时间段与证据引用。
4. 对视频执行隐私扫描；发现账号、通知、Key、内部路径或原始敏感 Prompt 必须废弃并重录。
5. 视频与账本均通过 Gate 后，旧录屏继续保留 `superseded-local`，新录屏才可标记 verified。
