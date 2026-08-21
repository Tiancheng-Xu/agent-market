import assert from "node:assert/strict";
import test from "node:test";

import { injectRetainPolicies } from "./inject-agent-market-cluster-retain.mjs";

const fixture = `AWSTemplateFormatVersion: "2010-09-09"
Parameters:
  ProjectName:
    Type: String
Resources:
  PerformanceCluster:
    Type: AWS::ECS::Cluster
    Properties:
      ClusterName: !Sub "\${ProjectName}-performance"
      Tags:
        - Key: Project
          Value: !Ref ProjectName
  Worker:
    Type: AWS::ECS::TaskDefinition
    Properties:
      ExecutionRoleArn: !GetAtt TaskExecutionRole.Arn
Outputs:
  ClusterArn:
    Value: !GetAtt PerformanceCluster.Arn
`;

test("injects exactly two Retain lines and preserves short-form tags byte for byte", () => {
  const insertion = "    DeletionPolicy: Retain\n    UpdateReplacePolicy: Retain\n";
  const transformed = injectRetainPolicies(fixture);
  assert.equal(transformed, fixture.replace(
    "  PerformanceCluster:\n",
    `  PerformanceCluster:\n${insertion}`,
  ));
  assert.equal(transformed.replace(insertion, ""), fixture);
  for (const tag of [
    '!Sub "${ProjectName}-performance"',
    "!Ref ProjectName",
    "!GetAtt TaskExecutionRole.Arn",
    "!GetAtt PerformanceCluster.Arn",
  ]) assert.ok(transformed.includes(tag), `${tag} must remain byte-identical`);
});

test("rejects duplicate PerformanceCluster logical IDs", () => {
  const duplicate = fixture.replace(
    "  Worker:\n",
    "  PerformanceCluster:\n    Type: AWS::ECS::Cluster\n  Worker:\n",
  );
  assert.throws(() => injectRetainPolicies(duplicate), /PERFORMANCE_CLUSTER_MATCH_COUNT/);
});

test("rejects anomalous resource indentation", () => {
  const anomalous = fixture.replace("  PerformanceCluster:\n", "   PerformanceCluster:\n");
  assert.throws(() => injectRetainPolicies(anomalous), /PERFORMANCE_CLUSTER_INDENTATION_INVALID/);
});

test("rejects existing policy conflicts", () => {
  const conflictingDeletion = fixture.replace(
    "  PerformanceCluster:\n",
    "  PerformanceCluster:\n    DeletionPolicy: Delete\n",
  );
  const conflictingReplacement = fixture.replace(
    "  PerformanceCluster:\n",
    "  PerformanceCluster:\n    UpdateReplacePolicy: Snapshot\n",
  );
  assert.throws(() => injectRetainPolicies(conflictingDeletion), /PERFORMANCE_CLUSTER_POLICY_CONFLICT/);
  assert.throws(() => injectRetainPolicies(conflictingReplacement), /PERFORMANCE_CLUSTER_POLICY_CONFLICT/);
});

test("rejects tabs, malformed Type indentation, and missing ECS cluster type", () => {
  assert.throws(() => injectRetainPolicies(fixture.replace("    Type: AWS::ECS::Cluster", "\tType: AWS::ECS::Cluster")), /TABS_NOT_ALLOWED/);
  assert.throws(() => injectRetainPolicies(fixture.replace("    Type: AWS::ECS::Cluster", "     Type: AWS::ECS::Cluster")), /PERFORMANCE_CLUSTER_TYPE_INVALID/);
  assert.throws(() => injectRetainPolicies(fixture.replace("AWS::ECS::Cluster", "AWS::SQS::Queue")), /PERFORMANCE_CLUSTER_TYPE_INVALID/);
});
