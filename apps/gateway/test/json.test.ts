import { describe, expect, it } from 'vitest';

import { type Json, canonicalize, isJson } from '../src/protocol/json';

describe('canonicalize (RFC 8785)', () => {
  // The two RFC examples are built from code points, so this file holds no escape sequences that an
  // editor or a tool could rewrite on the way.
  const BACKSLASH = String.fromCharCode(92);
  const QUOTE = String.fromCharCode(34);

  it('matches the example in RFC 8785 section 3.2.2', () => {
    const input: Json = {
      // The first number has more digits than a double can hold, on purpose: RFC 8785 rounds it.
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      // Euro sign, dollar, U+000F, line feed, A, apostrophe, B, quote, two backslashes, quote, slash
      string: [
        String.fromCodePoint(0x20ac),
        '$',
        String.fromCodePoint(0x0f),
        String.fromCodePoint(0x0a),
        "A'B",
        QUOTE,
        BACKSLASH,
        BACKSLASH,
        QUOTE,
        '/',
      ].join(''),
      literals: [null, true, false],
    };

    const expectedString = [
      QUOTE,
      String.fromCodePoint(0x20ac),
      '$',
      `${BACKSLASH}u000f`,
      `${BACKSLASH}n`,
      "A'B",
      `${BACKSLASH}${QUOTE}`,
      `${BACKSLASH}${BACKSLASH}`,
      `${BACKSLASH}${BACKSLASH}`,
      `${BACKSLASH}${QUOTE}`,
      '/',
      QUOTE,
    ].join('');

    expect(canonicalize(input)).toBe(
      `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":${expectedString}}`,
    );
  });

  it('sorts keys by UTF-16 code units, as in RFC 8785 section 3.2.3', () => {
    const input: Json = {
      [String.fromCodePoint(0x20ac)]: 'Euro Sign',
      [String.fromCodePoint(0x0d)]: 'Carriage Return',
      [String.fromCodePoint(0xfb33)]: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      [String.fromCodePoint(0x1f600)]: 'Emoji: Grinning Face',
      [String.fromCodePoint(0x80)]: 'Control',
      [String.fromCodePoint(0xf6)]: 'Latin Small Letter O With Diaeresis',
    };

    // Read the values in the order they appear in the canonical text. (Parsing the text back into an
    // object would not do: JavaScript lists number-like keys such as "1" first.)
    const values = [...canonicalize(input).matchAll(/:"([^"]+)"/g)].map((match) => match[1]);
    expect(values).toEqual([
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]);
  });

  it('gives the same bytes whatever order the keys were written in', () => {
    const a: Json = { b: 1, a: { d: [1, 2, { z: null, y: true }], c: 'x' } };
    const b: Json = { a: { c: 'x', d: [1, 2, { y: true, z: null }] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"c":"x","d":[1,2,{"y":true,"z":null}]},"b":1}');
  });

  it('keeps array order and writes no whitespace', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize({ 'a b': ' c ' })).toBe('{"a b":" c "}');
  });

  it('writes numbers the way ECMAScript does', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(1e21)).toBe('1e+21');
    expect(canonicalize(0.1)).toBe('0.1');
    expect(canonicalize(1794538800)).toBe('1794538800');
  });

  it('rejects values that are not JSON', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize(String.fromCharCode(0xd800))).toThrow(TypeError);
    expect(() => canonicalize({ a: undefined } as unknown as Json)).toThrow(TypeError);
    expect(() => canonicalize({ a: 1n } as unknown as Json)).toThrow(TypeError);
    expect(() => canonicalize(new Date(0) as unknown as Json)).toThrow(TypeError);
  });
});

describe('isJson', () => {
  it('accepts plain JSON and rejects everything else', () => {
    expect(isJson({ a: [1, 'two', null, true, { b: {} }] })).toBe(true);
    expect(isJson(undefined)).toBe(false);
    expect(isJson({ a: undefined })).toBe(false);
    expect(isJson({ a: 1n })).toBe(false);
    expect(isJson({ a: Number.NaN })).toBe(false);
    expect(isJson({ a: String.fromCharCode(0xd800) })).toBe(false);
    expect(isJson(new Map())).toBe(false);
  });

  it('rejects structures nested too deeply to be an honest request', () => {
    let deep: Json = 'leaf';
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(isJson(deep)).toBe(false);
  });
});
