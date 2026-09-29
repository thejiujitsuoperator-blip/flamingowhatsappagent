#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { loadGymConfig } from './config.js';
import { createPool, prepareSchema } from './db.js';
import { GeminiLeadExtractor, KeywordLeadExtractor, type LeadExtractor } from './extractor.js';
import { runImport } from './importer.js';
import { readExports, type DateOrder } from './sources/exportParser.js';
import { readWhatsAppHistory } from './sources/whatsappHistory.js';
import type { HistoryChat, SkippedSource } from './types.js';
import { isIsoDate, normalizePhone, setDefaultCountryCode, zonedToUtc } from './util.js';

const HELP = `One-time WhatsApp history importer. Saves and qualifies leads. Never sends any message.

Usage:
  npm run import -- --source export --path ./exports [options]
  npm run import -- --source whatsapp [options]

Sources:
  --source export      Read WhatsApp "Export chat" .txt files (a file or a folder, searched recursively)
  --source whatsapp    Link as a temporary device (scan QR) and read WhatsApp's history sync

Options:
  --path <file|dir>        Export file/folder (export source)
  --gym-names <a,b>        Sender names used by the gym account in exports (e.g. "Flamingo Fitness")
  --contacts <file.csv>    name,phone CSV for customers saved by name in exports
  --date-order <auto|DMY|MDY>  Date format in exports (default auto)
  --since <YYYY-MM-DD>     Only import messages from this date
  --max-chats <n>          Process at most n chats (useful for a trial run)
  --concurrency <n>        Parallel Gemini calls (default 3)
  --dry-run                Analyse and report only; write nothing to the database
  --no-llm                 Skip Gemini: keyword filter only, leads stay NEW
  --force                  Allow running again after a completed import of the same source
  --auth-dir <dir>         Session folder for the temporary device (default auth_state_import)
  --idle-seconds <n>       whatsapp source: finish after n seconds without new history (default 90)
  --max-minutes <n>        whatsapp source: hard limit for the sync (default 20)
  --keep-linked            whatsapp source: don't unlink the temporary device afterwards
  --report <file>          Report path (default import-report-<timestamp>.json)
`;

function readContactsCsv(path: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!path) return map;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const [name, phone] = line.split(',').map((s) => s?.trim().replace(/^"|"$/g, ''));
    const normalized = normalizePhone(phone);
    if (name && normalized) map.set(name.toLowerCase(), normalized);
  }
  return map;
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      path: { type: 'string' },
      'gym-names': { type: 'string' },
      contacts: { type: 'string' },
      'date-order': { type: 'string', default: 'auto' },
      since: { type: 'string' },
      'max-chats': { type: 'string' },
      concurrency: { type: 'string', default: '3' },
      'dry-run': { type: 'boolean', default: false },
      'no-llm': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'auth-dir': { type: 'string', default: 'auth_state_import' },
      'idle-seconds': { type: 'string', default: '90' },
      'max-minutes': { type: 'string', default: '20' },
      'keep-linked': { type: 'boolean', default: false },
      report: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.source) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  const source = values.source;
  if (source !== 'export' && source !== 'whatsapp') throw new Error('--source must be "export" or "whatsapp"');
  if (source === 'export' && !values.path) throw new Error('--path is required for --source export');
  if (values.since && !isIsoDate(values.since)) throw new Error('--since must be YYYY-MM-DD');
  const dateOrder = values['date-order']!.toUpperCase().replace('AUTO', 'auto') as DateOrder;
  if (!['auto', 'DMY', 'MDY'].includes(dateOrder)) throw new Error('--date-order must be auto, DMY or MDY');

  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: undefined });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!values['no-llm'] && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required (or pass --no-llm)');
  if (process.env.DEFAULT_COUNTRY_CODE) setDefaultCountryCode(process.env.DEFAULT_COUNTRY_CODE);

  const config = loadGymConfig(process.env.GYM_CONFIG_PATH ?? '../config/gym.json');
  const adminPhones = (process.env.ADMIN_PHONES ?? '').split(',').map((p) => normalizePhone(p)).filter((p): p is string => !!p);
  const pool = createPool(process.env.DATABASE_URL, ['true', '1'].includes(process.env.DATABASE_SSL ?? ''));

  let runId: number | null = null;
  try {
    await prepareSchema(pool);
    const dryRun = values['dry-run']!;

    // One-time guard: a completed import of the same source blocks re-runs unless --force.
    const previous = await pool.query<{ id: number; finished_at: Date }>(
      `SELECT id, finished_at FROM history_import_runs WHERE source = $1 AND status = 'COMPLETED' ORDER BY id DESC LIMIT 1`,
      [source],
    );
    if (previous.rows[0] && !values.force && !dryRun) {
      throw new Error(
        `History was already imported from "${source}" (run #${previous.rows[0].id} on ${previous.rows[0].finished_at.toISOString()}). ` +
          'Re-running is safe (messages are de-duplicated) but repeats Gemini calls; pass --force to continue.',
      );
    }

    let chats: HistoryChat[];
    let unreadable: SkippedSource[] = [];
    if (source === 'export') {
      const r = readExports(values.path!, {
        timezone: config.timezone,
        gymNames: (values['gym-names'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        contactPhones: readContactsCsv(values.contacts),
        dateOrder,
      });
      chats = r.chats;
      unreadable = r.skipped;
    } else {
      chats = await readWhatsAppHistory({
        authDir: values['auth-dir']!,
        idleSeconds: Number(values['idle-seconds']),
        maxMinutes: Number(values['max-minutes']),
        unlinkWhenDone: !values['keep-linked'],
        logger,
      });
    }
    logger.info({ chats: chats.length, unreadable: unreadable.length }, 'History loaded');

    if (!dryRun) {
      const run = await pool.query<{ id: number }>(
        `INSERT INTO history_import_runs (source, options) VALUES ($1, $2) RETURNING id`,
        [source, JSON.stringify({ ...values, chats: chats.length })],
      );
      runId = run.rows[0]!.id;
    }

    const extractor: LeadExtractor = values['no-llm']
      ? new KeywordLeadExtractor()
      : new GeminiLeadExtractor(process.env.GEMINI_API_KEY!, process.env.GEMINI_MODEL ?? 'gemini-2.5-flash', config);
    const summary = await runImport(pool, chats, extractor, {
      config,
      adminPhones,
      since: values.since ? zonedToUtc(values.since, '00:00', config.timezone) : undefined,
      dryRun,
      maxChats: values['max-chats'] ? Number(values['max-chats']) : undefined,
      concurrency: Number(values.concurrency),
      now: () => new Date(),
      logger,
    }, runId);
    const stats = { ...summary.stats, unreadable_files: unreadable.length };

    if (runId) {
      await pool.query(`UPDATE history_import_runs SET status = 'COMPLETED', stats = $2, finished_at = NOW() WHERE id = $1`, [
        runId,
        JSON.stringify(stats),
      ]);
    }

    const reportPath = values.report ?? `import-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(reportPath, JSON.stringify({ dryRun, source, stats, unreadable, chats: summary.results }, null, 2));
    console.log(`\n${dryRun ? 'DRY RUN - nothing was written.' : 'Import complete.'} No messages were sent.`);
    console.table(stats);
    console.log(`Per-chat report: ${reportPath} (contains customer data - keep it private)`);
  } catch (err) {
    if (runId) {
      await pool
        .query(`UPDATE history_import_runs SET status = 'FAILED', error = $2, finished_at = NOW() WHERE id = $1`, [runId, (err as Error).message])
        .catch(() => undefined);
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`\nImport failed: ${(err as Error).message}`);
  process.exit(1);
});
