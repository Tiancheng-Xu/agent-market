import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import test from "node:test";
import assert from "node:assert/strict";

const templatePath = fileURLToPath(new URL("./template.yaml", import.meta.url));
const template = readFileSync(templatePath, "utf8");

test("declares the complete project-owned AWS chain", () => {
  for (const type of [
    "AWS::ApiGatewayV2::Api",
    "AWS::Lambda::Function",
    "AWS::SNS::Topic",
    "AWS::SQS::Queue",
    "AWS::ECS::Cluster",
    "AWS::ECS::TaskDefinition",
    "AWS::ECR::Repository",
    "AWS::Lambda::EventSourceMapping",
  ]) {
    assert.match(template, new RegExp(type.replaceAll("::", "\\:\\:")));
  }
  assert.match(template, /BatchSize:\s*1/u);
  assert.match(template, /MaximumConcurrency:\s*2/u);
  assert.doesNotMatch(template, /ReservedConcurrentExecutions/u);
});

test("cannot recreate or replace protected shared foundation resources", () => {
  for (const forbidden of [
    "AWS::EC2::VPC",
    "AWS::EC2::NatGateway",
    "AWS::RDS::DBInstance",
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "AWS::IAM::OIDCProvider",
    "AWS::S3::Bucket",
  ]) {
    assert.doesNotMatch(
      template,
      new RegExp(
        `Type:\\s*${forbidden.replaceAll("::", "\\:\\:")}\\s*(?:\\n|$)`,
      ),
    );
  }
  assert.doesNotMatch(template, /AWS::ECS::Service/u);
});

test("supports a reversible pause without stack deletion", () => {
  assert.match(template, /ConsumerMappingUuid/u);
  assert.match(template, /ClusterName/u);
  assert.match(template, /WorkQueueUrl/u);
});
