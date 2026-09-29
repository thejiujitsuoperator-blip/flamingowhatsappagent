# Flamingo WhatsApp Gym Agent

A WhatsApp AI receptionist for a gym. It answers leads, qualifies them, books trials, follows up, reminds members about payments and lets the owner manage everything by chatting with it.

**Stack:** Node.js + TypeScript · [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp) · Google Gemini (`@google/genai`) with function calling · PostgreSQL / Supabase · `node-cron`

## Architecture

```
WhatsApp ─► Baileys (src/whatsapp/baileys.ts)
              │  normalise message, resolve phone (incl. LID → phone)
              ▼
         MessageHandler (src/handlers/messageHandler.ts)
              │  de-duplicate · identify contact · STOP/START · handoff/paused check · rate limit
              ▼
         Load CRM context (lead / member / payments / conversation state) from Postgres
              ▼
         Gemini agent loop (src/agent/agent.ts)  ◄──►  Tools (src/agent/tools/*)  ◄──►  Postgres
              ▼
         Outbox (src/services/outbox.ts): paced, logged sending ─► Baileys ─► WhatsApp

Scheduler (src/scheduler): every minute dispatch due scheduled_messages;
daily at automation.dailyJobHour plan payment reminders + mark unresponsive leads LOST.
```

The database is the source of truth. Gemini only sees the last 20 messages (from `message_logs`), the CRM context and the gym knowledge. It changes data only through tools, and every tool validates its arguments with zod.

## Project layout

| Path | Purpose |
| --- | --- |
| `migrations/001_init.sql` | Schema: `contacts`, `leads`, `members`, `memberships`, `payments`, `conversations`, `scheduled_messages`, `message_logs` |
| `config/gym.example.json` | Gym knowledge (plans, prices, timings, FAQs, policies) + automation settings. The agent may only state facts from this file |
| `src/whatsapp/` | Baileys connection, QR login, reconnects, message extraction |
| `src/handlers/messageHandler.ts` | Inbound pipeline (customers, admins, staff takeover detection) |
| `src/agent/` | Gemini client, tool-calling loop, prompts, customer + admin tools |
| `src/services/` | Business logic: leads/trials/follow-ups, members/payments/reminders, handoff/opt-out, outbox |
| `src/scheduler/` | Cron jobs and the scheduled-message dispatcher |
| `src/repositories/` | SQL data access |
| `tests/` | Unit + Postgres integration tests (fake WhatsApp transport, scripted fake Gemini) |

## Setup

1. **Requirements:** Node 20+ and PostgreSQL 14+ (local, `docker compose up -d postgres`, or Supabase).
2. `npm install`
3. `cp .env.example .env` and set `DATABASE_URL`, `GEMINI_API_KEY` and `ADMIN_PHONES` (the owner's/staff's WhatsApp numbers with country code, e.g. `919876543210`).
   - **Supabase:** use the connection string from *Project Settings → Database* and set `DATABASE_SSL=true`.
4. `cp config/gym.example.json config/gym.json` and replace **everything** with your gym's real details. The example prices are placeholders.
5. `npm run migrate` (the app also runs migrations on start-up).
6. `npm run dev`, then scan the QR code in the terminal from the gym's WhatsApp: *Settings → Linked devices → Link a device*. The session is saved in `WA_AUTH_DIR` (default `auth_state/`), so keep that folder private and persistent.

Production: `npm run build && npm start`, or use `docker compose up -d`. For the first Docker run, use `docker compose run --rm agent` so you can scan the QR code.

## How it works

### Phase 1: Conversation
- Every inbound text goes through the Gemini tool loop with the gym knowledge and the person's CRM context. Replies are short and WhatsApp-style, in the person's language.
- Messages from the same chat are processed one at a time, in order. WhatsApp re-deliveries are ignored (unique `wa_message_id`).
- For media without text, the agent asks the person to type their question.

### Phase 2: Leads
- Every non-member who messages becomes a lead (`NEW`). The agent collects name, fitness goal, preferred plan, joining date and trial interest a little at a time, saving each detail with `updateLead`. The phone number comes from WhatsApp.
- Lead stages: `NEW → QUALIFIED` (automatic once name + goal + plan/join date are known) `→ TRIAL_BOOKED` (`bookTrial`, checked against the trial hours and closed days) `→ FOLLOW_UP → CONVERTED / LOST`.
- When a trial is booked, the admins get a message and the lead gets a reminder about 3 hours before.

### Phase 3: Members and payments
- Members are created by the owner, for example: *"Add Rahul Sharma 9876543210 on the monthly plan from Oct 1"*. This creates `members`, a `memberships` row (plan, start/expiry, monthly fee, billing cycle) and the first `payments` row. Any existing lead for that number becomes `CONVERTED`.
- Marking a payment paid cancels its pending reminders, extends the membership expiry by one billing cycle and creates the next cycle's payment (while auto-renew is on).

