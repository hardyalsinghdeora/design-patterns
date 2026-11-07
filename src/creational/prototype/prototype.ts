/**
 * PROTOTYPE
 * Create new objects by copying a fully configured instance instead of rebuilding them from scratch.
 */

/* Example domain: notification templates, pricing plan presets and a report
   configuration with nested objects, cloned from named presets. Amounts are
   integers in minor units. */

export interface Prototype<T> {
  clone(): T;
}

/* ------------------------------------------------------------------------ */
/* 1. Notification templates: flat data, so a copy constructor that spreads  */
/*    the one-level arrays and records is already a full copy.               */
/* ------------------------------------------------------------------------ */

export type Channel = 'email' | 'sms' | 'push';

export class NotificationTemplate implements Prototype<NotificationTemplate> {
  constructor(
    readonly channel: Channel,
    public subject: string,
    public body: string,
    public tags: string[] = [],
    public defaults: Record<string, string> = {},
  ) {}

  render(vars: Record<string, string>): { subject: string; body: string } {
    const values: Record<string, string> = { ...this.defaults, ...vars };
    const fill = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
    return { subject: fill(this.subject), body: fill(this.body) };
  }

  clone(): NotificationTemplate {
    return new NotificationTemplate(this.channel, this.subject, this.body, [...this.tags], { ...this.defaults });
  }
}

/* ------------------------------------------------------------------------ */
/* 2. Pricing plan presets: Set, Map and Date fields. Each needs its own     */
/*    constructor call, or the "copy" shares them with the preset.           */
/* ------------------------------------------------------------------------ */

export class PricingPlan implements Prototype<PricingPlan> {
  constructor(
    public name: string,
    public monthlyPriceMinor: number,
    readonly currency: string,
    readonly features: Set<string>,
    readonly limits: Map<string, number>,
    public validFrom: Date,
  ) {}

  allows(feature: string): boolean {
    return this.features.has(feature);
  }

  limit(key: string): number {
    return this.limits.get(key) ?? 0;
  }

  /** A derived preset (a regional or promotional variant) without touching the original. */
  variant(name: string, discountPercent: number): PricingPlan {
    const copy = this.clone();
    copy.name = name;
    copy.monthlyPriceMinor = Math.round((this.monthlyPriceMinor * (100 - discountPercent)) / 100);
    return copy;
  }

  clone(): PricingPlan {
    return new PricingPlan(
      this.name,
      this.monthlyPriceMinor,
      this.currency,
      new Set(this.features),
      new Map(this.limits),
      new Date(this.validFrom.getTime()),
    );
  }
}

/* ------------------------------------------------------------------------ */
/* 3. Report configuration: deeply nested plain data. This is where the      */
/*    shallow-copy bug bites, and where structuredClone is the idiom.        */
/* ------------------------------------------------------------------------ */

export interface ReportColumn {
  key: string;
  label: string;
  format: 'money' | 'date' | 'text';
}

export interface ReportConfigData {
  name: string;
  owner: string;
  filters: { period: { from: Date; to: Date }; regions: string[]; minAmountMinor: number };
  columns: ReportColumn[];
  delivery: { channel: 'email' | 'slack'; recipients: string[]; schedule: { cron: string; timezone: string } };
  /** Alert thresholds per metric, e.g. "refund_rate_bp" -> 250. */
  thresholds: Map<string, number>;
}

/** BUG: spread copies one level. filters, columns, delivery and thresholds are still shared with the original. */
export const shallowCopy = (config: ReportConfigData): ReportConfigData => ({ ...config });

/** BUG: JSON turns every Date into a string and every Map into {}. The types lie after this call. */
export const jsonCopy = (config: ReportConfigData): ReportConfigData => JSON.parse(JSON.stringify(config)) as ReportConfigData;

/**
 * FIX: structuredClone (global since Node 17) copies nested objects, arrays,
 * Date, Map, Set, typed arrays and even cycles. It does NOT keep class
 * prototypes or functions, which is why the classes above write clone().
 */
export const deepCopy = (config: ReportConfigData): ReportConfigData => structuredClone(config);

export class ReportConfig implements Prototype<ReportConfig> {
  constructor(readonly data: ReportConfigData) {}

  describe(): string {
    const { name, filters, columns, delivery } = this.data;
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return `${name}: ${filters.regions.join('/')} ${day(filters.period.from)}..${day(filters.period.to)}, ${columns.length} columns, ${delivery.schedule.cron} ${delivery.schedule.timezone} -> ${delivery.recipients.join(', ')}`;
  }

  /** Plain data inside, class outside: deep-copy the data, re-wrap it to keep the prototype. */
  clone(): ReportConfig {
    return new ReportConfig(deepCopy(this.data));
  }
}

/* ------------------------------------------------------------------------ */
/* Registry: named, pre-configured prototypes. Callers never see the stored  */
/* instance, only fresh copies, so nobody can corrupt a preset for others.    */
/* ------------------------------------------------------------------------ */

export class PrototypeRegistry<T extends Prototype<T>> {
  private readonly prototypes = new Map<string, T>();

  /** Stores a private copy: the caller may keep mutating the object it passed in. */
  register(name: string, prototype: T): this {
    this.prototypes.set(name, prototype.clone());
    return this;
  }

  create(name: string, customize?: (copy: T) => void): T {
    const prototype = this.prototypes.get(name);
    if (!prototype) throw new Error(`No prototype named "${name}". Registered: ${this.names().join(', ')}`);
    const copy = prototype.clone();
    customize?.(copy);
    return copy;
  }

  has(name: string): boolean {
    return this.prototypes.has(name);
  }

  names(): string[] {
    return [...this.prototypes.keys()].sort();
  }
}

/* --- Preset catalogues, loaded once at startup --- */

export function notificationPresets(): PrototypeRegistry<NotificationTemplate> {
  return new PrototypeRegistry<NotificationTemplate>()
    .register('order-shipped', new NotificationTemplate('email', 'Order {{orderId}} has shipped', 'Hi {{name}}, track it at {{trackingUrl}}.', ['transactional'], { name: 'there' }))
    .register('payment-failed', new NotificationTemplate('sms', 'Payment failed', 'Your payment for {{orderId}} failed. Retry: {{retryUrl}}', ['billing', 'urgent']));
}

export function pricingPresets(validFrom: Date): PrototypeRegistry<PricingPlan> {
  return new PrototypeRegistry<PricingPlan>()
    .register('starter', new PricingPlan('Starter', 99_900, 'INR', new Set(['invoices']), new Map([['seats', 2], ['invoices_per_month', 100]]), validFrom))
    .register('pro', new PricingPlan('Pro', 4_99_900, 'INR', new Set(['invoices', 'webhooks', 'exports']), new Map([['seats', 10], ['invoices_per_month', 5_000]]), validFrom));
}

export function reportPresets(period: { from: Date; to: Date }): PrototypeRegistry<ReportConfig> {
  return new PrototypeRegistry<ReportConfig>().register(
    'monthly-revenue',
    new ReportConfig({
      name: 'Monthly revenue',
      owner: 'finance',
      filters: { period, regions: ['IN', 'SG'], minAmountMinor: 0 },
      columns: [
        { key: 'invoice', label: 'Invoice', format: 'text' },
        { key: 'paidAt', label: 'Paid at', format: 'date' },
        { key: 'amountMinor', label: 'Amount', format: 'money' },
      ],
      delivery: { channel: 'email', recipients: ['finance@acme.example'], schedule: { cron: '0 6 1 * *', timezone: 'Asia/Kolkata' } },
      thresholds: new Map([['refund_rate_bp', 250]]),
    }),
  );
}
