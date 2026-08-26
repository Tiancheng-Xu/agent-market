# Agent Market Todo List

## 最终 UI 收尾

- [x] 修正模块等高布局：当前同一行所有模块按最高模块统一高度，导致内容较少的模块底部出现大块空白。调整为内容自适应高度；如必须保留网格对齐，仅对明确需要对齐的局部组件设置最小高度，不使用整组强制等高。
  - 验收：桌面端各模块高度随内容变化，无明显无意义底部空白。
  - 验收：H5 纵向排列不继承桌面端固定高度。
  - 验收：在 375、390、430、1440 px 复核布局，不产生横向溢出或内容截断。
  - 状态：已实现内容自适应规则；纳入 375、390、430、1440 px 最终回归。

## 本地产品闭环

- [x] GraphQL 多 Agent 成功、Provider 失败、超时、取消、幂等重试和独立 Judge / Final Arbiter。
- [x] Personal Code/Image Agent 精确 manifest identity、Owner Scope、签名 Runtime smoke；Image 使用 `2fa405e1...` manifest digest，`4bba2f8f...` 仅作为 GGUF layer SHA。
- [x] 任务发布、质押和委员会链交互适配完成本地 Gate；未发送新的 Sepolia 交易。
- [x] Cocos Creator 3.8.8 虚拟办公室、本地截图、架构、PRD 和脱敏 Evidence。
- [x] 16 个路由在 375、390、430、1440、1920 像素下共 80 个组合通过可视回归。
- [x] 全仓 `pnpm verify` 通过；仓库策略、Evidence、TypeScript、Solidity、Go 与 Python Gate 均通过。

## 交付与外部边界

- [ ] 重新录制修复后的外置 Chrome 全流程；MetaMask 当前需要用户在扩展面板自行解锁，录屏不得读取密码或发送交易。
- [ ] 完成独立审查、PR 与 Cloudflare Preview 回读；生产发布保持人工待确认。
- [ ] AWS V2 性能全链生产回读：需要动作时成本/复用矩阵与用户再次授权。
- [ ] V3 Sepolia 合约部署和网页端真实交易闭环：需要用户再次授权并保留精确 receipt/event 回读。
