# nacid/actions

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

The Forgejo runner image must provide Node.js 20 for JavaScript actions.
