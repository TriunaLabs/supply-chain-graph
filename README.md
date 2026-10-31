# Supply Chain Graph skill

A Codex skill and local starter by Triuna Labs, Inc. for a portfolio dependency graph. The included CLI reads only configured project roots and parent directories explicitly selected for discovery. It does not search the whole computer for repositories. Local scanning does not install packages, fetch Git remotes, or send notifications. Network lookups are separate commands.

## Try it

Requires Node.js 20 or newer. From this directory:

```sh
node scripts/supply-chain.mjs scan --config examples/portfolio.example.json --out local/snapshot.json
node scripts/supply-chain.mjs render --snapshot local/snapshot.json --out local/dashboard.html
```

The example config points at a tiny fixture. These `local/` commands are for the synthetic demo only; write every real config and scan output to a private location outside this repo. A project without a known root can use `"root": null`; it will appear as an unavailable coverage source. The `local/` output directory is ignored by Git. Open `local/dashboard.html` in a browser, or inspect the [safe demo dashboard](examples/demo-dashboard.html). The fixture is a subdirectory of this clone, so any Git branch and commit shown for Sample App belong to the enclosing Supply Chain Graph repository, not a separate Sample App repository.

The demo page is generated from `examples/demo-snapshot.json`, a synthetic snapshot with no local paths or Git metadata. After changing anything under `assets/`, regenerate it so the checked-in page matches the code; a test fails when it is stale:

```sh
node scripts/supply-chain.mjs render --snapshot examples/demo-snapshot.json --out examples/demo-dashboard.html
```

## Scan one real project on Windows

From your cloned repository, choose a project directory and keep the config and scan output outside the clone. Replace the sample path below with the absolute path to your own project. The project ID is a lowercase label for this dashboard.

```powershell
$project = 'C:\path\to\your-project'
if (-not (Test-Path -LiteralPath $project -PathType Container)) { throw 'Choose an existing project directory' }
$private = Join-Path $env:USERPROFILE 'supply-chain-graph-private'
New-Item -ItemType Directory -Force -Path $private | Out-Null

node scripts/supply-chain.mjs init --out "$private\portfolio.json"
node scripts/supply-chain.mjs set-root --config "$private\portfolio.json" --id my-project --label "My Project" --root $project --out "$private\portfolio.with-project.json"
node scripts/supply-chain.mjs scan --config "$private\portfolio.with-project.json" --out "$private\snapshot.json"
node scripts/supply-chain.mjs render --snapshot "$private\snapshot.json" --out "$private\dashboard.html"
Invoke-Item "$private\dashboard.html"
```

`init` creates a new empty config and stops if that file already exists. For another project, use your latest config as `set-root --config` and choose a new `--out` path. The static HTML is read-only. To enable **Set root** and **Open folder in Explorer**, run `node scripts/supply-chain.mjs serve --config "$private\portfolio.with-project.json" --snapshot "$private\snapshot.json" --out "$private\dashboard.html"` and open the localhost URL printed in the terminal. A project without a lockfile still shows declared dependencies and literal JavaScript imports, but installed versions and security status remain unknown until supported resolution and opt-in lookups are available.

In local editing mode, click **Add project folder**, then **Choose project folder**, select a directory, and click **Add and scan** to save it. The dialog opens in front of the browser window you clicked in, on the same monitor, with the drives listed under This PC. If the page keeps saying it is waiting and no dialog appears, the server was started by a launcher that runs it in a restricted job; stop it and start `serve` from your own terminal.

## Choose project folders or discover them

Start a private portfolio config outside this repository:

```sh
node scripts/supply-chain.mjs init --out PRIVATE_CONFIG
```

To add a known project, provide its absolute folder path. The command writes a new config, leaving the original for review:

```sh
node scripts/supply-chain.mjs set-root --config PRIVATE_CONFIG --id sample-app --root ABSOLUTE_PROJECT_FOLDER --out PRIVATE_UPDATED_CONFIG
node scripts/supply-chain.mjs scan --config PRIVATE_UPDATED_CONFIG --out PRIVATE_SNAPSHOT
```

Alternatively, choose one or more parent folders to search for candidate repositories and manifests. Discovery searches only those folders, skips build output, `node_modules`, and hidden directories, and refuses a whole drive or filesystem root. The default limits are depth 3 and 10,000 directories; both can be lowered. The report marks itself incomplete if the limit is reached or a directory cannot be read, and lists unreadable paths for private review. Review candidates before adopting them because a nested workspace package or duplicate checkout is not necessarily a new product.

