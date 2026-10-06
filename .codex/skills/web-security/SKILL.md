---
name: web-security
description: Reduce common web security risks while preserving application behavior.
---

# Web Security

Check relevant risks:
- XSS and unsafe HTML
- injection
- CSRF where applicable
- authentication/authorization boundaries
- secrets exposed to client code
- unsafe redirects
- insecure dependency usage
- untrusted file uploads
- sensitive data in logs
- insecure CORS or headers

Never expose secrets in frontend code.
Prefer framework/platform security primitives.
Do not weaken security controls merely to make development easier.
