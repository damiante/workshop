# Detect environment capabilities (#23)

## Context

The Implementation agent was told to attach a screenshot for web UI changes and replied that Playwright wasn't available.

**Assessment: this is a container problem, not a host problem.** Every agent step, including `claude` and every tool it runs, executes inside the agent image (`agent/Dockerfile`). The host only supplies a Docker engine, CPU and memory, and nothing from the host reaches the container apart from the run's volume. So probing hosts would find nothing useful.

The first implementation (commit `8abbb84` on this branch) put Playwright and Chromium in the one agent image. The owner rejected that in PR review: the extra 300–400 MB is wasted on most runs. **Revised outcome:**
- Two agent images: the **base** image, exactly as it was before this ticket, and a **browser** image that adds Playwright with headless Chromium.
- The Classifier says which capabilities a ticket needs for testing its change (today only `browser`). Workshop records that as a ticket label.
- Implementation runs for a ticket that needs `browser` use the browser image. Every other run (Classifier, Design, Design review, Merge, usage probe, and Implementation for other tickets) uses the base image.
- The runner still reads the `workshop.capabilities` label from the image it actually runs and tells the agent in `system.md` what it has. That part of `8abbb84` stays.

## Approach

1. **One Dockerfile, two stages.** `agent/Dockerfile` gets a `base` stage (today's content on `main`, unchanged) and a `browser` stage `FROM base`. The browser stage adds the Playwright install from `8abbb84` (pinned `PLAYWRIGHT_VERSION=1.64.1`, `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` owned by `agent`, `NODE_PATH`), plus `LABEL workshop.capabilities="browser"`. Building `--target base` gives the old image byte for byte. Building `--target browser` gives the browser image. A separate `Dockerfile.browser` built `FROM` a published base tag would need the base pushed first and wouldn't work in the PR's build-only CI job. Stages share the build cache and need nothing extra.
   - The base stage carries no `workshop.capabilities` label, so it declares no capabilities.
2. **Ship both images.** CI publishes `…/workshop-agent` (base) and `…/workshop-agent-browser`, both tagged `latest` and with the commit sha. The Workshop image pins both, through `WORKSHOP_AGENT_IMAGE` and a new `WORKSHOP_AGENT_BROWSER_IMAGE`. A host pulls the browser image only the first time it runs a browser ticket (`ensureImage` is already lazy).
3. **Classifier output → ticket label.** `CLASSIFIER_SCHEMA` gets an optional `capabilities` array (enum `["browser"]`). When the Classifier accepts a ticket, `planClassifier` sets the `workshop/needs:browser` label to match the list: it adds the label when `browser` is listed and removes it when it isn't. Ticket state already lives in `workshop/*` labels, so this follows the existing pattern: no migration, the owner sees the label on GitHub and can add or remove it by hand, and a re-classify after requested changes updates it. In delta mode the Classifier lists capabilities for the whole ticket, not just the delta, so a re-classify doesn't drop a browser the ticket still needs.
4. **Allocation.** `context()` in `runner.ts` picks the image:
   - a repository with a custom image always uses that image (Workshop can't know what variants it has);
   - otherwise, `implement` runs on a ticket labelled `workshop/needs:browser` use `config.agentBrowserImage`;
   - everything else uses `config.agentImage`.
   This is a pure function, so it gets unit tests. The image is recomputed whenever `context()` runs (including when Workshop re-attaches after a restart). That's harmless: `prepare` and `publish` behave the same in both images, and a `run` container that is re-attached is never re-created.
5. **Reporting stays label-based.** `imageLabels`, `capabilitiesOf` and `environmentText` from `8abbb84` stay. The no-browser text gets one extra sentence so agents on the base image know how a browser could be provided.

## Changes

Start from the current branch (`8abbb84`). First merge `origin/main` into it: it carries `0c9d64f`, which lets agents push changes under `.github/workflows/`. The earlier push failures came from this branch editing `build.yml` without that permission.

### `agent/Dockerfile`
- Name the first stage: `FROM node:24-trixie-slim AS base`. Restore its content to `main`'s version: no Playwright, no `NODE_PATH`, no `LABEL`, and the original header comment, extended to describe the two targets. Keep `ENTRYPOINT` in `base`.
- Append:
  ```dockerfile
  # The browser image: the base image plus Playwright with headless Chromium, for screenshots and
  # browser tests. Workshop uses it only for Implementation runs on tickets labelled workshop/needs:browser.
  FROM base AS browser
  USER root
  ARG PLAYWRIGHT_VERSION=1.64.1
  ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
  RUN <the npm install / playwright install --with-deps --only-shell chromium / chown step from 8abbb84>
  USER agent
  ENV NODE_PATH=/usr/local/lib/node_modules
  LABEL workshop.capabilities="browser"
  ```
- Note in the header comment: with no `--target`, Docker builds the last stage (`browser`), so build the base image with `--target base`.

### `.github/workflows/build.yml`
- `agent-image` job: build twice with `docker/build-push-action@v6` (`load: true`, `push: false`, `cache-from: type=gha,scope=agent`): `target: base` tagged `workshop-agent:ci`, and `target: browser` tagged `workshop-agent-browser:ci`. Checks:
  - the existing screenshot and label checks, run against `workshop-agent-browser:ci`;
  - base has no browser: `docker run --rm --entrypoint bash workshop-agent:ci -c '! command -v playwright'`, and its `workshop.capabilities` label is empty (`test -z "$(docker image inspect … --format '{{index .Config.Labels "workshop.capabilities"}}')"`).
- `images` job: the agent push step gets `target: base`. Add a step "Build and push the agent browser image" (`target: browser`, tags `${image}-agent-browser:latest` and `:${sha}`, same cache scope). The Workshop build gets `AGENT_BROWSER_IMAGE=${image}-agent-browser:${sha}` in `build-args`.

### `Dockerfile` (root)
- `ARG AGENT_BROWSER_IMAGE=ghcr.io/damiante/workshop-agent-browser:latest` and `WORKSHOP_AGENT_BROWSER_IMAGE=$AGENT_BROWSER_IMAGE` in `ENV`. Update the comment ("the agent images built from the same commit").

### `server/src/config.ts`
- `agentBrowserImage: process.env.WORKSHOP_AGENT_BROWSER_IMAGE ?? 'ghcr.io/damiante/workshop-agent-browser:latest'`.

### `server/src/workflow/labels.ts`
- `export const CAPABILITIES = ['browser'] as const; export type Capability = (typeof CAPABILITIES)[number];`
- `label.needs = (c: Capability) => \`workshop/needs:${c}\``.
- `LABEL_DEFS`: `{ name: label.needs('browser'), color: '5c6b73', description: 'Workshop: Implementation gets a browser (Playwright) to test this' }`. Check that the description fits GitHub's 100-character limit.
- `TicketState` gets `needs: Capability[]`, and `parseLabels` fills it.
- `export function setNeeds(labels: string[], needs: Capability[])`: label edits in the same shape as `setSize` (adds missing labels, removes unlisted ones).
- `export function imageFor(agent: AgentName, state: TicketState, images: { repo: string | null; base: string; browser: string }): string`: the rule in Approach 4.

### `server/src/workflow/schemas.ts`
- `ClassifierResult.capabilities?: Capability[]`.
- `CLASSIFIER_SCHEMA.properties.capabilities`: `{ type: 'array', items: { type: 'string', enum: CAPABILITIES }, description: 'What the Implementation agent's container needs to test the change (accept only): browser for a web UI change that needs a screenshot or a browser test. Empty when nothing extra is needed.' }`. Not required.
- `parseResult` (classifier): if present, `capabilities` must be an array of known values. Error: `capabilities must be a list of: browser.`

### `server/src/workflow/transitions.ts`
- `planClassifier` accept branch: `combine(setSize(...), moveTo(...), setNeeds(ctx.labels, r.capabilities ?? []))`. When `browser` is listed, append to the comment, before "Next:": `Implementation will run with a browser (Playwright) to test it.`

### `server/src/workflow/prompts.ts`
- Classifier prompt, new step 7: `7. When accepting, list in capabilities what the Implementation agent needs to test the change: "browser" when it changes a web UI that should be checked in a browser or shown in a screenshot. Leave it empty otherwise, since the browser image is large. In delta mode, list what the whole ticket needs, not only the requested changes.`
- `environmentText` no-browser branch, after the existing text: `Workshop gives Implementation runs a browser when the ticket has the \`workshop/needs:browser\` label.`

### `server/src/scheduler/runner.ts`
- `context()`: `image: imageFor(r.agent, parseLabels(labelsOf(ticket)), { repo: repo.image, base: config.agentImage, browser: config.agentBrowserImage })`.
- The `imageLabels`/`environmentText` lines from `8abbb84` stay as they are.

### Docs
- `README.md`:
  - Custom image paragraph: replace the sentences added in `8abbb84`. New text: Workshop has two images, `workshop-agent` and `workshop-agent-browser` (Playwright with headless Chromium). Implementation runs on tickets labelled `workshop/needs:browser` (the Classifier sets this label, and you can set it yourself) use the browser image. A repository's custom image is used for every run, so build it `FROM` the browser image if its tickets need a browser.
  - Configuration table: add a `WORKSHOP_AGENT_BROWSER_IMAGE` row (set at build).
  - Development: the agent image command becomes `podman build --target base -t workshop-agent:dev agent` and `podman build --target browser -t workshop-agent-browser:dev agent`.
- `AGENTS.md`, `.env.example` (add a commented `WORKSHOP_AGENT_BROWSER_IMAGE=localhost/workshop-agent-browser:dev`), and the `server/AGENTS.md` "Trying the agent image locally" block: use `--target base`.
- `docs/design/architecture.md` line 21: the base image as before, plus a browser variant chosen for Implementation when the ticket is labelled `workshop/needs:browser`. Keep the sentence about the capabilities label.
- `docs/design/workflow.md` label table (after the `workshop/size:*` row): `| \`workshop/needs:browser\` | Set by the Classifier (or you): Implementation runs in the browser image |`.
- `server/AGENTS.md` Docker bullet: also mention `imageFor` choosing the image per run.

## Data and interfaces

- No DB migration. No API or client change: the ticket view already shows its labels.
- New label `workshop/needs:browser`, created with the others from `LABEL_DEFS`.
- Classifier schema: optional `capabilities: ("browser")[]`.
- New env var `WORKSHOP_AGENT_BROWSER_IMAGE`. New published image `ghcr.io/damiante/workshop-agent-browser`.
- Image label `workshop.capabilities`: set on the browser image only.

## Tests

Run `npm run typecheck` and `npm test`.

- `server/test/workflow.test.ts`:
  - `parseLabels` reads `needs: ['browser']` from `workshop/needs:browser`.
  - `setNeeds`: adds the label for `['browser']`, removes it for `[]`, and makes no edit when the labels already match.
  - `imageFor`: implement + browser → browser image; implement without browser → base; design (or classifier, merge) + browser → base; a repo image wins in every case.
  - `parseResult('classifier', …)`: accepts `capabilities: ['browser']` and a missing field; rejects `['gpu']` and `'browser'` (not an array).
  - `planTransition` classifier accept: with `capabilities: ['browser']` it adds `workshop/needs:browser` and the comment mentions the browser. In delta mode with `capabilities: []` on a ticket that has the label, it removes the label.
  - `environmentText([])` mentions `workshop/needs:browser`. The existing capability tests stay.
- `server/test/pipeline.test.ts`: the started spec's `image` is `config.agentBrowserImage` for an implement run on a ticket labelled `workshop/needs:browser`, and `config.agentImage` without the label. Ticket 1 is already set to `implement`. The existing environment-capability tests stay.
- Images: the `agent-image` CI job checks both targets on every push and PR. The Implementation agent's container has no Docker or Podman, so it should say in its summary that it relied on CI for this.

## Risks and open questions

- **Custom repo images** don't switch: a repository with its own image uses it for every run, so it needs a browser built in if its tickets need one. The README says so, and agents are told when no browser is present.
- **Wrong classification.** If the Classifier misses `browser`, the Implementation agent says it couldn't take a screenshot. The owner then adds `workshop/needs:browser` and requests changes. The opposite mistake only costs a larger image pull.
- **Tickets already past classification** (including this one) have no `workshop/needs:browser` label, so their Implementation runs use the base image until the owner adds the label. No backfill.
- **Debian trixie and `playwright install --with-deps`**: CI hasn't run on this branch yet, because the earlier pushes failed. If 1.64.1 rejects trixie, the `agent-image` job fails before merge. The fallback is to install Chromium's libraries with `apt-get` (Playwright's Debian 12 list, mapped to trixie's `t64` package names) and then run `playwright install --only-shell chromium` without `--with-deps`. Note in the Dockerfile which path was taken.
- **Disk:** hosts that run browser tickets keep both images, which share the base layers, so the browser image adds roughly 300–400 MB.
- Out of scope, as before: getting screenshots into the PR (the `run` container has no GitHub access). The environment text tells agents to save screenshots in `/tmp` so `publish`'s `git add -A` doesn't commit them by accident.

## Review

Design review of the first (single-image) version. Rows 7–9 and "one image for every ticket" were superseded by the owner's PR feedback (two images, Classifier-driven selection), which this revision implements.

| # | Criticism | Fix | Adopted |
|---|-----------|-----|---------|
| 1 | Untestable as written: the only check of the Dockerfile was a manual `podman build`, but the Implementation agent's container has no Docker or Podman, and CI only builds images on `main`. | New `agent-image` CI job that builds the image on every push/PR and runs the screenshot and label checks as the `agent` user. | Yes |
| 2 | `publish` runs `git add -A`, so a screenshot the agent writes inside `/work/repo` is silently committed and pushed. | Environment text tells agents to save screenshots outside the repo (e.g. /tmp) unless they mean to commit them. | Yes |
| 3 | `NODE_PATH` only works for CommonJS `require`; an `.mjs` script with `import 'playwright'` fails. | Environment text says to use a `.cjs` script and why. | Yes |
| 4 | The `/dev/shm` and sandbox risks were overstated. | Risk rewritten; the remaining concern is the per-agent memory limit. | Yes |
| 5 | Wrong assumption: an image not based on ours can't run Workshop at all; the realistic no-label case is a custom image built `FROM` an older Workshop image. | Body corrected; README note. | Yes |
| 6 | Naming hazard: `Ctx.labels` already means container labels. | The parsed result is called `caps`. | Yes |
| 7 | Detect by probing inside the container instead of a label. | Not adopted: untestable without building the image, and gives allocation nothing to match on. | No |
| 8 | Gap against the ticket: no Classifier or allocation change. | Superseded: now implemented per the owner's review. | Superseded |
| 9 | `ensureImage` never re-pulls an existing tag. | No change: releases pin images by commit sha. | No |
