# Update badge

Sends a JSON POST to the persistent [badges service](https://git.nacid.me/nacid/badges).
Use `https://github.com/nacid/actions/badge@v3` on Forgejo or
`nacid/actions/badge@v3` on GitHub after this action is published.
The runner must provide Node.js 24; there are no runtime package dependencies.

## Usage

Update through the internal Astra proxy from an allowed LAN/VPN network:

```yaml
- name: Update Docker badge
  uses: https://github.com/nacid/actions/badge@v3
  with:
    endpoint: https://astra.nacid.me/badge
    path: my-project/docker.svg
    type: docker
    passed: true
    message: ${{ steps.version.outputs.version }}
```

The public service is the default endpoint; provide a bearer token from CI secrets:

```yaml
- name: Update tests badge
  uses: nacid/actions/badge@v3
  with:
    token: ${{ secrets.BADGES_TOKEN }}
    path: my-project/tests.svg
    type: tests
    passed: true
    message: passed
```

Custom badge:

```yaml
- uses: https://github.com/nacid/actions/badge@v3
  with:
    token: ${{ secrets.BADGES_TOKEN }}
    path: my-project/coverage.svg
    type: custom
    passed: true
    label: coverage
    color: '#007ec6'
    message: '95%'
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `endpoint` | No | `https://nacid.me/badge` | Base HTTP(S) URL, without credentials, query, or fragment. A trailing slash is optional. |
| `path` | Yes | | Relative badge path, e.g. `my-project/build.svg`. No leading/trailing slash or empty/dot segments. |
| `token` | No | | Optional bearer token. Omitted from the request when empty; registered as a masked secret when supplied. |
| `type` | No | `custom` | One of the types below, case-sensitive. |
| `color` | No | `#28a745` | Message background color for `custom` badges only. |
| `label` | No | `build` | Label for `custom` badges only. |
| `message` | Yes | | Non-empty message; numbers/versions should be supplied as strings. |
| `passed` | Yes | | Boolean `true`/`false`. `true` keeps the normal color; `false` overrides it with red `#e05d44`. |

| Type | Label | Message background |
| --- | --- | --- |
| `tests` | `tests` | Burgundy `#800020` |
| `npm` | `npm` | Blue `#007ec6` |
| `docker` | `docker` | Light green `#97ca00` |
| `dev` | `dev` | Green `#28a745` |
| `alpha` | `alpha` | Green `#28a745` |
| `beta` | `beta` | Green `#28a745` |
| `release` | `release` | Green `#28a745` |
| `custom` | From `label` | From `color` |

Preset labels/colors are fixed; `label` and `color` are ignored for presets.
With `passed: false`, red overrides every preset and custom color; the label and
message remain unchanged. This input has no default: missing or invalid values
fail the action before any HTTP request. String values `true`/`false` from runner
inputs are parsed explicitly (case-insensitive); `0`, `1`, `yes`, and `no` are rejected.
The label background retains the service's standard gray color.
Input boundary whitespace is trimmed, following the other actions in this repository.
Path segments are URL-encoded; provide an unencoded path (Unicode is supported).
The service limit is 1024 UTF-8 bytes for the path including its leading slash
and 16 KiB for the serialized JSON body.

The action waits up to 30 seconds, rejects redirects, and fails the step on
network/TLS errors or non-2xx HTTP status. It does not print response bodies,
badge messages, or the token, and does not retry writes automatically.
Invoke after the corresponding tests or artifact publication; concurrent updates
follow the service's last-successful-write policy.

Read the resulting SVG using its public URL, for example:

```markdown
![docker](https://nacid.me/badge/my-project/docker.svg)
```

To report a failed test step as well as a successful one:

```yaml
- name: Run tests
  id: tests
  run: npm test

- name: Update tests badge
  if: ${{ !cancelled() }}
  uses: https://github.com/nacid/actions/badge@v3
  with:
    token: ${{ secrets.BADGES_TOKEN }}
    path: my-project/tests.svg
    type: tests
    passed: ${{ steps.tests.outcome == 'success' }}
    message: ${{ steps.tests.outcome }}
```
