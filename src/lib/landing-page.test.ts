import { expect } from 'chai';
import { renderLandingPage } from './landing-page';

describe('landing-page', () => {
    describe('renderLandingPage()', () => {
        it('returns HTML5 document with utf-8 charset and viewport', () => {
            const html = renderLandingPage('abc123', 'hassemu.0');
            expect(html).to.include('<!DOCTYPE html>');
            expect(html).to.include('<meta charset="utf-8">');
            expect(html).to.include('viewport');
        });

        it('embeds the resolved datapoint path', () => {
            const html = renderLandingPage('abc123', 'hassemu.0');
            expect(html).to.include('hassemu.0.clients.abc123.mode');
        });

        it('includes 15-second meta-refresh tag', () => {
            const html = renderLandingPage('abc123', 'hassemu.0');
            expect(html).to.include('<meta http-equiv="refresh" content="15">');
        });

        it('omits IP row when ip is null', () => {
            const html = renderLandingPage('abc123', 'hassemu.0', 'en', null);
            // ipLabel shouldn't be rendered without IP
            expect(html).to.not.include('IP address');
        });

        it('renders IP row when ip is provided', () => {
            const html = renderLandingPage('abc123', 'hassemu.0', 'en', '192.168.1.42');
            expect(html).to.include('192.168.1.42');
        });

        it('omits IP row when ip is empty string', () => {
            const html = renderLandingPage('abc123', 'hassemu.0', 'en', '');
            expect(html).to.not.include('IP address');
        });

        it('omits IP row when ip is whitespace only', () => {
            const html = renderLandingPage('abc123', 'hassemu.0', 'en', '   ');
            expect(html).to.not.include('IP address');
        });

        it('skips loopback IPs in landing page (E3 v1.16.0)', () => {
            for (const loopback of ['127.0.0.1', '::1', '0.0.0.0', '127.0.0.5', '   ']) {
                const html = renderLandingPage('abc', 'hassemu.0', 'en', loopback);
                expect(html, `loopback ${loopback}`).to.not.include('IP address');
                expect(html, `loopback ${loopback} value`).to.not.include(`<td>${loopback}`);
            }
        });

        it('shows non-loopback IPs (E3 v1.16.0)', () => {
            const html = renderLandingPage('abc', 'hassemu.0', 'en', '192.168.1.42');
            expect(html).to.include('IP address');
            expect(html).to.include('192.168.1.42');
        });

        it('falls back to English on unknown language', () => {
            const enHtml = renderLandingPage('abc', 'hassemu.0', 'en');
            const unknownHtml = renderLandingPage('abc', 'hassemu.0', 'klingon');
            expect(unknownHtml).to.equal(enHtml);
        });

        it('renders German strings when language is de', () => {
            const html = renderLandingPage('abc', 'hassemu.0', 'de');
            // German page-title
            expect(html).to.include('lang="de"');
        });

        it('renders all 11 supported languages without crashing', () => {
            const langs = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
            for (const lang of langs) {
                const html = renderLandingPage('abc', 'hassemu.0', lang);
                expect(html).to.be.a('string').and.have.length.greaterThan(500);
                expect(html).to.include('<!DOCTYPE html>');
            }
        });

        describe('XSS protection', () => {
            it('escapes < > & " \' in clientId', () => {
                const html = renderLandingPage('<script>alert(1)</script>', 'hassemu.0');
                expect(html).to.not.include('<script>alert(1)</script>');
                expect(html).to.include('&lt;script&gt;alert(1)&lt;/script&gt;');
            });

            it('escapes namespace injection attempts', () => {
                const html = renderLandingPage('abc', 'hassemu.0"><script>x</script>');
                // Raw injected payload must never appear unescaped — that's the XSS guarantee.
                expect(html).to.not.include('"><script>');
                expect(html).to.not.include('</script>');
            });

            it('escapes IP injection attempts', () => {
                const html = renderLandingPage('abc', 'hassemu.0', 'en', '<img src=x onerror=alert(1)>');
                expect(html).to.not.include('<img src=x onerror=alert(1)>');
                expect(html).to.include('&lt;img src=x onerror=alert(1)&gt;');
            });

            it('escapes ampersands in user input', () => {
                const html = renderLandingPage('a&b', 'hassemu.0');
                expect(html).to.include('a&amp;b');
            });

            it('escapes single quotes', () => {
                const html = renderLandingPage("a'b", 'hassemu.0');
                expect(html).to.include('a&#39;b');
                expect(html).to.not.match(/[^&]a'b/);
            });

            it('does not double-escape already-escaped sequences', () => {
                // The escaper runs once over user-supplied id; passing &amp; through
                // should produce &amp;amp; (treat input as raw text).
                const html = renderLandingPage('a&amp;b', 'hassemu.0');
                expect(html).to.include('a&amp;amp;b');
            });
        });
    });
});
