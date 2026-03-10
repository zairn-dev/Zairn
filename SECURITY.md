# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainers or use [GitHub Security Advisories](https://github.com/otanl/zairn/security/advisories/new)
3. Include a description of the vulnerability and steps to reproduce

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Security Considerations

### Row Level Security (RLS)

All database tables use Supabase RLS policies. When adding new tables:

- Always enable RLS: `ALTER TABLE new_table ENABLE ROW LEVEL SECURITY;`
- Add appropriate SELECT/INSERT/UPDATE/DELETE policies
- Test that users cannot access other users' data

### API Keys

- Never commit `.env` files (enforced by `.gitignore`)
- Use `VITE_` prefix only for public-safe keys (Supabase anon key)
- IPFS pinning keys and service role keys must remain server-side

### Encryption

GeoDrop uses AES-256-GCM for content encryption with location-derived keys. The encryption salt is stored separately from the encrypted content to prevent single-point compromise.

### GPS Spoofing

The GeoDrop SDK includes movement-speed validation to detect unrealistic location jumps. This is a basic countermeasure; production deployments should add server-side validation.
