# Local verification and release checks

Use fictional students and isolated browser contexts. Do not use a live PDF service for regression tests.

## Browser and PDF prerequisites

Install the locked Node dependencies and browser:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chrome
```

The PDF parity journey renders locally with Chromium and extracts text with Poppler's `pdftotext`. Install Poppler using your existing package manager:

- macOS with Homebrew: `brew install poppler`
- Debian/Ubuntu: `sudo apt-get install poppler-utils`
- Conda/Micromamba: create an isolated environment with `micromamba create -p "$HOME/.cache/econplanner-testing/poppler" -c conda-forge poppler`.

Verify `pdftotext -v`. If it is outside PATH, set `PDFTOTEXT` to the absolute executable path, for example:

```sh
export PDFTOTEXT="$HOME/.cache/econplanner-testing/poppler/bin/pdftotext"
"$PDFTOTEXT" -v
pnpm exec playwright test tests/e2e/architecture-repairs.spec.js
```

The PDF journey checks this prerequisite before starting. A missing executable is a failed prerequisite, never a passing or silently skipped PDF check. CI installs `poppler-utils` before its browser suite.

## Regression campaign

```sh
pnpm test
pnpm exec playwright test
pnpm exec playwright test tests/e2e/econ-planner-accessibility.spec.js --repeat-each 5
node --test tests/economics-move-matrix.test.js
ECONOMICS_MOVE_MATRIX_MODE=full node --test tests/economics-move-matrix.test.js
pnpm run lint
pnpm run build
pnpm run verify:pdf:economics -- --dry-run
```

The matrix reports generated and uncovered cells; record both. The full mode includes extended plans and 50 stateful runs using seed 20260923. Browser assertions wait for observable state within bounded timeouts; do not replace failures with arbitrary sleeps or weaken the required appearance.

## After an authorized merge

1. Confirm the merged revision and synchronize local main without discarding work.
2. Check that Vercel created a production deployment for that exact revision.
3. Wait for Ready and verify that the production domain points to it. A green preview deployment is insufficient.
4. Run fictional production smoke/regression journeys, including accepted/rejected moves, reload and report JSON/HTML agreement. Preserve existing user browser storage by using isolated contexts.
5. Report deployment identity, completed coverage, failures and limitations. If no automatic deployment appears, report it explicitly; do not declare the release complete. Trigger a manual production deployment only with authorization.

Preserve 30-day PDF retention and disabled HTML storage. A local PDF dry run does not prove hosted PDF delivery or retention expiry.
