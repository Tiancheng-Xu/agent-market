# Agent Market 动态风险定价与 Reputation V2 设计

日期：2026-09-01  
状态：产品方向与实施计划已确认，L2 实施中

## 1. 目标与分期

Agent Market 采用 `P + A + B`：`P` 是任务预算，`A` 是单侧可退履约保证金，`B` 是不退的平台服务费。发布方缴纳 `P + A + B`，Agent Team 集体缴纳与发布方相同的 `A`。

L2 本轮实现 Risk Assessor 契约、确定性报价、Reputation V2、状态投影、UI 和本地 Gate。L2 不部署新 Sepolia 合约，不把历史 V3 证据升级为新经济模型的链上证明，也不接入未经审计的收益协议。

L3/L4 才评估对称保证金合约、收益 Vault、节点级部分裁决、保险池、DAO/申诉网络与真实资金收益。

## 2. 角色边界

- Risk Assessor：在资金锁定前输出结构化风险因子、原因码和建议 Gate；不能设置费率、发交易或覆盖确定性 Gate。
- Deterministic Risk Engine：按冻结公式输出 `score`、`tier`、`depositRateBps` 和版本化报价。
- Queen：风险报价确认后规划 DAG。
- Executor、Judge、Red Team、Repair、Final Arbiter Agent：维持现有独立执行和审查职责。
- Platform Arbiter Wallet：唯一可请求资金裁决的链上权限主体；不得用 LLM 文本直接裁决。

Final Arbiter Agent 只判断交付质量，Platform Arbiter Wallet 才能请求链上资金裁决，两者不得合并。

## 3. 风险评分

| 因子 | 权重 |
| --- | ---: |
| 任务复杂度 | 20 |
| 验收标准歧义 | 15 |
| 外部依赖 | 10 |
| 数据和权限敏感度 | 15 |
| 资金与链上风险 | 15 |
| 不可逆性 | 10 |
| 工期与超时风险 | 5 |
| Agent 信誉不确定性 | 10 |

Risk Assessor 只提供每项 0 至 100 的值和原因码。Risk Engine 负责确定性计算。缺失因子或 Schema 错误必须阻止报价，不能静默降级为低风险。

## 4. 风险等级与对称保证金

| 风险分 | 等级 | 单侧保证金率 |
| ---: | --- | ---: |
| 0-20 | R1 | 5% |
| 21-40 | R2 | 10% |
| 41-60 | R3 | 15% |
| 61-80 | R4 | 25% |
| 81-100 | R5 | 40%，且必须人工复核 |

```text
PublisherPayment = P + A + B
A = P * depositRateBps / 10000
AgentTeamDeposit = A
```

Agent Team 内部分配：

```text
NodeWeight_i = shareBps_i * nodeRiskMultiplier_i * reputationRiskMultiplier_i
AgentDeposit_i = A * NodeWeight_i / sum(NodeWeight)
```

总额必须守恒；舍入余数按“权重最高，然后 Agent ID 字典序最小”确定性分配。

## 5. Reputation V2

```text
RawScore
= 35% * DeliveryReliability
+ 25% * QualityScore
+ 10% * CommunicationScore
+ 15% * DisputeOutcomeScore
+ 15% * ExperienceScore
```

- DeliveryReliability：成功、失败、超时和退款；保留 90 天窗口、最近 20 次事件和 30 天半衰期。
- QualityScore：仅统计已完成并验收订单的一次有效评价。
- CommunicationScore：首次响应、撤回率和节点超时。
- DisputeOutcomeScore：只处罚被最终裁定有责任的争议；合理申诉和胜诉不扣分。
- ExperienceScore：订单数和金额采用对数缩放并封顶，避免马太效应。

小样本平滑：

```text
Confidence = n / (n + 10)
FinalScore = 30 + Confidence * (RawScore - 30)
```

公开展示必须包含综合分、五维分、样本量、置信度、窗口和更新时间。自评、关联钱包、重复评价、无验收资格评价全部拒绝；Judge 分数不能替代用户评价。

## 5.1 公平匹配引擎演进

匹配始终采用“硬过滤 -> 候选召回 -> 排序与探索 -> 脱敏审计”四层。后层不能绕过前层。

### 当前确定性基线

- 分类、Tags、能力、License、访问范围和健康状态执行硬过滤。
- 默认三个席位为两个历史排序席位加一个冷启动探索席位。
- 历史候选不足时由合格新人补位；纯冷启动时从新人池抽满三个不同 `modelTag`。
- 冷启动采用 `SHA-256(taskId + matchingRound + policyVersion)` 驱动的可复现 Fisher-Yates 洗牌，不使用全局随机。
- 高风险任务可以禁用冷启动席位并进入人工复核。
- `NO_ELIGIBLE_AGENT` 是业务结果，`MATCHING_ERROR` 才是系统错误。

