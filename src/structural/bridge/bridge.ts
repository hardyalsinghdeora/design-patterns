/**
 * BRIDGE
 * Split "what a notification says" (Alert, Digest, Receipt) from "how it is
 * delivered" (Email, SMS, Slack) so each side varies on its own: N + M classes, not N x M.
 *
 * Example domain: a notification service. Amounts are integers in minor units.
 */

export interface Recipient {
  name: string;
  email?: string;
  phone?: string;
  slackId?: string;
}

export type Priority = 'low' | 'normal' | 'high';

/** What the abstraction hands the implementor: composed, channel-agnostic. */
export interface Envelope {
  subject: string;
  body: string;
  priority: Priority;
}

/** What a channel can carry. The abstraction adapts to this without knowing which channel it is. */
export interface ChannelLimits {
  maxBodyChars: number;
  supportsSubject: boolean;
}

export interface DeliveryReceipt {
  channel: string;
  to: string;
  payload: string;
}

/**
 * The implementor interface. Low-level primitives only: resolve an address and
 * push bytes. It knows nothing about alerts, digests or receipts.
 */
export interface Channel {
  readonly name: string;
  readonly limits: ChannelLimits;
  addressOf(recipient: Recipient): string | undefined;
  deliver(address: string, envelope: Envelope): DeliveryReceipt;
}

export class NotDeliverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotDeliverableError';
  }
}

/* ------------------------------------------------------------------------ */
/* Concrete implementors. Each one records what it "sent" in place of a real */
/* provider call (SES, Twilio, Slack Web API) so the example stays offline.  */
/* ------------------------------------------------------------------------ */

function record(log: DeliveryReceipt[], receipt: DeliveryReceipt): DeliveryReceipt {
  log.push(receipt);
  return receipt;
}

export class EmailChannel implements Channel {
  readonly name = 'email';
  readonly limits: ChannelLimits = { maxBodyChars: 10_000, supportsSubject: true };
  readonly sent: DeliveryReceipt[] = [];

  addressOf(recipient: Recipient): string | undefined {
    return recipient.email;
  }

  deliver(address: string, envelope: Envelope): DeliveryReceipt {
    const headers = [`To: ${address}`, `Subject: ${envelope.subject}`];
    if (envelope.priority === 'high') headers.push('X-Priority: 1');
    return record(this.sent, { channel: this.name, to: address, payload: `${headers.join('\n')}\n\n${envelope.body}` });
  }
}

export class SmsChannel implements Channel {
  readonly name = 'sms';
  /** One GSM-7 segment. Longer messages cost more and arrive split. */
  readonly limits: ChannelLimits = { maxBodyChars: 160, supportsSubject: false };
  readonly sent: DeliveryReceipt[] = [];

  addressOf(recipient: Recipient): string | undefined {
    return recipient.phone;
  }

  deliver(address: string, envelope: Envelope): DeliveryReceipt {
    return record(this.sent, { channel: this.name, to: address, payload: envelope.body });
  }
}

export class SlackChannel implements Channel {
  readonly name = 'slack';
  readonly limits: ChannelLimits = { maxBodyChars: 3_000, supportsSubject: true };
  readonly sent: DeliveryReceipt[] = [];

  addressOf(recipient: Recipient): string | undefined {
    return recipient.slackId;
  }

  deliver(address: string, envelope: Envelope): DeliveryReceipt {
    const mention = envelope.priority === 'high' ? '<!here> ' : '';
    return record(this.sent, { channel: this.name, to: address, payload: `${mention}*${envelope.subject}*\n${envelope.body}` });
  }
}

/**
 * Idiomatic TypeScript: an implementor does not need a class. A factory
 * returning an object literal satisfies Channel just as well.
 */
export function createWebhookChannel(
  urlFor: (recipient: Recipient) => string | undefined,
  post: (url: string, json: string) => void,
): Channel {
  return {
    name: 'webhook',
    limits: { maxBodyChars: 50_000, supportsSubject: true },
    addressOf: urlFor,
    deliver(address, envelope) {
      const json = JSON.stringify(envelope);
      post(address, json);
      return { channel: 'webhook', to: address, payload: json };
    },
  };
}

