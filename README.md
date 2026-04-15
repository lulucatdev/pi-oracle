# pi-oracle

`pi-oracle` is a local pi package that wraps [`@steipete/oracle`](https://github.com/steipete/oracle) behind a pi extension and a prompt template. It provides:

- an `oracle_consult` custom tool for explicit Oracle calls from pi;
- a `/oracle` prompt template that tells pi to inspect the repository, choose the minimal relevant files, call Oracle, and then summarize the result.

## What it does

The package is designed for cases where a normal pi answer is not enough and an external second-model review is useful. By default it routes Oracle through browser mode with:

- `engine: browser`
- `model: gpt-5.4-pro`
- `wait: true`
- Oracle's recommended browser auto-reattach settings for long Pro responses

That matches a ChatGPT browser workflow and avoids OpenAI API keys when your browser login already has access to GPT-5.4 Pro.

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
pi install git:github.com/lulucatdev/pi-oracle@v0.1.0
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
3. call `oracle_consult` with the Oracle prompt plus those files; and
4. summarize the returned Oracle answer, or explicitly report preview, background, or failure state when the tool did not produce a final Oracle assessment.

## Direct tool shape

The extension registers `oracle_consult` with structured parameters. The most important fields are:

- `prompt`: the Oracle task or question;
- `files`: attached files, directories, or globs;
- `model`: optional override, default `gpt-5.4-pro`;
- `engine`: optional override, default `browser`;
- `wait`: optional override, default `true`; when set to `false`, the tool starts Oracle in background mode and returns session metadata plus startup logs rather than a final answer;
- `dryRunMode`: `summary`, `json`, or `full` for non-spending previews; when this is set, the tool returns preview metadata rather than a real Oracle answer;
- failed Oracle launches surface as tool errors and should be summarized as failures rather than as Oracle assessments;
- browser-specific options such as `browserAttachments`, `browserThinkingTime`, `browserKeepBrowser`, `browserManualLogin`, and `browserModelStrategy`.

## Browser prerequisites

Oracle's browser mode expects a Chromium-based browser profile it can reuse for ChatGPT. In the common case, the default Chrome profile is enough. If your working login lives in another browser, configure Oracle in `~/.oracle/config.json`, for example:

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

If cookie reuse fails, Oracle also supports manual-login mode. Either ask pi to use `browserManualLogin: true` on the tool call or set this in `~/.oracle/config.json`:

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
npm run release:check
```

A non-spending Oracle smoke test is also possible after installation by invoking `/oracle` on a small request and asking pi to use `dryRunMode: "summary"`.

## Release workflow

For future tagged releases:

1. update `package.json` if the package version should change;
2. run `npm run release:check`;
3. commit the release-ready state;
4. create and push a tag such as `v0.1.1`;
5. create the matching GitHub Release entry with `gh release create`;
6. install or test the pinned tag with `pi install git:github.com/lulucatdev/pi-oracle@v0.1.1`.

See `RELEASING.md` for the full command sequence.
