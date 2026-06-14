# PRD: Unified Actual Budget Bank Importer

## Problem Statement

Managing two separate bank importers (comdirect and DKB) is tedious: they live in different subdirectories, use different runtimes (Node.js vs Python), have different config formats, and require different invocation commands. Adding a third bank means building a third standalone tool from scratch. There is no single entry point that simply accepts a CSV and does the right thing.

## Solution

A single Node.js CLI tool (`import.js`) in the project root that accepts any supported bank's CSV export file, automatically detects the bank from the CSV header, reads shared configuration from a single `.importer-config` file, and imports the transactions into the correct Actual Budget account via the official `@actual-app/api` package.

## User Stories

1. As a user, I want to run a single command regardless of which bank's CSV I have, so that I don't need to remember which importer to use.
2. As a user, I want the tool to detect the bank automatically from the CSV file, so that I don't have to specify `--bank dkb` or `--bank comdirect` manually.
3. As a user, I want a `--dry-run` flag that shows me what would be imported without touching Actual Budget, so that I can verify the parsed transactions before committing.
4. As a user, I want a single `.importer-config` file for all banks, so that I only have one place to update when my server URL or password changes.
5. As a user, I want the tool to tell me clearly if the config file is missing or incomplete, so that I can fix it without reading the source code.
6. As a user, I want a `--list-accounts --bank <name>` flag that connects to that bank's budget and prints all accounts with their IDs, so that I can look up the correct ID when configuring a new bank.
7. As a user, I want duplicate transactions to be skipped automatically, so that I can safely re-run the importer on the same CSV without creating duplicates.
8. As a user, I want the tool to always show me a preview table of parsed transactions before importing, so that I can confirm dates, amounts, and payees look correct regardless of whether I'm doing a dry run or a real import.
9. As a user, I want the tool to print a summary (imported / skipped) at the end, so that I know the import succeeded and how many new transactions were added.
10. As a user, I want clear error messages when the server is unreachable, so that I can diagnose connection problems without reading stack traces.
11. As a user, I want the tool to handle the German number format (`-1.630,00`) correctly for both banks, so that amounts are always imported accurately.
12. As a user, I want the tool to handle the comdirect win1252 encoding automatically, so that I don't need to convert the file before importing.
13. As a user, I want pending/open transactions in comdirect exports to be skipped with a notice, so that only booked transactions are imported.
14. As a user, I want a `.importer-config.example` file in the repo, so that I have a template when setting up the tool on a new machine.
15. As a user, I want the config file to be gitignored by default, so that my server password is never accidentally committed.
16. As a developer adding a new bank, I want to only add a single self-contained adapter object, so that I never need to touch the detection logic, import flow, or config loader to support a new bank.

## Implementation Decisions

- **Runtime**: Node.js with `@actual-app/api` (the official Actual Budget JS package). The DKB Python importer is retired; its logic is re-implemented in JavaScript.

- **Entry point**: `import.js` in the project root. Single file, no build step.

- **Bank adapter pattern**: Each bank is described by a self-contained adapter object registered in a top-level `BANKS` array. Adding a new bank means appending one object to that array — no other code changes required:

  ```js
  // Prototype from design session — decision-relevant parts only
  {
    name: 'dkb',                          // used as config key prefix
    encoding: 'utf-8',
    detect(lines) {                        // returns true if this bank owns the CSV
      return lines[4]?.includes('Buchungsdatum');
    },
    parse(content) { /* → Transaction[] */ }
  }
  ```

  The import flow iterates `BANKS` to detect the bank, reads `${adapter.name.toUpperCase()}_SYNC_ID` and `${adapter.name.toUpperCase()}_ACCOUNT_ID` from config, and calls `api.importTransactions`. None of this code changes when a new adapter is added.

- **Bank detection**: The first adapter whose `detect(lines)` returns `true` wins. Detection happens before any parsing, using the raw file content split into lines (read as latin1 so ASCII field names are safe regardless of encoding). DKB is identified by both `"Buchungsdatum"` and `"Verwendungszweck"` in line 5; comdirect by `"Buchungstag"` and `"Vorgang"` in line 5. An unrecognised CSV exits with a clear error listing supported banks.

- **CSV parsers**: Each adapter's `parse` function is a pure function returning `Transaction[]`. The comdirect adapter decodes win1252 via `iconv-lite` before parsing; the DKB adapter reads UTF-8. Both produce the same transaction shape consumed by the Actual API. The DKB date field uses a `DD.MM.YY` format (2-digit year); the parser prefixes `"20"` to produce a full `YYYY-MM-DD` date.

- **Transaction shape**: `{ date, amount, payee_name, notes, imported_id }` — the format expected by `api.importTransactions()`.

- **Amount representation**: integers in cents (1 EUR = 100), matching the Actual Budget internal format. Both parsers convert German decimal notation (`-40,25` → `-4025`).

