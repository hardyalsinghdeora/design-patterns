import { describe, expect, it } from 'vitest';
import { Bundle, CycleError, Order, Product, priceOf, weightOf, type CatalogItem, type ItemNode } from './composite';

const cable = () => new Product('CBL-C', 'USB-C cable', 49_900, 60);
const hdmi = () => new Product('CBL-H', 'HDMI cable', 79_900, 120);
const stand = () => new Product('STD-1', 'Laptop stand', 2_49_900, 1_400);

/** Home office kit: stand + cable pack (2 x USB-C, HDMI, 10% off), whole kit 5% off. */
function homeOfficeKit() {
  const usbC = cable();
  const pack = new Bundle('PK-CBL', 'Cable pack', { discountBps: 1_000, packagingGrams: 30 }).add(usbC, 2).add(hdmi());
  const kit = new Bundle('KIT-HO', 'Home office kit', { discountBps: 500, packagingGrams: 400 }).add(stand()).add(pack);
  return { kit, pack, usbC };
}

describe('Composite: products and bundles', () => {
  it('a leaf prices, weighs and describes itself', () => {
    const p = cable();
    expect([p.price(), p.weightGrams()]).toEqual([49_900, 60]);
    expect(p.describe()).toEqual(['CBL-C USB-C cable Rs 499.00']);
  });

  it('computes nested totals with a discount at each level', () => {
    const { kit, pack } = homeOfficeKit();
    expect(pack.listPrice()).toBe(1_79_700);
    expect(pack.price()).toBe(1_61_730); // 10% off
    expect(kit.listPrice()).toBe(2_49_900 + 1_61_730);
    expect(kit.price()).toBe(4_11_630 - 20_582); // 5% of 4,11,630 rounds to 20,582
  });

  it('adds packaging weight at every level', () => {
    const { kit } = homeOfficeKit();
    expect(kit.weightGrams()).toBe(400 + 1_400 + (30 + 2 * 60 + 120));
  });

  it('lets the client treat leaves and composites interchangeably', () => {
    const { kit } = homeOfficeKit();
    const items: CatalogItem[] = [kit, cable()];
    const order = new Order('ord_1');
    for (const item of items) order.add(item);
    expect(order.subtotal()).toBe(kit.price() + 49_900);
    expect(order.weightGrams()).toBe(2_130);
    expect(order.shippingMinor()).toBe(3 * 4_000); // 2.13 kg -> 3 started kg
  });

  it('flattens the tree into an aggregated picking list', () => {
    const { kit } = homeOfficeKit();
    const order = new Order('ord_2').add(kit, 2).add(cable());
    expect(Object.fromEntries(order.pickingList())).toEqual({ 'STD-1': 2, 'CBL-C': 5, 'CBL-H': 2 });
  });

  it('refuses cycles but allows sharing a child between bundles', () => {
    const { kit, pack, usbC } = homeOfficeKit();
    expect(() => pack.add(pack)).toThrow(CycleError);
    expect(() => pack.add(kit)).toThrow(/would create a cycle/);
    const travel = new Bundle('KIT-TR', 'Travel kit').add(pack).add(usbC);
    expect(travel.contains(usbC)).toBe(true);
    expect(() => new Bundle('KIT-X', 'Super kit').add(kit).add(travel)).not.toThrow();
  });

  it('describes the tree with indentation and quantities', () => {
    const { pack } = homeOfficeKit();
    expect(pack.describe()).toEqual([
      'PK-CBL Cable pack Rs 1617.30 (-10% of Rs 1797.00)',
      '  2 x CBL-C USB-C cable Rs 499.00',
      '  CBL-H HDMI cable Rs 799.00',
    ]);
  });

  it('removing a child updates every total above it', () => {
    const { kit, pack } = homeOfficeKit();
    const before = kit.price();
    expect(pack.remove('CBL-H')).toBe(true);
    expect(pack.remove('NOPE')).toBe(false);
    expect(kit.price()).toBeLessThan(before);
    expect(pack.size).toBe(1);
  });

  it('the discriminated-union form computes the same totals', () => {
    const product = (sku: string, priceMinor: number, grams: number): ItemNode => ({ kind: 'product', sku, priceMinor, grams });
    const pack: ItemNode = {
      kind: 'bundle', sku: 'PK-CBL', discountBps: 1_000, packagingGrams: 30,
      children: [{ node: product('CBL-C', 49_900, 60), quantity: 2 }, { node: product('CBL-H', 79_900, 120), quantity: 1 }],
    };
    const kit: ItemNode = {
      kind: 'bundle', sku: 'KIT-HO', discountBps: 500, packagingGrams: 400,
      children: [{ node: product('STD-1', 2_49_900, 1_400), quantity: 1 }, { node: pack, quantity: 1 }],
    };
    const { kit: classKit } = homeOfficeKit();
    expect(priceOf(kit)).toBe(classKit.price());
    expect(weightOf(kit)).toBe(classKit.weightGrams());
  });
});
