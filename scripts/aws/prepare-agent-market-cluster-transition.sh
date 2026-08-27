#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
STACK_NAME="${2:-}"
SHARED_CLUSTER_ARN="${3:-}"
REGION="${4:-${AWS_REGION:-us-east-1}}"
ARTIFACT_DIR="${T7_TRANSITION_DIR:-.tc-flow/runtime/t7-cluster-transition/${STACK_NAME}}"
FINAL_TEMPLATE="infra/aws/template.yaml"
MARKER_PARAMETER_NAME="/agent-market/${STACK_NAME}/cluster-transition-marker"
[[ "$ACTION" == "prepare" || "$ACTION" == "approve" || "$ACTION" == "prepare-final" || "$ACTION" == "approve-final" ]] && [[ -n "$STACK_NAME" && -n "$SHARED_CLUSTER_ARN" ]] || {
  echo "usage: $0 prepare|approve|prepare-final|approve-final STACK_NAME SHARED_CLUSTER_ARN [REGION]" >&2; exit 64;
}
mkdir -p "$ARTIFACT_DIR"
aws_cli() { aws --region "$REGION" --no-cli-pager "$@"; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
change_set_review_hash() {
  jq -cS '{StackId,ChangeSetId,ChangeSetName,Changes}' "$1" | shasum -a 256 | awk '{print $1}'
}
validate_change_set_scope() {
  jq -e '
    .Status == "CREATE_COMPLETE" and .ExecutionStatus == "AVAILABLE" and
    (.Changes | length) > 0 and
    any(.Changes[];
      .Type == "Resource" and
      .ResourceChange.LogicalResourceId == "PerformanceCluster" and
      .ResourceChange.ResourceType == "AWS::ECS::Cluster" and
      .ResourceChange.Action == "Modify") and
    all(.Changes[];
      .Type == "Resource" and
      (
        (
          .ResourceChange.LogicalResourceId == "PerformanceCluster" and
          .ResourceChange.ResourceType == "AWS::ECS::Cluster" and
          .ResourceChange.Action == "Modify"
        ) or
        (
          .ResourceChange.LogicalResourceId == "DispatcherFunction" and
          .ResourceChange.ResourceType == "AWS::Lambda::Function" and
          .ResourceChange.Action == "Modify" and
          .ResourceChange.Replacement == "False" and
          (.ResourceChange.Details | length) > 0 and
          all(.ResourceChange.Details[];
            .Evaluation == "Dynamic" and
            .ChangeSource == "ResourceAttribute" and
            .CausingEntity == "PerformanceCluster.Arn" and
            .Target.RequiresRecreation == "Never")
        )
      ))
  ' "$1" >/dev/null || { echo "change set exceeds Retain-only PerformanceCluster scope and its non-replacing DispatcherFunction ARN dependency" >&2; return 1; }
}

STACK_FILE="$ARTIFACT_DIR/stack.json"
CURRENT_TEMPLATE_FILE="$ARTIFACT_DIR/current-template.yaml"
PHASE1_TEMPLATE_FILE="$ARTIFACT_DIR/phase1-template.yaml"
PARAMETERS_FILE="$ARTIFACT_DIR/previous-parameters.json"
CHANGE_SET_FILE="$ARTIFACT_DIR/phase1-change-set.json"
REVIEW_FILE="$ARTIFACT_DIR/phase1-review.json"
APPROVAL_CHANGE_SET_FILE="$ARTIFACT_DIR/approval-change-set.json"
MARKER_FILE="$ARTIFACT_DIR/transition-marker.json"
FINAL_REVIEW_FILE="$ARTIFACT_DIR/final-template-review.json"

validate_retained_cluster_state() {
  local retained_template="$ARTIFACT_DIR/current-retained-template.yaml"
  aws_cli cloudformation get-template --stack-name "$STACK_NAME" --template-stage Original \
    --query TemplateBody --output text > "$retained_template"
  local cluster_block
  cluster_block="$(awk '
    /^  PerformanceCluster:$/ { capture=1; count+=1 }
    capture && /^  [A-Za-z][A-Za-z0-9]+:$/ && $0 != "  PerformanceCluster:" { capture=0 }
    capture { print }
    END { if (count != 1) exit 2 }
  ' "$retained_template")" || { echo "retained PerformanceCluster block is missing or ambiguous" >&2; return 1; }
  grep -Fxq "    DeletionPolicy: Retain" <<<"$cluster_block" || { echo "retained cluster DeletionPolicy is not Retain" >&2; return 1; }
  grep -Fxq "    UpdateReplacePolicy: Retain" <<<"$cluster_block" || { echo "retained cluster UpdateReplacePolicy is not Retain" >&2; return 1; }
  local cluster_physical_id
  cluster_physical_id="$(aws_cli cloudformation describe-stack-resource --stack-name "$STACK_NAME" \
    --logical-resource-id PerformanceCluster --query 'StackResourceDetail.PhysicalResourceId' --output text)"
  [[ "$SHARED_CLUSTER_ARN" == */"$cluster_physical_id" ]] || { echo "retained cluster physical ID mismatch" >&2; return 1; }
}

if [[ "$ACTION" == "prepare-final" || "$ACTION" == "approve-final" ]]; then
  [[ -f "$MARKER_FILE" && -f "$REVIEW_FILE" && -f "$PHASE1_TEMPLATE_FILE" ]] || { echo "approved transition artifacts missing" >&2; exit 1; }
  validate_retained_cluster_state
  prior_marker_sha256="$(sha256_file "$MARKER_FILE")"
  resolved_marker="$(aws_cli ssm get-parameter --name "$MARKER_PARAMETER_NAME" --query 'Parameter.Value' --output text)"
  [[ "$resolved_marker" == "$prior_marker_sha256" ]] || { echo "current transition marker is not bound to local approval" >&2; exit 1; }
  final_template_sha256="$(sha256_file "$FINAL_TEMPLATE")"
  final_review_sha256="$(jq -cnS --arg stackName "$STACK_NAME" --arg sharedClusterArn "$SHARED_CLUSTER_ARN" \
    --arg priorMarkerSha256 "$prior_marker_sha256" --arg finalTemplateSha256 "$final_template_sha256" \
    '{stackName:$stackName,sharedClusterArn:$sharedClusterArn,priorMarkerSha256:$priorMarkerSha256,finalTemplateSha256:$finalTemplateSha256}' \
    | shasum -a 256 | awk '{print $1}')"
  if [[ "$ACTION" == "prepare-final" ]]; then
    jq -cn --arg stackName "$STACK_NAME" --arg region "$REGION" --arg sharedClusterArn "$SHARED_CLUSTER_ARN" \
      --arg priorMarkerSha256 "$prior_marker_sha256" --arg finalTemplateSha256 "$final_template_sha256" \
      --arg finalReviewSha256 "$final_review_sha256" --arg approvalToken "approve-final-${final_review_sha256:0:16}" \
      '{schemaVersion:1,stackName:$stackName,region:$region,sharedClusterArn:$sharedClusterArn,
        priorMarkerSha256:$priorMarkerSha256,finalTemplateSha256:$finalTemplateSha256,
        finalReviewSha256:$finalReviewSha256,approvalToken:$approvalToken}' > "$FINAL_REVIEW_FILE"
    echo "Review $FINAL_TEMPLATE and $FINAL_REVIEW_FILE; then rerun approve-final with APPROVE_TOKEN from the review file." >&2
    exit 0
  fi
  jq -e --arg stack "$STACK_NAME" --arg region "$REGION" --arg cluster "$SHARED_CLUSTER_ARN" \
    --arg prior "$prior_marker_sha256" --arg final "$final_template_sha256" --arg review "$final_review_sha256" \
    '.schemaVersion == 1 and .stackName == $stack and .region == $region and .sharedClusterArn == $cluster and
      .priorMarkerSha256 == $prior and .finalTemplateSha256 == $final and .finalReviewSha256 == $review' \
    "$FINAL_REVIEW_FILE" >/dev/null || { echo "final template review is stale or invalid" >&2; exit 1; }
  [[ "${APPROVE_TOKEN:-}" == "$(jq -r '.approvalToken' "$FINAL_REVIEW_FILE")" ]] || { echo "explicit final approval token mismatch" >&2; exit 1; }
  jq --arg finalTemplateSha256 "$final_template_sha256" --arg finalReviewSha256 "$final_review_sha256" \
    --arg finalReapprovedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.finalTemplateSha256=$finalTemplateSha256 | .finalReviewSha256=$finalReviewSha256 | .finalReapprovedAt=$finalReapprovedAt' \
    "$MARKER_FILE" > "$MARKER_FILE.next"
  mv "$MARKER_FILE.next" "$MARKER_FILE"
  marker_sha256="$(sha256_file "$MARKER_FILE")"
  aws_cli ssm put-parameter --name "$MARKER_PARAMETER_NAME" --type String --tier Standard \
    --overwrite --value "$marker_sha256" >/dev/null
  printf '{"markerParameterName":"%s","markerSha256":"%s","finalReviewSha256":"%s"}\n' \
    "$MARKER_PARAMETER_NAME" "$marker_sha256" "$final_review_sha256"
  exit 0
