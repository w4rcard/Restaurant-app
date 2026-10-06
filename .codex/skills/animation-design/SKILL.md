---
name: animation-design
description: Create smooth, purposeful, performant web animations and microinteractions.
---

# Animation Design

Use animation to communicate state, hierarchy, continuity, and feedback.

## Principles
- Prefer subtle, purposeful motion.
- Keep timing consistent across the product.
- Use transform and opacity for performant transitions when possible.
- Use ease-out for entrances and ease-in for exits when appropriate.
- Animate state changes rather than decorating every element.
- Add polished hover, focus, press, loading, success, and navigation transitions.
- Use staggered reveals for grouped content sparingly.
- Preserve immediate interaction; do not make users wait for decoration.
- Avoid `transition: all` when specific properties are sufficient.
- Respect `prefers-reduced-motion`.
- Do not add an animation library if CSS/Web Animations API is sufficient.
- If Motion/Framer Motion already exists, use the existing approach instead of introducing a duplicate.
- Avoid layout-triggering animations when transform/opacity can achieve the effect.
- Verify animation performance on lower-powered devices.
