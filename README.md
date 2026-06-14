# actual-bank-importer

Importiert Kontoauszüge (CSV) von deutschen Banken in [Actual Budget](https://actualbudget.org).

Die Bank wird automatisch anhand des CSV-Headers erkannt. Neue Banken können durch Hinzufügen eines Adapter-Objekts in `import.js` ergänzt werden.

**Unterstützte Banken:** DKB, comdirect

## Voraussetzungen

- Node.js 18+
- Laufende Actual Budget Instanz

## Installation

```bash
npm install
cp .importer-config.example .importer-config
```

`.importer-config` ausfüllen (siehe [Konfiguration](#konfiguration)).

## Verwendung

```bash
# Import (Bank wird automatisch erkannt)
node import.js Umsatzliste.csv

# Vorschau ohne Import
node import.js Umsatzliste.csv --dry-run

# Account-IDs nachschlagen
node import.js --list-accounts --bank dkb
node import.js --list-accounts --bank comdirect
```

## Konfiguration

`.importer-config` ist eine einfache Key=Value-Datei (kein JSON, kein YAML) und wird nie committed.

```ini
ACTUAL_SERVER_URL=https://your-actual-server.example.com

# Authentifizierung — genau eine Option setzen:
ACTUAL_TOKEN=...          # API-Token (für OIDC-Setups erforderlich)
# ACTUAL_PASSWORD=...     # Server-Passwort (nur ohne OIDC)

# DKB
DKB_SYNC_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
DKB_ACCOUNT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# comdirect
COMDIRECT_SYNC_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
COMDIRECT_ACCOUNT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**API-Token** (für OIDC-Setups): Actual Budget → Settings → Show advanced settings → API Token

**Sync-ID**: Actual Budget → Settings → Show advanced settings → Sync ID

**Account-IDs**: Mit `--list-accounts` nachschlagen (siehe oben).

Jede Bank kann in ein anderes Budget (unterschiedliche `SYNC_ID`) und ein anderes Konto (`ACCOUNT_ID`) importieren.

## Neue Bank hinzufügen

Ein Adapter-Objekt ans `BANKS`-Array in `import.js` anhängen:

```js
{
  name: 'sparkasse',     // Prefix für Config-Keys: SPARKASSE_SYNC_ID, SPARKASSE_ACCOUNT_ID
  encoding: 'utf-8',     // oder 'win1252'
  detect(lines) {
    return lines[4]?.includes('Auftragskonto');
  },
  parse(content) {
    // CSV parsen, Array von Transaktionen zurückgeben:
    // [{ date, amount, payee_name, notes, imported_id }, ...]
    // date: 'YYYY-MM-DD', amount: Cent als Integer (1 EUR = 100)
  },
}
```

Kein weiterer Code muss geändert werden.
