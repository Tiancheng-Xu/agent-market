#!/usr/bin/env bash
set -euo pipefail
STACK_NAME="${1:-}"
SHARED_CLUSTER_ARN="${2:-}"
AGGREGATOR_IMAGE_DIGEST="${3:-}"
REGION="${4:-${AWS_REGION:-us-east-1}}"
[[ $# -eq 3 || $# -eq 4 ]] || {
  echo "usage: $0 STACK_NAME SHARED_CLUSTER_ARN sha256:DIGEST [REGION]" >&2; exit 64;
}
[[ -n "$STACK_NAME" && -n "$SHARED_CLUSTER_ARN" && "$AGGREGATOR_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "usage: $0 STACK_NAME SHARED_CLUSTER_ARN sha256:DIGEST [REGION]" >&2; exit 64;
}
validation="$(scripts/aws/validate-agent-market-cluster-transition.sh "$STACK_NAME" "$SHARED_CLUSTER_ARN")"
marker_parameter="$(jq -er '.markerParameterName' <<<"$validation")"
marker_sha256="$(jq -er '.markerSha256' <<<"$validation")"
expected_resolved_value="$(jq -er '.expectedResolvedValue' <<<"$validation")"
approved_final_template_sha256="$(jq -er '.finalTemplateSha256 | select(test("^[0-9a-f]{64}$"))' <<<"$validation")"
[[ "$marker_sha256" == "$expected_resolved_value" ]] || { echo "validator marker mismatch" >&2; exit 1; }
resolved_value="$(aws --region "$REGION" --no-cli-pager ssm get-parameter --name "$marker_parameter" --query 'Parameter.Value' --output text)"
[[ "$resolved_value" == "$marker_sha256" ]] || { echo "SSM transition marker mismatch" >&2; exit 1; }
umask 077
frozen_dir="$(mktemp -d "/tmp/agent-market-template.XXXXXX")"
trap 'rm -rf "$frozen_dir"' EXIT
frozen_template="$frozen_dir/frozen-template.yaml"
cp infra/aws/template.yaml "$frozen_template"
chmod 400 "$frozen_template"
hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
[[ "$(hash_file "$frozen_template")" == "$approved_final_template_sha256" ]] || {
  echo "approved final template hash mismatch" >&2; exit 1;
}
# This is the only repository-supported final deployment path. The local policy rejects bare deploy/update-stack elsewhere.
[[ "$(hash_file "$frozen_template")" == "$approved_final_template_sha256" ]] || {
  echo "frozen template changed before deploy" >&2; exit 1;
}
aws --region "$REGION" --no-cli-pager cloudformation deploy \
  --stack-name "$STACK_NAME" --template-file "$frozen_template" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides SharedEcsClusterArn="$SHARED_CLUSTER_ARN" \
    ClusterTransitionMarkerSha256="$marker_parameter" AggregatorImageDigest="$AGGREGATOR_IMAGE_DIGEST"