### 后续语义召回

Task 与 Agent 描述可生成 Embedding，在已经通过硬过滤的候选池内做语义 Top-K。Embedding 模型、向量版本、相似度和召回原因必须可追踪；低置信度或向量不可用时回退确定性基线。语义相似不能替代权限、License、Tags 或能力资格。

### 历史数据智能排序

历史数据足够后，模型可预测接单、按时完成、验收质量、沟通、明确归责争议、预计成本和可靠性。目标不是 CTR，而是多目标交付效用：

```text
ExpectedUtility
= DeliverySuccess + AcceptanceQuality + Timeliness
- AttributedDisputeRisk - ExpectedCost - Uncertainty
```

候选模型必须与确定性 baseline 使用同一冻结、去重、脱敏评测集，并同时比较质量、正确性、安全、P95 延迟、成本和可靠性。先离线、再影子运行；任何关键 Gate 退化都不得替换基线。即使学习排序上线，也永久保留受控探索席位，避免历史头部垄断曝光。

每次匹配只保存策略版本、候选数量、过滤原因码、公开 Agent ID、选择原因与 seed hash；不得公开私有 Prompt、关联钱包、Provider Key、原始评价事件或内部路径。

## 6. 结算、罚没与利益冲突

| 结果 | 任务预算 | 发布方保证金 | Agent 保证金 |
| --- | --- | --- | --- |
| 正常验收 | 按份额支付 Agent | 全退 | 全退 |
| 发布方违约 | 支付合格节点 | 按责任扣除 | 全退 |
| Agent 违约 | 未完成部分退款 | 全退 | 违约节点按责任扣除 |
| 部分责任 | 按里程碑拆分 | 按责任扣除 | 按责任扣除 |
| 不可抗力 | 未执行部分退款 | 全退 | 全退 |
| 状态未知 | 不支付、不退款 | 继续锁定 | 继续锁定并进入 `manual_review` |

平台不得因裁决方向直接获利。罚没款优先补偿守约方，其余进入独立保险池和已披露仲裁成本；不得全部进入平台 Treasury。

## 7. 平台收益边界

长期产品目标：

```text
PlatformGrossRevenue = B + Yield(PublisherDeposit + AgentTeamDeposit)
```

L2 只展示模拟报价，不实现真实 Yield。收益模块必须经审计，并满足本金与任务预算隔离、收益浮动披露、流动性缓冲、赎回 Gate、紧急暂停和用户事前同意。平台不得通过提高风险分扩大收益本金。

## 8. 报价契约

```json
{
  "riskVersion": 1,
  "score": 67,
  "tier": "R4",
  "depositRateBps": 2500,
  "factors": [],
  "requiredGates": [],
  "taskFingerprint": "sha256:...",
  "quotedAt": "ISO-8601",
  "expiresAt": "ISO-8601"
}
```

报价绑定任务指纹、规则版本和过期时间。任务内容、预算、DAG、Agent 分配或权限实质变化后必须重新报价，并由双方确认同一版本。

## 9. UI 与 Evidence

- 发布页显示风险维度、原因码、单侧保证金率和双方金额。
- Agent 接单前显示节点风险、信誉修正和个人保证金。
- 订单页显示冻结的 `riskVersion`、`riskHash`、报价状态和重新报价原因。
- 信誉页显示综合分、五维分、样本量和置信度。
- 模拟收益必须明确标记模拟；本地 Gate、生产 Web、AWS Runtime 和 Sepolia 证据继续独立判定。

## 10. 验收 Gate

- 相同输入得到相同报价。
- 风险分、费率、Agent 分配和舍入总额守恒。
- 小样本不能直接升至高信誉。
- 争议胜诉不产生负面信誉。
- R5 未经人工复核不能锁定资金。
- 状态未知只能进入 `manual_review`。
- 确定性 Gate 失败不能被 LLM、Judge 或信誉分覆盖。
- 375、390、430、1440 视口无横向溢出、无 `pageerror`。
- UI 不把模拟收益表述为已实现、已保证或已外部验证。

## 11. 实现范围

### L2 本轮

- Risk Assessor 结构化契约。
- Deterministic Risk Engine 和对称保证金报价。
- Reputation V2 与反作弊 Gate。
- 报价、信誉、订单状态 UI。
- 本地测试和 Evidence 边界。

### L3 长期

- 对称保证金新合约或迁移版本。
- 节点级部分裁决、保险池和经审计的收益 Vault。

### L4 长期

- 独立申诉网络或 DAO。
- 双人复核、治理审计、对账和异常资金运营。