- **Deduplication (`imported_id`)**: DKB uses the `Kundenreferenz` field when present, falling back to `${rawDate}|${rawAmount}|${payee}` (raw strings from the CSV). Comdirect uses the `Ref.` code from `Buchungstext` when present, falling back to the first 20 hex characters of an MD5 hash of `date:amount:buchungstext[:80]`. The Actual API uses `imported_id` to skip already-imported transactions.

- **Config format**: Key-value pairs in `.importer-config` (same format as a `.env` file). Parsed by a minimal built-in loader — no external dotenv dependency.

  ```
  ACTUAL_SERVER_URL=https://fractual.fly.dev

  # Authentication — set exactly one:
  ACTUAL_TOKEN=...        # API token (preferred; required for OIDC setups)
  # ACTUAL_PASSWORD=...  # Server password (non-OIDC only)

  COMDIRECT_SYNC_ID=...
  COMDIRECT_ACCOUNT_ID=...
  DKB_SYNC_ID=...
  DKB_ACCOUNT_ID=...
  ```

  `ACTUAL_URL` is accepted as an alias for `ACTUAL_SERVER_URL`.

- **Budget and account mapping**: Each bank has its own `${BANK}_SYNC_ID` and `${BANK}_ACCOUNT_ID`. This supports importing different banks into different Actual Budget budgets (different sync IDs) as well as different accounts within the same budget. The bank name (detected from the CSV) is used as a prefix to look up both values from the config. A missing `SYNC_ID` or `ACCOUNT_ID` for the detected bank is a hard config error with a clear message.

- **Import strategy**: Bulk import via a single `api.importTransactions(accountId, transactions)` call per CSV file, consistent with the `@actual-app/api` design. No per-transaction retry loop.

- **CLI flags**: `--dry-run` (preview only), `--list-accounts --bank <dkb|comdirect>` (connect to that bank's budget and print all accounts with IDs, then exit). The `--bank` flag is only required for `--list-accounts`; normal imports always use automatic detection.

- **`package.json`**: Single `package.json` in the project root with `@actual-app/api` and `iconv-lite` as dependencies.

## Testing Decisions

Good tests for this tool verify **external behavior** — what transactions come out of a given CSV input, and whether the correct account is targeted — not internal implementation details like how a regex is written or which loop is used.

**What makes a good test here:**
- Feed a real or realistic CSV fixture and assert on the normalized `Transaction[]` output.
- Test edge cases in parsing: pending rows, malformed amounts, missing dates, duplicate `imported_id` values.
- Do not mock the CSV parsers when testing detection; do not mock `api.importTransactions` when testing parsers — keep each layer's tests isolated by only mocking at the boundary with external systems (the Actual API).

**Modules to test:**

1. **Bank adapter `detect`** — unit tests per adapter with sample header strings. Inputs: valid header for that bank, header for another bank, unknown header, empty string. Expected outputs: `true`, `false`, `false`, `false`. Tests live alongside each adapter.

2. **Adapter `parse` functions** — unit tests using fixture CSV files (the existing sample CSVs in the repo are ideal prior art). Assert on: transaction count, date format (`YYYY-MM-DD`), amount as integer cents, payee extraction, `imported_id` uniqueness, skipping of pending rows (comdirect), skipping of rows with missing dates or amounts. Each adapter's tests are self-contained.

3. **`loadConfig`** — unit tests with fixture config strings. Assert on: correctly parsed values, clear errors for missing required keys.

4. **End-to-end / integration** — manual only, using `--dry-run` against a real CSV file. No automated integration tests against a live Actual instance are in scope.

**Prior art**: The existing `parseCsv` function in `comdirect_import.js` and `parse_dkb_csv` in `dkb_import.py` serve as reference implementations and sources for fixture data.

## Out of Scope

- Support for banks beyond DKB and comdirect in this iteration (though the adapter pattern makes adding them trivial).
- Automatic download of CSV exports from bank portals.
- macOS Keychain integration (the existing comdirect implementation is retired).
- OpenID Connect / browser-based authentication (the existing DKB implementation is retired).
- Per-transaction retry logic (bulk import via `@actual-app/api` is sufficient).
- A graphical or web-based UI.
- Windows or Linux support (tool is developed and used on macOS).
- Splitting one CSV across multiple Actual accounts.
- Packaging or distribution as an npm package.

## Further Notes

- The `.importer-config` file must be added to `.gitignore` at the project root. An `.importer-config.example` with placeholder values should be committed as documentation.
- The existing `comdirect-importer/` and `dkb-importer/` subdirectories can be kept as historical reference but are no longer the active importers once `import.js` is working.
- The Actual Budget server URL (`https://fractual.fly.dev`) is a fly.io-hosted instance that may cold-start — a connection timeout of at least 30 seconds is appropriate. Auth uses `ACTUAL_TOKEN` (sessionToken) when set, falling back to `ACTUAL_PASSWORD`.
- The `@actual-app/api` version currently in use is `^26.4.0` (from `comdirect-importer/package.json`).
