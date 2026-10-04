/** The little isometric office that stands for the app. Drawn here; nothing borrowed. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="brand-mark">
      <polygon points="4,13 16,19 16,30 4,24" fill="#e8e0c3" />
      <polygon points="16,19 28,13 28,24 16,30" fill="#b9cfbd" />
      <polygon points="4,13 16,7 28,13 16,19" fill="var(--accent)" />
      <g fill="#7fa89a">
        <polygon points="7,17 10,18.5 10,21 7,19.5" />
        <polygon points="12,19.5 14,20.5 14,23 12,22" />
        <polygon points="18,20.5 20,19.5 20,22 18,23" />
        <polygon points="22,18.5 25,17 25,19.5 22,21" />
      </g>
    </svg>
  );
}
