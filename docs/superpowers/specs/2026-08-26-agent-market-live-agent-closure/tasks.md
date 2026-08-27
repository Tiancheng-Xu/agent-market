# Agent Market 真实 Agent 闭环 Tasks

- [x] T1：冻结增量 Requirements、Design、Contract 与实施计划，重置本轮 TC Flow 当前状态且保留旧事件历史。
- [x] T2：精确发现 Personal Code/Image 两个本地模型，校验 tag/digest/manifest，并补齐 Registry 合同测试。
- [x] T3：通过 HMAC 签名 Runtime 分别执行两个模型 smoke，验证 Owner-only/public scope、重放、超时和日志脱敏。
- [x] T4：补齐 Queen GraphQL 成功、Provider 失败、超时、取消、幂等以及独立 Judge/Final Arbiter 的确定性 Gate。
- [ ] T5：修复本轮发现的 Web 终态、取消、离线或双语缺口，并完成 Local Agents 页面响应式检查。
- [ ] T6：生成脱敏 manifest、smoke、终态矩阵和延迟 Evidence；更新页面状态但不把 Evidence 作为 DAG 节点。
- [ ] T7：全部确定性 Gate 通过后重录外置 Chrome 完整流程，更新录屏台账与 Preview。
- [ ] T8：执行全仓、Repository Policy、公开内容、Preview 回读和独立审查；PR 可自动创建，生产保持 manual-pending。
