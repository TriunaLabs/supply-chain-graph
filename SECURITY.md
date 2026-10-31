# Security and privacy

This project inventories dependency evidence. It is not a complete vulnerability scanner, and an unavailable or failed lookup is **unknown**, never a clean result.

## Data boundaries

- A real config can contain project labels, absolute roots, and private repository identities. Snapshots, rendered dashboards, diff events, triage notes, logs, and CI artifacts can repeat those details and reveal package versions, commits, dependency paths, and known weaknesses. Keep them in a private location outside this source repository. The .gitignore covers common local output names but is not a publication or secret-scanning control.
- The tool does not enumerate the whole computer by default. A user provides exact project roots or explicitly selected discovery parent folders. Discovery has depth and directory limits and refuses a drive or filesystem root. A scan also discovers candidates when the private config explicitly contains searchRoots; it reports them but does not add them automatically.
- The scan, render, and diff commands operate locally. Enrich and advisory-details make explicit network requests. npm package names and exact resolved versions are sent to OSV; names are sent to the public npm registry. Decide whether even package names disclose private work before enabling enrichment. The scanner does not install dependencies, execute package scripts, or fetch Git remotes.
- The serve command binds to loopback and exposes a local editor that can update the selected config, triage state, and snapshot, open a verified local folder, and open a native folder dialog on the server's own desktop. The dialog returns only the one directory the user picked; the browser cannot submit an arbitrary path through it, and the server validates the result and saves nothing until the user submits the form. `SUPPLY_CHAIN_FOLDER_PICKER` replaces the dialog command and is read from the environment of the person who starts `serve`, like any other command they run. Treat its session URL as sensitive: it contains an access token and may be captured in terminal logs or browser history. Do not reverse-proxy it, bind it to a public interface, or share a real dashboard HTML file.
- `evaluate`, `packet`, and `summary` are local. A packet is the only document designed to leave the private environment: it carries event and finding IDs, a project ID or opaque alias, package names and versions, one dependency path, evidence sources, and advisory IDs, and no absolute roots, source text, credentials, or remote labels. Decide whether package names may leave before delivering it anywhere. The webhook example sends nothing unless you set its URL and secret, signs every body, and keeps receipts and suppression state in files you choose.
- Dependency metadata, source files, repository descriptions, and advisory text are untrusted input. An LLM consuming results must treat them as evidence to analyze, not instructions to follow. Do not give an agent repository write, issue creation, notification, or deployment access solely because it read a finding.

## Before the first public push or release

1. Publish only the reusable skill, source, synthetic fixtures, and documentation. Exclude real configs, local/, snapshots, dashboards generated from real projects, triage state, logs, downloaded files, and credentials.
2. Inspect the exact staged file list and staged diff, including HTML and JSON fixtures. Search for private project names, absolute paths, email addresses, tokens, remote URLs, and generated scan records. Scan the Git history if reusing an existing repository; deleting a file from the latest commit does not remove it from history.
3. Run the included tests and a secret scanner. Review findings manually; an automated pass cannot establish that all business-sensitive names or paths are absent.
4. Configure GitHub secret scanning and push protection, code scanning, and private vulnerability reporting for the new public repository where available. Keep CI tokens read-only unless a separate, reviewed action requires write access.
5. Review any public demo again after rendering. Only the synthetic fixture should appear in public screenshots, Pages builds, README images, or release assets.

## Reporting a vulnerability

After the public repository exists, enable GitHub private vulnerability reporting and use it for reports involving this tool. Until that channel is available, contact the maintainer through the organization's published contact route without attaching private snapshots or exploit details to a public issue. Do not post sensitive reproduction data in public issues.

See [pipeline integration](references/pipeline-integration.md) for safe automation boundaries.

Before installation, users may run [NVIDIA SkillSpector](https://docs.nvidia.com/skills/scanning-agent-skills) on the skill directory and inspect its report. Its static mode avoids sending skill file contents to an LLM provider, but its dependency check can still query OSV. It does not run or sandbox this skill, and a low-risk report is not proof of safe runtime behavior.