fi

if [[ "$ACTION" == "prepare" ]]; then
  aws_cli cloudformation describe-stacks --stack-name "$STACK_NAME" > "$STACK_FILE"
  aws_cli cloudformation get-template --stack-name "$STACK_NAME" --template-stage Original \
    --query TemplateBody --output text > "$CURRENT_TEMPLATE_FILE"
  node scripts/aws/inject-agent-market-cluster-retain.mjs "$CURRENT_TEMPLATE_FILE" "$PHASE1_TEMPLATE_FILE"
  jq '[.Stacks[0].Parameters[] | {ParameterKey,UsePreviousValue:true}]' "$STACK_FILE" > "$PARAMETERS_FILE"
  change_set_name="agent-market-cluster-retain-$(date -u +%Y%m%d%H%M%S)"
  change_set_arn="$(aws_cli cloudformation create-change-set --stack-name "$STACK_NAME" \
    --change-set-name "$change_set_name" --change-set-type UPDATE \
    --template-body "file://$PHASE1_TEMPLATE_FILE" --parameters "file://$PARAMETERS_FILE" \
    --capabilities CAPABILITY_NAMED_IAM --query Id --output text)"
  aws_cli cloudformation wait change-set-create-complete --change-set-name "$change_set_arn" --stack-name "$STACK_NAME"
  aws_cli cloudformation describe-change-set --change-set-name "$change_set_arn" --stack-name "$STACK_NAME" > "$CHANGE_SET_FILE"
  validate_change_set_scope "$CHANGE_SET_FILE"
  review_hash="$(change_set_review_hash "$CHANGE_SET_FILE")"
  approval_token="approve-${review_hash:0:16}"
  jq -cn --arg stackName "$STACK_NAME" --arg region "$REGION" --arg sharedClusterArn "$SHARED_CLUSTER_ARN" \
    --arg changeSetArn "$change_set_arn" --arg changeSetReviewSha256 "$review_hash" \
    --arg phase1TemplateSha256 "$(sha256_file "$PHASE1_TEMPLATE_FILE")" \
    --arg finalTemplateSha256 "$(sha256_file "$FINAL_TEMPLATE")" --arg approvalToken "$approval_token" \
    '{schemaVersion:1,stackName:$stackName,region:$region,sharedClusterArn:$sharedClusterArn,
      changeSetArn:$changeSetArn,changeSetReviewSha256:$changeSetReviewSha256,
      phase1TemplateSha256:$phase1TemplateSha256,finalTemplateSha256:$finalTemplateSha256,
      approvalToken:$approvalToken}' > "$REVIEW_FILE"
  echo "Review $CHANGE_SET_FILE and $REVIEW_FILE; then rerun approve with APPROVE_TOKEN from the review file." >&2
  exit 0
