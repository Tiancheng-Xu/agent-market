#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
STACK_NAME="${2:-}"
REGION="${3:-${AWS_REGION:-us-east-1}}"
WAIT_SECONDS="${WAIT_SECONDS:-180}"
if [[ "$ACTION" != "pause" && "$ACTION" != "resume" ]] || [[ -z "$STACK_NAME" ]]; then
  echo "usage: $0 pause|resume STACK_NAME [REGION]" >&2
  exit 64
fi

aws_cli() { aws --region "$REGION" --no-cli-pager "$@"; }
stack_output() {
  local key="$1"
  aws_cli cloudformation describe-stacks --stack-name "$STACK_NAME" \
    | jq -er --arg key "$key" '.Stacks[0].Outputs[] | select(.OutputKey == $key) | .OutputValue'
}

PROJECT_NAME="$(stack_output ProjectName)"
CLUSTER_ARN="$(stack_output SharedEcsClusterArn)"
STARTED_BY="$(stack_output TaskStartedBy)"
INGESTION_FUNCTION="$(stack_output IngestionFunctionName)"
DISPATCHER_FUNCTION="$(stack_output DispatcherFunctionName)"
MAPPING_UUID="$(stack_output ConsumerMappingUuid)"
WORK_QUEUE_URL="$(stack_output WorkQueueUrl)"
STATE_PARAMETER="$(stack_output LifecycleStateParameterName)"

list_project_task_arns() {
  local desired_status
  for desired_status in PENDING RUNNING; do
    aws_cli ecs list-tasks --cluster "$CLUSTER_ARN" --started-by "$STARTED_BY" \
      --desired-status "$desired_status" --query 'taskArns[]' --output text
  done | tr '\t' '\n' | sed '/^None$/d;/^$/d' | sort -u
}

