import { describe, expect, it } from 'vitest';
import { normaliseReply, optionsOf, renderPlain, resolveNumberedChoice, LIMITS, type BotReply } from '../src/channels/reply.js';

describe('normaliseReply', () => {
  it('keeps at most 3 buttons and truncates titles to 20 chars with an ellipsis', () => {
    const r = normaliseReply({
      text: 'Pick one',
      buttons: [
        { id: 'a', title: 'A very long button title indeed' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' },
      ],
    });
    expect(r.buttons).toHaveLength(3);
    expect(r.buttons![0]!.title).toBe('A very long button…');
    expect(r.buttons![0]!.title.length).toBeLessThanOrEqual(LIMITS.buttonTitle);
  });

  it('caps a list at 10 rows across sections, drops empty sections, truncates row text', () => {
    const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: `${prefix} row number ${i} with a long name`, description: 'd'.repeat(100) }));
    const r = normaliseReply({ text: 't', list: { button: 'Choose a product please', sections: [{ title: 'S1', rows: rows(7, 'a') }, { title: 'S2', rows: rows(7, 'b') }, { title: 'S3', rows: rows(2, 'c') }] } });
    const all = r.list!.sections.flatMap((s) => s.rows);
    expect(all).toHaveLength(10);
    expect(r.list!.sections.map((s) => s.title)).toEqual(['S1', 'S2']);
    expect(r.list!.button.length).toBeLessThanOrEqual(LIMITS.buttonTitle);
    expect(all.every((row) => row.title.length <= LIMITS.rowTitle && (row.description ?? '').length <= LIMITS.rowDescription)).toBe(true);
  });

  it('keeps only one interactive kind: buttons > list > link', () => {
    const r = normaliseReply({ text: 't', buttons: [{ id: 'a', title: 'A' }], list: { button: 'L', sections: [{ title: 's', rows: [{ id: 'x', title: 'X' }] }] }, link: { label: 'Pay', url: 'https://x.test' } });
    expect(r.buttons).toHaveLength(1);
    expect(r.list).toBeUndefined();
    expect(r.link).toBeUndefined();
  });

  it('drops options whose id exceeds 64 bytes (Telegram callback_data) and caps text', () => {
    const r = normaliseReply({ text: 'x'.repeat(5000), buttons: [{ id: 'ok', title: 'OK' }, { id: 'z'.repeat(65), title: 'Too long' }] });
    expect(r.buttons!.map((b) => b.id)).toEqual(['ok']);
    expect(r.text.length).toBeLessThanOrEqual(LIMITS.text);
  });

  it('removes an empty buttons/list and never throws on odd input', () => {
    const r = normaliseReply({ text: 'hello', buttons: [], list: { button: 'b', sections: [] } });
    expect(r).toEqual({ text: 'hello' });
  });
});

describe('renderPlain & numbered choices', () => {
  const reply: BotReply = { text: 'What next?', buttons: [{ id: 'checkout', title: 'Checkout' }, { id: 'catalog', title: 'Keep shopping' }] };

  it('numbers the options', () => {
    expect(renderPlain(reply)).toBe('What next?\n\n1. Checkout\n2. Keep shopping\n\nReply with a number.');
  });

  it('renders list rows with descriptions and links as label: url', () => {
    expect(renderPlain({ text: 'Products', list: { button: 'Choose', sections: [{ title: 'Apparel', rows: [{ id: 'p1', title: 'Tee', description: '₹499' }] }] } }))
      .toBe('Products\n\n1. Tee — ₹499\n\nReply with a number.');
    expect(renderPlain({ text: 'Pay here', link: { label: 'Pay ₹998', url: 'https://rzp.io/i/x' } })).toBe('Pay here\n\nPay ₹998: https://rzp.io/i/x');
    expect(renderPlain({ text: 'Just text' })).toBe('Just text');
  });

  it('maps a numbered answer back to the option id', () => {
    const opts = optionsOf(reply);
    expect(opts).toEqual([{ id: 'checkout', title: 'Checkout' }, { id: 'catalog', title: 'Keep shopping' }]);
    expect(resolveNumberedChoice(' 2 ', opts)).toBe('catalog');
    expect(resolveNumberedChoice('3', opts)).toBeUndefined();
    expect(resolveNumberedChoice('order TEE 2', opts)).toBeUndefined();
  });
});

describe('unicode-safe truncation (T44)', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  it('never splits an emoji at the cut boundary', () => {
    const name = 'Mango Pickle Jars 🥭 extra large'; // emoji straddles the 20-char cut
    const r = normaliseReply({ text: 't', buttons: [{ id: 'a', title: name }] });
    expect(lone.test(r.buttons![0]!.title)).toBe(false);
    // whole code points only, AND within the stricter UTF-16 length (Meta doesn't specify how emoji are counted)
    expect(r.buttons![0]!.title).toBe('Mango Pickle Jars…');
    expect(r.buttons![0]!.title.length).toBeLessThanOrEqual(20);
    const list = normaliseReply({ text: 't', list: { button: 'Choose', sections: [{ title: 'S', rows: [{ id: 'p', title: 'Premium Basmati Rice 🍚🍚 5kg', description: '🌶'.repeat(80) }] }] } });
    const row = list.list!.sections[0]!.rows[0]!;
    expect(lone.test(row.title) || lone.test(row.description ?? '')).toBe(false);
  });
});
