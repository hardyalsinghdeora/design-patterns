import { describe, expect, it } from 'vitest';
import {
  AlertNotification,
  DigestNotification,
  EmailChannel,
  NotDeliverableError,
  ReceiptNotification,
  SlackChannel,
  SmsChannel,
  createWebhookChannel,
  sendWithFallback,
  type Channel,
  type DeliveryReceipt,
  type Envelope,
  type Notification,
  type Recipient,
} from './bridge';

const asha: Recipient = { name: 'Asha', email: 'asha@example.com', phone: '+919800000001', slackId: 'U01ASHA' };

const abstractions: Record<string, (c: Channel) => Notification> = {
  alert: (c) => new AlertNotification(c, { service: 'payments-api', severity: 'critical', summary: 'p99 latency 2.4s' }),
  digest: (c) => new DigestNotification(c, 'weekly', [{ topic: 'Invoices', count: 12 }, { topic: 'Refunds', count: 3 }]),
  receipt: (c) => new ReceiptNotification(c, { orderId: 'ord_7', currency: 'INR', lines: [{ name: 'Plan', amountMinor: 49_900 }] }),
};
const channels: Record<string, () => Channel> = {
  email: () => new EmailChannel(),
  sms: () => new SmsChannel(),
  slack: () => new SlackChannel(),
};

describe('Bridge: notifications x channels', () => {
  it('every abstraction works with every channel (3 + 3 classes, 9 combinations)', () => {
    const seen: string[] = [];
    for (const [kind, make] of Object.entries(abstractions)) {
      for (const [name, channel] of Object.entries(channels)) {
        const receipt = make(channel()).send(asha);
        expect(receipt.channel).toBe(name);
        expect(receipt.payload.length).toBeGreaterThan(0);
        seen.push(`${kind}/${name}`);
      }
    }
    expect(seen).toHaveLength(9);
  });

  it('adding a channel touches no abstraction', () => {
    // A brand-new implementor written here, after the abstractions were "shipped".
    class PushChannel implements Channel {
      readonly name = 'push';
      readonly limits = { maxBodyChars: 240, supportsSubject: true };
      addressOf = (r: Recipient) => (r.name === 'Asha' ? 'device-token-1' : undefined);
      deliver(address: string, e: Envelope): DeliveryReceipt {
        return { channel: this.name, to: address, payload: `${e.subject} | ${e.body}` };
      }
    }
    for (const make of Object.values(abstractions)) {
      expect(make(new PushChannel()).send(asha)).toMatchObject({ channel: 'push', to: 'device-token-1' });
    }
  });

  it('inlines the subject and truncates the body on a channel without subjects', () => {
    const sms = new SmsChannel();
    const long = new AlertNotification(sms, { service: 'ledger', severity: 'warning', summary: 'x'.repeat(400) });
    const { payload } = long.send(asha);
    expect(payload.startsWith('[WARNING] ledger\n')).toBe(true);
    expect(payload).toHaveLength(160);
    expect(payload.endsWith('…')).toBe(true);
  });

  it('keeps channel-specific rendering inside the implementor', () => {
    const alert = abstractions['alert'];
    if (!alert) throw new Error('missing fixture');
    expect(alert(new EmailChannel()).send(asha).payload).toContain('X-Priority: 1');
    expect(alert(new SlackChannel()).send(asha).payload.startsWith('<!here> *[CRITICAL] payments-api*')).toBe(true);
  });

  it('a refined abstraction adapts to channel limits without knowing the channel', () => {
    const digest = abstractions['digest'];
    if (!digest) throw new Error('missing fixture');
    expect(digest(new EmailChannel()).send(asha).payload).toContain('- Invoices: 12');
    expect(digest(new SmsChannel()).send(asha).payload).toBe('Your weekly digest\n15 updates across 2 topics.');
  });

  it('swaps the channel at runtime and falls back when a recipient is unreachable', () => {
    const noSlack: Recipient = { name: 'Ravi', phone: '+919800000002' };
    const receipt = new ReceiptNotification(new SlackChannel(), { orderId: 'ord_8', currency: 'INR', lines: [] });
    expect(() => receipt.send(noSlack)).toThrow(NotDeliverableError);
    expect(sendWithFallback(receipt, noSlack, [new SlackChannel(), new EmailChannel(), new SmsChannel()]).channel).toBe('sms');
    expect(receipt.channelName).toBe('sms');
    expect(() => sendWithFallback(receipt, { name: 'Ghost' }, [new EmailChannel()])).toThrow(/unreachable/);
  });

  it('formats receipt money from integer minor units', () => {
    const r = new ReceiptNotification(new EmailChannel(), {
      orderId: 'ord_9',
      currency: 'INR',
      lines: [
        { name: 'Pro plan', amountMinor: 1_29_900 },
        { name: 'Credit', amountMinor: -5 },
      ],
    }).send(asha);
    expect(r.payload).toContain('Pro plan: INR 1299.00');
    expect(r.payload).toContain('Credit: -INR 0.05');
    expect(r.payload).toContain('Total: INR 1298.95');
  });

  it('accepts a functional implementor', () => {
    const posted: string[] = [];
    const webhook = createWebhookChannel(() => 'https://hooks.example.com/a', (url, json) => posted.push(`${url} ${json}`));
    abstractions['alert']?.(webhook).send(asha);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('"priority":"high"');
  });
});
