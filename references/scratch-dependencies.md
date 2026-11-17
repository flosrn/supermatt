# Scratch dependency preflight

Create each disposable repository copy with `node "<this file's directory>/copy-scratch-tree.mjs" "<repo>" "<scratch>"` (Bun: `bun --no-env-file`), using absolute, shell-quoted paths. The destination must not exist, its parent must exist, and it must be outside the repository.

The helper first tries a copy-on-write clone of the directory (`clonefile` through Python 3's standard-library `ctypes` on macOS, `cp --reflink=always` elsewhere), removes every `.git` entry and special or device file without following symlinks, and preserves file modes.

A failed or unavailable clone or cleanup discards the partial copy before the original rsync fallback; the command reports its method. Copies include ignored and untracked files, and writing an ordinary file in the copy leaves the repository unchanged. The following preflight still runs for either method.

Before a copied tree is edited or runs a reproduction, mutation, or hook, check its containment and prove its dependencies resolve from that tree. A worktree can inherit packages from an ancestor even when its own `node_modules` exists; copying that local directory alone loses the inherited packages.

Run `node <this file's directory>/check-scratch-containment.mjs <scratch>` with both paths shell-quoted, or use Bun with `--no-env-file`. It rejects a linked scratch root, unresolved symlinks, and links whose canonical targets escape the scratch tree, with one exception.

A link whose target does not exist fails as `dangling link (target missing in scratch): <link> -> <target>`.

That exception is a link to a system file the user cannot change: a non-directory owned by root, not writable by the current user, and outside the user's home. Directories never qualify, since a read-only directory can hold writable paths.

The check also rejects a `.git` entry at any depth that is not a directory, such as the `gitdir:` pointer file a raw copy of a linked worktree keeps, since Git commands in scratch would follow it into the real repository and commit on its branch; a `.git` directory, such as `git init` creates in the copy, passes.

In each directory holding `pyvenv.cfg`, the check rejects a `bin/` script with an absolute interpreter path outside scratch (`shebang points outside scratch`). It reads the `#!` line or the shell word after `'''exec'` on line 2 of the `/bin/sh` launcher.

A root-owned interpreter path ending at a system file covered by the exception, such as `/usr/bin/env` or `/usr/bin/python3`, passes.

The system-file exception covers a Python virtualenv whose `bin/python` links to a system interpreter such as `/usr/bin/python3.12`. Leave that link as it is and never copy the interpreter into scratch.

If the trigger needs no Python, remove the copied virtualenv directories that contain escaping links or editable-install metadata, then rerun the containment check instead of repairing or reinstalling them.

If the trigger needs Python, an interpreter the user owns or one under the home directory (pyenv, uv, or a per-user Homebrew) fails the check until the scratch Python helper copies its runtime into the virtualenv. Replacing the interpreter link with a different Python is not an environment rebuild.

Whenever the copy holds a Python virtualenv (a directory holding `pyvenv.cfg`), run `node "<this file's directory>/prepare-scratch-python.mjs" "<repo>" "<scratch>"` (Bun: `bun --no-env-file`) right after the copy and before the containment check, with the same two paths in the same order as the copy helper.

The Python helper refuses a missing, symlinked, or non-directory scratch root, a scratch root containing `.git`, and a scratch root equal to, inside, or containing the repository. It writes only inside scratch and never through a link, refusing a linked `bin` directory.

Once it finds a virtualenv, the helper refuses a repository or scratch path holding a quote, backslash, or control character, since virtualenv files store such a path escaped or cannot hold it. It also refuses a virtualenv path holding a control character.

For each virtualenv whose interpreter the user owns, the helper copies the runtime, the parent of the `bin` directory holding the interpreter's canonical path, with its symlinks and modes, to `<venv>/.scratch-python/<runtime>`. It relinks the `bin/` links that left scratch into the copy and points `pyvenv.cfg`'s `home`, `executable`, and `command` at it.

A link to a locked system interpreter stays. A virtualenv created with `--copies` keeps its interpreter.

In every virtualenv, the helper replaces the repository path, as given and canonical, with the scratch path in each text file outside the copied runtime: editable-install `.pth` lines and finder modules, `direct_url.json`, `activate` scripts, and console-script interpreters.

The repository path escaped as Python's `json.dumps` or `ascii()` writes it becomes the scratch path escaped the same way. A file URL of the repository, in Python's or uv's percent-encoding, becomes the scratch path in Python's encoding. A rewritten `#!` line longer than 127 bytes or holding a space becomes the `/bin/sh` `'''exec'` launcher that pip and uv write.

After preparing every virtualenv, the helper checks containment of the whole scratch tree before starting any Python. A failed check stops preparation without executing startup code. The helper then runs each virtualenv's `bin/python` from `/` and fails unless `sys.prefix` is that virtualenv.

The helper prints each change, then a summary; a rerun on the same scratch changes nothing, and a failure prints one `Scratch Python preparation failed: <reason>` line and exits 1.

Conda environments, which have no `pyvenv.cfg`, and Windows layouts are not handled. Two cases are unverified: a uv runtime relocated on macOS, and a pyenv build with `--enable-shared`, which may still load `libpython` from its original prefix where the containment check cannot see it.

Python editable installs can keep the original checkout in `.pth` path entries under `site-packages` or `dist-packages`, or in `direct_url.json` file URLs; the containment check rejects these escapes (while allowing the same read-only system files as interpreter links).

The containment check reads a `.pth` the way Python's site module does: a line ends wherever Python's `str.splitlines` ends one, such as at a line feed, a carriage return, or a vertical tab; blank, comment, and `import` lines are skipped. A `.pth` link to a regular file inside scratch is read through the link, and a `.pth` that is not a regular file is skipped.

A virtualenv's `lib/pythonX.Y/site-packages` (or `dist-packages`) is checked under that name, against which Python resolves relative lines, even where `lib` or a directory below it is a link inside scratch, and so is any other `site-packages` or `dist-packages` that is a link inside scratch.

A `direct_url.json` that records only an archive install (an `archive_info` object, with no `dir_info` or `vcs_info` key), such as the record of the wheel pip came from in a uv runtime, may name a URL outside scratch, since the archive's files were copied into `site-packages`; any other record, such as a directory install (`dir_info`), editable or not, may not.

For a trigger that needs Python, force a real reinstall of the editable package from inside the scratch copy, for example `uv pip install --reinstall -e .` or the repository's `uv sync --locked --reinstall-package <package>` command; plain `uv sync` can leave copied editable metadata unchanged. Rerun the containment check after the reinstall, including the interpreter check above.

Copy other required external targets into scratch and replace those links there, then rerun the check after dependency setup and before editing or execution. Do not modify the external targets. This is a preflight for a quiescent tree, not a sandbox against concurrent filesystem changes.

For Node or Bun, run `node <this file's directory>/check-scratch-dependencies.mjs <package-directory> <required-package>...`, using the imports required by the check and its preload. `<package-directory>` is the package that runs the check inside the scratch tree: the one whose `package.json` declares the test runner and the check's imports.

In a workspace, `<package-directory>` is usually a member directory such as `<scratch>/apps/x`, not the scratch root, since a workspace root often declares neither. Bun can run the same helper with `bun --no-env-file`.

The helper treats Node built-ins as resolved and lists each by name, including when the check requires only built-ins. Package entry points still resolve without execution and are reported with their canonical paths. A missing package still reports a setup failure and exits 1.

When workspace members under the given directory declare the missing package in `dependencies` or `devDependencies`, the failure also names each one, in the form ``vitest is declared by `apps/x`: rerun with `<scratch>/apps/x` ``; rerun from the member that runs the check.

Run the helper against the same package directory in the source tree to locate a missing package's actual installation, then prepare the scratch dependencies with the repository's supported setup. Keep generated caches private and preserve restrictions on environment files and credentials.

After resolution passes, run the actual runtime's preload or smallest startup check from the scratch tree. Other ecosystems use their equivalent dependency-resolution and startup checks.

A failed preflight stops the scratch run before a mutation or push; report it as a setup failure. Keep normal hooks enabled. Retain the dependency paths and successful preflight commands with the verification evidence for the next worker.
