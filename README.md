# nacid/actions

Reusable actions for GitHub Actions and Forgejo Actions. Use `@v3` for the
latest checked revision of major version 3, or pin a commit SHA for an exact
revision. On Forgejo, use a fully qualified GitHub URL such as
`https://github.com/nacid/actions/files@v3`.

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
`setup-valdor`, and Node.js 24 for `docker`.

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

## Development

Run `npm test` to test all actions, including `files` and `version`.
Run `npm run check` to test the actions and rebuild the `setup-valdor` bundle.
