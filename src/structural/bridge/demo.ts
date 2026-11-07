import {
  AlertNotification,
  DigestNotification,
  EmailChannel,
  ReceiptNotification,
  SlackChannel,
  SmsChannel,
  sendWithFallback,
  type Channel,
  type Notification,
  type Recipient,
} from './bridge';

const asha: Recipient = { name: 'Asha', email: 'asha@example.com', phone: '+919800000001', slackId: 'U01ASHA' };
const channels: Channel[] = [new EmailChannel(), new SmsChannel(), new SlackChannel()];

const build: Array<[string, (c: Channel) => Notification]> = [
  ['Alert', (c) => new AlertNotification(c, { service: 'payments-api', severity: 'critical', summary: 'Error rate 7% for 5 min', runbookUrl: 'https://runbooks.example.com/payments' })],
  ['Digest', (c) => new DigestNotification(c, 'weekly', [{ topic: 'Invoices paid', count: 41 }, { topic: 'Disputes', count: 2 }])],
  ['Receipt', (c) => new ReceiptNotification(c, { orderId: 'ord_1042', currency: 'INR', lines: [{ name: 'Pro plan', amountMinor: 1_29_900 }, { name: 'GST 18%', amountMinor: 23_382 }] })],
];

console.log('\n3 notification kinds x 3 channels = 9 combinations from 6 classes:\n');
for (const [kind, make] of build) {
  for (const channel of channels) {
    const { payload } = make(channel).send(asha);
    console.log(`--- ${kind} via ${channel.name}`);
    console.log(payload.split('\n').map((l) => `    ${l}`).join('\n'));
  }
}

console.log('\nRavi has no Slack or email; the receipt falls back to SMS at runtime:');
const ravi: Recipient = { name: 'Ravi', phone: '+919800000002' };
const receipt = build[2]?.[1](new SlackChannel());
if (receipt) {
  const delivered = sendWithFallback(receipt, ravi, [new SlackChannel(), new EmailChannel(), new SmsChannel()]);
  console.log(`  delivered via ${delivered.channel} to ${delivered.to}`);
}
console.log();
