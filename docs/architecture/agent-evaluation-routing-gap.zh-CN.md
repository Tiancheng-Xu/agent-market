# Agent 评测、裁判与派单差距清单

更新时间：2026-08-23

## 当前已实现

- 硬过滤先于排序：访问范围、能力、健康状态、模型去重和低分淘汰先执行。
- 三候选不得使用相同 `modelTag`。
- 新模型从 0 分开始并获得有界探索加成；旧低分模型不再进入候选池。
- Judge 不能审查自己的输出，Final Arbiter 不能由 Queen 兼任。
- Judge 结果使用幂等事件写入本机私有评分账本；Learning Loop 只写脱敏摘要。
- Mastra 管顶层 Workflow，LangGraph 管状态与分支，LangChain 管单节点模型调用。

以上状态在本批总 Gate 通过前均为 `implemented / gate-pending`，不是生产验证。

## 仍存在的差距

1. 尚无冻结离线评测集，不能证明路由版本相对 baseline 的质量提升。
2. 尚未把 Component Eval 与 End-to-End Eval 分开统计。
3. 当前 Judge 只提供 Pointwise 分数；Pairwise A/B 换序与位置偏差检测未实现。
4. 尚未保存 Judge model/revision/prompt/rubric/seed，也没有人工金标校准集。
5. 尚未按事实、安全、实现质量、用户意图拆分多裁判；低置信度人工升级仍为 planned。
6. 当前私有评分主要是质量聚合，尚未形成 capability、quality、reliability、safety、latency、cost、freshness 的完整可解释向量。
7. RAG 的 Hybrid Retrieval、Rerank、Citation 与检索失败显式暴露尚未接入当前任务流。
8. 用户修正、撤销、人工接管和重试信号尚未经过清洗进入离线评测集。

## 最小演进路径

1. 冻结按 Capability 分层的离线集，增加正常、长上下文、工具失败、拒答、安全、成本敏感和模糊需求样例。
2. 先增加 Deterministic Checks：Schema、编译、测试、链接、权限、事实引用；LLM Judge 只负责难以规则化的维度。
3. 增加 Pointwise 过线和 Pairwise 排序，A/B 双向运行检测位置偏差。
4. 引入 Judge 版本记录、人工金标和一致率；低置信度、高风险或高价值任务升级人工。
5. 将评分扩展为可解释向量，派单返回 Reason Codes、候选列表和降级原因。
6. 最后再引入 Hybrid Retrieval + Rerank + Citation；检索失败必须明确返回，不能伪造来源。

## Gate 边界

- 没有同一冻结集上的 baseline vs candidate 数据，不声称路由优化有效。
- 没有人工金标一致率，不声称 LLM Judge 已校准。
- 没有真实 Provider 调用、延迟和成本记录，不填写推测分数。
- Catalog 只公开安全元数据；Secret、私有 Prompt、本地端口和模型权重留在 Runtime 边界内。
