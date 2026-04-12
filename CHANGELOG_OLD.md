# Older Changes

## 0.8.11 (2026-03-28)
- Add error middleware for malformed JSON requests (returns 400 instead of 500)

## 0.8.10 (2026-03-28)
- Consistent admin UI i18n keys (supportHeader)
- Add PayPal to FUNDING.yml

## 0.8.9 (2026-03-28)
- Use adapter timer methods (setInterval/clearInterval) instead of native timers
- Add Windows and macOS to CI test matrix
- README: standard license format with full MIT text
- Split old changelog entries into CHANGELOG_OLD.md

## 0.8.8 (2026-03-25)
- Simplified admin UI from tabs to single page layout
- Fixed onUnload to be synchronous (prevents SIGKILL on shutdown)
- Removed broken Ko-fi icon from donation button
- Added translate script

## 0.6.2 (2026-03-15)
- Full JSDoc documentation for all TypeScript interfaces, classes and methods
- ESLint runs without warnings (0 errors, 0 warnings)

## 0.6.1 (2026-03-15)
- Add GitHub Actions CI (Node.js 20, 22, 24)
- Add GitHub Actions Release (automatic release on tag push)

## 0.6.0 (2026-03-15)
- Full TypeScript migration (src/ and tests)
- Strict mode enabled
- Separate tsconfig for build and test

## 0.5.2 (2026-03-14)
- Migrate to @iobroker/eslint-config
- Prettier code formatting
- ESM module configs (.mjs)

## 0.5.1 (2026-03-14)
- Update HA_VERSION from 2024.12.0 to 2026.3.1

## 0.5.0 (2026-03-14)
- Express 4.x to 5.2.1
- ESLint 9.x to 10.0.3
- All dependencies updated to March 2026 versions

## 0.4.0 (2026-03-14)
- **Breaking:** Node.js 20+ required (was 18+)
- **Breaking:** js-controller 7.0.0+ required (was 5.0.0+)
- **Breaking:** Admin 7.0.0+ required (was 6.0.0+)
- jsonConfig Admin UI (replaces Materialize)
- Encrypted password storage (encryptedNative/protectedNative)
- SVG adapter icon

## 0.3.0 (2026-02-18)
- Fix mdns.js XML closing tag (`</n>` → `</name>`) — mDNS discovery was broken
- Fix `requires_api_password` in /api/discovery_info (was dynamic instead of hardcoded true)
- Fix token refresh (grant_type: refresh_token was not supported)
- Remove `uuid` and `body-parser` dependencies (use Node.js built-ins)
- Extract constants (HA_VERSION, LOGIN_SCHEMA, SESSION_TTL_MS)
- Session cleanup timer (every 5 min)
- Request logging moved to debug level

## 0.2.0 (2026-02-01)
- Remove proxy function
- Use Avahi only for mDNS
- Remove CORS

## 0.1.0 (2026-02-01)
- Initial release
- Home Assistant API emulation
- OAuth2-like authentication flow
- mDNS service discovery
- Redirect to configurable URL
