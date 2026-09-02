# Contributing

Thanks for helping improve RuneSchool Harness.

## Development

Install Bun 1.3 or newer, then run:

```sh
bun install --frozen-lockfile
bun run check
```

Keep changes adapter-neutral. Simulation-specific commands, content, proprietary assets, production
URLs, deployment configuration, credentials, runtime traces, databases, and agent memory do not
belong in this repository.

Add or update tests for behavior changes. Public contracts live in `src/core`, implementations in
their corresponding module, and package entry points in each module's `index.ts`.

## Security and generated files

Never commit a real `.env`, token, private key, credential-bearing URL, trace, control descriptor,
socket, SQLite database, or copied runtime data. Use placeholders in tests and documentation. See
[SECURITY.md](SECURITY.md) for vulnerability reporting and the trust model.

By contributing, you agree that your contribution is licensed under Apache-2.0.
