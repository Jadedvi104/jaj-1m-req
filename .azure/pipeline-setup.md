# Pipeline activation

See ../CI_CD.md for branch flow, OIDC subjects, environment variables, migration
handling, and verification. The Azure deployment identity is provisioned by
infra/github-identity.bicep in a separate resource group. The application
identity is separate and can only pull images and read runtime secrets.

Sign the GitHub CLI into an account with admin access to Jadedvi104/jaj-1m-req.
Run scripts/ci/setup-github.sh after successful hosting provisioning to create
the testing environment, restrict it to the testing branch, populate its
non-secret variables, and align the Azure federated credential with GitHub's
immutable owner/repository-ID OIDC subject. The script requires both an admin
GitHub login and an Azure login that can update the deployment identity. Commit
and push the CI/CD files to enable the workflow. Production deployment remains
disabled until separately provisioned.
