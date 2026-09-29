# WhatsApp History Importer

A standalone, **one-time** tool that reads the gym's past WhatsApp chats, saves the enquiries as leads in the WhatsApp agent's database and qualifies them with Gemini.

**It never sends anything.** It has no code that can send a message, and it doesn't create any `scheduled_messages` rows, so no follow-ups or reminders get queued. With the `whatsapp` source, every send method on the WhatsApp socket is replaced with one that throws an error.

It is its own project, with its own `package.json` and dependencies, and imports nothing from the agent's code. It only shares the database, and it reads the same `config/gym.json` to get the plan codes and timezone.

## What it does

1. **Reads history** from one of two sources:
   - `export`: the `.txt` files from WhatsApp's *Export chat → Without media*. It reads a single file or a whole folder, in Android and iOS formats; zip files must be unzipped first.
   - `whatsapp`: links itself as a temporary extra device (you scan a QR code), collects WhatsApp's history sync, then unlinks itself.
2. **Filters** out groups, broadcasts, the owner/staff numbers (`ADMIN_PHONES`) and chats where the customer never wrote.
3. **Qualifies** each remaining chat with Gemini using structured JSON output. For each chat it decides whether it's a gym enquiry and extracts the name, fitness goal, plan, joining date, trial interest and trial date/time, an outcome and a short summary for staff. Gemini is told to extract only what the chat states explicitly. The results are then checked: unknown plan codes and invalid dates become empty.
4. **Saves** each chat:
   - **Personal or other non-gym chats are not stored at all.**
   - New enquiries become leads with `source = 'whatsapp_import'`. The lead's `created_at` is the date of the customer's first message, so "today's leads" reports stay accurate.
   - Lead stages: `QUALIFIED` only if name + goal + plan or joining date are known (the same rule the agent uses). `TRIAL_BOOKED` only for a trial with an agreed date and time that is still in the future; past or unclear trials go into the notes. `CONVERTED` and `LOST` follow what the chat shows.
   - Leads the agent already knows are only **filled in where fields are blank**. The importer never overwrites or downgrades them, apart from moving them from `NEW` to `QUALIFIED` when the rule is met.
   - Existing members get their history saved as context for the agent. No lead is created and Gemini isn't called for them.
   - Messages go into `message_logs` with their original timestamps. Customer messages are stored as `CUSTOMER`, the gym's as `HUMAN`, and each is tagged with `import_run_id`, so the agent sees this history the next time the person writes.
5. **Reports:** it prints a summary table and writes a per-chat JSON report (`import-report-*.json`). The report contains customer data, so keep it private.

## Safety

| | |
| --- | --- |
| Sends nothing | No sending code, no `scheduled_messages` rows (tested), and the `whatsapp` source blocks sending at the socket |
| One-time | Each run is recorded in `history_import_runs`. After a completed import, the same source refuses to run again unless you pass `--force` |
| Re-runs are harmless | Messages are de-duplicated by WhatsApp id, or by a stable hash for exports. Chats with no new messages are skipped without calling Gemini |
| Try before writing | `--dry-run` analyses everything and writes nothing. `--max-chats 20` runs on a sample |
| Privacy | Non-enquiry chats are skipped entirely |

## Setup

```bash
cd history-importer
npm install
cp .env.example .env     # same DATABASE_URL as the agent, plus GEMINI_API_KEY
```
The agent's database must already be migrated (`npm run migrate` in the agent folder). The importer adds only `history_import_runs` and the `message_logs.import_run_id` column.

## Usage

**From exported chats** (on the gym phone: open a chat → ⋮ → More → Export chat → Without media):
```bash
# try it out first
npm run import -- --source export --path ./exports --gym-names "Flamingo Fitness" --dry-run --max-chats 20
# real import
npm run import -- --source export --path ./exports --gym-names "Flamingo Fitness"
```
- `--gym-names` is the name the gym's own messages appear under in the exports.
- An export doesn't contain the customer's number if they were saved as a contact by name. For those, pass `--contacts contacts.csv` with lines of `name,phone`. Chats without a phone number are listed as skipped in the report.
- Dates are auto-detected as DD/MM or MM/DD. Use `--date-order DMY|MDY` to force one. Timestamps are read in the gym's timezone.

**Directly from WhatsApp** (no exports needed):
```bash
npm run import -- --source whatsapp --dry-run      # scan the QR code: Settings > Linked devices > Link a device
npm run import -- --source whatsapp --force        # real import (--force only needed after a previous completed run)
```
- Waits until no new history has arrived for `--idle-seconds` (90), with a hard limit of `--max-minutes` (20).
- The temporary device unlinks itself at the end (`--keep-linked` disables this). It runs alongside the agent's own linked device.
- How much history WhatsApp sends to a newly linked device is up to WhatsApp, and it's often the most recent months. For older chats, use exports.

Other options: `--since YYYY-MM-DD`, `--concurrency 3`, `--no-llm` (keyword filter only; leads stay `NEW` and aren't qualified), `--report file.json`. Run with `--help` to see all options.

## After the import
- Imported leads **don't** get automatic follow-ups or trial reminders. The agent starts following up only when a lead messages again.
- For leads marked `CONVERTED`, ask the agent to "add … as a member" so payments and reminders are tracked.

## Tests
```bash
npm run typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/gym_import_test npm test
```
The database tests **drop and recreate the `public` schema** of `TEST_DATABASE_URL`, then load the agent's schema from `../migrations/001_init.sql` (override with `AGENT_SCHEMA_SQL`).
