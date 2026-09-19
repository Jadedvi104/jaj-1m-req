#!/usr/bin/env bash
set -euo pipefail

# Only update an existing app. Infrastructure, secrets, and migrations are separate.
app_args=(--name "$AZURE_CONTAINER_APP" --resource-group "$AZURE_RESOURCE_GROUP")
revision=not-created
digest_image=not-published
previous_revision=unavailable
previous_image=unavailable
report() {
  result=$?
  {
    echo "Deployment exit code: $result"
    echo "Commit: $GITHUB_SHA"
    echo "Target revision: $revision"
    echo "Image: $digest_image"
    echo "Previous ready revision: $previous_revision"
    echo "Previous image (verify schema compatibility before rollback): $previous_image"
  } >> "$GITHUB_STEP_SUMMARY"
  if [[ "$result" != 0 ]]; then
    # Select only operational metadata; never print app secrets or environment values.
    az containerapp revision list "${app_args[@]}" \
      --query '[].{revision:name,active:properties.active,health:properties.healthState,provisioning:properties.provisioningState}' \
      -o table || true
  fi
  exit "$result"
}
trap report EXIT
bash scripts/ci/verify-release.sh
mode=$(az containerapp show "${app_args[@]}" --query properties.configuration.activeRevisionsMode -o tsv)
[[ "$mode" == Single ]] || { echo 'Deployment requires Single revision mode'; exit 1; }
container_names=$(az containerapp show "${app_args[@]}" --query 'properties.template.containers[].name' -o tsv)
printf '%s\n' "$container_names" | grep -Fxq -- "$AZURE_CONTAINER_NAME" || {
  echo 'The configured container does not exist'; exit 1;
}
[[ "$AZURE_CONTAINER_NAME" =~ ^[a-zA-Z0-9-]+$ ]] || { echo 'Invalid container name'; exit 1; }
previous_revision=$(az containerapp show "${app_args[@]}" --query properties.latestReadyRevisionName -o tsv)
if [[ -n "$previous_revision" ]]; then
  previous_image=$(az containerapp revision show "${app_args[@]}" --revision "$previous_revision" \
    --query "properties.template.containers[?name=='$AZURE_CONTAINER_NAME'].image | [0]" -o tsv)
fi
registry=$(az acr show --name "$AZURE_ACR_NAME" --query loginServer -o tsv)
az acr login --name "$AZURE_ACR_NAME" --output none
docker load -i "$RUNNER_TEMP/deployment-image/image.tar"
[[ "${EXPECTED_IMAGE_ID:-}" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Verified CI image ID missing'; exit 1; }
actual_image_id=$(docker image inspect jaj-api:ci --format '{{.Id}}')
[[ "$actual_image_id" == "$EXPECTED_IMAGE_ID" ]] || { echo 'Loaded image does not match the image verified in CI'; exit 1; }
image="$registry/jaj-api:$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
docker tag jaj-api:ci "$image"
docker push "$image"
# Resolve the pushed manifest and deploy the immutable digest, not a mutable tag.
digest_image=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" | grep -F "$registry/jaj-api@sha256:" | head -n 1)
[[ "$digest_image" == "$registry/jaj-api@sha256:"* ]] || { echo 'Image digest missing'; exit 1; }
# A branch can advance while downloading/publishing the image. Check again
# immediately before changing the app; environment concurrency serializes releases.
bash scripts/ci/verify-release.sh
revision_suffix="ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
revision="$AZURE_CONTAINER_APP--$revision_suffix"
updated_revision=$(az containerapp update "${app_args[@]}" --container-name "$AZURE_CONTAINER_NAME" \
  --image "$digest_image" --revision-suffix "$revision_suffix" --query properties.latestRevisionName -o tsv)
[[ "$updated_revision" == "$revision" ]] || { echo 'Azure returned an unexpected revision'; exit 1; }
ready=false
for _attempt in {1..60}; do
  latest_ready=$(az containerapp show "${app_args[@]}" --query properties.latestReadyRevisionName -o tsv)
  if [[ "$latest_ready" == "$revision" ]]; then ready=true; break; fi
  provisioning=$(az containerapp revision show "${app_args[@]}" --revision "$revision" \
    --query properties.provisioningState -o tsv)
  [[ "$provisioning" != Failed ]] || { echo 'New revision provisioning failed'; exit 1; }
  sleep 10
done
[[ "$ready" == true ]] || { echo 'New revision did not become ready'; exit 1; }
deployed_image=$(az containerapp revision show "${app_args[@]}" --revision "$revision" \
  --query "properties.template.containers[?name=='$AZURE_CONTAINER_NAME'].image | [0]" -o tsv)
[[ "$deployed_image" == "$digest_image" ]] || { echo 'Ready revision image does not match this release'; exit 1; }
fqdn=$(az containerapp show "${app_args[@]}" --query properties.configuration.ingress.fqdn -o tsv)
[[ -n "$fqdn" ]] || { echo 'Container App has no ingress hostname'; exit 1; }
for route in live ready; do
  curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 5 \
    --connect-timeout 10 --max-time 20 "https://$fqdn/api/health/$route" >/dev/null
done
for route in users products; do
  status=$(curl --silent --show-error --retry 3 --connect-timeout 10 --max-time 20 \
    --output /dev/null --write-out '%{http_code}' "https://$fqdn/api/$route")
  [[ "$status" == 404 ]] || { echo "Production route check failed: /api/$route returned $status"; exit 1; }
done
echo "url=https://$fqdn" >> "$GITHUB_OUTPUT"
echo "Application: https://$fqdn" >> "$GITHUB_STEP_SUMMARY"
