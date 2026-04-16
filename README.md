# pi-oracle

`pi-oracle` is a local pi package that wraps [`@steipete/oracle`](https://github.com/steipete/oracle) behind a pi extension and a prompt template. It provides:

- an `oracle_consult` custom tool for explicit Oracle calls from pi;
- a `/oracle` prompt template that tells pi to inspect the repository, choose the minimal relevant files, call Oracle, and then summarize the result.

## What it does

The package is designed for cases where a normal pi answer is not enough and an external second-model review is useful. By default it routes Oracle through browser mode with:

- `engine: browser`
- `model: gpt-5.4-pro`
- `wait: true`
- a `5s` browser cookie-sync grace period before Oracle gives up on Chrome session reuse
- Oracle's recommended browser auto-reattach settings for long Pro responses

That matches a ChatGPT browser workflow and avoids OpenAI API keys when your browser login already has access to GPT-5.4 Pro. These are wrapper-level defaults for pi; if you need a different value for a specific run, override it through the structured tool parameters rather than Oracle CLI flags.

## Install and load

From this package root:

```bash
npm install
```

For normal use from the public repository:

```bash
pi install git:github.com/lulucatdev/pi-oracle
```

To pin a stable release:

```bash
pi install git:github.com/lulucatdev/pi-oracle@v0.1.2
```

For local development from this working copy:

```bash
pi install /Users/lucas/Developer/pi-oracle
```

For a one-off run without installing globally:

```bash
pi -e /Users/lucas/Developer/pi-oracle/extensions/pi-oracle/index.ts \
  --prompt-template /Users/lucas/Developer/pi-oracle/prompts/oracle.md
```

## Using `/oracle`

Inside pi, invoke the prompt template directly:

```text
/oracle review the sync engine for data-race risks
/oracle compare my current refactor plan against the actual storage layer code
/oracle find the smallest file set needed to explain why the login flow fails on macOS
```

The prompt template instructs pi to:

1. inspect the repository;
2. choose the smallest relevant file set;
3. call `oracle_consult` with the Oracle prompt plus those files;
4. for completed runs, call `get_oracle_content` and summarize the stored full Oracle result rather than the compact inline preview; and
5. for preview, background, or failure states, report that state explicitly instead of inventing an Oracle answer.

## Direct tool shape

The extension registers `oracle_consult` with structured parameters. The most important fields are:

- `prompt`: the Oracle task or question;
- `files`: attached files, directories, or globs;
- `model`: optional override, default `gpt-5.4-pro`;
- `engine`: optional override, default `browser`;
- `wait`: optional override, default `true`; when set to `false`, the tool starts Oracle in background mode for upstream-supported detached runs, returns session metadata plus startup logs immediately, and later emits a follow-up message when the stored result becomes complete;
- `dryRunMode`: `summary`, `json`, or `full` for non-spending previews; when this is set, the tool returns preview metadata rather than a real Oracle answer;
- wrapper validation failures surface as true tool errors, while Oracle process failures return a structured failed result with `status: "failed"` and `details.error: true`; callers should summarize both as failures rather than as Oracle assessments;
- successful, failed, and detached launches persist a stored result under `.pi/oracle/<responseId>/` and return a `responseId` plus stored-section metadata;
- browser-specific options such as `browserAttachments`, `browserThinkingTime`, `browserKeepBrowser`, `browserManualLogin`, `browserModelStrategy`, and `browserCookieWait`.

## Stored result retrieval

Stored Oracle results live under `.pi/oracle/<responseId>/` in the current project root. This is local runtime state and should stay untracked in git. Each stored response uses plain files such as:

- `metadata.json`
- `answer.md` when a final Oracle answer exists
- `logs.txt` for startup or failure logs

Use `get_oracle_content` to read the stored result back into the agent context. It accepts:

- `responseId`: the id returned by `oracle_consult`
- `section`: `answer`, `logs`, `metadata`, or `all` (default)

The wrapper currently generates `responseId` values with the helper in `extensions/pi-oracle/store.ts`:

```ts
export function createOracleResponseId(now: Date = new Date()): string {
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];
  return `${parts.join("")}-${randomUUID().slice(0, 8)}`;
}
```

In practice, that means the emitted format is `YYYYMMDDHHMMSS-xxxxxxxx`, for example `20260416144336-918a2378`.

For successful attached runs, `/oracle` now uses this retrieval path automatically before it summarizes Oracle's answer.

In addition to that wrapper-owned store, the extension now runs Oracle itself with a project-local Oracle home at `.pi/oracle/oracle-home/`. That means upstream Oracle session artifacts such as `meta.json` and `output.log` are also recorded under the current project instead of only under `~/.oracle/sessions/`. On first use, if `.pi/oracle/oracle-home/config.json` does not exist and `~/.oracle/config.json` does, the wrapper seeds the project-local Oracle config from the global one for compatibility.

Detached-run note: the current Oracle CLI rejects browser `--no-wait` launches with `Unable to start in background; use --wait to run inline.` In practice, background completion plus follow-up retrieval is therefore for detached engine modes that Oracle supports, such as API-based sessions.

## Browser prerequisites

Oracle's browser mode expects a Chromium-based browser profile it can reuse for ChatGPT. In the common case, the default Chrome profile is enough. For project-local runs, configure Oracle in `.pi/oracle/oracle-home/config.json` in this project. On first use the wrapper copies `~/.oracle/config.json` there when available. For example:

```json5
{
  engine: "browser",
  model: "gpt-5.4-pro",
  browser: {
    chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    chromeCookiePath: null,
    modelStrategy: "select"
  }
}
```

The wrapper now passes `--browser-cookie-wait 5s` by default, which gives Oracle one extra chance to finish Chrome cookie reuse before it reports a missing ChatGPT session. This reduces transient false negatives on macOS when Keychain access or ChatGPT auth redirects are slow.

If cookie reuse still fails, Oracle also supports manual-login mode. Either ask pi to use `browserManualLogin: true` on the tool call, increase `browserCookieWait`, or set manual-login defaults in `.pi/oracle/oracle-home/config.json` for this project. The wrapper seeds that local config from `~/.oracle/config.json` automatically when the local file is missing:

```json5
{
  browser: {
    manualLogin: true,
    keepBrowser: true
  }
}
```

See the upstream Oracle docs for more advanced browser configuration, remote Chrome, and API-mode usage.

## Validation

Useful local checks:

```bash
npm run typecheck
npm run oracle:help
npm run pack:check
```

Optional integration checks, which require `pi` plus a configured model/provider:

```bash
npm run validate:wrapper:preview
npm run validate:wrapper:error
npm run validate:wrapper:retrieve
npm run validate:wrapper:background
npm run release:check
```

If ChatGPT is signed in locally, live attached browser validation is also possible:

```bash
pi --mode json -ne -ns -np -e ./extensions/pi-oracle/index.ts \
  -p 'Call oracle_consult exactly once with prompt "Reply with exactly OK.", files ["README.md"], engine "browser", model "gpt-5.4-pro", wait true. Then stop.' \
  --no-session --thinking off

pi -ne -ns -np -e ./extensions/pi-oracle/index.ts \
  --prompt-template ./prompts/oracle.md \
  -p '/oracle inspect the repository briefly, attach the smallest relevant file set, and ask Oracle to reply with exactly OK. Then report whether the final summary came from stored retrieved content.' \
  --no-session --thinking off
```

A non-spending Oracle smoke test is also possible after installation by invoking `/oracle` on a small request and asking pi to use `dryRunMode: "summary"`.

## Release workflow

For future tagged releases:

1. update `package.json` if the package version should change;
2. run `npm run release:check`;
3. commit the release-ready state;
4. create and push a tag such as `v0.1.2`;
5. create the matching GitHub Release entry with `gh release create`;
6. install or test the pinned tag with `pi install git:github.com/lulucatdev/pi-oracle@v0.1.2`.

See `RELEASING.md` for the full command sequence.
