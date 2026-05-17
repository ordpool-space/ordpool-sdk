# ordpool-sdk

Higher-level Bitcoin / Ordinals SDK for the [ordpool](https://ordpool.space) ecosystem.

[`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser) reads raw transactions and pulls out the artifacts inside (inscriptions, runes, BRC-20, SRC-20, CAT-21, Atomicals, Labitbu, OpenTimestamps). **ordpool-sdk** is everything one layer up from that — domain code that talks to networks, signs things, walks calendars, wraps third-party REST APIs. It's the place for code that doesn't fit the parser's zero-dependency, pure-function constraint.

MIT-licensed, works in Node.js and browsers.

```
npm install github:ordpool-space/ordpool-sdk
```

## Status

Early scaffold. Public API surface is intentionally empty for now — modules will land as concrete needs surface (calendar clients, signing helpers, etc.). The repository is here so we have a place to put things in the right home from day one, rather than letting domain code drift into the parser or into the mempool fork.

## Why two packages

We own three TypeScript codebases:

- [`ordpool-parser`](https://github.com/ordpool-space/ordpool-parser) — zero runtime dependencies, pure functions, runs anywhere.
- [`ordpool-sdk`](https://github.com/ordpool-space/ordpool-sdk) — higher-level domain code that can have dependencies and side effects.
- `ordpool/frontend` and `ordpool/backend` — forked from mempool.

Helpers that should be reusable from a CLI, GitHub Action, third-party app, or another ecosystem repo belong in the parser or the SDK depending on shape (pure-function vs. networked).

## License

MIT
