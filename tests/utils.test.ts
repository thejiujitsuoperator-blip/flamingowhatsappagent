import { describe, expect, it } from 'vitest';
import { parseGymConfig } from '../src/config/gym.js';
import {
  addMonths,
  diffDays,
  isWithinQuietHours,
  localDate,
  localHour,
  nextSendableTime,
  zonedToUtc,
} from '../src/utils/dates.js';
import { formatMoney, renderTemplate } from '../src/utils/format.js';
import { normalizePhone } from '../src/utils/phone.js';
import { KeyedSerialQueue, SlidingWindowLimiter } from '../src/utils/rateLimiter.js';
import { customerTools } from '../src/agent/tools/customerTools.js';
import { adminTools } from '../src/agent/tools/adminTools.js';
import { toDeclaration } from '../src/agent/tools/types.js';
import { isStopKeyword } from '../src/services/conversationControl.js';
import exampleConfig from '../config/gym.example.json' with { type: 'json' };

const TZ = 'Asia/Kolkata';

describe('dates', () => {
  it('adds months clamping to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });
  it('converts local wall time to UTC', () => {
    expect(zonedToUtc('2026-10-05', '09:00', TZ).toISOString()).toBe('2026-10-05T03:30:00.000Z');
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
  });
  it('computes local date and diff', () => {
    expect(localDate(TZ, new Date('2026-10-04T20:00:00Z'))).toBe('2026-10-05');
    expect(diffDays('2026-10-05', '2026-10-02')).toBe(3);
  });
  it('respects quiet hours', () => {
    const quiet = { start: 21, end: 9 };
    expect(isWithinQuietHours(22, quiet)).toBe(true);
    expect(isWithinQuietHours(3, quiet)).toBe(true);
    expect(isWithinQuietHours(12, quiet)).toBe(false);
    // 23:00 IST -> next day 09:00 IST
    const late = nextSendableTime(new Date('2026-10-02T17:30:00Z'), TZ, quiet);
    expect(late.toISOString()).toBe('2026-10-03T03:30:00.000Z');
    // 03:00 IST -> same day 09:00 IST
    const early = nextSendableTime(new Date('2026-10-02T21:30:00Z'), TZ, quiet);
    expect(early.toISOString()).toBe('2026-10-03T03:30:00.000Z');
    expect(localHour(TZ, late)).toBe(9);
    const noon = new Date('2026-10-02T06:30:00Z');
    expect(nextSendableTime(noon, TZ, quiet)).toBe(noon);
  });
});

describe('phone + format', () => {
  it('normalises phone numbers', () => {
    expect(normalizePhone('98765 43210')).toBe('919876543210');
    expect(normalizePhone('+91-98765-43210')).toBe('919876543210');
    expect(normalizePhone('09876543210')).toBe('919876543210');
    expect(normalizePhone('abc')).toBeNull();
  });
  it('renders templates and money', () => {
    const cfg = parseGymConfig(exampleConfig);
    expect(formatMoney(2500, cfg)).toBe('₹2,500');
    expect(renderTemplate('Hey {name}, {amount} due {x}', { name: 'Rahul', amount: '₹2,500' })).toBe('Hey Rahul, ₹2,500 due {x}');
  });
  it('detects STOP keywords only as whole message', () => {
    expect(isStopKeyword('STOP')).toBe(true);
    expect(isStopKeyword(' unsubscribe ')).toBe(true);
    expect(isStopKeyword("don't stop me now")).toBe(false);
  });
});

describe('rate limiting', () => {
  it('sliding window limits per key', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => t);
    expect(l.tryAcquire('a')).toBe(true);
    expect(l.tryAcquire('a')).toBe(true);
    expect(l.tryAcquire('a')).toBe(false);
    expect(l.tryAcquire('b')).toBe(true);
    t = 1001;
    expect(l.tryAcquire('a')).toBe(true);
  });
  it('serial queue runs tasks for the same key in order', async () => {
    const q = new KeyedSerialQueue();
    const order: number[] = [];
    await Promise.all([
      q.run('k', async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      }),
      q.run('k', async () => order.push(2)),
    ]);
    expect(order).toEqual([1, 2]);
  });
});

describe('tool declarations', () => {
  it('produce Gemini-compatible schemas', () => {
    for (const tool of [...customerTools, ...adminTools]) {
      const decl = toDeclaration(tool);
      const json = JSON.stringify(decl);
      expect(json).not.toContain('$schema');
      expect(json).not.toContain('additionalProperties');
    }
  });
  it('never expose financial write tools to customers', () => {
    const names = customerTools.map((t) => t.name);
    expect(names).not.toContain('markPaymentPaid');
    expect(names).not.toContain('createMember');
    expect(names).not.toContain('updateMember');
    expect(names).toContain('handoffToHuman');
  });
});