/* ------------------------------------------------------------------------ */
/* The abstraction and its refinements. They hold a Channel (the bridge) and */
/* only ever talk to it through the Channel interface.                       */
/* ------------------------------------------------------------------------ */

export interface Composed {
  subject: string;
  lines: string[];
  priority: Priority;
}

const fit = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export abstract class Notification {
  constructor(protected channel: Channel) {}

  get channelName(): string {
    return this.channel.name;
  }

  /** Swap the implementation at runtime (user preference changed, fallback). */
  via(channel: Channel): this {
    this.channel = channel;
    return this;
  }

  canReach(recipient: Recipient): boolean {
    return this.channel.addressOf(recipient) !== undefined;
  }

  /** The one place that turns "what to say" into an Envelope the channel can carry. */
  send(recipient: Recipient): DeliveryReceipt {
    const address = this.channel.addressOf(recipient);
    if (address === undefined) throw new NotDeliverableError(`${recipient.name} has no ${this.channel.name} address`);
    const { subject, lines, priority } = this.compose();
    const { maxBodyChars, supportsSubject } = this.channel.limits;
    const text = (supportsSubject ? lines : [subject, ...lines]).join('\n');
    return this.channel.deliver(address, { subject, body: fit(text, maxBodyChars), priority });
  }

  protected abstract compose(): Composed;
}

export interface AlertDetails {
  service: string;
  severity: 'warning' | 'critical';
  summary: string;
  runbookUrl?: string;
}

export class AlertNotification extends Notification {
  constructor(
    channel: Channel,
    private readonly alert: AlertDetails,
  ) {
    super(channel);
  }

  protected compose(): Composed {
    const { service, severity, summary, runbookUrl } = this.alert;
    const lines = [summary];
    if (runbookUrl) lines.push(`Runbook: ${runbookUrl}`);
    return { subject: `[${severity.toUpperCase()}] ${service}`, lines, priority: severity === 'critical' ? 'high' : 'normal' };
  }
}

export interface DigestItem {
  topic: string;
  count: number;
}

export class DigestNotification extends Notification {
  constructor(
    channel: Channel,
    private readonly period: string,
    private readonly items: DigestItem[],
  ) {
    super(channel);
  }

  protected compose(): Composed {
    const total = this.items.reduce((sum, i) => sum + i.count, 0);
    const headline = total === 0 ? 'Nothing new.' : `${total} updates across ${this.items.length} topics.`;
    // The refinement asks the implementor what it can carry, not which channel it is.
    const detail = this.channel.limits.maxBodyChars < 500 ? [] : this.items.map((i) => `- ${i.topic}: ${i.count}`);
    return { subject: `Your ${this.period} digest`, lines: [headline, ...detail], priority: 'low' };
  }
}

export function formatMoney(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  return `${sign}${currency} ${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export interface ReceiptDetails {
  orderId: string;
  currency: string;
  lines: Array<{ name: string; amountMinor: number }>;
}

export class ReceiptNotification extends Notification {
  constructor(
    channel: Channel,
    private readonly receipt: ReceiptDetails,
  ) {
    super(channel);
  }

  protected compose(): Composed {
    const { orderId, currency, lines } = this.receipt;
    const totalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
    return {
      subject: `Receipt for ${orderId}`,
      lines: [...lines.map((l) => `${l.name}: ${formatMoney(l.amountMinor, currency)}`), `Total: ${formatMoney(totalMinor, currency)}`],
      priority: 'normal',
    };
  }
}

/** Runtime swap in practice: try channels in preference order until one can reach the recipient. */
export function sendWithFallback(notification: Notification, recipient: Recipient, channels: Channel[]): DeliveryReceipt {
  for (const channel of channels) {
    if (notification.via(channel).canReach(recipient)) return notification.send(recipient);
  }
  throw new NotDeliverableError(`${recipient.name} is unreachable on ${channels.map((c) => c.name).join(', ')}`);
}
