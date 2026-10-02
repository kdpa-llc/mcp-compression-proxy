import { describe, expect, it } from '@jest/globals';
import { parse, normalize, equal } from 'fast-uri';
import { Address4, Address6, AddressError } from 'ip-address';

// Pure dependency behavior checks; no network exploit simulation.

describe('Host canonicalization across equivalent spellings', () => {
  it('folds decoded host case', () => {
    expect(parse('//%41.com').host).toBe('a.com');
  });

  it('normalizes the host idempotently', () => {
    expect(normalize('//%41.com')).toBe('//a.com');
    expect(normalize(normalize('//%41.com'))).toBe('//a.com');
  });

  it('compares encoded and literal hosts equally', () => {
    expect(equal('//%41.com', '//a.com')).toBe(true);
  });

  it('preserves path case', () => {
    expect(equal('//%41.com/Path', '//a.com/path')).toBe(false);
  });
});

describe('Address-family containment boundaries', () => {
  it.each(['isInSubnet', 'isHostInSubnet'] as const)('%s rejects IPv6 in IPv4', (method) => {
    expect(new Address6('a00::1')[method](new Address4('10.0.0.0/8'))).toBe(false);
  });

  it.each(['isInSubnet', 'isHostInSubnet'] as const)('%s rejects IPv4 in IPv6', (method) => {
    expect(new Address4('32.0.0.1')[method](new Address6('2000::/3'))).toBe(false);
  });

  it.each(['isInSubnet', 'isHostInSubnet'] as const)(
    '%s preserves same-family and explicit conversion controls',
    (method) => {
      expect(new Address4('10.0.0.1')[method](new Address4('10.0.0.0/8'))).toBe(true);
      expect(new Address4('8.8.8.8')[method](new Address4('10.0.0.0/8'))).toBe(false);
      expect(new Address6('2001:db8::1')[method](new Address6('2001:db8::/32'))).toBe(true);
      expect(new Address6('2001:db9::1')[method](new Address6('2001:db8::/32'))).toBe(false);
      expect(new Address6('::ffff:10.0.0.1').to4()[method](new Address4('10.0.0.0/8'))).toBe(true);
    }
  );
});

describe('Bounded IPv6 parsing diagnostics', () => {
  it('accepts the 45-character IPv6 boundary', () => {
    const address = 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255';
    expect(address).toHaveLength(45);
    expect(Address6.isValid(address)).toBe(true);
    expect(new Address6(address).correctForm()).toBe('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
  });

  it('rejects 46 characters without an amplified diagnostic', () => {
    const address = '!'.repeat(46);
    expect(() => new Address6(address)).toThrow(AddressError);
    try {
      new Address6(address);
    } catch (error) {
      expect(error).toBeInstanceOf(AddressError);
      expect((error as AddressError).parseMessage).toBeUndefined();
    }
    expect(Address6.isValid(address)).toBe(false);
  });
});
