# Architecture

The harness keeps world-specific authority behind an adapter boundary:

```text
model providers ──> minds/director/coordinators ──> validated tool calls
                                                    │
                              reflex engine ─────────┤
                                                    v
host application ──> WorldView (read)          ActionSink (write) ──> world server
        │
        ├── credentials and authorization
        ├── adapter command allow-list
        └── event-to-PerceptDelta conversion
```

`src/core` contains contracts. The model, memory, mind, reflex, director, runtime, control, and TUI
directories implement reusable layers. `src/world.ts` and `src/protocol.ts` provide the small public
wire vocabulary that replaced imports from the original monorepo.

The host is the security boundary. The harness can choose among advertised commands, but the host
must validate command names, payloads, identities, and permissions for every request. Model-authored
JavaScript is not part of this repository or its extension model.

The original application retains its server adapter, scenario content, product-specific prompts,
runtime data, and deployment automation. Those components are intentionally absent here.
