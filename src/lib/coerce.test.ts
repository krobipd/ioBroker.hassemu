import { expect } from 'chai';
import {
    coerceFiniteNumber,
    coerceString,
    coerceBoolean,
    coerceUuid,
    coerceSafeUrl,
    coerceSafeUrlReason,
    isPlainObject,
    safeStringEqual,
} from './coerce';

describe('coerce', () => {
    describe('coerceFiniteNumber', () => {
        it('accepts finite numbers', () => {
            expect(coerceFiniteNumber(0)).to.equal(0);
            expect(coerceFiniteNumber(42)).to.equal(42);
            expect(coerceFiniteNumber(-3.14)).to.equal(-3.14);
        });

        it('parses numeric strings', () => {
            expect(coerceFiniteNumber('42')).to.equal(42);
            expect(coerceFiniteNumber('-3.14')).to.equal(-3.14);
        });

        it('rejects NaN and Infinity', () => {
            expect(coerceFiniteNumber(NaN)).to.be.null;
            expect(coerceFiniteNumber(Infinity)).to.be.null;
            expect(coerceFiniteNumber(-Infinity)).to.be.null;
        });

        it('rejects empty string', () => {
            expect(coerceFiniteNumber('')).to.be.null;
        });

        it('rejects non-numeric strings', () => {
            expect(coerceFiniteNumber('abc')).to.be.null;
            expect(coerceFiniteNumber('12abc')).to.be.null;
        });

        it('rejects null / undefined / objects / arrays / booleans', () => {
            expect(coerceFiniteNumber(null)).to.be.null;
            expect(coerceFiniteNumber(undefined)).to.be.null;
            expect(coerceFiniteNumber({})).to.be.null;
            expect(coerceFiniteNumber([1])).to.be.null;
            expect(coerceFiniteNumber(true)).to.be.null;
        });
    });

    describe('coerceString', () => {
        it('accepts non-empty strings', () => {
            expect(coerceString('hello')).to.equal('hello');
            expect(coerceString(' ')).to.equal(' ');
        });

        it('rejects empty string', () => {
            expect(coerceString('')).to.be.null;
        });

        it('rejects non-strings', () => {
            expect(coerceString(42)).to.be.null;
            expect(coerceString(null)).to.be.null;
            expect(coerceString(undefined)).to.be.null;
            expect(coerceString({})).to.be.null;
            expect(coerceString([])).to.be.null;
            expect(coerceString(true)).to.be.null;
        });
    });

    describe('coerceBoolean', () => {
        it('accepts true and false', () => {
            expect(coerceBoolean(true)).to.equal(true);
            expect(coerceBoolean(false)).to.equal(false);
        });

        it('rejects truthy / falsy non-booleans', () => {
            expect(coerceBoolean(1)).to.be.null;
            expect(coerceBoolean(0)).to.be.null;
            expect(coerceBoolean('true')).to.be.null;
            expect(coerceBoolean('false')).to.be.null;
            expect(coerceBoolean('')).to.be.null;
            expect(coerceBoolean(null)).to.be.null;
            expect(coerceBoolean(undefined)).to.be.null;
            expect(coerceBoolean({})).to.be.null;
        });
    });

    describe('isPlainObject', () => {
        it('accepts plain objects', () => {
            expect(isPlainObject({})).to.be.true;
            expect(isPlainObject({ a: 1 })).to.be.true;
            expect(isPlainObject(Object.create(null))).to.be.true;
        });

        it('rejects arrays', () => {
            expect(isPlainObject([])).to.be.false;
            expect(isPlainObject([1, 2])).to.be.false;
        });

        it('rejects null / undefined / primitives', () => {
            expect(isPlainObject(null)).to.be.false;
            expect(isPlainObject(undefined)).to.be.false;
            expect(isPlainObject(42)).to.be.false;
            expect(isPlainObject('str')).to.be.false;
            expect(isPlainObject(true)).to.be.false;
        });
    });

    describe('coerceUuid', () => {
        it('accepts valid UUIDs (any version)', () => {
            expect(coerceUuid('12345678-1234-1234-1234-123456789abc')).to.equal('12345678-1234-1234-1234-123456789abc');
            expect(coerceUuid('abcdef12-3456-4789-abcd-ef1234567890')).to.equal('abcdef12-3456-4789-abcd-ef1234567890');
        });

        it('lowercases the output', () => {
            expect(coerceUuid('ABCDEF12-3456-4789-ABCD-EF1234567890')).to.equal('abcdef12-3456-4789-abcd-ef1234567890');
        });

        it('rejects malformed strings', () => {
            expect(coerceUuid('not-a-uuid')).to.be.null;
            expect(coerceUuid('')).to.be.null;
            expect(coerceUuid('12345678-1234-1234-1234')).to.be.null;
            expect(coerceUuid('12345678-1234-1234-1234-123456789abcZ')).to.be.null;
        });

        it('rejects non-strings', () => {
            expect(coerceUuid(null)).to.be.null;
            expect(coerceUuid(42)).to.be.null;
            expect(coerceUuid({})).to.be.null;
            expect(coerceUuid([])).to.be.null;
        });
    });

    describe('coerceSafeUrl', () => {
        it('accepts http and https URLs', () => {
            expect(coerceSafeUrl('http://example.com')).to.equal('http://example.com');
            expect(coerceSafeUrl('https://example.com/path')).to.equal('https://example.com/path');
            expect(coerceSafeUrl('http://192.168.1.10:8082/vis/')).to.equal('http://192.168.1.10:8082/vis/');
        });

        it('rejects dangerous schemes', () => {
            expect(coerceSafeUrl('javascript:alert(1)')).to.be.null;
            expect(coerceSafeUrl('data:text/html,<script>')).to.be.null;
            expect(coerceSafeUrl('file:///etc/passwd')).to.be.null;
            expect(coerceSafeUrl('ftp://example.com')).to.be.null;
        });

        it('rejects URLs with embedded credentials', () => {
            expect(coerceSafeUrl('http://user:pass@example.com')).to.be.null;
            expect(coerceSafeUrl('https://admin@example.com')).to.be.null;
        });

        it('rejects unparseable strings', () => {
            expect(coerceSafeUrl('not a url')).to.be.null;
            expect(coerceSafeUrl('http://')).to.be.null;
            expect(coerceSafeUrl('://example.com')).to.be.null;
        });

        it('rejects empty and overlong strings', () => {
            expect(coerceSafeUrl('')).to.be.null;
            const longUrl = `http://example.com/${'a'.repeat(2048)}`;
            expect(coerceSafeUrl(longUrl)).to.be.null;
        });

        it('rejects non-strings', () => {
            expect(coerceSafeUrl(null)).to.be.null;
            expect(coerceSafeUrl(42)).to.be.null;
            expect(coerceSafeUrl({})).to.be.null;
        });
    });

    describe('coerceSafeUrlReason (E4 v1.16.0)', () => {
        it('returns safe + null reason for OK URLs', () => {
            const r = coerceSafeUrlReason('http://example.com/');
            expect(r.safe).to.equal('http://example.com/');
            expect(r.reason).to.be.null;
        });

        it('reports bad-scheme for javascript:', () => {
            const r = coerceSafeUrlReason('javascript:alert(1)');
            expect(r.safe).to.be.null;
            expect(r.reason).to.equal('bad-scheme:javascript:');
        });

        it('reports bad-scheme for data:', () => {
            const r = coerceSafeUrlReason('data:text/html,<script>x</script>');
            expect(r.safe).to.be.null;
            expect(r.reason).to.equal('bad-scheme:data:');
        });

        it('reports credentials-in-url for user:pass URLs', () => {
            const r = coerceSafeUrlReason('https://user:pass@example.com/');
            expect(r.safe).to.be.null;
            expect(r.reason).to.equal('credentials-in-url');
        });

        it('reports unparseable for malformed strings', () => {
            const r = coerceSafeUrlReason('not a url');
            expect(r.safe).to.be.null;
            expect(r.reason).to.equal('unparseable');
        });

        it('reports empty for empty string', () => {
            const r = coerceSafeUrlReason('');
            expect(r.safe).to.be.null;
            expect(r.reason).to.equal('empty');
        });

        it('reports too-long for >2048 chars', () => {
            const r = coerceSafeUrlReason('http://x.com/' + 'a'.repeat(2050));
            expect(r.safe).to.be.null;
            expect(r.reason).to.equal('too-long');
        });

        it('reports not-a-string for non-strings', () => {
            const r = coerceSafeUrlReason(42);
            expect(r.safe).to.be.null;
            expect(r.reason).to.equal('not-a-string');
        });
    });

    describe('safeStringEqual (F5 v1.22.0)', () => {
        it('returns true for identical strings', () => {
            expect(safeStringEqual('admin', 'admin')).to.be.true;
        });

        it('returns false for different strings of same length', () => {
            expect(safeStringEqual('admin', 'admit')).to.be.false;
        });

        it('returns false for different lengths (no length-leak via early-return)', () => {
            expect(safeStringEqual('admin', 'administrator')).to.be.false;
            expect(safeStringEqual('a', 'aaaaaaaaaa')).to.be.false;
        });

        it('returns true for empty strings', () => {
            expect(safeStringEqual('', '')).to.be.true;
        });

        it('handles UTF-8 correctly', () => {
            expect(safeStringEqual('Häuser', 'Häuser')).to.be.true;
            expect(safeStringEqual('Häuser', 'Hauser')).to.be.false;
        });
    });
});
