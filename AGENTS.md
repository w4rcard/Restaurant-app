# Codex Web Development Rules

Use the matching skill when its description applies. Keep the active context small.

## Efficiency
- Search narrowly before reading broadly.
- Ignore generated/vendor/dependency directories unless relevant.
- Do not dump large files or logs into context.
- Make focused changes.
- Review the final diff.
- Verify with the smallest meaningful check.
- Never sacrifice correctness, accessibility, security, or required verification for token savings.

## Design
- Inspect an existing design system before changing it.
- Prefer coherent, reusable visual patterns over one-off styling.
- Treat responsive behavior, accessibility, interaction states, and motion as part of the design.
- Avoid generic AI-looking UI and unnecessary decorative effects.

## Motion
- Prefer purposeful, subtle animation.
- Favor transform/opacity for performance.
- Respect prefers-reduced-motion.
- Do not add animation libraries when existing CSS/platform capabilities are sufficient.
