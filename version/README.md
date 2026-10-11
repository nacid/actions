# Version action

Computes a `<prefix>X.Y.N` tag for the current commit and, by default, creates and pushes it as a lightweight Git tag. `prefix` defaults to `version/`. `X.Y` comes from the configured version source; `N` is one greater than the highest existing full tag in that series, or `0` when the series has no tags. If the current commit already has full version tags with the configured prefix, the action returns the highest version without reading the version source or pushing another tag. Tags with other prefixes, major-only tags such as `v3`, and prerelease tags are ignored.

## Usage

```yaml
- name: Prepare version
  id: version
  uses: nacid/actions/version@v3
  env:
    FORGEJO_TOKEN: ${{ github.token }}
  with:
    version-type: PY_TOML
    version-source: pyproject.toml
```

Set `push-tag: false` to return the computed version outputs without creating a local tag or pushing it to `origin`:

```yaml
- name: Compute version without tagging
  id: version
  uses: nacid/actions/version@v3
  env:
    FORGEJO_TOKEN: ${{ github.token }}
  with:
    version-type: PY_TOML
    version-source: pyproject.toml
    push-tag: false
```

The default is `push-tag: true`. Both modes fetch existing tags before choosing the next patch number. An existing version tag on the current commit is returned in either mode.

The checkout must fetch the full history. For HTTP(S) origins, the action reads `FORGEJO_TOKEN` for authenticated tag fetches and pushes. Forgejo exposes its automatic `${{ forgejo.token }}` under that name. On GitHub, set `FORGEJO_TOKEN: ${{ github.token }}` in the action step's `env` and grant `contents: write` when pushing tags. The token is passed to Git through the process environment and is not stored in the remote URL or printed in command logs.

On Forgejo, use the fully qualified reference `https://github.com/nacid/actions/version@v3` to load the action from GitHub regardless of the runner's default actions host. Forgejo supplies `FORGEJO_TOKEN` automatically, so omit the GitHub `env` mapping there. The major tag tracks checked commits; pin a commit SHA for an exact revision.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `working-directory` | No | `.` | Git checkout relative to `GITHUB_WORKSPACE`, or an absolute directory. |
| `version-type` | Yes | | `TXT`, `PY_TOML`, or `UNITY`. |
| `version-source` | Yes | | Source path relative to `working-directory`, or an absolute path. |
| `prefix` | No | `version/` | Literal tag prefix, for example `v` or `release/`. Include any desired separator. |
| `push-tag` | No | `true` | Create and push the computed full tag. Set `false` to return outputs without creating a tag. |
| `retries` | No | `3` | Positive number of attempts to push a version tag. |
| `retry-sleep` | No | `1.0` | Non-negative delay between retry attempts, in seconds. |

For `prefix: v`, tags are named `vX.Y.N` and only matching full tags participate
in patch selection and existing-tag reuse. The prefix is matched literally,
including characters such as `+` and `.`; it must produce valid Git tag names.
The `version` and numeric component outputs are independent of the prefix.

## Checkout and authentication

`working-directory` selects the Git checkout and defaults to `.`. Relative paths are resolved from `GITHUB_WORKSPACE`; absolute paths are also accepted. `version-source` is relative to that working directory, so sibling action and project checkouts can be used without prefixing the source path:

```yaml
- name: Prepare project version
  id: version
  uses: ./Ci/version
  with:
    working-directory: Project
    version-type: UNITY
    version-source: ProjectSettings/ProjectSettings.asset
```

For `ssh://git@host/path.git` and SCP-style `git@host:path.git` origins, the action reuses the SSH authentication configured by the repository checkout. `FORGEJO_TOKEN` is not required or used. Keep `persist-credentials: true` on `actions/checkout` so its SSH command and key remain available to the version step.

When `push-tag` is enabled, the selected HTTP token or SSH key must be allowed to push version tags under the repository's tag protection rules.

`PY_TOML` reads the PEP 621 `version` field from the `[project]` section. The source patch component is ignored when selecting the next tag.

For a text file:

```yaml
- name: Prepare version
  id: version
  uses: nacid/actions/version@v3
  env:
    FORGEJO_TOKEN: ${{ github.token }}
  with:
    version-type: TXT
    version-source: version.txt
```

`TXT` finds the first `X.Y.Z` version anywhere in the file. Prerelease and build suffixes are accepted. For example, both `1.4.2` and `release=1.4.2-rc.1+build.7` select the `1.4` tag series.

For a Unity project:

```yaml
- name: Prepare version
  id: version
  uses: nacid/actions/version@v3
  env:
    FORGEJO_TOKEN: ${{ github.token }}
  with:
    version-type: UNITY
    version-source: ProjectSettings/ProjectSettings.asset
```

`UNITY` reads `PlayerSettings.bundleVersion`. It accepts `X.Y.Z` with an optional prerelease or build suffix. As with every handler, only `X.Y` selects the tag series.

The action uses the Node.js 20 action runtime and does not require a POSIX shell. The execution environment must provide Node.js and Git; GitHub-hosted runner images already do, while Forgejo runner images must include them.

## Outputs

- `commit`: the full commit SHA of `HEAD` in `working-directory`.
- `version`: `X.Y.N` without the configured prefix.
- `version_tag`: the complete `<prefix>X.Y.N` tag, existing or computed. With `push-tag: false`, a computed tag is not created.
- `version_major`, `version_minor`, `version_patch`: numeric version components.
- `version_code`: `major * 1_000_000 + minor * 1_000 + patch`.

For `version/0.3.10`, the component outputs are `0`, `3`, and `10`, and `version_code` is `3010`.

## This repository's major tag

The repository's [version.txt](../version.txt) contains `3.0.0`. Its
[workflow](../.github/workflows/check.yml) invokes `./version` with `prefix: v`
and `push-tag: false` after the tests and bundle checks succeed on `main`.
It uses `version_major` to create or move `v3` to the checked commit.
Only the major tag is pushed; no full-version tag is created by this workflow.

## Adding a version type

Add a module to the `mode` directory. Its filename is the lowercase, kebab-case form of the type: for example, `UNITY` maps to `mode/unity.mjs` and `SOME_TYPE` maps to `mode/some-type.mjs`. The module must export:

```js
export async function getVersionMajorMinor(versionSource) {
  return { major, minor };
}
```
