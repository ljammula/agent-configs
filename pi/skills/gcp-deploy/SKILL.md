---
name: gcp-deploy
description: GCP and Cloud Run deployment planning and execution. Use when GCP, Cloud Run, or Google Terraform configuration is present; invoke mutation steps only when the user explicitly requests deployment. Do not auto-run IAM, secret, traffic, migration, or infrastructure mutations.
---

# GCP deploy

Keep planning, validation, and deployment separate. Deployment, IAM, secret, traffic, migration, or infrastructure changes require explicit user authorization.

Prefer immutable revisions, deploy with no traffic, smoke-test, migrate traffic gradually, and retain a tested rollback. Use least-privilege, short-lived credentials supplied only to the deployment environment.
