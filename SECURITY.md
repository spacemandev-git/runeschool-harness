# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting feature for this repository. Do not open a
public issue with exploit details, credentials, private endpoints, or customer data. Include the
affected commit, impact, reproduction steps, and any suggested mitigation.

If private reporting is not available yet, contact the repository owner privately and wait for a
secure channel before sharing sensitive material.

## Security model

- The RuneSchool server is authoritative. It must authenticate identities and validate the command
  name, payload, target entity, and permissions for every request.
- Actor commands are restricted client-side to `ACTOR_COMMAND_TYPES`; admin command types are not
  accepted on actor links, and `move` is explicitly denied by `AGENT_DENIED_COMMANDS`. These checks
  reduce exposure but do not replace server-side authorization.
- Model output, prompt content, tool arguments, memory, events, and peer messages are untrusted.
- The public reflex DSL is declarative and closed. The harness does not evaluate model-authored
  JavaScript or expose filesystem, process, or environment APIs to models.
- Actor and admin tokens are held only in live runtime/transport memory. They are removed or
  redacted from bus events, JSONL traces, control traffic, error text, admin reports, and displayable
  runtime config. Never print, persist, or pass them to a model.
- Provider credentials are read from named environment variables. Literal credential-shaped HTTP
  headers are rejected by model-config validation, and model API keys are absent from config views.
- JSONL traces are created with owner-only permissions and redact credential-shaped fields, bearer
  values, credential-like query parameters, and values from credential-shaped environment
  variables. Redaction is defense in depth, not permission to log secrets.
- The control plane is intended for one trusted machine account. Keep its owner-only descriptor
  directory and Unix socket private; do not proxy it onto a network without authentication and TLS.

## Environment and trace hygiene

Keep real `.env` files, attach documents containing actor/admin credentials, traces, daemon logs,
control descriptors, sockets, SQLite databases, and agent memory out of version control. Use secret
managers or environment injection outside local development, and use placeholders in examples and
tests. Enable `--trace-model-messages` only when prompt capture is necessary and the trace location
is appropriately protected.

## If a secret is exposed

Revoke or rotate it first. Removing a value from the latest commit is not enough because Git
history, forks, caches, logs, and CI artifacts may retain it. After rotation, purge history where
practical and review provider and RuneSchool server audit logs.
