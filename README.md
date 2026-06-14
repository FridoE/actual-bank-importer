# actual-bank-importer

Imports bank statement CSV exports into [Actual Budget](https://actualbudget.org).

The bank is detected automatically from the CSV header. Adding support for a new bank requires only a single adapter object in `import.js`.

**Supported banks:** DKB, comdirect

## Requirements

- Node.js 18+
- A running Actual Budget instance

## Setup

```bash
npm install
cp .importer-config.example .importer-config
```

Fill in `.importer-config` (see [Configuration](#configuration)).

## Usage

```bash
# Import transactions (bank is auto-detected)
node import.js Umsatzliste.csv

# Preview without importing
node import.js Umsatzliste.csv --dry-run

# Look up account IDs
node import.js --list-accounts --bank dkb
node import.js --list-accounts --bank comdirect
```

## Configuration

`.importer-config` is a simple key=value file (no JSON, no YAML) and is never committed.

```ini
ACTUAL_SERVER_URL=https://your-actual-server.example.com

ACTUAL_PASSWORD=your-password-here

# DKB
DKB_SYNC_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
DKB_ACCOUNT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# comdirect
COMDIRECT_SYNC_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
COMDIRECT_ACCOUNT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**Sync ID**: Actual Budget → Settings → Show advanced settings → Sync ID

**Account IDs**: Use `--list-accounts` to look them up (see above).

Each bank can import into a different budget (different `SYNC_ID`) and a different account (`ACCOUNT_ID`).

## Adding a new bank

Append one adapter object to the `BANKS` array in `import.js`:

```js
{
  name: 'sparkasse',     // config key prefix: SPARKASSE_SYNC_ID, SPARKASSE_ACCOUNT_ID
  encoding: 'utf-8',     // or 'win1252'
  detect(lines) {
    return lines[4]?.includes('Auftragskonto');
  },
  parse(content) {
    // Parse CSV and return an array of transactions:
    // [{ date, amount, payee_name, notes, imported_id }, ...]
    // date: 'YYYY-MM-DD', amount: integer cents (1 EUR = 100)
  },
}
```

No other code changes required.
