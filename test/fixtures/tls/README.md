# TLS test fixtures

Test-only keys and self-signed certificates for `src/lib/tls.test.ts` and the HTTPS tests of `src/lib/webserver.test.ts`.
Generated once on 2026-11-11 with OpenSSL 3.6 (EC P-256, valid 100 years); they protect nothing and are used nowhere else.

| Files                         | Subject                  | subjectAltName                                                |
| ----------------------------- | ------------------------ | ------------------------------------------------------------- |
| `named.key` / `named.crt`     | `CN=cn-of-named.example` | `DNS:*.wild.example, DNS:display-test.example, IP:192.0.2.50` |
| `cn-only.key` / `cn-only.crt` | `CN=cn-only.example`     | none                                                          |
| `le.key` / `le.crt`           | `CN=le.example`          | `DNS:le.example, DNS:*.le.example`                            |
