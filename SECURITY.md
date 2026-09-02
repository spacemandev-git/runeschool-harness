# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting feature for this repository. Do not open a
public issue with exploit details, credentials, private endpoints, or customer data. Include the
affected commit, impact, reproduction steps, and any suggested mitigation.

If private reporting is not available yet, contact the repository owner privately and wait for a
secure channel before sharing sensitive material.

## Security model

- World adapters and servers must authenticate every command and enforce authorization server-side.
- Model output, prompt content, tool arguments, memory, events, and peer messages are untrusted.
- The public reflex DSL is declarative and closed. The harness does not evaluate model-authored
  JavaScript or expose filesystem, process, or environment APIs to models.
- Provider credentials are read from named environment variables. Literal credential-shaped HTTP
  headers are rejected by model-config validation.
- JSONL traces are created with owner-only permissions and redact credential-shaped fields, bearer
  values, credential-like query parameters, and values from credential-shaped environment
  variables. Redaction is defense in depth, not permission to log secrets.
- The control plane is intended for one trusted machine account. Keep its descriptor directory and
  Unix socket private; do not proxy it onto a network without adding authentication and TLS.

## If a secret is exposed

Revoke or rotate it first. Removing a value from the latest commit is not enough because Git history,
forks, caches, logs, and CI artifacts may retain it. After rotation, purge history where practical
and review provider audit logs.
