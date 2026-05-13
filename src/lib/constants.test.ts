import { expect } from 'chai';
import { HA_VERSION, SESSION_TTL_MS, CLEANUP_INTERVAL_MS, LOGIN_SCHEMA, OAUTH_ACCESS_TOKEN_TTL_S } from './constants';

describe('constants', () => {
    describe('HA_VERSION', () => {
        it('should be a valid HA-style version string (year.month.patch)', () => {
            expect(HA_VERSION).to.be.a('string');
            expect(HA_VERSION).to.match(/^\d{4}\.\d+\.\d+$/);
        });

        it('should be from year 2026 or later', () => {
            const year = parseInt(HA_VERSION.split('.')[0], 10);
            expect(year).to.be.at.least(2026);
        });
    });

    describe('SESSION_TTL_MS', () => {
        it('should be a positive number', () => {
            expect(SESSION_TTL_MS).to.be.a('number');
            expect(SESSION_TTL_MS).to.be.greaterThan(0);
        });

        it('should be 10 minutes in milliseconds', () => {
            expect(SESSION_TTL_MS).to.equal(10 * 60 * 1000);
        });
    });

    describe('CLEANUP_INTERVAL_MS', () => {
        it('should be a positive number', () => {
            expect(CLEANUP_INTERVAL_MS).to.be.a('number');
            expect(CLEANUP_INTERVAL_MS).to.be.greaterThan(0);
        });

        it('should be 5 minutes in milliseconds', () => {
            expect(CLEANUP_INTERVAL_MS).to.equal(5 * 60 * 1000);
        });

        it('should be less than SESSION_TTL_MS', () => {
            expect(CLEANUP_INTERVAL_MS).to.be.lessThan(SESSION_TTL_MS);
        });
    });

    describe('LOGIN_SCHEMA', () => {
        it('should be an array', () => {
            expect(LOGIN_SCHEMA).to.be.an('array');
        });

        it('should have username and password fields', () => {
            expect(LOGIN_SCHEMA).to.have.lengthOf(2);

            const usernameField = LOGIN_SCHEMA.find(f => f.name === 'username');
            const passwordField = LOGIN_SCHEMA.find(f => f.name === 'password');

            expect(usernameField).to.exist;
            expect(passwordField).to.exist;
        });

        it('should have required fields', () => {
            for (const field of LOGIN_SCHEMA) {
                expect(field.required).to.be.true;
                expect(field.type).to.equal('string');
            }
        });
    });

    describe('OAUTH_ACCESS_TOKEN_TTL_S', () => {
        it('should be a positive number of seconds', () => {
            expect(OAUTH_ACCESS_TOKEN_TTL_S).to.be.a('number');
            expect(OAUTH_ACCESS_TOKEN_TTL_S).to.be.greaterThan(0);
        });

        it('should be 30 minutes in seconds (HA default)', () => {
            expect(OAUTH_ACCESS_TOKEN_TTL_S).to.equal(30 * 60);
        });
    });

});