owned_project_task_arns() {
  local task_arns=() task_arn described
  while IFS= read -r task_arn; do
    [[ -n "$task_arn" ]] && task_arns+=("$task_arn")
  done < <(list_project_task_arns)
  ((${#task_arns[@]} > 0)) || return 0
  described="$(aws_cli ecs describe-tasks --cluster "$CLUSTER_ARN" --tasks "${task_arns[@]}" --include TAGS)"
  jq -e --arg started_by "$STARTED_BY" --arg project "$PROJECT_NAME" '
    (.failures | length) == 0 and
    ([.tasks[] | select(
      .startedBy != $started_by or
      ([.tags[]? | select(.key == "Project") | .value] | first) != $project
    )] | length) == 0
  ' >/dev/null <<<"$described" || { echo "project task ownership validation failed" >&2; return 1; }
  jq -r '.tasks[] | select(.lastStatus == "PENDING" or .lastStatus == "RUNNING") | .taskArn' <<<"$described" | sort -u
}

wait_for_project_tasks_to_clear() {
  local deadline=$((SECONDS + WAIT_SECONDS)) active
  while ((SECONDS < deadline)); do
    active="$(owned_project_task_arns)"
    [[ -z "$active" ]] && return 0
    sleep 3
  done
  echo "project tasks did not clear before deadline" >&2
  return 1
}

stop_project_tasks() {
  local task_arn
  while IFS= read -r task_arn; do
    [[ -z "$task_arn" ]] && continue
    aws_cli ecs stop-task --cluster "$CLUSTER_ARN" --task "$task_arn" \
      --reason "agent-market operator pause" >/dev/null
  done < <(owned_project_task_arns)
  wait_for_project_tasks_to_clear
}

get_concurrency() {
  local function_name="$1" response
  response="$(aws_cli lambda get-function-concurrency --function-name "$function_name")"
  if [[ -z "${response//[[:space:]]/}" ]]; then
    printf '%s\n' "unreserved"
    return 0
  fi
  jq -er 'if has("ReservedConcurrentExecutions") then .ReservedConcurrentExecutions else "unreserved" end' <<<"$response"
}

concurrency_json() {
  local value="$1"
  if [[ "$value" == "unreserved" ]]; then printf '%s' '"unreserved"'; else printf '%s' "$value"; fi
}

put_state() {
  aws_cli ssm put-parameter --name "$STATE_PARAMETER" --type String --overwrite --value "$1" >/dev/null
}

state_with_status() {
  local state_json="$1" state="$2"
  jq -c --arg state "$state" --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.state = $state | .updatedAt = $updated_at' <<<"$state_json"
}

validate_resume_state() {
  local state_json="$1"
  jq -e \
    --arg stack "$STACK_NAME" --arg region "$REGION" --arg project "$PROJECT_NAME" \
    --arg cluster "$CLUSTER_ARN" --arg started_by "$STARTED_BY" \
    --arg ingestion "$INGESTION_FUNCTION" --arg dispatcher "$DISPATCHER_FUNCTION" \
    --arg mapping "$MAPPING_UUID" --arg queue "$WORK_QUEUE_URL" --arg parameter "$STATE_PARAMETER" '
    .version == 1 and .state == "paused" and
    ((keys | sort) == (["capturedAt","clusterArn","dispatcherFunction","ingestionFunction","mappingUuid","priorDispatcherConcurrency","priorIngestionConcurrency","priorMappingState","projectName","region","stackName","startedBy","state","stateParameter","updatedAt","version","workQueueUrl"] | sort)) and
    .stackName == $stack and .region == $region and .projectName == $project and
    .clusterArn == $cluster and .startedBy == $started_by and
    .ingestionFunction == $ingestion and .dispatcherFunction == $dispatcher and
    .mappingUuid == $mapping and .workQueueUrl == $queue and .stateParameter == $parameter and
    (.capturedAt | fromdateiso8601) and (.updatedAt | fromdateiso8601) and
    (.priorMappingState == "Enabled" or .priorMappingState == "Disabled") and
    ((.priorIngestionConcurrency == "unreserved") or
      (.priorIngestionConcurrency | type == "number" and . == floor and . >= 0 and . <= 1)) and
    ((.priorDispatcherConcurrency == "unreserved") or
      (.priorDispatcherConcurrency | type == "number" and . == floor and . == 1))
  ' >/dev/null <<<"$state_json" || { echo "lifecycle state schema or ownership invalid" >&2; return 1; }
}

queue_has_messages_without_metric() {
  local attributes message_count queue_name metric datapoints
  attributes="$(aws_cli sqs get-queue-attributes --queue-url "$WORK_QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed)"
  message_count="$(jq '[.Attributes[] | tonumber] | add // 0' <<<"$attributes")"
  ((message_count > 0)) || return 1
  queue_name="${WORK_QUEUE_URL##*/}"
  metric="$(aws_cli cloudwatch get-metric-statistics --namespace AWS/SQS \
    --metric-name ApproximateAgeOfOldestMessage --dimensions "Name=QueueName,Value=$queue_name" \
    --start-time "$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --period 60 --statistics Maximum)"
  datapoints="$(jq '.Datapoints | length' <<<"$metric")"
  ((datapoints == 0))
}

restore_concurrency() {
  local function_name="$1" value="$2"
  if [[ "$value" == "unreserved" ]]; then
    aws_cli lambda delete-function-concurrency --function-name "$function_name" >/dev/null
  else
    aws_cli lambda put-function-concurrency --function-name "$function_name" \
      --reserved-concurrent-executions "$value" >/dev/null
  fi
}


canonical_state() {
  local value="$1"
  if jq -e . >/dev/null 2>&1 <<<"$value"; then jq -cS . <<<"$value"; else printf '%s' "$value"; fi
}

read_state_value() {
  aws_cli ssm get-parameter --name "$STATE_PARAMETER" --with-decryption | jq -er '.Parameter.Value'
}

snapshot_hash() {
  jq -cS '.snapshot' <<<"$1" | shasum -a 256 | awk '{print $1}'
}

validate_lifecycle_state() {
  local state_json="$1"
  jq -e \
    --arg stack "$STACK_NAME" --arg region "$REGION" --arg project "$PROJECT_NAME" \
    --arg cluster "$CLUSTER_ARN" --arg started_by "$STARTED_BY" \
    --arg ingestion "$INGESTION_FUNCTION" --arg dispatcher "$DISPATCHER_FUNCTION" \
    --arg mapping "$MAPPING_UUID" --arg queue "$WORK_QUEUE_URL" --arg parameter "$STATE_PARAMETER" '
    .version == 2 and
    (.operationId | type == "string" and test("^[0-9a-f]{64}$")) and
    (.state | IN("pausing","paused","resuming","resumed")) and
    (.step | type == "string" and length > 0) and
    (.snapshotHash | test("^[0-9a-f]{64}$")) and
    .ownership == {
      stackName:$stack,region:$region,projectName:$project,clusterArn:$cluster,
      startedBy:$started_by,ingestionFunction:$ingestion,dispatcherFunction:$dispatcher,
      mappingUuid:$mapping,workQueueUrl:$queue,stateParameter:$parameter
    } and
    (.snapshot.priorIngestionConcurrency == "unreserved" or
      (.snapshot.priorIngestionConcurrency | type == "number" and . >= 0 and . <= 1000)) and
    ((.snapshot.priorDispatcherConcurrency == "unreserved") or
      (.snapshot.priorDispatcherConcurrency | type == "number" and . == 1)) and
    (.snapshot.priorMappingState | IN("Enabled","Disabled")) and
    (.snapshot.capturedAt | fromdateiso8601)
  ' <<<"$state_json" >/dev/null || { echo "pause lifecycle schema or ownership invalid" >&2; return 1; }
  [[ "$(snapshot_hash "$state_json")" == "$(jq -r '.snapshotHash' <<<"$state_json")" ]] || {
    echo "immutable pause snapshot hash mismatch" >&2; return 1;
  }
}

cas_state() {
  local expected="$1" next="$2" record current current_version put_result put_version written_record written written_version
  if record="$(aws_cli ssm get-parameter --name "$STATE_PARAMETER" --with-decryption 2>/dev/null)"; then
    current="$(jq -er '.Parameter.Value' <<<"$record")"
    current_version="$(jq -er '.Parameter.Version' <<<"$record")"
  else
    current="__MISSING__"
    current_version=0
  fi
  [[ "$(canonical_state "$current")" == "$(canonical_state "$expected")" ]] || {
    echo "pause state CAS precondition failed" >&2; return 1;
  }
  if [[ "$current" == "__MISSING__" ]]; then
    put_result="$(aws_cli ssm put-parameter --name "$STATE_PARAMETER" --type String --value "$next")"
  else
    validate_lifecycle_state "$expected" 2>/dev/null || [[ "$expected" != \{* ]] || return 1
    put_result="$(aws_cli ssm put-parameter --name "$STATE_PARAMETER" --type String --overwrite --value "$next")"
  fi
  put_version="$(jq -er '.Version' <<<"$put_result")"
  [[ "$put_version" -eq $((current_version + 1)) ]] || {
    echo "pause state CAS version conflict" >&2; return 1;
  }
  written_record="$(aws_cli ssm get-parameter --name "$STATE_PARAMETER" --with-decryption)"
  written="$(jq -er '.Parameter.Value' <<<"$written_record")"
  written_version="$(jq -er '.Parameter.Version' <<<"$written_record")"
  [[ "$written_version" -eq "$put_version" && "$(canonical_state "$written")" == "$(canonical_state "$next")" ]] || {
    echo "pause state CAS readback failed" >&2; return 1;
  }
}

advance_state() {
  local next_state="$1" next_step="$2" next
  validate_lifecycle_state "$state"
  next="$(jq -c --arg next_state "$next_state" --arg next_step "$next_step" \
    --arg updated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.state=$next_state | .step=$next_step | .updatedAt=$updated' <<<"$state")"
  cas_state "$state" "$next"
  state="$next"
}

new_pause_state() {
  local prior_ingestion prior_dispatcher prior_mapping operation_id captured snapshot snapshot_digest
  prior_ingestion="$(get_concurrency "$INGESTION_FUNCTION")"
  prior_dispatcher="$(get_concurrency "$DISPATCHER_FUNCTION")"
  prior_mapping="$(aws_cli lambda get-event-source-mapping --uuid "$MAPPING_UUID" --query State --output text)"
  [[ "$prior_mapping" == "Enabled" || "$prior_mapping" == "Disabled" ]] || { echo "invalid mapping state" >&2; return 1; }
  captured="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  operation_id="$(printf '%s' "$STACK_NAME:$REGION:$captured:$$:$RANDOM" | shasum -a 256 | awk '{print $1}')"
  snapshot="$(jq -cn \
    --argjson ingestion "$(concurrency_json "$prior_ingestion")" \
    --argjson dispatcher "$(concurrency_json "$prior_dispatcher")" \
    --arg mapping "$prior_mapping" --arg captured "$captured" '
    {priorIngestionConcurrency:$ingestion,priorDispatcherConcurrency:$dispatcher,
     priorMappingState:$mapping,capturedAt:$captured}')"
  snapshot_digest="$(printf '%s' "$snapshot" | jq -cS . | shasum -a 256 | awk '{print $1}')"
  jq -cn \
    --arg operation "$operation_id" --arg snapshot_hash "$snapshot_digest" --arg updated "$captured" \
    --arg stack "$STACK_NAME" --arg region "$REGION" --arg project "$PROJECT_NAME" \
    --arg cluster "$CLUSTER_ARN" --arg started_by "$STARTED_BY" \
    --arg ingestion "$INGESTION_FUNCTION" --arg dispatcher "$DISPATCHER_FUNCTION" \
    --arg mapping "$MAPPING_UUID" --arg queue "$WORK_QUEUE_URL" --arg parameter "$STATE_PARAMETER" \
    --argjson snapshot "$snapshot" '
    {version:2,operationId:$operation,state:"pausing",step:"snapshot",
     ownership:{stackName:$stack,region:$region,projectName:$project,clusterArn:$cluster,
       startedBy:$started_by,ingestionFunction:$ingestion,dispatcherFunction:$dispatcher,
       mappingUuid:$mapping,workQueueUrl:$queue,stateParameter:$parameter},
     snapshot:$snapshot,snapshotHash:$snapshot_hash,updatedAt:$updated}'
}

state="$(read_state_value 2>/dev/null || true)"
if [[ "$ACTION" == "pause" ]]; then
  if [[ -n "$state" ]] && jq -e '.version == 2' >/dev/null 2>&1 <<<"$state"; then
    validate_lifecycle_state "$state"
    lifecycle="$(jq -r '.state' <<<"$state")"
    if [[ "$lifecycle" == "paused" ]]; then exit 0; fi
    [[ "$lifecycle" == "pausing" || "$lifecycle" == "resumed" ]] || {
      echo "cannot pause while lifecycle is $lifecycle" >&2; exit 1;
    }
  fi
  if [[ -z "$state" ]] || ! jq -e '.version == 2 and .state == "pausing"' >/dev/null 2>&1 <<<"$state"; then
    if [[ -z "$state" ]]; then expected="__MISSING__"; else expected="$state"; fi
    next="$(new_pause_state)"
    validate_lifecycle_state "$next"
    cas_state "$expected" "$next"
    state="$next"
  fi

  if [[ "$(jq -r '.step' <<<"$state")" == "snapshot" ]]; then
    aws_cli lambda update-event-source-mapping --uuid "$MAPPING_UUID" --enabled false >/dev/null
    advance_state pausing mapping_disabled
  fi
  if [[ "$(jq -r '.step' <<<"$state")" == "mapping_disabled" ]]; then
    aws_cli lambda put-function-concurrency --function-name "$INGESTION_FUNCTION" --reserved-concurrent-executions 0 >/dev/null
    advance_state pausing ingestion_stopped
  fi
  if [[ "$(jq -r '.step' <<<"$state")" == "ingestion_stopped" ]]; then
    aws_cli lambda put-function-concurrency --function-name "$DISPATCHER_FUNCTION" --reserved-concurrent-executions 0 >/dev/null
    advance_state pausing dispatcher_stopped
  fi
  if [[ "$(jq -r '.step' <<<"$state")" == "dispatcher_stopped" ]]; then
    stop_project_tasks
    advance_state pausing tasks_drained
  fi
  if [[ "$(jq -r '.step' <<<"$state")" == "tasks_drained" ]]; then
    advance_state paused complete
  fi
  exit 0
fi

[[ -n "$state" ]] || { echo "pause state missing" >&2; exit 1; }
validate_lifecycle_state "$state"
lifecycle="$(jq -r '.state' <<<"$state")"
if [[ "$lifecycle" == "resumed" ]]; then exit 0; fi
[[ "$lifecycle" == "paused" || "$lifecycle" == "resuming" ]] || {
  echo "cannot resume while lifecycle is $lifecycle" >&2; exit 1;
}
if [[ "$lifecycle" == "paused" ]]; then
  [[ "$(aws_cli lambda get-event-source-mapping --uuid "$MAPPING_UUID" --query State --output text)" == "Disabled" ]] || {
    echo "mapping is not disabled" >&2; exit 1;
  }
  [[ "$(get_concurrency "$INGESTION_FUNCTION")" == "0" && "$(get_concurrency "$DISPATCHER_FUNCTION")" == "0" ]] || {
    echo "paused concurrency drift" >&2; exit 1;
  }
  [[ -z "$(list_project_task_arns)" ]] || { echo "project tasks still active" >&2; exit 1; }
  if queue_has_messages_without_metric; then
    echo "queue_has_messages_without_metric" >&2
    exit 1
  fi
  advance_state resuming resume_started
fi

if [[ "$(jq -r '.step' <<<"$state")" == "resume_started" ]]; then
  restore_concurrency "$INGESTION_FUNCTION" "$(jq -r '.snapshot.priorIngestionConcurrency' <<<"$state")"
  advance_state resuming ingestion_restored
fi
if [[ "$(jq -r '.step' <<<"$state")" == "ingestion_restored" ]]; then
  restore_concurrency "$DISPATCHER_FUNCTION" "$(jq -r '.snapshot.priorDispatcherConcurrency' <<<"$state")"
  advance_state resuming dispatcher_restored
fi
if [[ "$(jq -r '.step' <<<"$state")" == "dispatcher_restored" ]]; then
  aws_cli lambda update-event-source-mapping --uuid "$MAPPING_UUID" \
    --enabled "$(jq -r '.snapshot.priorMappingState == "Enabled"' <<<"$state")" >/dev/null
  advance_state resuming mapping_restored
fi
if [[ "$(jq -r '.step' <<<"$state")" == "mapping_restored" ]]; then
  advance_state resumed complete
fi
