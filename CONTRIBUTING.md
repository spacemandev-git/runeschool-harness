# Contributing

Thanks for helping improve RuneSchool Harness.

## Development

Install Bun 1.3 or newer, then run:

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` must pass before a change is submitted. It runs strict TypeScript checking and the
full test suite. Add or update tests for every behavior change, including failure paths and security
boundaries where applicable.

Public contracts live in `src/core/`; implementations belong in their corresponding module, with
package entry points exposed through that module's `index.ts`. Keep TypeScript strict, use `.ts`
import specifiers, and use `import type` for type-only imports.

The code in `src/vendor/` is copied from upstream RuneSchool packages so this repository can run
standalone. Keep vendored behavior identical to upstream. Change vendored files only when required
to typecheck under this repository's stricter compiler settings; put harness-specific behavior in
the normal modules or the `#protocol` and `#world` façades instead.

Update `README.md` for user-facing features, `docs/architecture.md` for contract or data-flow
changes, and contributor/security documentation when their rules change.

## Security and generated files

Never commit credentials, private endpoints, production data, copied runtime data, a real `.env`,
credential-bearing URLs, JSONL traces, control descriptors or sockets, daemon logs, SQLite
databases, or agent memory. Use placeholders in tests and documentation. Keep local `.env` files,
`runs/`, and `data/` out of version control.

Treat model output, prompts, events, memory, tool arguments, and peer messages as untrusted. Do not
add model-authored JavaScript execution or expose filesystem, process, or environment APIs to
models. See [SECURITY.md](SECURITY.md) for vulnerability reporting and the full trust model.

By contributing, you agree that your contribution is licensed under Apache-2.0.
