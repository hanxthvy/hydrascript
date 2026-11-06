<!-- [xihanzu-NR] -->
# Security Policy

## Supported Versions

Only the latest published release of HydraScript receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| >= 0.13 | :white_check_mark: |
| < 0.13  | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within HydraScript, please do **NOT** open a public issue.

Instead, please report security vulnerabilities via one of the following channels:
1. **GitHub Private Vulnerability Reporting**: Use the "Report a vulnerability" button under the **Security** tab of this repository.
2. **Direct Email**: Send details directly to `contact@hanz.dev`.

Please include:
- A clear description of the vulnerability and its potential impact.
- Exact steps to reproduce, proof of concept, or minimal test case.
- Any suggested fixes or mitigations if available.

We will acknowledge receipt within 48 hours and work with you to coordinate a disclosure timeline and patch release.

## Scope & Architectural Defenses

HydraScript provides built-in defenses in its server layer (`hydra dev`, `hydra preview`, `hydra serve`):
- **Origin check on action POSTs**: Cross-origin form POSTs are refused to prevent CSRF.
- **Default response headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy`.
- **Request size limit**: Configurable request body limit (`server.bodyLimit`), defaulting to 1 MiB with a clean 413 reply.
- **Rate limiting**: Configurable per-IP rate limiting via `server.rateLimit`.
- **Environment isolation**: Only variables prefixed with `PUBLIC_` are reachable by client bundles; non-public variables read by client code trigger compile/build errors.

Content Security Policy (CSP) is intentionally left to the project operator (configured via `server.headers` in `hydraconfig.json`) because arbitrary third-party resources vary per project.
