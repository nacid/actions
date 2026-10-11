# Find files

Find files matching a glob pattern and expose their names as action outputs.
Runs on Node.js 20 without dependencies or a shell, on GitHub Actions and Forgejo Actions.

```yaml
- id: apk
  uses: nacid/actions/files@v3
  with:
    pattern: 'dist/*.apk'

- run: echo "$APK_NAME"
  env:
    APK_NAME: ${{ steps.apk.outputs.first }}
```

On Forgejo, use `https://github.com/nacid/actions/files@v3`. The major tag
tracks checked commits; pin a commit SHA when an exact revision is required.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `pattern` | Yes | | One file mask, relative to `working-directory` or absolute. |
| `minimum` | No | `1` | Minimum required file count, a non-negative integer. Use `0` to allow no matches. |
| `working-directory` | No | `.` | Directory relative to `GITHUB_WORKSPACE`, or an absolute directory. |

Supported wildcards: `*` matches any characters within a path segment, `?` matches
one character, and a complete `**` segment matches zero or more directory levels.
Use `dist/**/*.apk` to include subdirectories. Forward and backward slashes are
accepted as path separators. Other glob syntax (such as braces, character classes,
or exclusions) is not supported. Matching is case-sensitive and includes hidden
files. Recursive searches do not follow directory symlinks; file symlinks are included.

## Outputs

Matches are sorted lexicographically by full path before stripping directories.
Only files are included. Identical names from different directories remain separate
entries. `first` and `last` refer to this order, not modification time.

| Output | Example | Description |
| --- | --- | --- |
| `first` | `asd.apk` | First file name without directories. |
| `last` | `xyz.apk` | Last file name without directories. |
| `all` | `asd.apk,xyz.apk` | All file names without directories, joined with commas and no spaces. |
| `count` | `2` | Number of matching files. |

When fewer than `minimum` files match, the action fails before writing outputs,
with a message such as `Found 0 files matching 'dist/*.apk', but minimum is 1`.
With `minimum: 0`, when nothing matches (including a missing directory in the mask),
`first`, `last`, and `all` are empty and `count` is `0`.
A missing or empty `pattern`, invalid `minimum`, inaccessible
search directory, or filesystem permission error fails the action.
Commas in file names are preserved without escaping in `all`.
