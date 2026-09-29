import type { WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { groupIntoChats } from '../src/sources/whatsappHistory.js';

const msg = (id: string, remoteJid: string, text: string, fromMe = false, extra: Partial<WAMessage['key']> = {}, pushName?: string) =>
  ({ key: { id, remoteJid, fromMe, ...extra }, message: { conversation: text }, messageTimestamp: 1_790_000_000 + Number(id.slice(1)), pushName }) as WAMessage;

describe('whatsapp history grouping', () => {
  it('groups 1:1 chats by phone, resolving LIDs and skipping groups', () => {
    const chats = groupIntoChats(
      [
        msg('m1', '919822222222@s.whatsapp.net', 'Hi, prices?', false, {}, 'Priya'),
        msg('m2', '919822222222@s.whatsapp.net', 'Monthly is 2500', true),
        msg('m3', '123456789@lid', 'Do you have trials?'),
        msg('m4', '1203630@g.us', 'group chatter'),
        msg('m5', '555@lid', 'from unknown lid', false, { remoteJidAlt: '919833333333@s.whatsapp.net' }),
      ],
      new Map(),
      new Map([['123456789@lid', '919811111111@s.whatsapp.net']]),
    );
    expect(chats.map((c) => [c.phone, c.name, c.messages.length])).toEqual([
      ['919822222222', 'Priya', 2],
      ['919811111111', null, 1],
      ['919833333333', null, 1],
    ]);
  });
});
