# Detect environment capabilities (#23)

## Context

The Implementation agent was told to attach a screenshot for web UI changes and replied that Playwright wasn't available.

**Assessment: this is a container problem, not a host problem.** Every agent step, including `claude` and every tool it runs, executes inside the agent image (`agent/Dockerfile`). The host only supplies a Docker engine, CPU and memory (`DockerEnvironment.describe()`), and nothing from the host reaches the container apart from the run's volume. The image is `node:24-trixie-slim` plus git, Python and a C toolchain. It has no browser, no Playwright and none of the shared libraries Chromium needs. So probing hosts would find nothing useful, and no host could provide a browser to the container anyway.

Intended outcome:
- The default agent image can drive a headless browser (Playwright + Chromium), so agents can take screenshots and run browser tests.
- The image declares what it can do, Workshop reads that declaration from whatever image a run uses (default or per-repo), and it tells the agent in its system prompt. Agents then know what's available up front. They stop guessing, and when a custom image lacks something they say so plainly.

## Approach

1. **Put Playwright and a headless Chromium in the default image.** Install the `playwright` npm package globally, pinned like Claude Code, and run `playwright install --with-deps --only-shell chromium` as root. Browsers go to a fixed `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, owned by `agent`. That way a repository pinned to a different Playwright version can still `npx playwright install chromium` into the same place: the system libraries are already there, and the download needs no root. `--only-shell` (the headless shell) roughly halves the browser download compared with full Chromium, and headless is all an unattended container can use.
   - Alternative considered: a separate `-browser` image variant chosen per ticket. It saves roughly 300–400 MB per host, but it needs a second CI build, a second pinned image setting, and selection logic. The image is already about 1 GB with build-essential, and it's pulled once per host. One image is simpler, and every ticket gets the capability.
2. **Declare capabilities as an image label:** `LABEL workshop.capabilities="browser"` (comma-separated). Images built `FROM` the Workshop image inherit the label. If an image overrides it, it must restate the list. An image without the label (in practice: one built `FROM` a Workshop image older than this change, since an image not based on ours lacks the `workshop-agent` entrypoint and can't run a step at all) has no declared capabilities.
3. **Detect at run time.** A new `Environment.imageLabels(image)` reads the labels through the host's engine (`docker.getImage(image).inspect()` → `Config.Labels`). When the runner builds `system.md`, it parses the labels into a capability list and appends an "Environment" section after the protocol. This is the detection the ticket title asks for. It works per run, so it covers per-repo images and needs no stored state.
4. **No Classifier or allocation change (deliberately).** With one image per repo and the capability in the default image, there's nothing to choose between: every host runs the same image, and the repo setting decides the image. Adding `capabilities` to `CLASSIFIER_SCHEMA` would store a value that nothing acts on. If image variants or capability-specific hosts appear later, the label added here is what allocation would match against. See Open questions.

## Changes

### `agent/Dockerfile`
- Before `USER agent`, add a root step:
  ```dockerfile
  # Headless Chromium for screenshots and browser tests. Browsers live outside $HOME at a fixed path,
  # owned by agent, so a repository pinned to another Playwright version can install its own build there.
  ARG PLAYWRIGHT_VERSION=<latest 1.x at implementation time: npm view playwright version>
  ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
  RUN npm install -g playwright@${PLAYWRIGHT_VERSION} \
   && playwright install --with-deps --only-shell chromium \
   && rm -rf /var/lib/apt/lists/* /root/.npm \
   && chown -R agent:agent /opt/ms-playwright
  ```
  (It goes after the `usermod` step so `agent` exists.)
- Add `NODE_PATH=/usr/local/lib/node_modules` to the final `ENV`, so `require('playwright')` works in ad-hoc CommonJS scripts. The CLI (`playwright screenshot …`) is on `PATH` already.
- Add `LABEL workshop.capabilities="browser"`.
- Update the header comment: mention the browser, and that images built `FROM` this one keep its capabilities label.

### `server/src/providers/types.ts`
- `Environment`: add `imageLabels(image: string): Promise<Record<string, string>>` with the doc comment `An image's labels; empty when the image isn't on the host.`

### `server/src/providers/docker/index.ts`
- Implement it: `(await this.docker.getImage(image).inspect()).Config?.Labels ?? {}`, and return `{}` on a 404 (use the existing `ignore(404)` pattern).

### `server/src/workflow/prompts.ts` (pure)
- `export const CAPABILITY_LABEL = 'workshop.capabilities';`
- `export function capabilitiesOf(labels: Record<string, string>): string[]`: split the label on commas, trim, lowercase, drop empties, de-duplicate.
- `export function environmentText(caps: string[]): string`: returns a `## Environment` section.
  - With `browser`: `A headless Chromium is available through Playwright (installed globally; browsers in $PLAYWRIGHT_BROWSERS_PATH). For a screenshot, start the app and run \`playwright screenshot --full-page <url> <file>.png\`; for scripted checks, \`require('playwright')\` from a CommonJS script (\`.cjs\`: the global install resolves through NODE_PATH, which \`import\` ignores). If the repository pins its own Playwright version, run \`npx playwright install chromium\` first. Everything left under /work/repo is committed and pushed when you finish, so save screenshots outside it (for example /tmp) unless you mean to commit them.`
  - Without `browser`: `No browser is installed in this environment. If the task needs one (screenshots, browser tests), do the rest and say in your summary what you couldn't check.`
  - Any other capabilities are listed by name: `Other capabilities declared by this image: x, y.`
- `protocolText` stays unchanged. It is also shown in the agent settings UI (`agents.ts`), and the environment section varies by run.

### `server/src/scheduler/runner.ts`
- In `runSpec`, in the `r.resumes === 0` branch (call the result `caps`: `Ctx.labels` already means the container labels): `const caps = capabilitiesOf(await ctx.env.imageLabels(ctx.image).catch(() => ({})));`. Failing to read labels must not fail the run; it just reads as "no capabilities".
- `system.md` becomes `${promptFor(agent)}\n\n${protocolText(...)}\n\n${environmentText(caps)}`.

### `server/test/pipeline.test.ts`
- `FakeEnv`: add `imageLabels = async (_image: string) => this.labels` with a settable `labels: Record<string, string> = {}` field.

### `.github/workflows/build.yml`
- New job `agent-image`, on every push and pull request (no `needs`, runs alongside `test`): `docker/setup-buildx-action@v3`, then `docker/build-push-action@v6` with `context: agent`, `load: true`, `push: false`, `tags: workshop-agent:ci`, `cache-from: type=gha,scope=agent` (read only; `images` keeps writing the cache). Then two steps:
  ```sh
  docker run --rm --entrypoint bash workshop-agent:ci -c 'cd /tmp && playwright screenshot --full-page "data:text/html,<h1>hi</h1>" s.png && test -s s.png && node -e "require(\"playwright\")"'
  test "$(docker image inspect workshop-agent:ci --format '{{index .Config.Labels "workshop.capabilities"}}')" = browser
  ```
  The container runs as `agent`, so this also proves the unprivileged user can launch the browser. Update the workflow's header comment (images are now built, not published, on every push).

### Docs
- `README.md` (custom image paragraph, line ~88): one sentence saying the default image includes Playwright with headless Chromium, and that an image built `FROM` it keeps the `workshop.capabilities` label, which tells agents what the image can do.
- `docs/design/architecture.md` line 21: add "Playwright with headless Chromium" to the agent image description, plus one sentence on the capabilities label and that the runner reports it to the agent.
- `README.md`, same paragraph: a custom image built `FROM` an older Workshop image has no browser until it is rebuilt; agents are told so.
- `server/AGENTS.md`: under Docker notes, one bullet: "Image capabilities come from the `workshop.capabilities` label (`imageLabels`), read per run and described to the agent in `system.md`."

## Data and interfaces

- No DB migration, no API or client change.
- New image label `workshop.capabilities` (comma-separated; currently only `browser` is known).
- `Environment.imageLabels` added to the provider interface.
- Image env: `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, `NODE_PATH=/usr/local/lib/node_modules`.

## Tests

Run `npm run typecheck` and `npm test`.

- `server/test/workflow.test.ts`:
  - `capabilitiesOf`: `{}` → `[]`; `{ 'workshop.capabilities': ' Browser, ,gpu,browser' }` → `['browser', 'gpu']`; unrelated labels are ignored.
  - `environmentText(['browser'])` mentions `playwright screenshot`. `environmentText([])` says no browser is installed. `environmentText(['browser', 'gpu'])` lists `gpu`.
- `server/test/pipeline.test.ts`:
  - With `fake.env.labels = { 'workshop.capabilities': 'browser' }`, the run step's `system.md` contains the Playwright text. With `{}`, it contains "No browser is installed".
  - When `imageLabels` rejects, the run still starts and `system.md` says no browser is installed.
- `server/test/docker.integration.test.ts` (opt-in): `imageLabels('docker.io/library/alpine:3.22')` returns an object, and `imageLabels('workshop-test/missing:none')` returns `{}`.
- Image smoke test: the new `agent-image` CI job (see Changes) builds the image and takes a screenshot as `agent` on every push, so the PR's checks verify the Dockerfile. The Implementation agent's container has no Docker or Podman, so it can't build the image itself; it should say so in its summary and rely on CI. Locally the same commands work with `podman build -t workshop-agent:dev agent`.

## Risks and open questions

- **Debian trixie support in `playwright install --with-deps`.** Older Playwright releases only knew Debian 11/12 and fail on an unknown OS. Pin a release whose `nativeDeps` has a `debian13` entry if one exists; the CI job above shows immediately whether the install works. If the pinned version rejects trixie, install the dependency packages with `apt-get` explicitly (the Chromium list from Playwright's `nativeDeps` for Debian 12, mapped to trixie's `t64` names), then run `playwright install --only-shell chromium` without `--with-deps`. Note which path was taken in the Dockerfile comment.
- **Image size** grows by roughly 300–400 MB (headless shell plus fonts and libraries). Hosts pull it once per release.
- **arm64 hosts**: CI publishes amd64 only today, so nothing changes. Playwright's Chromium supports linux/arm64 if that changes.
- **Memory and sandbox**: Docker's `/dev/shm` is 64 MB, but Playwright launches Chromium with `--disable-dev-shm-usage` and without the Chromium sandbox by default (`chromiumSandbox: false`), so neither `ShmSize` nor extra capabilities/seccomp changes are needed. Chromium does count against the per-agent memory limit; if agents report OOM kills while browsing, raise the host's per-agent memory.
- **How screenshots reach the pull request** is outside this ticket. The `run` container has no GitHub access, so an agent can only commit an image to the branch or describe it. `publish` runs `git add -A`, so a screenshot left in the repo is committed whether or not the agent meant to; the environment text tells agents to save them in /tmp unless they intend to commit them. If the owner wants screenshots embedded in the PR, that's a follow-up: for example, `publish` uploads files from `.workshop/screenshots/`, and `openOrUpdatePr` links them.
- **Open question (not blocking): Classifier capabilities.** I recommend not adding `capabilities` to the Classifier until there is more than one image or host to choose from (see Approach 4). If the owner prefers a separate browser image to keep the default small, the follow-up is: a `capabilities` array in `CLASSIFIER_SCHEMA` stored on the ticket, a `browserImage` setting, and `context()` picking that image when the ticket needs `browser` and the repo has no custom image.

## Review

| # | Criticism | Fix | Adopted |
|---|-----------|-----|---------|
| 1 | Untestable as written: the only check of the Dockerfile was a manual `podman build`, but the Implementation agent's container has no Docker or Podman, and CI only builds images on `main`. A broken install (e.g. trixie not supported) would merge unnoticed and break every run after release. | New `agent-image` CI job that builds the image on every push/PR and runs the screenshot and label checks as the `agent` user. | Yes |
| 2 | `publish` runs `git add -A`, so a screenshot the agent writes inside `/work/repo` is silently committed and pushed. | Environment text tells agents to save screenshots outside the repo (e.g. /tmp) unless they mean to commit them; noted under Risks. | Yes |
| 3 | `NODE_PATH` only works for CommonJS `require`; an agent writing an `.mjs` script with `import 'playwright'` gets a resolution error and may conclude Playwright is missing. | Environment text says to use a `.cjs` script and why. | Yes |
| 4 | The `/dev/shm` risk and the implied sandbox concern were overstated: Playwright already passes `--disable-dev-shm-usage` and disables the Chromium sandbox by default. | Risk rewritten; real remaining concern is the per-agent memory limit. | Yes |
| 5 | Wrong assumption: "an image not based on ours has no label". Such an image can't run Workshop at all (no `workshop-agent` entrypoint). The realistic no-label case is a custom image built `FROM` an older Workshop image, which keeps lacking a browser until rebuilt. | Body corrected; README sentence telling owners to rebuild custom images. | Yes |
| 6 | Naming hazard: `Ctx` already has a `labels` field (container labels), so `labels` for image labels in `runSpec` would be confusing. | Design names the result `caps`. | Yes |
| 7 | Simpler alternative: detect by probing inside the container (`command -v playwright` in the entrypoint, appending to `system.md`) instead of a label. Needs no provider change and reflects what's really installed. | Not adopted. The probe can only be unit-tested by building the image, it ties the system prompt to entrypoint versions baked into custom images, and it gives allocation nothing to match on later. The label is read from the image actually on the host, and the CI job (1) checks that label and install agree. | No |
| 8 | Gap against the ticket: no Classifier or allocation change. | Kept out, with the reasoning in Approach 4: one image per repo and every host runs the same image, so a classified capability would change nothing. The follow-up is spelled out under Open questions for the owner. | No (deliberate; not blocking) |
| 9 | Image staleness: `ensureImage` never re-pulls a tag already on a host, so a host might keep an old image. | No change: releases pin the agent image by commit sha, and for custom tags the label is read from the image the host actually runs, so what agents are told always matches what they get. | No (not a problem) |

