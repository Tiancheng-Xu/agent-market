#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
STACK_NAME="${STACK_NAME:-agent-market-performance}"
AWS_REGION="${AWS_REGION:-us-east-1}"

case "$ACTION" in
  pause|resume|status) ;;
  *)
    printf 'Usage: %s [pause|resume|status]\n' "$0" >&2
    exit 64
    ;;
esac

resources="$(aws cloudformation list-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --output json)"

mapping_uuid="$(jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::Lambda::EventSourceMapping") | .PhysicalResourceId] | if length == 1 then .[0] else empty end' <<<"$resources")"
cluster_name="$(jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::ECS::Cluster") | .PhysicalResourceId] | if length == 1 then .[0] else empty end' <<<"$resources")"

if [[ -z "$mapping_uuid" || -z "$cluster_name" ]]; then
  echo "Refusing lifecycle action: expected exactly one stack-owned event mapping and ECS cluster." >&2
  exit 1
fi

wait_for_mapping_state() {
  local expected_state="$1"
  local state

  for _ in {1..30}; do
    state="$(aws lambda get-event-source-mapping \
      --uuid "$mapping_uuid" \
      --region "$AWS_REGION" \
      --query 'State' \
      --output text)"
    if [[ "$state" == "$expected_state" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for event source mapping state $expected_state (last state: $state)." >&2
  return 1
}

if [[ "$ACTION" == "pause" ]]; then
  aws lambda update-event-source-mapping \
    --uuid "$mapping_uuid" \
    --no-enabled \
    --region "$AWS_REGION" \
    --query 'State' \
    --output text >/dev/null
  wait_for_mapping_state "Disabled"
elif [[ "$ACTION" == "resume" ]]; then
  aws lambda update-event-source-mapping \
    --uuid "$mapping_uuid" \
    --enabled \
    --region "$AWS_REGION" \
    --query 'State' \
    --output text >/dev/null
  wait_for_mapping_state "Enabled"
fi

mapping_state="$(aws lambda get-event-source-mapping \
  --uuid "$mapping_uuid" \
  --region "$AWS_REGION" \
  --query 'State' \
  --output text)"

running_tasks="$(aws ecs list-tasks \
  --cluster "$cluster_name" \
  --desired-status RUNNING \
  --region "$AWS_REGION" \
  --query 'length(taskArns)' \
  --output text)"

if [[ "$ACTION" == "pause" && "$running_tasks" != "0" ]]; then
  echo "Consumer is disabled, but Fargate still has running tasks; wait for natural completion before claiming paused." >&2
  exit 1
fi

jq -n \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg action "$ACTION" \
  --arg stack "$STACK_NAME" \
  --arg region "$AWS_REGION" \
  --arg mappingState "$mapping_state" \
  --argjson runningFargateTasks "$running_tasks" \
  '{
    capturedAt: $capturedAt,
    action: $action,
    stack: $stack,
    region: $region,
    eventSourceMapping: $mappingState,
    runningFargateTasks: $runningFargateTasks,
    destructiveAction: false,
    sharedInfrastructureChanged: false
  }'