### Phase 4: Payment reminders
- A daily job creates reminders for the payment `daysBefore` (3) days ahead, on the due date, and when it is overdue (`overdueDays`: 1 and 7).
- **No duplicates:** each reminder has a unique `dedupe_key` (`payment:<id>:before`, `:due`, `:overdue:<n>`), so running the job again (or restarting) never creates a second one.
- Just before sending, the dispatcher checks the database again. It skips the reminder if the payment is no longer `PENDING`, the member isn't active, the contact opted out, or the conversation is handed off or paused.

### Phase 5: Lead follow-ups
- After each agent reply to an open lead, a follow-up sequence is scheduled for day 1, 3 and 7 (configurable). A new message from the lead cancels the pending sequence, and the next reply starts a fresh one.
- Follow-ups stop when the lead replies, sends STOP, books a trial, converts, is marked lost or is handed off. Leads with no reply 7 days after the final follow-up are marked `LOST`.
- If a lead asks to be contacted later, `scheduleFollowUp` sends a one-off message on that date.

### Phase 6: Admin commands and human handoff
Numbers listed in `ADMIN_PHONES` talk to a back-office agent with admin tools. Example commands:

| Command | Tools used |
| --- | --- |
| "Show today's leads" | `listLeads` |
| "Who has payments due this week?" | `listPaymentsDue` |
| "Show overdue members" | `listOverdueMembers` |
| "How many leads converted this month?" | `getLeadStats` |
| "Stop messaging Rahul" | `stopMessaging` (pauses AI + cancels automation) |
| "Mark Rahul's payment as paid" | `markPaymentPaid` |
| "Resume AI for Priya" / "Who needs attention?" | `resumeMessaging` / `listHandoffs` |
| "Add member …", "Change Rahul's fee to 2000" | `createMember` / `updateMember` |

If a name matches more than one person, the tool returns the candidates and the agent asks which one you mean.

**Handoff.** Complaints, refunds, discounts or negotiation, "I already paid" claims, unusual financial requests, questions the knowledge base can't answer, and requests for staff all trigger `handoffToHuman`. The conversation becomes `NEEDS_HUMAN`, the AI stops replying, pending follow-ups are cancelled and the admins get an alert. If staff reply from the gym's WhatsApp phone, the chat switches to `HUMAN_ACTIVE` automatically. Send "resume AI for …" to hand it back to the AI.

## Safety measures

| Requirement | Implementation |
| --- | --- |
| Never invent pricing/policies | Facts come only from `config/gym.json` (embedded in the prompt and available via `getGymInformation`). The prompt tells the agent to hand off when the information is missing. |
| Database is the source of truth | All state is in Postgres. Gemini history is rebuilt from `message_logs` on every message. |
| No reminders for paid payments | Re-checked at send time. Paying cancels the reminders. |
| No duplicate scheduled messages | `scheduled_messages.dedupe_key UNIQUE` plus `FOR UPDATE SKIP LOCKED` claiming (safe with several instances). |
| STOP / unsubscribe | Handled by keyword matching before Gemini runs. Sets `opted_out` and cancels everything; START re-subscribes. |
| Rate limiting | Inbound: 8 messages/min per contact. Outbound: at least 1.2 s between messages and 30/min overall. Automated messages: at most 2 per contact per day, and none during quiet hours (21:00–09:00). |
| Every automated message logged | Every outbound message, including failures, is written to `message_logs` (source `AUTOMATED`, linked to its `scheduled_message_id`). Tool calls are stored with each agent reply. |
| Human approval for unusual financial requests | Customers have no financial write tools and are handed off instead. For admins, `markPaymentPaid` asks for explicit confirmation when the amount differs from what's due. |
| Privacy | Customer tools take no phone or contact argument; they only ever act on the person in the current chat. |

## Configuration

`config/gym.json` → `automation` / `rateLimits` (all optional, defaults shown in `config/gym.example.json`):
- `quietHours`, `dailyJobHour`, `maxAutomatedPerContactPerDay`
- `paymentReminders.daysBefore`, `.overdueDays`, `.templates` (`{name}`, `{amount}`, `{dueDate}`, `{plan}`, `{gymName}`)
- `leadFollowUps.enabled`, `.steps[] {afterDays, message}` (`{name}`, `{gymName}`), `.markLostAfterDays`

## Tests

```bash
npm run typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/gym_agent_test npm test
```
The integration tests **drop and recreate the `public` schema** of `TEST_DATABASE_URL`, so use a dedicated database. Without `TEST_DATABASE_URL`, only the unit tests run.

## Notes and limits (V1)
- Baileys is an unofficial WhatsApp Web client. Use a dedicated number for the gym and keep message volumes modest. For large-scale messaging, the official WhatsApp Business Cloud API is the safer choice; the `MessageTransport` interface lets you swap it in.
- Rate limits are in memory, per process. The scheduled-message claiming is safe across processes, but run a single WhatsApp connection per number.
- Only text messages are understood (no voice notes or images yet).
