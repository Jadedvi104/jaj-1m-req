import {
  calculateOrderTotal,
  MAX_SATANG,
  orderFingerprint,
  validateOrderRequest,
} from './order-policy';

const request = {
  branchId: '00000000-0000-4000-8000-00000000000a',
  tableSessionId: '00000000-0000-4000-8000-00000000000b',
  customerName: 'Guest',
  customerPhone: '080',
  items: [{ productId: '00000000-0000-4000-8000-00000000000c', quantity: 2 }],
};

describe('Order policy', () => {
  it.each(['', ' ', 'a b', 'a\n', 'é', 'a'.repeat(129)])(
    'rejects invalid idempotency key %p',
    (key) => {
      expect(() => validateOrderRequest(request, key)).toThrow();
    },
  );
  it.each([0, -1, 1.5, 1001, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects quantity %p',
    (quantity) => {
      expect(() =>
        validateOrderRequest(
          { ...request, items: [{ ...request.items[0], quantity }] },
          'key',
        ),
      ).toThrow();
    },
  );
  it('accepts the maximum supported quantity and key length', () => {
    expect(() =>
      validateOrderRequest(
        { ...request, items: [{ ...request.items[0], quantity: 1000 }] },
        'a'.repeat(128),
      ),
    ).not.toThrow();
  });
  it.each([0, 101])('rejects %i items', (length) => {
    expect(() =>
      validateOrderRequest(
        {
          ...request,
          items: Array.from({ length }, (_, index) => ({
            productId: String(index),
            quantity: 1,
          })),
        },
        'key',
      ),
    ).toThrow();
  });
  it('rejects duplicate UUIDs even when their casing differs', () => {
    expect(() =>
      validateOrderRequest(
        {
          ...request,
          items: [
            request.items[0],
            {
              ...request.items[0],
              productId: request.items[0].productId.toUpperCase(),
            },
          ],
        },
        'key',
      ),
    ).toThrow();
  });
  it('canonicalizes item ordering, object property order and UUID case without mutating input', () => {
    const items = [
      ...request.items,
      { productId: '00000000-0000-4000-8000-00000000000d', quantity: 1 },
    ];
    const original = structuredClone(items);
    const fingerprint = orderFingerprint({ ...request, items });
    expect(
      orderFingerprint({
        ...request,
        branchId: request.branchId.toUpperCase(),
        items: [...items].reverse().map((item) => ({
          quantity: item.quantity,
          productId: item.productId.toUpperCase(),
        })),
      }),
    ).toBe(fingerprint);
    expect(items).toEqual(original);
  });
  it.each([
    { customerName: 'Other' },
    { customerPhone: '090' },
    { tableSessionId: 'other' },
    { branchId: 'other' },
    { items: [{ ...request.items[0], quantity: 3 }] },
    { items: [{ ...request.items[0], sizeCode: 'large' }] },
    { items: [{ ...request.items[0], spiceLevel: 'hot' }] },
  ])('binds fingerprint to request changes %p', (change) => {
    expect(orderFingerprint({ ...request, ...change })).not.toBe(
      orderFingerprint(request),
    );
  });
  it('calculates exact integer satang including zero-priced items', () => {
    expect(
      calculateOrderTotal([
        { price: 0, quantity: 10 },
        { price: 1200, quantity: 2 },
      ]),
    ).toBe(2400);
    expect(calculateOrderTotal([{ price: MAX_SATANG, quantity: 1 }])).toBe(
      MAX_SATANG,
    );
  });
  it.each([-1, 0.1, Infinity, NaN])('rejects invalid price %p', (price) => {
    expect(() => calculateOrderTotal([{ price, quantity: 1 }])).toThrow();
  });
  it('rejects both line and cumulative overflow', () => {
    expect(() =>
      calculateOrderTotal([{ price: MAX_SATANG, quantity: 2 }]),
    ).toThrow();
    expect(() =>
      calculateOrderTotal([
        { price: MAX_SATANG, quantity: 1 },
        { price: 1, quantity: 1 },
      ]),
    ).toThrow();
  });
});