fi

[[ -f "$REVIEW_FILE" && -f "$CHANGE_SET_FILE" && -f "$PHASE1_TEMPLATE_FILE" ]] || { echo "transition review artifacts missing" >&2; exit 1; }
jq -e --arg stack "$STACK_NAME" --arg region "$REGION" --arg cluster "$SHARED_CLUSTER_ARN" \
  '.schemaVersion == 1 and .stackName == $stack and .region == $region and .sharedClusterArn == $cluster' "$REVIEW_FILE" >/dev/null
[[ "${APPROVE_TOKEN:-}" == "$(jq -r '.approvalToken' "$REVIEW_FILE")" ]] || { echo "explicit approval token mismatch" >&2; exit 1; }
[[ "$(sha256_file "$PHASE1_TEMPLATE_FILE")" == "$(jq -r '.phase1TemplateSha256' "$REVIEW_FILE")" ]] || { echo "phase1 template changed after review" >&2; exit 1; }
[[ "$(sha256_file "$FINAL_TEMPLATE")" == "$(jq -r '.finalTemplateSha256' "$REVIEW_FILE")" ]] || { echo "final template changed after review" >&2; exit 1; }
review_hash="$(jq -r '.changeSetReviewSha256' "$REVIEW_FILE")"
[[ "$(change_set_review_hash "$CHANGE_SET_FILE")" == "$review_hash" ]] || { echo "stored change set changed after review" >&2; exit 1; }
change_set_arn="$(jq -r '.changeSetArn' "$REVIEW_FILE")"
aws_cli cloudformation describe-change-set --change-set-name "$change_set_arn" --stack-name "$STACK_NAME" > "$APPROVAL_CHANGE_SET_FILE"
validate_change_set_scope "$APPROVAL_CHANGE_SET_FILE"
approval_hash="$(change_set_review_hash "$APPROVAL_CHANGE_SET_FILE")"
[[ "$approval_hash" == "$review_hash" ]] || { echo "live change set differs from reviewed content" >&2; exit 1; }
aws_cli cloudformation execute-change-set --stack-name "$STACK_NAME" --change-set-name "$change_set_arn"
aws_cli cloudformation wait stack-update-complete --stack-name "$STACK_NAME"
cluster_physical_id="$(aws_cli cloudformation describe-stack-resource --stack-name "$STACK_NAME" \
  --logical-resource-id PerformanceCluster --query 'StackResourceDetail.PhysicalResourceId' --output text)"
