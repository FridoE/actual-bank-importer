#!/usr/bin/env node
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const iconv  = require('iconv-lite');
const api    = require('@actual-app/api');

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, '.importer-config');

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`Error: Config file not found: ${CONFIG_FILE}`);
    console.error(`  Copy .importer-config.example to .importer-config and fill in your values.`);
    process.exit(1);
  }
  const config = {};
  for (const line of fs.readFileSync(CONFIG_FILE, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const eq = t.indexOf('=');
    config[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return config;
}

function requireConfig(config, keys) {
  const missing = keys.filter(k => !config[k]);
  if (!missing.length) return;
  console.error('Configuration error — missing keys in .importer-config:');
  for (const k of missing) console.error(`  • ${k}`);
  process.exit(1);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function parseAmountCents(raw) {
  // German decimal notation: "-1.630,00" → -163000
  const s = raw.trim().replace(/ | /g, '').replace(/\./g, '').replace(',', '.');
  return Math.round(parseFloat(s) * 100);
}

// ── Bank adapters ─────────────────────────────────────────────────────────────
//
// To add a new bank: append one object to this array. No other code changes needed.
//   name      – used as config key prefix (e.g. "dkb" → DKB_SYNC_ID, DKB_ACCOUNT_ID)
//   encoding  – iconv-lite encoding to decode the raw CSV buffer
//   detect(lines) → bool  – return true if the first lines match this bank's format
//   parse(content) → Transaction[]  – parse decoded CSV string into transactions

const BANKS = [
  // ── DKB ────────────────────────────────────────────────────────────────────
  {
    name: 'dkb',
    encoding: 'utf-8',

    detect(lines) {
      const h = lines[4] ?? '';
      return h.includes('Buchungsdatum') && h.includes('Verwendungszweck');
    },

    parse(content) {
      const lines = content.split(/\r?\n/);
      if (lines.length < 5) {
        console.error('ERROR: Too few rows — is this a valid DKB export?');
        process.exit(1);
      }

      const header = lines[4].split(';').map(c => c.trim().replace(/^"|"$/g, ''));
      const col = Object.fromEntries(header.map((h, i) => [h, i]));

      function get(row, name) {
        const i = col[name];
        return (i !== undefined && i < row.length) ? row[i].trim().replace(/^"|"$/g, '') : '';
      }

      const transactions = [];

      for (let i = 5; i < lines.length; i++) {
        const row = lines[i].split(';');
        if (!row.some(c => c.trim())) continue;

        const datumStr = get(row, 'Buchungsdatum');
        if (!datumStr) continue;

        // "17.04.26" → "2026-04-17"
        const [d, m, y] = datumStr.split('.');
        if (!d || !m || !y) continue;
        const date = `${y.length === 2 ? '20' + y : y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

        const betragStr = get(row, 'Betrag (€)');
        if (!betragStr) continue;
        const amount = parseAmountCents(betragStr);
        if (isNaN(amount)) continue;

        const payee      = get(row, 'Zahlungsempfänger*in') || get(row, 'Zahlungspflichtige*r');
        const notes      = get(row, 'Verwendungszweck');
        const customerRef = get(row, 'Kundenreferenz');
        const imported_id = customerRef || `${datumStr}|${betragStr}|${payee}`;

        transactions.push({ date, amount, payee_name: payee, notes, imported_id });
      }
      return transactions;
    },
  },

  // ── comdirect ──────────────────────────────────────────────────────────────
  {
    name: 'comdirect',
    encoding: 'win1252',

    detect(lines) {
      const h = lines[4] ?? '';
      return h.includes('Buchungstag') && h.includes('Vorgang');
    },

    parse(content) {
      const transactions = [];
      let inData = false;

      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const row   = line.split(';').map(f => f.trim().replace(/^"|"$/g, ''));
        const first = row[0];

        if (first === 'Buchungstag') { inData = true; continue; }
        if (!inData) continue;
        if (first === 'Alter Kontostand' || first === 'Neuer Kontostand') break;
        if (row.length < 5) continue;

        const buchungstag  = row[0];
        const vorgang      = row[2];
        const buchungstext = row[3];
        const umsatzRaw    = row[4];

        if (buchungstag === 'offen') {
          console.log(`  [skipped – pending] ${buchungstext.slice(0, 60)}`);
          continue;
        }

        const [d, m, y] = buchungstag.split('.');
        if (!d || !m || !y) continue;
        const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

        const amount = parseAmountCents(umsatzRaw);
        if (isNaN(amount)) { console.log(`  [skipped – invalid amount] ${umsatzRaw}`); continue; }

        // Extract payee from Buchungstext
        let payee;
        const senderMatch = buchungstext.match(
          /(?:Auftraggeber|Empf[äÄ]nger):\s*(.+?)(?:\s{2,}|Kto\/IBAN|BLZ\/BIC|Buchungstext|$)/i
        );
        if (senderMatch) {
          payee = senderMatch[1].trim();
        } else {
          const textMatch = buchungstext.match(/Buchungstext:\s*([^,/\n]+)/i);
          payee = textMatch ? textMatch[1].trim() : vorgang.trim();
        }

        const notesMatch  = buchungstext.match(/Buchungstext:\s*(.+)/i);
        const notes       = (notesMatch ? notesMatch[1].trim() : buchungstext).slice(0, 500) || undefined;

        const refMatch    = buchungstext.match(/Ref\.\s+([A-Z0-9/]+)/);
        const imported_id = refMatch
          ? refMatch[1]
          : crypto.createHash('md5').update(`${date}:${amount}:${buchungstext.slice(0, 80)}`).digest('hex').slice(0, 20);

        transactions.push({ date, amount, payee_name: payee.slice(0, 255), notes, imported_id });
      }
      return transactions;
    },
  },
];

// ── Detection ─────────────────────────────────────────────────────────────────

function detectAdapter(rawBuffer) {
  // Read header lines as latin1 — safe for ASCII-only field names in both encodings
  const lines = rawBuffer.slice(0, 2048).toString('latin1').split(/\r?\n/);
  for (const adapter of BANKS) {
    if (adapter.detect(lines)) return adapter;
  }
  console.error('Error: Could not detect bank from CSV header.');
  console.error(`  Supported banks: ${BANKS.map(b => b.name).join(', ')}`);
  console.error('  Make sure this is an unmodified CSV export from one of these banks.');
  process.exit(1);
}

// ── Actual API ────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '.actual-data');

function serverURL(config) {
  return config.ACTUAL_SERVER_URL || config.ACTUAL_URL;
}

async function connectActual(config) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  await api.init({ dataDir: DATA_DIR, serverURL: serverURL(config), password: config.ACTUAL_PASSWORD });
}

async function cmdListAccounts(bankName, config) {
  const syncId = config[`${bankName.toUpperCase()}_SYNC_ID`];
  if (!syncId) {
    console.error(`Error: ${bankName.toUpperCase()}_SYNC_ID not set in .importer-config`);
    process.exit(1);
  }
  if (!serverURL(config)) { console.error('Configuration error — set ACTUAL_SERVER_URL in .importer-config'); process.exit(1); }
  if (!config.ACTUAL_PASSWORD) {
    console.error('Configuration error — set ACTUAL_PASSWORD in .importer-config');
    process.exit(1);
  }

  console.log(`Connecting to ${serverURL(config)} …`);
  await connectActual(config);
  await api.downloadBudget(syncId);

  const accounts = await api.getAccounts();
  if (!accounts.length) {
    console.log('No accounts found.');
  } else {
    console.log(`\n${'ID'.padEnd(38)}  Name`);
    console.log('-'.repeat(60));
    for (const acc of accounts) console.log(`${String(acc.id).padEnd(38)}  ${acc.name}`);
  }

  await api.shutdown();
}

async function cmdImport(csvFile, dryRun, config) {
  const rawBuffer = fs.readFileSync(csvFile);
  const adapter   = detectAdapter(rawBuffer);
  const content   = iconv.decode(rawBuffer, adapter.encoding);
  const bankKey   = adapter.name.toUpperCase();

  console.log(`\nDetected bank : ${adapter.name}`);
  console.log(`File          : ${csvFile}`);

  const transactions = adapter.parse(content);

  console.log(`Transactions  : ${transactions.length} found\n`);
  if (!transactions.length) { console.log('Nothing to import.'); return; }

  console.log(`${'Date'.padEnd(12)} ${'Amount'.padStart(12)}  Payee`);
  console.log('─'.repeat(70));
  for (const t of transactions) {
    const eur = (t.amount / 100).toFixed(2).padStart(12);
    console.log(`${t.date.padEnd(12)} ${eur}  ${(t.payee_name || '–').slice(0, 42)}`);
  }
  console.log();

  if (dryRun) { console.log('Dry run — no data written.'); return; }

  requireConfig(config, [`${bankKey}_SYNC_ID`, `${bankKey}_ACCOUNT_ID`]);
  if (!serverURL(config)) { console.error('Configuration error — set ACTUAL_SERVER_URL in .importer-config'); process.exit(1); }
  if (!config.ACTUAL_PASSWORD) {
    console.error('Configuration error — set ACTUAL_PASSWORD in .importer-config');
    process.exit(1);
  }

  const syncId    = config[`${bankKey}_SYNC_ID`];
  const accountId = config[`${bankKey}_ACCOUNT_ID`];

  console.log(`Connecting to ${serverURL(config)} …`);
  await connectActual(config);

  console.log(`Loading budget ${syncId} …`);
  await api.downloadBudget(syncId);

  console.log(`Importing into account ${accountId} …`);
  const result = await api.importTransactions(accountId, transactions);
  await api.shutdown();

  const added   = (result.added   || []).length;
  const updated = (result.updated || []).length;
  console.log(`\nDone!  Added: ${added},  Skipped/updated: ${updated}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Actual Budget CSV Importer

Usage:
  node import.js <file.csv>                        Import (bank auto-detected)
  node import.js <file.csv> --dry-run              Preview without importing
  node import.js --list-accounts --bank <name>     List accounts in that bank's budget

Supported banks: ${BANKS.map(b => b.name).join(', ')}
    `.trim());
    return;
  }

  if (args.length === 0) {
    console.error('Usage: node import.js <file.csv> [--dry-run]');
    console.error('       node import.js --help');
    process.exit(1);
  }

  const config = loadConfig();

  if (args.includes('--list-accounts')) {
    const bankIdx = args.indexOf('--bank');
    if (bankIdx === -1 || !args[bankIdx + 1]) {
      console.error('Error: --list-accounts requires --bank <name>');
      console.error(`  Supported: ${BANKS.map(b => b.name).join(', ')}`);
      process.exit(1);
    }
    const bankName = args[bankIdx + 1].toLowerCase();
    if (!BANKS.find(b => b.name === bankName)) {
      console.error(`Error: Unknown bank "${bankName}". Supported: ${BANKS.map(b => b.name).join(', ')}`);
      process.exit(1);
    }
    await cmdListAccounts(bankName, config);
    return;
  }

  const csvFile = args.find(a => !a.startsWith('--'));
  if (!csvFile) {
    console.error('Error: No CSV file specified. Run with --help for usage.');
    process.exit(1);
  }
  if (!fs.existsSync(csvFile)) {
    console.error(`Error: File not found: ${csvFile}`);
    process.exit(1);
  }

  await cmdImport(csvFile, args.includes('--dry-run'), config);
}

main().catch(err => {
  console.error('\nError:', err.message || err);
  process.exit(1);
});