```sh
node scripts/supply-chain.mjs discover --config PRIVATE_CONFIG --search-root ABSOLUTE_PROJECT_PARENT --depth 3 --max-directories 10000 --out PRIVATE_DISCOVERY
node scripts/supply-chain.mjs adopt-discovery --config PRIVATE_CONFIG --discovery PRIVATE_DISCOVERY --out PRIVATE_EXPANDED_CONFIG --nested-locks
node scripts/supply-chain.mjs scan --config PRIVATE_EXPANDED_CONFIG --out PRIVATE_SNAPSHOT
```

`discover` only reports candidates; `adopt-discovery` writes a new config for review. It adds unlisted top-level sources and, with `--nested-locks`, nested roots with supported lockfile names. An existing ID keeps its identity when `set-root` changes its path. If a config contains `searchRoots`, `scan` also searches those explicitly configured parents for coverage reporting, but it does not add candidates to the project list. Set `discoveryDepth` or `discoveryMaxDirectories` in that private config to lower the scan-time discovery bounds.

For a clickable root editor, start the local server and open the localhost URL it prints:

```sh
node scripts/supply-chain.mjs serve --config PRIVATE_EXPANDED_CONFIG --snapshot PRIVATE_SNAPSHOT --out PRIVATE_DASHBOARD
```

When nothing is selected, the right-hand panel is a start-here guide: it offers **Add project folder** and **Discover projects under a parent folder**, lists what the scan reads, states that nothing leaves the machine unless you run the opt-in enrichment, and spells out what the npm status counts mean for the open snapshot. Clicking blank graph space brings it back. In local server mode, **Discover projects under a parent folder** opens the folder dialog for a parent, adds that parent to the private config's `searchRoots`, rescans, and lists every repository and manifest it found in **Roots to review**; **Add all N unlisted repositories and scan** adopts the top-level candidates in one step, while nested manifests stay as review items. The **Roots to review** table has **Set root** buttons, and **Add project folder** opens the same form for a new root. In local server mode the form has a **Choose project folder** button: the server opens a native folder dialog on the machine running `serve` (the Windows folder browser, the macOS chooser, or `zenity` on Linux), verifies that the chosen path is an accessible directory and not a drive root, and fills in the absolute path, a suggested ID, and a display name. Nothing is saved until you click **Add and scan**; cancelling the dialog leaves the form unchanged. Set `SUPPLY_CHAIN_FOLDER_PICKER` to a command that prints one directory path (a JSON array for arguments with spaces) to use a different dialog tool. Start `serve` from your own terminal: when an IDE or agent launcher starts it inside a restricted job, Windows creates the dialog but never draws it, the page keeps saying it is waiting, and later clicks report that a dialog is already open. The server logs when a dialog opens and closes, without the chosen path. In local server mode, the form saves the private config and rescans; it does not run network enrichment. Selecting a project or project-specific dependency shows its absolute source root and an **Open folder in Explorer** button. For an npm occurrence, the server opens its installed directory if that directory exists; otherwise it opens the project root. The server resolves the selected node against the current snapshot and private config; the browser cannot submit an arbitrary path for this action. It binds to `127.0.0.1`, requires its random session link to read the dashboard and a token for edits, and does not expose a public endpoint. A saved `file://` dashboard remains read-only and shows the path without the Explorer action. Browsers do not give a page the absolute path of a folder a user picks, so the folder dialog is opened by the local server instead; the root form also accepts a pasted absolute path, and both are validated as accessible before anything is saved. The same server saves action status and notes to a private `triage-state.json` beside the snapshot, or to `--state FILE` when supplied.

## Advisory and lifecycle lookups

The local scan does not query security or registry services. To add source-backed package checks from a network-enabled machine:

```sh
node scripts/supply-chain.mjs enrich --snapshot PRIVATE_SNAPSHOT --out PRIVATE_ENRICHED
node scripts/supply-chain.mjs advisory-details --snapshot PRIVATE_ENRICHED --out PRIVATE_DETAILED
node scripts/supply-chain.mjs render --snapshot PRIVATE_DETAILED --out PRIVATE_DASHBOARD
```

