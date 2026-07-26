# nacid/actions

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
  uses: nacid/actions/docker@v1
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
  - uses: actions/checkout@v4

  - uses: nacid/actions/setup-valdor@v1
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
      - uses: actions/checkout@v4

      # A fully qualified URL avoids Forgejo's DEFAULT_ACTIONS_URL prefix.
      - uses: https://github.com/nacid/actions/setup-valdor@v1
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

Keys are normalized to upper snake case (`TOOL_PATH`, `EXTRAS_CACHE`) and
exported for subsequent workflow steps. `{{root}}` is replaced with the
workspace path and `{{extras}}` with its `extras` subdirectory. A resolved value
is registered as a secret only when its `secret` flag is `true`.

The Forgejo runner image must provide Node.js 20 for JavaScript actions.
