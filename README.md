# Muse Batch Studio

**English** · [Tiếng Việt](README.vi.md)

A local web tool for generating AI videos in bulk. Paste a list of prompts, attach characters with `@tag` reference images, run jobs in parallel across several accounts, watch progress live, preview each result, then download the MP4. Includes a drag-and-drop **Flow Studio** for image-to-video cards.

> **Two modes**
> - `MUSE_ADAPTER=muse` generates **real** videos on [muse.ai](https://muse.ai) by driving a logged-in Chrome (see [Real videos on Muse](#real-videos-on-muse)).
> - The default adapter, `mock`, produces ffmpeg-style test-pattern clips, not AI output. There is no global warning banner: only the clips themselves carry a **SIMULATED** (`MÔ PHỎNG`) badge. Set `MUSE_ADAPTER=muse` before `npm start` if you want real videos.

> **Disclaimer.** This is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by Meta or Muse. Automating a web app through a browser may violate that service's terms of use. Use it only with your own account and at your own risk.

> **The user interface and server messages are in Vietnamese.** Strings live in [web/src/i18n/vi.ts](web/src/i18n/vi.ts) if you want to translate them.

## Features

- **Batch input**: one video per line (or per paragraph, or the whole text as one prompt). A live badge shows how many jobs you are about to create.
- **`@tag` reference images**: type `@` to pick an image from the library. An unknown tag turns red; click it to choose an existing library image and the prompt is rewritten.
- **Account Pool**: several accounts, each with slots. A single FIFO dispatcher assigns jobs, retries failures, handles timeouts and rate limits, and never runs a job twice.
- **Live strip**: every running job stays pinned at the top, with elapsed time.
- **Preview before download**, search, status filters and pagination.
- **Regenerate**: make a new job from a finished one (same prompt, images, length, ratio); the old video is kept. The source job is locked while its regeneration is pending, so you cannot queue duplicates.
- **Flow Studio**: image-to-video cards on a pannable, zoomable canvas that share the same queue.
- **Secure by default**: credentials are encrypted at rest, nothing sensitive is returned by the API or written to logs, and the server refuses to listen beyond loopback without an access token.

## Quick start

Requirements: **Node.js 24 or newer** (uses the built-in `node:sqlite`). ffmpeg is optional (used for thumbnails with the `muse` adapter).

```bash
git clone https://github.com/hienpham197/muse_batch_studio.git
cd muse_batch_studio
npm install

# Development: web at http://localhost:5173, API at http://127.0.0.1:8787
npm run dev

# Production build: open http://127.0.0.1:8787
npm run build
npm start
```

First run in the browser:

1. Click **Tài khoản** (Accounts) in the header and add one or more accounts, by password or by [cookie](#cookie-login).
2. Click **+ Thêm ảnh tham chiếu** (Add reference images), pick images, fix the suggested tags, then save them to the library.
3. Paste prompts (one video per line; type `@` to insert an image). They are queued about two seconds after you stop typing.
4. Press **▶ Chạy hàng đợi** (Run queue), watch the live strip, click a thumbnail to preview, then download the MP4.

With the `mock` adapter any account logs in, except a password or cookie value starting with `invalid`. Add a marker to a prompt to simulate failures:

| Marker | Behaviour |
|---|---|
| `[lỗi]` | Always fails: retries, then ends as Failed |
| `[lỗi-lần-đầu]` | Fails on the first run, succeeds on retry |
| `[treo]` | Stops reporting progress, to test the timeout |
| `[giới-hạn]` | Reports a rate limit once; the dispatcher backs off and resumes |

## Real videos on Muse

Muse has no public API: its chat runs over an encrypted WebSocket handled by the web app itself. The `muse` adapter ([server/src/adapters/muse-browser.ts](server/src/adapters/muse-browser.ts)) therefore drives a real, logged-in Chrome with Playwright, following the approach of [Muse-Chat-MCP](https://github.com/duclm1x1/Muse-Chat-MCP) (MIT), which this project borrows its selectors from. Per job it:

1. Opens a new chat (`/thread/new`).
2. Attaches the job's reference images **in order**, each file named after its tag. It only sends once the images are visible in the composer; otherwise the job fails with `REF_NOT_ATTACHED` instead of producing a video without references.
3. Sends the prompt **verbatim** (line breaks preserved, no wrapper text). It appends only what Muse has no field for: duration and aspect ratio when the prompt does not mention them, and the image order. If the composer holds less than 90% of the text, the job fails with `PROMPT_NOT_TYPED` rather than sending a truncated prompt.
4. Waits for Muse to return a video, downloads the MP4 and makes a thumbnail (ffmpeg, if available).

```bash
# macOS / Linux
MUSE_ADAPTER=muse MUSE_HEADLESS=1 npm start

# Windows PowerShell
$env:MUSE_ADAPTER = "muse"; $env:MUSE_HEADLESS = "1"; npm start
```

**Login modes** (pick one):

| Mode | Configuration | Notes |
|---|---|---|
| Per-account cookie (default) | leave `MUSE_PROFILE_DIR` and `MUSE_CDP` empty | The app launches its own Chrome and loads each Account Pool cookie into a separate browser context, so several accounts can run in parallel. The cookie must include HttpOnly cookies (export it with a cookie-manager extension); a `document.cookie` string may be rejected |
| Dedicated profile | `MUSE_PROFILE_DIR=<folder>` (leave `MUSE_HEADLESS` unset for the first run) | A Chrome window opens; sign in to Muse by hand once and the session is kept in that profile. One account only |
| Attach to running Chrome | `MUSE_CDP=http://127.0.0.1:9222` | Start Chrome with `--remote-debugging-port=9222 --user-data-dir=<separate folder>`; Chrome 136+ refuses to attach to the default profile. One account only |

In the two single-session modes every account shares one login, so the pool accepts one account and the cookie value you type is ignored (enter any valid cookie, such as `chrome=1`, to create the entry).

**Things to know**

- Selectors (composer, stop button, messages) come from Muse-Chat-MCP. The single-reference flow was verified on the real site, and runs with 3 to 6 references work, but the selectors can break whenever Muse changes its UI. Failures surface as `MUSE_DRIVER_ERROR` or `REF_NOT_ATTACHED`; set `MUSE_DEBUG=1` to save screenshots to `data/muse-debug/` (before sending, after sending, and on errors).
- Muse does not report a percentage, so the UI shows an indeterminate "generating" bar instead of an invented number.
- Muse accepts a requested length of 5 or 10 seconds in the prompt and returned exactly that in testing, but length is ultimately Muse's decision.
- One tab runs one job at a time; keep 1 slot per account.
- Every job opens a fresh chat, so "continue from the last frame of Video 1" has nothing to continue from. For continuity, save the last frame to the library and attach it with an `@tag`.
- Reference images with many characters, or many references per prompt, lower fidelity and colour saturation. Shorter prompts and fewer references per shot (for example 5-second shots) keep characters closer to the references.

## Cookie login

For platforms that only offer a browser session. In **Tài khoản**, choose **Cookie**, optionally add a label, and paste the cookie in either form:

- A `Cookie` header string: `name1=value1; name2=value2` (DevTools, Network tab, any request, Request Headers). A leading `Cookie:` is stripped.
- JSON exported by a browser extension: `[{"name": "...", "value": "..."}]`.

The UI reports how many cookies it recognised (never their values). The server re-validates: at most 32 KB and 100 cookies, RFC 6265 names, no control characters.

- The cookie is normalised and encrypted with AES-256-GCM, like a password. The display name is `<label> · <6-char fingerprint>`; the fingerprint is a keyed hash and cannot be reversed.
- Pasting the same cookie again (even reordered) is reported as a duplicate.
- Adapters receive `{ kind: 'cookie', label, cookie }`; `cookie` is used verbatim as the `Cookie` header.
- An expired or rejected cookie turns the account Offline with a hint. Cookies are not refreshed automatically: delete the account and add it again with a new cookie.
- **A cookie is a live login.** Treat anything you paste into chats, issues, commits or screenshots as leaked, and sign out of that session on the platform to invalidate it.

## Configuration

Read from environment variables; see [.env.example](.env.example). The server does not load `.env` by itself: export the variables in your shell, or start it with `node --env-file=.env`.

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Listen address. Anything other than loopback requires `MUSE_ACCESS_TOKEN` |
| `MUSE_ACCESS_TOKEN` | empty | Enables a sign-in screen for the workspace owner |
| `MUSE_DATA_DIR` | `./data` | SQLite database, images, videos |
| `MUSE_KEY_DIR` | `%APPDATA%\muse-batch-manager` or `~/.config/muse-batch-manager` | Encryption key; must be outside `MUSE_DATA_DIR` |
| `MUSE_MASTER_KEY` | empty | 32-byte base64 key; takes precedence over the key file |
| `MUSE_ADAPTER` | `mock` | `muse` (real videos) or `mock` (simulated) |
| `MUSE_PROFILE_DIR`, `MUSE_CDP` | empty | Login mode for the `muse` adapter (see above) |
| `MUSE_CHANNEL`, `MUSE_HEADLESS` | `chrome`, empty | Browser (`chrome` or `msedge`); set `MUSE_HEADLESS=1` to run it without a window |
| `MUSE_PLATFORM_URL` | `https://muse.ai/` | Base URL of the platform |
| `MUSE_MAX_WAIT_MS`, `MUSE_IDLE_GRACE_MS` | 30 min, 2 min | Longest wait per video; extra wait after Muse stops replying without a video |
| `MUSE_DEBUG` | empty | `1` saves Muse screenshots to `data/muse-debug` |
| `MUSE_DEV_ROUTES` | empty | `1` enables routes that control simulated sessions (tests only) |

Concurrency, retries (N), timeout (X) and slots per account are changed in the UI. Defaults: 3 threads, N = 2, X = 15 minutes, 1 slot.

## How jobs run

- **Only the dispatcher assigns jobs.** Each pass takes the oldest `Waiting` job (FIFO), picks the enabled, online account with a free slot and the least work, health-checks its session just before assigning, then marks the job `Running`.
- **Effective threads** = `min(configured threads, total slots of online accounts)`. The UI shows both numbers when they differ.
- **Failed jobs** retry up to N times with growing delays, then become `Failed` with the original error code and a plain-language message.
- **Stuck jobs**: no progress for X minutes aborts the run, frees the slot, marks a timeout and re-queues the job (counted as a retry).
- **An account that drops, is disabled or is deleted**: its running jobs return to `Waiting`, keep their FIFO position and cost no retry. Every run has its own `runId`, so callbacks from an old run are ignored and no job runs twice.
- **Rate limits** pause assignment (growing cooldown, at most 2 minutes) without costing a retry.
- **Stop all** moves running jobs to `Stopped`; waiting jobs stay as they are.
- **Server restart**: running jobs return to `Waiting` and the dispatcher stays stopped until you press run.
- **Auto-stop**: when nothing is waiting or running the dispatcher turns off; new jobs added while it runs are picked up automatically.

## Project layout

```text
shared/   Types, defaults, prompt splitting, @tag parsing, tag suggestions, cookie parsing
server/   Fastify + SQLite: Account Pool, dispatcher, image library, Studio, API, adapters
web/      React 19 + Vite + Tailwind CSS v4 (Vietnamese UI)
e2e/      Playwright (Python) browser tests
```

The scheduling model lives in [server/src/dispatcher.ts](server/src/dispatcher.ts) and [server/src/accounts.ts](server/src/accounts.ts). Colours are semantic tokens in [web/src/index.css](web/src/index.css) (light and dark follow the OS). Some code comments cite sections ("Mục 2.5") of the original internal specification, which is not published.

## Adding another platform

Implement `PlatformAdapter` in [server/src/adapters/types.ts](server/src/adapters/types.ts):

| Method | Responsibility |
|---|---|
| `login(credentials)` | Sign in through the platform's official channel and return a session. Throw `AuthError` if rejected |
| `health(session)` | Return `healthy`, `expired` or `unreachable` with a reason |
| `refresh(session)` | Refresh the session if possible |
| `generate(session, spec, hooks)` | Generate the video. Call `hooks.onProgress` only with **real** progress (otherwise set `reportsProgress = false`), download the result to a temp file and return the video and thumbnail paths. Throw `WorkerError` with the right `kind` (`transient`, `permanent`, `rate-limit`, `session-lost`) |
| `close(session)` | Dispose of the session |

Register it in `createAdapter` in [server/src/core.ts](server/src/core.ts). `spec.refImages` already holds the file path of every `@tag`, resolved when the job was created; adapters do not re-read tags from the prompt. If the platform has an official API key, prefer it over a browser session: the pool, dispatcher and flow stay the same.

## Internal API

Everything is under `/api`, returns JSON, and errors look like `{ "error": { "code", "message", "details" } }` (messages are Vietnamese).

| Area | Endpoints |
|---|---|
| Accounts | `GET/POST /accounts`, `PATCH/DELETE /accounts/:id`, `POST /accounts/:id/health` |
| Image library | `POST /refs/upload`, `POST /refs/commit`, `GET /refs`, `GET/DELETE /refs/:tag` |
| Settings | `GET/PUT /settings`, `PUT /settings/concurrency` |
| Queue | `POST /queue/enqueue`, `/queue/process`, `/queue/stop`, `/queue/clear-finished` |
| Jobs | `GET /jobs`, `POST /jobs/:id/retry`, `POST /jobs/:id/regenerate`, `DELETE /jobs/:id`, `GET /jobs/:id/video`, `GET /jobs/:id/thumbnail` |
| Studio | `GET/POST /studio/cards`, `PATCH/DELETE /studio/cards/:id`, `POST /studio/generate-all` |
| Overview | `GET /state` |

Image upload is two steps (`upload`, then `commit`) so users can fix tags before saving.

## Security

| Threat | Mitigation |
|---|---|
| Credentials leaking from the DB or a backup | AES-256-GCM; the key lives outside the data folder; identifiers are stored only as a keyed hash plus a masked form |
| Credentials leaking through the UI, logs or API | No endpoint returns credentials; logs record neither bodies nor queries; inputs are cleared on submit |
| A foreign web page calling your API (CSRF, DNS rebinding) | `Host` and `Origin` checks; `HttpOnly` + `SameSite=Strict` session cookie |
| Unauthorised access | Loopback only by default; anything else requires an access token; 5 wrong guesses per minute lock the login |
| Malicious uploads | Images are really decoded with `sharp`; only PNG, JPG and WebP are accepted; SVG and renamed files are rejected; file names are never used as paths |
| Leaked cookies | Encrypted at rest, masked input, never shown again, never in logs or error responses |
| Deleting an account by accident | The API requires `confirm=true`; the UI asks first |

Not done: a global API rate limit (single-owner tool), TLS (put it behind a reverse proxy if you expose it) and automatic key rotation.

**If you fork this repo, never commit** `data/`, `.env`, cookies, or the encryption key. They are listed in [.gitignore](.gitignore).

## Testing

```bash
npm test            # 75 tests: unit (shared) + API, dispatcher and Muse-adapter integration (server)
npm run typecheck
```

The Muse adapter is tested against a local fake Muse that exposes the same DOM attributes the adapter relies on. It checks the control flow; it does not prove the selectors match the live site.

Browser tests use four Playwright scripts in [e2e/](e2e/): `ui_acceptance.py` (37 checks), `ui_cookie.py` (10 checks for cookie login), `ui_attach.py` (picking an existing library image for a missing tag) and `ui_extra.py` (9 checks: slots, N/X settings, pinned strip, disabling an account mid-run, error and retry, the player not resetting on 2-second refresh). Each needs a fresh server with empty data:

```bash
# requires: pip install playwright, and Microsoft Edge
MUSE_DATA_DIR=/tmp/muse-e2e MUSE_KEY_DIR=/tmp/muse-e2e-keys MUSE_MOCK_JOB_SECONDS=9 MUSE_MOCK_FAIL_RATE=0 npm start
MUSE_URL=http://localhost:8787 python e2e/ui_acceptance.py   # stop the server, wipe the data, restart, then run ui_extra.py
```

## Design decisions

- **"Paste and go"** only adds jobs to the queue; you still press **▶ Run queue**.
- **A timeout** re-queues the job and counts as one retry; after N it becomes `Failed` with code `JOB_TIMEOUT`.
- **"Clear finished"** only hides jobs from the list; the videos stay. The `×` button on a row deletes the file too.
- **Studio jobs** share the queue and the live strip but are not listed in the Queue tab, since they already appear on their cards.
- **A shared image for a batch** is attached after the `@tag` images.
- **An unknown tag at enqueue time** rejects the whole batch instead of running without the image.

## License

Licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**.

- **Allowed:** personal use, learning, research, hobby projects, and use by educational, charitable and other noncommercial organisations. You may modify and share it for these purposes, as long as you keep the license text and the `Required Notice` line.
- **Not allowed:** commercialising it. That includes selling it, offering it as a paid product or service, using it inside a commercial product, or running it to make money (for example generating videos you sell). For commercial use, contact the author for a separate license.
- This is a *source-available* license, not an OSI-approved open-source license. Third-party dependencies keep their own licenses.

## Credits

- [Muse-Chat-MCP](https://github.com/duclm1x1/Muse-Chat-MCP) (MIT) for the research on how to drive the Muse web app.
- Built with Fastify, React, Vite, Tailwind CSS, Playwright and sharp.
