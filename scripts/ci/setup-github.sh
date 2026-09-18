#!/usr/bin/env bash
set -euo pipefail

# Run with a GitHub admin login (or GH_TOKEN) after hosting verification.
repo=Jadedvi104/jaj-1m-req
metadata=${1:-infra/azure-hosting.deployment.json}
[[ -f "$metadata" ]] || { echo "Missing verified deployment metadata: $metadata"; exit 1; }
command -v az >/dev/null || { echo 'Azure CLI is required.'; exit 1; }
[[ $(gh repo view "$repo" --json viewerPermission --jq .viewerPermission) == ADMIN ]] || {
  echo 'Sign in with repository admin access before configuring deployments.'; exit 1;
}

# GitHub repositories using immutable OIDC subjects include owner/repository IDs.
# Azure performs an exact, case-sensitive subject match.
IFS=$'\t' read -r owner owner_id name repo_id < <(
  gh api "repos/$repo" --jq '[.owner.login, (.owner.id|tostring), .name, (.id|tostring)] | @tsv'
)
expected_subject="repo:${owner}@${owner_id}/${name}@${repo_id}:environment:testing"
identity_group=$(node -p 'require("./"+process.argv[1]).identityResourceGroup' "$metadata")
client_id=$(node -p 'require("./"+process.argv[1]).githubVariables.AZURE_CLIENT_ID' "$metadata")
identity_name=$(az identity list --resource-group "$identity_group" \
  --query "[?clientId=='$client_id'].name | [0]" -o tsv)
[[ -n "$identity_name" ]] || { echo 'Deployment identity not found in Azure.'; exit 1; }
credential_name=github-testing
current_subject=$(az identity federated-credential show --identity-name "$identity_name" \
  --resource-group "$identity_group" --name "$credential_name" --query subject -o tsv)
if [[ "$current_subject" != "$expected_subject" ]]; then
  az identity federated-credential update --identity-name "$identity_name" \
    --resource-group "$identity_group" --name "$credential_name" \
    --issuer https://token.actions.githubusercontent.com \
    --subject "$expected_subject" --audiences api://AzureADTokenExchange \
    --output none
fi
# Preserve existing review settings. Create only if this environment is absent.
existing=$(gh api "repos/$repo/environments" --jq '.environments[].name')
if ! printf '%s\n' "$existing" | grep -Fxq testing; then
  gh api --method PUT "repos/$repo/environments/testing" --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
fi
policy=$(gh api "repos/$repo/environments/testing" --jq '.deployment_branch_policy.custom_branch_policies')
[[ "$policy" == true ]] || { echo 'Configure testing to use selected deployment branches before continuing.'; exit 1; }
branches=$(gh api "repos/$repo/environments/testing/deployment-branch-policies" --jq '.branch_policies[] | select(.type == "branch") | .name')
if ! printf '%s\n' "$branches" | grep -Fxq testing; then
  gh api --method POST "repos/$repo/environments/testing/deployment-branch-policies" \
    -f name=testing -f type=branch >/dev/null
fi
while IFS=$'\t' read -r key value; do
  gh variable set "$key" --repo "$repo" --env testing --body "$value"
done < <(node -e '
  const m=require("./"+process.argv[1]);
  for(const [key,value] of Object.entries(m.githubVariables)) console.log(key+"\t"+value);
' "$metadata")
gh variable set AZURE_DEPLOY_TESTING --repo "$repo" --body true
echo "Testing deployment enabled with OIDC subject: $expected_subject"
echo 'Production settings were not changed.'
