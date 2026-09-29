import { describe, expect, it } from 'vitest';
import { chatTitleFromPath, parseExportText, type ExportParseOptions } from '../src/sources/exportParser.js';

const opts = (o: Partial<ExportParseOptions> = {}): ExportParseOptions => ({
  timezone: 'Asia/Kolkata',
  gymNames: [],
  contactPhones: new Map(),
  dateOrder: 'auto',
  ...o,
});

const ANDROID = `12/09/2026, 18:05 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.
12/09/2026, 18:05 - +91 98222 22222: Hi, what are your membership prices?
12/09/2026, 18:07 - Flamingo Fitness: Hi! Monthly is 2500.
Quarterly is 6500.
13/09/2026, 09:15 - +91 98222 22222: <Media omitted>
13/09/2026, 09:16 - +91 98222 22222: I'm Priya, want to lose weight`;

const IOS = `[9/12/26, 6:05:10 PM] Flamingo Fitness: ‎Messages and calls are end-to-end encrypted.
[9/12/26, 6:05:10 PM] Rahul K: Do you have a trial?
[9/13/26, 9:15:00 AM] Flamingo Fitness: Yes, free trial any day except Sunday
[9/13/26, 9:16:00 AM] Rahul K: ‎image omitted`;

describe('export parser', () => {
  it('parses Android exports with multi-line messages and phone senders', () => {
    const r = parseExportText(ANDROID, 'WhatsApp Chat with +91 98222 22222.txt', opts());
    if (!('chat' in r)) throw new Error(r.skipped.reason);
    expect(r.chat.phone).toBe('919822222222');
    expect(r.chat.name).toBeNull();
    expect(r.chat.messages.map((m) => [m.fromMe, m.text])).toEqual([
      [false, 'Hi, what are your membership prices?'],
      [true, 'Hi! Monthly is 2500.\nQuarterly is 6500.'],
      [false, '[media]'],
      [false, "I'm Priya, want to lose weight"],
    ]);
    // 12/09 with a 13/09 later => DMY; 18:05 IST = 12:35 UTC
    expect(r.chat.messages[0]!.timestamp.toISOString()).toBe('2026-09-12T12:35:00.000Z');
  });

  it('parses iOS exports (MDY, AM/PM, invisible marks) using --gym-names and contacts CSV', () => {
    const r = parseExportText(
      IOS,
      'WhatsApp Chat - Rahul K/_chat.txt',
      opts({ gymNames: ['Flamingo Fitness'], contactPhones: new Map([['rahul k', '919811111111']]) }),
    );
    if (!('chat' in r)) throw new Error(r.skipped.reason);
    expect(r.chat).toMatchObject({ phone: '919811111111', name: 'Rahul K' });
    expect(r.chat.messages).toHaveLength(3); // encryption notice dropped
    expect(r.chat.messages[0]!.timestamp.toISOString()).toBe('2026-09-12T12:35:10.000Z');
    expect(r.chat.messages[2]!.text).toBe('[media]');
  });

  it('produces stable ids so re-imports never duplicate', () => {
    const a = parseExportText(ANDROID, 'x/WhatsApp Chat with +91 98222 22222.txt', opts());
    const b = parseExportText(ANDROID, 'y/WhatsApp Chat with +91 98222 22222.txt', opts());
    if (!('chat' in a) || !('chat' in b)) throw new Error();
    expect(a.chat.messages.map((m) => m.id)).toEqual(b.chat.messages.map((m) => m.id));
    expect(new Set(a.chat.messages.map((m) => m.id)).size).toBe(4);
  });

  it('skips chats it cannot attribute safely', () => {
    const noPhone = parseExportText(IOS, 'WhatsApp Chat - Rahul K/_chat.txt', opts({ gymNames: ['Flamingo Fitness'] }));
    expect('skipped' in noPhone && noPhone.skipped.reason).toMatch(/no_phone/);
    const group = parseExportText(
      '01/10/2026, 10:00 - A: hi\n01/10/2026, 10:01 - B: hey\n01/10/2026, 10:02 - C: yo',
      'WhatsApp Chat with Friends.txt',
      opts({ gymNames: ['Gym'] }),
    );
    expect('skipped' in group && group.skipped.reason).toBe('group_chat');
  });

  it('extracts chat titles from file names', () => {
    expect(chatTitleFromPath('WhatsApp Chat with Priya (2).txt')).toBe('Priya');
    expect(chatTitleFromPath('exports/WhatsApp Chat - Rahul K/_chat.txt')).toBe('Rahul K');
  });
});