Add `--project PROJECT_ID` to check one project first. Enrichment sends npm package names and resolved versions to [OSV](https://google.github.io/osv.dev/post-v1-querybatch/) and names to the [public npm registry](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md). It does not send project IDs, local paths, or Git credentials. Git- or local-sourced packages are left unknown because a public name/version lookup would not verify their installed code. Review whether private package names are appropriate to query before running it. Failed or unavailable requests remain **unknown**; an empty OSV response is recorded only after a successful check.

The dashboard's status strip filters paths with critical advisory details, returned advisories, npm deprecation messages, a newer stable version at npm's `latest` tag, unknown advisory coverage, or local scan coverage gaps. A deprecation message already present in `package-lock.json` also appears, labeled **cached** until a registry check confirms it. `latest` is a publisher-managed tag, [not necessarily the highest published version](https://docs.npmjs.com/cli/v9/commands/npm-outdated/). “Newer npm latest” is informational. OSV details include a summary, source severity where available, and published fixed boundaries; these do not establish that a proposed update fixes every issue. The side panel gives direct or transitive action guidance. No remote lookups run while opening the dashboard.

For a large portfolio, add `--no-git` to `scan` to collect npm coverage first. Git is then marked `not-scanned`, so it cannot be mistaken for a clean result. Each project emits a progress line without its local path.

To produce alert candidates after a later scan:

```sh
node scripts/supply-chain.mjs diff --previous PRIVATE_PREVIOUS --current PRIVATE_CURRENT --out PRIVATE_EVENTS
```

The diff command writes candidate events only, including newly observed OSV IDs, cached or registry deprecation, and newer `latest` tags when enriched snapshots are compared. A failed later lookup never creates a false advisory-resolution event. A delivery integration should apply policy, acknowledgements, quiet hours, retries, and channel credentials separately. Do not commit a real portfolio snapshot without checking whether it reveals private project or dependency details.

## Current coverage

The source scan walks supported JavaScript and TypeScript files under each configured root, including `src`, even when `package.json` declares nothing and no lockfile exists. It records literal file-to-file imports and external package specifiers with line evidence. The default cap is 2,500 source files per project; skipped or unreadable files mark coverage partial. Nonliteral dynamic imports and bundler-specific aliases need separate analysis. A bare import or CDN mapping is not a verified npm installation, so it is not sent to OSV by the existing npm enrichment command.

When multiple local roots track the same GitHub repository, the project selector shows each checkout's branch and directory. The scope line reports the selected checkout's root, cached critical package count, and other checkouts of that remote. A project node is outlined red when one of its locked package versions has a cached critical advisory record; selecting it lists the implicated versions. This status belongs to that checkout's snapshot and does not imply that another checkout of the same remote has the same dependency versions.

| Source | Starter behavior |
| --- | --- |
| npm `package.json` + `package-lock.json` v2/v3 | Direct and transitive resolved occurrences, exact versions, source and integrity evidence |
| pnpm `pnpm-lock.yaml` v9 | Importers, workspace links, resolved snapshots, and transitive dependency edges; unsupported reference forms are flagged |
| Root `package.json` without a supported lock | Declared dependencies and requested ranges; resolved versions remain unknown |
| JavaScript and TypeScript source imports | Bounded scan of literal `import`, `export from`, dynamic `import()`, and `require()` specifiers; local file links and external bare imports remain separate from npm resolution |
| Root HTML import maps | Mapped URLs and version hints for bare browser imports, with no claim that the package is installed or that the URL was fetched |
| Git checkout | Local HEAD, branch, origin label, and cached upstream divergence when present; when the project folder is a subdirectory of a repository, the checkout records the enclosing repository root and is labeled as such (the demo fixture is one, inside this repository's own checkout) |
| GitHub git URLs in npm resolution | Links a package occurrence to a GitHub repository label |
| GitHub Actions and Git submodules | Workflow `uses` and submodule repository links from local files |
| Python `requirements.txt` at project root | Direct pinned versions or declared ranges; transitive resolution is not inferred. Pinned PyPI packages appear in the **npm / pnpm** lens labeled with their ecosystem and marked **Advisory unknown**, because the opt-in enrichment queries npm names only |
| Missing, ambiguous, or unsupported lockfile | Specific coverage finding with source and suggested next step |
| OSV advisories and npm registry lifecycle metadata | Opt-in `enrich` command; recorded per package version with checked, failed, and unavailable states |
| Remote GitHub heads, releases, other ecosystems | Adapter contract in `references/architecture.md`; not collected yet |

The dashboard has four network lenses: **JavaScript requests** connects manifest ranges to locked occurrences, **Source imports** connects importing files to local modules and external specifiers, **npm / pnpm** traces resolved direct and transitive packages, and **GitHub sources** connects checkouts, workflow actions, Git packages, and repositories. The **Graph view** control offers **All direct dependencies**, which draws every direct link for the projects in view, and **Dependency paths**, which draws a bounded multi-step sample. **All projects** starts with ten project roots per page; **Show all** places all configured roots and their direct links in one vertically scrollable graph. The path sample rotates its node budget across projects instead of filling it from the first large project. The graph footer states the visible edge count and scope. Click blank graph space or a selected node again to clear selection. The **Every recorded edge** index below the graph pages through all recorded relationships, including occurrence-to-artifact resolution, and accepts the same scope, status, and search inputs. Focus a project or search across the full snapshot to trace paths; use the JSON export for machine analysis. Status filters show bounded matching paths, while the relationship index remains complete for its active filters. Column headings explain each path. **Fit** uses viewport fit for paths and width fit for a tall direct chart; **+** and **−** adjust zoom. “No root manifest” means JavaScript was not found at that root; it is not a read error. Nested sources are listed for review. Live GitHub heads are not queried. Its visual language follows a warm paper, teal, and two-pane evidence workspace.

Suggested steps in the inspector are leads for review, not executed remediation. The local server lets you mark a package node or coverage finding **open**, **investigating**, or **acknowledged** and attach a note. Only a later scan can establish that a finding is no longer observed; acknowledgement does not resolve it. A notification workflow still needs stable cross-scan finding identity, ownership, suppression with expiry, deduplicated delivery, and a chosen channel. The current `diff` emits candidate events but does not send them. npm workspaces, unscanned nested manifests, other package ecosystems, live GitHub drift, runtime applicability, and tested fixed-version selection remain coverage work. See [architecture](references/architecture.md) for the implementation boundary.

Run the included parser, diff, and graph checks from the repository root with `node --test`. This uses test-file discovery and works without relying on shell or Node glob expansion.

## Security and automation

Read [SECURITY.md](SECURITY.md) before publishing or running the local editor. It covers what scan outputs expose, what opt-in lookups send to third parties, and a publication checklist. For CI and LLM triage, read the [pipeline integration guide](references/pipeline-integration.md). The current CLI writes machine-readable snapshots and candidate change events; it does not enforce a security policy, notify people, create pull requests, or authorize an agent to change code.

Users can independently review this skill with [NVIDIA SkillSpector](https://docs.nvidia.com/skills/scanning-agent-skills) before installing it: `skillspector scan PATH_TO_SKILL --no-llm` runs static analysis. This does not execute the skill or prove it safe. NVIDIA notes that the static scan can still send declared dependency names and versions to OSV, while an LLM-enabled scan sends eligible file contents to the configured provider. On Windows, omit SkillSpector's `--output` flag because its secure file-output mode is unavailable there; inspect terminal output or redirect to a private location after reviewing the command. Review the scripts and permission needs yourself.

For CI, `--out -` writes JSON (or rendered HTML for `render`) to stdout while progress goes to stderr. Avoid printing private snapshots in public logs. `init` refuses to overwrite an existing config. The stable integration points are explicit config paths and the versioned JSON contracts under [contracts/](contracts/README.md): `validate --schema snapshot|diff-events|policy|policy-result --file FILE` checks a document, and `evaluate --snapshot FILE --policy FILE --out FILE [--at ISO-TIME] [--previous RESULT]` applies a deterministic policy that reports coverage states, stable finding identities, transitions against a previous result, and a gate verdict (exit 3 on a configured gate failure, exit 1 on invalid input). The default policy in `contracts/policy.default.json` reports everything and fails nothing; see the pipeline guide for the remaining gaps before unattended remediation.

## Public repository boundaries

The fixture and tests use synthetic project names and paths. Keep real roots in a private config outside the repo. Scanned snapshots include absolute project roots for path inspection, so real snapshots and rendered dashboards should stay private. Project IDs, remote labels, package names, and commit IDs can also be sensitive. Host a dashboard only after reviewing its snapshot. Review the exact staged files and Git history before publishing changes to the public repository.

See [architecture and next steps](references/architecture.md) for the complete system design and authoritative source links.
