#!/usr/bin/env bash
set -euo pipefail

# Only update an existing app. Infrastructure, secrets, and migrations are separate.
app_args=(--name "$AZURE_CONTAINER_APP" --resource-group "$AZURE_RESOURCE_GROUP")
mode=$(az containerapp show "${app_args[@]}" --query properties.configuration.activeRevisionsMode -o tsv)
[[ "$mode" == Single ]] || { echo 'Deployment requires Single revision mode'; exit 1; }
container_names=$(az containerapp show "${app_args[@]}" --query 'properties.template.containers[].name' -o tsv)
printf '%s\n' "$container_names" | grep -Fxq -- "$AZURE_CONTAINER_NAME" || {
  echo 'The configured container does not exist'; exit 1;
}
registry=$(az acr show --name "$AZURE_ACR_NAME" --query loginServer -o tsv)
az acr login --name "$AZURE_ACR_NAME" --output none
docker load -i "$RUNNER_TEMP/deployment-image/image.tar"
image="$registry/jaj-api:$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
docker tag jaj-api:ci "$image"
docker push "$image"
# Resolve the pushed manifest and deploy the immutable digest, not a mutable tag.
digest_image=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" | grep -F "$registry/jaj-api@sha256:" | head -n 1)
[[ "$digest_image" == "$registry/jaj-api@sha256:"* ]] || { echo 'Image digest missing'; exit 1; }
revision=$(az containerapp update "${app_args[@]}" --container-name "$AZURE_CONTAINER_NAME" \
  --image "$digest_image" --query properties.latestRevisionName -o tsv)
[[ -n "$revision" ]] || { echo 'Azure returned no revision'; exit 1; }
ready=false
for attempt in {1..60}; do
  latest_ready=$(az containerapp show "${app_args[@]}" --query properties.latestReadyRevisionName -o tsv)
  if [[ "$latest_ready" == "$revision" ]]; then ready=true; break; fi
  sleep 10
done
[[ "$ready" == true ]] || { echo 'New revision did not become ready'; exit 1; }
fqdn=$(az containerapp show "${app_args[@]}" --query properties.configuration.ingress.fqdn -o tsv)
[[ -n "$fqdn" ]] || { echo 'Container App has no ingress hostname'; exit 1; }
for route in live ready; do
  curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 5 \
    --connect-timeout 10 --max-time 20 "https://$fqdn/api/health/$route" >/dev/null
done
echo "url=https://$fqdn" >> "$GITHUB_OUTPUT"
{
  echo "Deployed revision: $revision"
  echo
  echo "Image: $digest_image"
  echo
  echo "Application: https://$fqdn"
} >> "$GITHUB_STEP_SUMMARY"
