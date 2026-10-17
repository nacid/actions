[![tests](https://nacid.me/badge/actions-public/tests.svg)](https://github.com/nacid/actions/actions/workflows/check.yml)
[![build](https://nacid.me/badge/actions-public/build.svg)](https://github.com/nacid/actions/actions/workflows/check.yml)
[![release](https://nacid.me/badge/actions-public/release.svg)](https://github.com/nacid/actions/tags)

# Public CI actions

Reusable actions for GitHub Actions and Forgejo Actions. Use `@v3` for the
latest checked revision of major version 3, or pin a commit SHA for an exact
revision. On Forgejo, use a fully qualified GitHub URL such as
`https://github.com/nacid/actions/files@v3`.

## `badge`

Updates a persistent SVG badge with a JSON POST. The default endpoint is
`https://nacid.me/badge`; provide its bearer token from CI secrets.

```yaml
- uses: https://github.com/nacid/actions/badge@v3
  with:
    token: ${{ secrets.BADGES_TOKEN }}
    path: my-project/docker.svg
    type: docker
    passed: true
    message: ${{ steps.version.outputs.version }}
```

Supported presets are `tests`, `npm`, `docker`, `dev`, `alpha`, `beta`, and
`release`. The default `custom` type uses the `label` and `color` inputs.
Required boolean `passed` keeps the normal color when `true` and forces red
when `false`, for both presets and custom badges.
For requests through the internal Astra proxy, set
`endpoint: https://astra.nacid.me/badge`; no token is needed from its allowed
LAN/VPN networks. Requires Node.js 24. See
[the badge action documentation](badge/README.md) for colors and examples.

## `files`

Finds files matching a glob pattern and returns `first`, `last`, `all`
(comma-separated), and `count`. Names exclude directories; matches are sorted
by path. Requires at least `minimum` matches (default `1`). Set `minimum: 0`
to allow empty results.

```yaml
- id: apk
  uses: nacid/actions/files@v3
  with:
    pattern: 'dist/*.apk'
```

On Forgejo, use `https://github.com/nacid/actions/files@v3`. See
[the files action documentation](files/README.md) for masks and outputs.

## `version`

Reads the major and minor version from a project file and computes the next
`version/X.Y.N` tag for the current commit. The `prefix` input defaults to
`version/`; for example, `prefix: v` selects `vX.Y.N` tags. By default it creates a lightweight
tag and pushes it to `origin`; with `push-tag: false`, it only returns the
computed outputs. If `HEAD` already has a version tag, the action returns the
highest existing full version with the configured prefix without reading the
source or pushing another tag. Major-only tags such as `v3` are ignored.

Supported sources are `TXT` (the first `X.Y.Z` in a text file), `PY_TOML`
(the PEP 621 `[project].version`), and `UNITY` (`PlayerSettings.bundleVersion`).
The source patch component is ignored. Requires Git and a full-history checkout.

```yaml
permissions:
  contents: write

steps:
  - uses: actions/checkout@v6
    with:
      fetch-depth: 0
      persist-credentials: false

  - id: version
    uses: nacid/actions/version@v3
    env:
      FORGEJO_TOKEN: ${{ github.token }}
    with:
      version-type: TXT
      version-source: version.txt
```

On Forgejo, use `https://github.com/nacid/actions/version@v3`; the automatic
`FORGEJO_TOKEN` is already available. Relative source paths resolve from
`working-directory`. SSH origins reuse the checkout's authentication. See
[the version action documentation](version/README.md) for inputs, outputs,
authentication, and adding source handlers in `version/mode`.

## `docker`

Builds and publishes one `linux/amd64` and `linux/arm64` image. The normalized
branch, `sha-<12-character-commit>`, optional version, and optional additional
tag names are combined, deduplicated, and assigned to the same multi-platform
manifest.

```yaml
- id: meta
  uses: docker/metadata-action@v6
  with:
    images: ${{ vars.REGISTRY }}/${{ vars.REGISTRY_IMAGE }}
    tags: |
      type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}

- id: docker
  uses: nacid/actions/docker@v3
  with:
    registry: ${{ vars.REGISTRY }}
    registry-image: ${{ vars.REGISTRY_IMAGE }}
    registry-user: ${{ secrets.REGISTRY_USER }}
    registry-password: ${{ secrets.REGISTRY_PASS }}
    tags: ${{ steps.meta.outputs.tag-names }}
    labels: ${{ steps.meta.outputs.labels }}
    pull: true
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

The runner must provide Docker, Buildx, daemon access, and permission to start
a privileged container if QEMU emulation is missing. See
[the Docker action documentation](docker/README.md) for the
complete input and cleanup contract.

## `setup-valdor`

Downloads a tar archive from Valdor using a GitHub OIDC token and extracts it
into the current workspace.

GitHub Actions:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v6

  - uses: nacid/actions/setup-valdor@v3
    with:
      valdor-url: https://valdor.example/packages
      valdor-aud: https://valdor.example
      version: 1.2.3
      branch: main
```

Forgejo Actions:

```yaml
on:
  push:

enable-openid-connect: true

jobs:
  setup:
    runs-on: docker
    steps:
      - uses: actions/checkout@v6

      # A fully qualified URL avoids Forgejo's DEFAULT_ACTIONS_URL prefix.
      - uses: https://github.com/nacid/actions/setup-valdor@v3
        with:
          valdor-url: https://valdor.example/packages
          valdor-aud: https://valdor.example
          version: 1.2.3
          branch: main
```

The action sends the request to:

```text
{valdor-url}/{forge}?version=1.2.3&branch=main
```

Inputs:

- `valdor-url` — required Valdor base URL.
- `valdor-aud` — required audience used to request the GitHub OIDC token.
- `profile` — optional profile sent in the `X-Valdor-Profile` header when set.
- `extras` — optional extras sent in the `X-Valdor-Extras` header when set.
- `forge` — optional forge host. Defaults to the host from
  `forgejo.server_url` or `github.server_url`, for example `codeberg.org` or
  `github.com`.
- `version`, `tag`, `branch`, `commit` — optional query parameters passed to
  Valdor when set.

Valdor must return an uncompressed or supported compressed tar archive. The
archive is extracted into `github.workspace` (the action process working
directory).

The `files` step output is a JSON object mapping each extracted file's name in
`extras` (including nested directories) to its absolute path. For example,
`extras/certs/common.p12` produces a `common.p12` key. Only regular files from
the current archive are included; directories, symbolic links, pre-existing
files absent from the archive, and files named `envs.json` are excluded.
If different paths have the same filename, the action fails instead of
overwriting a key. Without matching files, the output is `{}`.

Outputs are strings, so use
[`fromJSON`](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#fromjson)
to read the file paths:

```yaml
- uses: nacid/actions/setup-valdor@v3
  id: setup
  with:
    valdor-url: https://valdor.example/packages
    valdor-aud: https://valdor.example
    extras: common.p12

- run: ./sign.sh
  env:
    CERTIFICATE_PATH: ${{ fromJSON(steps.setup.outputs.files)['common.p12'] }}
```

If the extracted archive contains `envs.json` at its root, the action reads and
deletes it. The file must contain a flat JSON object whose entries have a
boolean `secret` flag and a string `value`:

```json
{
  "toolPath": {
    "secret": true,
    "value": "{{root}}/tools"
  },
  "extras-cache": {
    "secret": false,
    "value": "{{extras}}/cache"
  }
}
```

Keys are preserved exactly (`toolPath`, `extras-cache`) and all values are
published as step outputs, without exporting environment variables.
The output name `files` (case-insensitive) is reserved for the file path map
and cannot be used as a key in `envs.json`.
`{{root}}` is replaced with the
workspace path and `{{extras}}` with its `extras` subdirectory. A resolved value
is registered as a secret only when its `secret` flag is `true`.
Resolved outputs are logged as `name=value` for non-secret values and
`name=***` for secrets, including multiline secrets. The full resolved value
is preserved in the step output.

Give the action step an `id` to access its outputs. Pass values explicitly to
the steps that need them:

```yaml
- uses: nacid/actions/setup-valdor@v3
  id: valdor
  with:
    valdor-url: https://valdor.example/packages
    valdor-aud: https://valdor.example

- run: ./build.sh
  env:
    TOOL_PATH: ${{ steps.valdor.outputs.toolPath }}
    EXTRAS_CACHE: ${{ steps.valdor.outputs['extras-cache'] }}
```

The Forgejo runner must provide Node.js 20 for `files`, `version`, and
`setup-valdor`, and Node.js 24 for `docker` and `badge`.

## Repository versioning

[version.txt](version.txt) contains the repository version in `N.N.N` format,
currently `3.0.0`. The [GitHub workflow](.github/workflows/check.yml) runs the
tests, rebuilds `setup-valdor`, and verifies that its committed bundle matches.
After those checks succeed on `main`, it invokes the local `version` action
with `prefix: v` and `push-tag: false`, then creates or moves `v{MAJOR}` to
the checked commit (`v3` for the current source).

The repository publishes only major tags such as `v3`; the workflow does not
create full-version tags. Pull requests and manual runs on other branches
only run the checks. Tag publishing jobs are serialized and have
`contents: write`; test jobs keep `contents: read`. This follows GitHub's
[guidance on moving major action tags](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/release-and-maintain-actions).

The workflow uses the local `./badge` action to update the README badges only
on `main`. `tests` reports the `npm test` passed/total counts; `build` reports
both the rebuild and the committed bundle check; `release` reports the result of updating the major tag
and displays its name (currently `v3`). Failed operations turn their badge red.
Skipped operations leave their badge unchanged; updates are skipped after
cancellation. Each badge
shows its last attempted operation, so the three badges may reflect different
commits when a later operation is skipped.

The test counter uses the final `node:test` summary, including nested tests;
total includes skipped, TODO, and cancelled tests. Test failures still fail
the step and turn the badge red. If no summary is available, the badge falls
back to the step outcome. `.github/test-counts.mjs` runs alongside the normal
console reporter in CI; local `npm test` is unchanged.

Updates use `https://nacid.me/badge` with the repository secret `BADGES_TOKEN`.
Badge service failures produce warnings and do not block checks or publication.
The SVGs are created on the first successful badge update.

## Development

Run `npm test` to test all actions, including `files`, `version`, and `badge`.
Run `npm run check` to test the actions and rebuild the `setup-valdor` bundle.