[[ "$SHARED_CLUSTER_ARN" == */"$cluster_physical_id" ]] || { echo "shared cluster ARN does not match retained cluster" >&2; exit 1; }
jq -cn --arg stackName "$STACK_NAME" --arg region "$REGION" --arg sharedClusterArn "$SHARED_CLUSTER_ARN" \
  --arg markerParameterName "$MARKER_PARAMETER_NAME" --arg retainedClusterPhysicalId "$cluster_physical_id" \
  --arg changeSetArn "$change_set_arn" --arg changeSetReviewSha256 "$review_hash" \
  --arg phase1TemplateSha256 "$(sha256_file "$PHASE1_TEMPLATE_FILE")" \
  --arg finalTemplateSha256 "$(sha256_file "$FINAL_TEMPLATE")" --arg approvedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion:1,stackName:$stackName,region:$region,sharedClusterArn:$sharedClusterArn,
    markerParameterName:$markerParameterName,retainedClusterPhysicalId:$retainedClusterPhysicalId,
    changeSetArn:$changeSetArn,changeSetReviewSha256:$changeSetReviewSha256,
    phase1TemplateSha256:$phase1TemplateSha256,finalTemplateSha256:$finalTemplateSha256,approvedAt:$approvedAt}' > "$MARKER_FILE"
marker_sha256="$(sha256_file "$MARKER_FILE")"
aws_cli ssm put-parameter --name "$MARKER_PARAMETER_NAME" --type String --tier Standard \
  --overwrite --value "$marker_sha256" >/dev/null
printf '{"markerParameterName":"%s","markerSha256":"%s"}\n' "$MARKER_PARAMETER_NAME" "$marker_sha256"
