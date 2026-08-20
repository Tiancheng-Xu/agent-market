# Agent Market AWS Reuse and Lifecycle

## Status boundary

This document records a read-only inventory and the intended project resource boundary. It is not deployment evidence. No Agent Market AWS resource had been created when this snapshot was captured.

## Live read-only inventory

The `us-east-1` account currently exposes the protected shared course foundation in a healthy state:

| Capability | Live state | Agent Market decision |
| --- | --- | --- |
| Shared network stack | Healthy | Reuse |
| Private application subnets in two AZs | Available | Reuse for Lambda and ECS |
| Private database subnets in two AZs | Available | Reuse indirectly through shared RDS |
| Shared NAT gateway | Available | Reuse; do not create another NAT |
| Shared PostgreSQL | Available, encrypted, deletion-protected | Reuse with an isolated Agent Market schema |
| GitHub Actions OIDC provider | Present | Reuse for CI deployment identity |
| Shared artifact bucket | Present | Reuse for deployment artifacts |
| Monthly AWS budget | USD 40 | Preserve |
| Existing Agent Market AWS stack | Absent | Create only after action-time approval |

BabySteps and any other project-owned resources are outside the Agent Market ownership boundary.

## Project-owned resource set

One CloudFormation stack may create only the following Agent Market resources:

1. One API Gateway HTTP API.
2. One VPC-connected transaction Lambda.
3. One bounded dispatcher Lambda with SQS batch size one and reserved concurrency one.
4. One SNS topic.
5. One SQS work queue and one SQS dead-letter queue.
6. One ECS cluster with no continuously running service.
7. One Fargate task definition for the short-lived matcher or trainer workload.
8. One private ECR repository with an image lifecycle policy.
9. Project-scoped IAM roles, log groups, security group, and SQS event-source mapping.

The stack must not create a VPC, NAT gateway, RDS instance, load balancer, public database endpoint, GitHub OIDC provider, or second artifact bucket.

## Cost and quota guard

- API Gateway HTTP API is request-priced with no minimum fee. The current public US East example starts at USD 1 per million requests.
- Lambda, SNS, SQS, and CloudWatch are usage-based for this low-volume verification run.
- Fargate runs only for a bounded validation task. At the published US East Linux/x86 rates, a 0.25 vCPU and 0.5 GB task running for ten minutes is approximately USD 0.002 before data transfer.
- ECR has no compute charge; only the small retained image storage is persistent project cost.
- The existing shared NAT and RDS fixed costs are protected baseline costs, not new Agent Market resources.

Pricing references:

- https://aws.amazon.com/api-gateway/pricing/
- https://aws.amazon.com/fargate/pricing/
- https://aws.amazon.com/ecr/pricing/

## Validation lifecycle

1. Deploy the project stack only after exact action-time approval.
2. Apply the Agent Market database migration to a project-specific schema.
3. Send one controlled request through API Gateway, Lambda, SNS, SQS, and the short-lived ECS task.
4. Verify request ID continuity, queue state, ECS exit status, PostgreSQL result, logs, and dashboard evidence.
5. Capture sanitized AWS console screenshots without account IDs, ARNs, secrets, endpoints, or unrelated projects.
6. Disable the SQS event-source mapping and confirm zero running ECS tasks.
7. Keep serverless resources idle for reproducibility, or delete only the exact Agent Market stack after fresh destructive-action confirmation.

## Protected resources

The shared network, NAT gateway, RDS instance, database secret, artifact bucket, OIDC provider, budget, and all non-Agent-Market project resources must never be deleted by Agent Market cleanup.

## Authorized post-evidence pause

After the production performance request is publicly readable from Evidence, the authorized reversible pause is limited to:

1. Disable the Agent Market SQS event-source mapping.
2. Wait for the Agent Market work queue consumer to stop receiving new work.
3. Confirm the Agent Market ECS cluster has zero running tasks.
4. Capture sanitized proof of the disabled trigger and zero running task count.

API Gateway, Lambda definitions, SNS, SQS, ECR, logs, and the project stack may remain idle for reproducibility because they have no continuously running project compute. Stack deletion, image deletion, queue purge, log deletion, and any shared-foundation change are not authorized by this pause instruction.
