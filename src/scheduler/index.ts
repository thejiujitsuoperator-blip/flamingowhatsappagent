import cron, { type ScheduledTask } from 'node-cron';
import type { AppContext } from '../context.js';
import { markUnresponsiveLeadsLost } from '../services/leads.js';
import { planPaymentReminders } from '../services/payments.js';
import { dispatchDueMessages } from './dispatcher.js';

/** Daily planning: payment reminders (Phase 4) and lead lifecycle housekeeping (Phase 5). */
export async function runDailyJobs(ctx: AppContext): Promise<void> {
  await planPaymentReminders(ctx);
  const lost = await markUnresponsiveLeadsLost(ctx);
  if (lost.length) ctx.logger.info({ leadIds: lost }, 'Marked unresponsive leads as LOST');
}

export function startScheduler(ctx: AppContext): { stop: () => Promise<void> } {
  const tasks: ScheduledTask[] = [];
  const safe = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (err) {
      ctx.logger.error({ err, job: name }, 'Scheduled job failed');
    }
  };

  tasks.push(
    cron.schedule('* * * * *', safe('dispatch', () => dispatchDueMessages(ctx)), {
      name: 'dispatch-scheduled-messages',
      noOverlap: true,
    }),
  );
  tasks.push(
    cron.schedule(`0 ${ctx.config.automation.dailyJobHour} * * *`, safe('daily', () => runDailyJobs(ctx)), {
      name: 'daily-jobs',
      timezone: ctx.config.timezone,
      noOverlap: true,
    }),
  );

  // Planning is idempotent (dedupe keys), so it is safe to also run it on every start-up
  // in case the process was down at the scheduled hour.
  void safe('daily-startup', () => runDailyJobs(ctx))();

  ctx.logger.info(
    { dailyJobHour: ctx.config.automation.dailyJobHour, timezone: ctx.config.timezone },
    'Scheduler started',
  );
  return {
    stop: async () => {
      for (const t of tasks) await t.stop();
    },
  };
}
