# Docker action

Builds one Docker image for `linux/amd64` and `linux/arm64`, pushes it to a
registry, and assigns every collected tag to the same multi-platform manifest.

The action always adds the normalized branch tag. It also adds the optional
`version` tag and every tag supplied through `tags`. Duplicate tags are removed
before the build.

For branch `Feature/Voice API`, version `1.4.7`, and additional tags `latest`
and `sha-0123456`, the action publishes:

```text
registry.example.test/team/token-service:feature-voice-api
registry.example.test/team/token-service:1.4.7
registry.example.test/team/token-service:latest
registry.example.test/team/token-service:sha-0123456
```

All references point to the digest returned through the `digest` output.

## Usage

GitHub Actions:

```yaml
- name: Build and publish Docker image
  id: docker
  uses: nacid/actions/docker@v1
  with:
    registry: ${{ vars.REGISTRY }}
    registry-image: ${{ vars.REGISTRY_IMAGE }}
    registry-user: ${{ secrets.REGISTRY_USER }}
    registry-password: ${{ secrets.REGISTRY_PASS }}
    version: 1.4.7
```

Forgejo Actions should use the fully qualified action URL unless its
`DEFAULT_ACTIONS_URL` points to GitHub:

```yaml
- name: Build and publish Docker image
  id: docker
  uses: https://github.com/nacid/actions/docker@v1
  with:
    registry: ${{ vars.REGISTRY }}
    registry-image: ${{ vars.REGISTRY_IMAGE }}
    registry-user: ${{ secrets.REGISTRY_USER }}
    registry-password: ${{ secrets.REGISTRY_PASS }}
    version: 1.4.7
```

Relative `context` and `dockerfile` paths are resolved from
`working-directory`. The working directory itself is resolved from
`GITHUB_WORKSPACE`:

```yaml
- uses: nacid/actions/docker@v1
  with:
    working-directory: Project
    context: .
    dockerfile: Dockerfile
    registry: ${{ vars.REGISTRY }}
    registry-image: ${{ vars.REGISTRY_IMAGE }}
    registry-user: ${{ secrets.REGISTRY_USER }}
    registry-password: ${{ secrets.REGISTRY_PASS }}
    version: 1.4.7
```

## Docker metadata integration

Additional tags contain tag names only, without the registry or image
repository. This matches the `tag-names` output of
`docker/metadata-action`.

```yaml
- name: Prepare image metadata
  id: meta
  uses: docker/metadata-action@v6
  with:
    images: ${{ vars.REGISTRY }}/${{ vars.REGISTRY_IMAGE }}
    tags: |
      type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}
      type=sha,prefix=sha-

- name: Build and publish Docker image
  id: docker
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

On `main`, this example publishes `main`, `latest`, and `sha-<short-sha>`.
The labels, base-image refresh, and GitHub Actions cache configuration are
passed directly to Buildx.

## Inputs

- `working-directory`: command working directory, relative to
  `GITHUB_WORKSPACE` or absolute. Defaults to `.`.
- `registry` (required): registry host, optionally including a port. It must
  not contain a URL scheme or repository path.
- `registry-image` (required): lowercase repository path without a tag or
  digest.
- `registry-user` (required): registry user name.
- `registry-password` (required): registry password or access token. It is
  masked and passed to `docker login` through standard input.
- `version`: optional Docker tag also passed to the Dockerfile as
  `APP_VERSION`.
- `tags`: optional additional Docker tag names, one per line. Full image
  references are rejected.
- `labels`: optional image labels, one `key=value` pair per line.
- `pull`: set to `true` to always attempt to pull newer base images. Defaults
  to `false`.
- `cache-from`: optional Buildx cache sources, one cache specification per
  line.
- `cache-to`: optional Buildx cache destinations, one cache specification per
  line.
- `context`: Docker build context relative to `working-directory`, or
  absolute. Defaults to `.`.
- `dockerfile`: Dockerfile path relative to `working-directory`, or absolute.
  Defaults to `Dockerfile`.
- `qemu-setup`: `auto` to configure missing emulators, or `never` to require
  preconfigured platform support. Defaults to `auto`.
- `qemu-image`: binfmt image used by automatic QEMU setup. Defaults to the
  versioned `docker.io/tonistiigi/binfmt:qemu-v10.2.3-68` image.

At least the branch tag is always published, so both `version` and `tags` may
be omitted.

## Build arguments

The action always passes:

- `APP_BRANCH`: the original, non-normalized branch name.
- `APP_COMMIT`: the first 12 hexadecimal characters of the current commit.

When `version` is set, it also passes:

- `APP_VERSION`: the supplied version.

The branch comes from `GITHUB_REF_NAME`, with `GITHUB_REF` and the checked-out
Git branch used as fallbacks. The commit comes from `GITHUB_SHA`, with checked
out `HEAD` used as a fallback.

## Outputs

- `image`: registry and repository without a tag.
- `tags`: complete newline-separated image references published by the action.
- `branch-tag`: complete image reference with the normalized branch tag.
- `version-tag`: complete image reference with the version tag when `version`
  is set.
- `commit`: the 12-character commit passed to the Dockerfile.
- `digest`: SHA-256 digest of the published multi-platform manifest.

## Runner requirements

The action uses the Node.js 24 action runtime and expects a Linux runner with:

- Docker CLI and access to a running Docker daemon;
- Docker Buildx available as a system CLI plugin;
- permission to start privileged containers when automatic QEMU setup is
  needed.

The action creates a temporary Buildx builder with the `docker-container`
driver. With `qemu-setup: auto`, it leaves an already capable daemon unchanged.
When a platform is missing, it removes the first builder, registers only the
missing emulator, recreates the builder, and verifies the platforms again.

Set `qemu-setup: never` when the daemon must not be changed. Missing platform
support then produces an error before registry login or image build.

## Credentials and cleanup

The action uses an isolated temporary `DOCKER_CONFIG`, so it does not modify
the runner user's persistent Docker credentials. It removes its Buildx builder,
logs out of the registry, and deletes temporary files after both successful and
failed builds.
