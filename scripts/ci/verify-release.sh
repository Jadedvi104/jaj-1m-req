#!/usr/bin/env bash
set -euo pipefail

# Recheck after approval/queue waits: rerunning an old run must not roll back
# a newer branch tip. Deliberate rollback follows the runbook's digest procedure.
case "${DEPLOYMENT_ENVIRONMENT:-}:${GITHUB_REF:-}" in
  testing:refs/heads/testing|staging:refs/heads/staging|production:refs/heads/main) ;;
  *) echo '::error::Deployment environment and branch do not match.'; exit 1 ;;
esac
case "${GITHUB_EVENT_NAME:-}" in
  push|workflow_dispatch) ;;
  *) echo '::error::Only branch pushes and manual releases may deploy.'; exit 1 ;;
esac
head_sha=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/${GITHUB_REF#refs/heads/}" --jq .object.sha)
[[ -n "$head_sha" && "$head_sha" == "$GITHUB_SHA" ]] || {
  echo '::error::This release has been superseded. Run CI on the current branch tip.'
  exit 1
}
