import { describe, expect, it } from 'vitest';

import { href, parseRoute } from '@/lib/route';

describe('the screen in the address bar', () => {
  it('reads the screen and its parameter', () => {
    expect(parseRoute('#/approvals')).toEqual({ screen: 'approvals', param: null });
    expect(parseRoute('#/evidence/0xabc')).toEqual({ screen: 'evidence', param: '0xabc' });
  });

  it('falls back to the live feed for anything it does not know', () => {
    expect(parseRoute('')).toEqual({ screen: 'feed', param: null });
    expect(parseRoute('#/settings')).toEqual({ screen: 'feed', param: null });
  });

  it('writes links that read back the same', () => {
    expect(href('ledger')).toBe('#/ledger');
    expect(parseRoute(href('evidence', '0xabc'))).toEqual({ screen: 'evidence', param: '0xabc' });
  });
});
