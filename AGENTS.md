# AGENTS.md

Workshop: a self-hosted service that works through GitHub issues with Claude Code agents running in Docker containers, tracking each ticket's state with `workshop/*` labels. Read [README.md](README.md) for what it does, and [docs/design/architecture.md](docs/design/architecture.md) and [docs/design/workflow.md](docs/design/workflow.md) for why it's built this way. Component notes: [server/AGENTS.md](server/AGENTS.md), [client/AGENTS.md](client/AGENTS.md).

## Layout

- `server/`: Node 24 + TypeScript (run directly, no build), Express 5, `node:sqlite`. API, sign-in, scheduler, run supervisor, provider adapters.
- `client/`: React 19 SPA built with Vite, served by the server.
- `agent/`: the agent container image (Claude Code plus toolchains) and its entrypoint (`prepare | run | publish | usage-probe`).
- `docs/design/`: requirements, diagrams, architecture and workflow notes.
- `.github/workflows/build.yml`: CI. Tests every push; publishes both images from `main`.

## Commands

```sh
npm install
npm test              # vitest: server then client
npm run typecheck     # tsc for both workspaces (also checks tests)
npm run build         # client bundle
npm run dev:server    # :3000, reads ../.env (see .env.example)
npm run dev:client    # :5173, proxies /api to :3000
WORKSHOP_TEST_DOCKER_SOCKET=/var/run/docker.sock npm test --workspace server   # plus the real-Docker test
podman build -t workshop-agent:dev agent && podman build -t workshop:dev .      # images (docker works too)
```

Run `npm run typecheck` and `npm test` before finishing. Vitest doesn't type-check, and the strict `tsc` settings catch things it won't.

## Conventions

- **TypeScript with erasable syntax only.** The server runs `.ts` files directly through Node's type stripping. No `enum`, no `namespace`, no constructor parameter properties (`constructor(private x)`). Import with explicit `.ts` extensions, and use `import type` for types.
- **Shared types** live in `server/src/api-types.ts`. The client imports them type-only, so that file must never import anything at runtime.
- **API errors** are `{ error: "readable message" }` with a proper status. The client shows the message as-is, so write it for the person using Workshop.
- **Every bug gets a test** that reproduces it first, at the right layer:
  - pure logic in `server/test/workflow.test.ts` or `gates.test.ts`;
  - the run lifecycle and sync in `server/test/pipeline.test.ts` (providers mocked);
  - HTTP behaviour in `server/test/api.test.ts`;
  - the client's transcript reducer in `client/test/`.
- **Keep dependencies few.** Write a few lines rather than add a package; standard library first.
- **Copy in the UI** is plain, sentence case, and says what happens ("Save settings", not "Submit"). See [client/AGENTS.md](client/AGENTS.md) for the visual rules.
