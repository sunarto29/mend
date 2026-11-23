# mend

One patch tool for every AI edit format.

`mend` is a command-line tool that applies AI-written edits to a tree of text
files. Models write edits in four formats, and `mend` reads all four to one
specification (`SPEC.md` in the make.fun kit for the bounty it was built for):

- unified diffs (often with wrong line numbers),
- `SEARCH/REPLACE` blocks,
- V4A patches,
- text-editor tool calls as JSON.

It finds the lines an edit names at the first of three matching tiers (exact,
trailing whitespace ignored, leading and trailing whitespace ignored), and it
changes every file or none: a failed edit changes nothing, the edits after it
still run, and when any edit failed no file is written.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is
  relative to it.
- `PATCH` is the patch file, or `-` / absent to read the patch from stdin.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`/`D`/`M`, or `R old -> new` for a
move) and `ok: <n> files`. Exit 1 lists each failed edit and
`failed: <k> of <n> edits`. Exit 2 reports `error: usage`, `error: no-patch`,
`error: format` or `error: parse <N>`.

## Requirements

Node 22 and its standard library only; nothing is installed before the
program runs. `runner.ts` is the kit's trial runner, kept as it is.

## License

MIT.
