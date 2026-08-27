/**
 * The Attest mark.
 *
 * Inlined as JSX rather than loaded as an <img> so it inherits the theme
 * tokens: the same component is correct on paper and on the dark ground
 * without shipping two files or a media query.
 *
 * See docs/BRAND.md for what the shapes mean and the minimum sizes.
 */

const MIN_MARK_PX = 16;

export function LogoMark({ size = 32, title = 'Attest', ...rest }) {
  if (import.meta.env?.DEV && size < MIN_MARK_PX) {
    console.warn(
      `LogoMark rendered at ${size}px; below ${MIN_MARK_PX}px the rule and the ` +
        `check merge into a single smudge. See docs/BRAND.md.`,
    );
  }

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      {...rest}
    >
      <title>{title}</title>
      {/* The seal. Uses the fixed ink rather than a token: the seal is the one
          element that must stay dark in both themes, the way a stamp does. */}
      <rect x="1.5" y="1.5" width="29" height="29" rx="9.5" fill="#0F1518" />
      {/* The rule — ledger line and signature line. */}
      <line
        x1="9.1"
        y1="22.6"
        x2="22.9"
        y2="22.6"
        stroke="#FAF9F6"
        strokeOpacity="0.4"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {/* The check, made on the rule. A mark on a line is a signature. */}
      <path
        d="M11.9 15.1 L16 19.5 L22.4 9.4"
        fill="none"
        stroke="#5FA89C"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Mark + wordmark. The gap between them is 12px — the mark's own corner
 * radius — so the spacing and the silhouette come from the same measurement.
 */
export function Logo({ size = 32, title = 'Attest', ...rest }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
      }}
      {...rest}
    >
      <LogoMark size={size} title={title} />
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: size * 0.72,
          fontWeight: 500,
          letterSpacing: '-0.01em',
          color: 'var(--ink-900)',
          lineHeight: 1,
        }}
      >
        Attest
      </span>
    </span>
  );
}

export default Logo;
