#!/usr/bin/env bash
set -euo pipefail
STACK_NAME="${1:-}"
SHARED_CLUSTER_ARN="${2:-}"
ARTIFACT_DIR="${3:-${T7_TRANSITION_DIR:-.tc-flow/runtime/t7-cluster-transition/${STACK_NAME}}}"
FINAL_TEMPLATE="infra/aws/template.yaml"
[[ -n "$STACK_NAME" && -n "$SHARED_CLUSTER_ARN" ]] || { echo "usage: $0 STACK_NAME SHARED_CLUSTER_ARN [ARTIFACT_DIR]" >&2; exit 64; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
MARKER_FILE="$ARTIFACT_DIR/transition-marker.json"
REVIEW_FILE="$ARTIFACT_DIR/phase1-review.json"
PHASE1_TEMPLATE_FILE="$ARTIFACT_DIR/phase1-template.yaml"
for path in "$MARKER_FILE" "$REVIEW_FILE" "$PHASE1_TEMPLATE_FILE" "$FINAL_TEMPLATE"; do [[ -f "$path" ]] || { echo "missing artifact: $path" >&2; exit 1; }; done
expected_parameter="/agent-market/${STACK_NAME}/cluster-transition-marker"
jq -e --arg stack "$STACK_NAME" --arg cluster "$SHARED_CLUSTER_ARN" --arg parameter "$expected_parameter" '
  .schemaVersion == 1 and .stackName == $stack and .sharedClusterArn == $cluster and
  .markerParameterName == $parameter and
  (.retainedClusterPhysicalId | type == "string" and length > 0) and
  (.changeSetArn | type == "string" and startswith("arn:")) and
  (.changeSetReviewSha256 | test("^[0-9a-f]{64}$")) and
  (.phase1TemplateSha256 | test("^[0-9a-f]{64}$")) and
  (.finalTemplateSha256 | test("^[0-9a-f]{64}$")) and
  (.approvedAt | fromdateiso8601)
' "$MARKER_FILE" >/dev/null || { echo "marker schema or ownership invalid" >&2; exit 1; }
[[ "$(jq -r '.changeSetReviewSha256' "$MARKER_FILE")" == "$(jq -r '.changeSetReviewSha256' "$REVIEW_FILE")" ]] || { echo "review hash mismatch" >&2; exit 1; }
[[ "$(sha256_file "$PHASE1_TEMPLATE_FILE")" == "$(jq -r '.phase1TemplateSha256' "$MARKER_FILE")" ]] || { echo "phase1 template hash mismatch" >&2; exit 1; }
[[ "$(sha256_file "$FINAL_TEMPLATE")" == "$(jq -r '.finalTemplateSha256' "$MARKER_FILE")" ]] || { echo "final template hash mismatch" >&2; exit 1; }
marker_sha256="$(sha256_file "$MARKER_FILE")"
approved_final_template_sha256="$(jq -r '.finalTemplateSha256' "$MARKER_FILE")"
jq -cn --arg markerParameterName "$expected_parameter" --arg markerSha256 "$marker_sha256" \
  --arg expectedResolvedValue "$marker_sha256" --arg finalTemplateSha256 "$approved_final_template_sha256" \
  '{markerParameterName:$markerParameterName,markerSha256:$markerSha256,
    expectedResolvedValue:$expectedResolvedValue,finalTemplateSha256:$finalTemplateSha256}'
