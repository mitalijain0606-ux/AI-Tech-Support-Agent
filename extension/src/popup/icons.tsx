type IconProps = { className?: string };

export function CheckIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="10" cy="10" r="8.2" strokeLinecap="round" />
      <path d="M6.5 10.2l2.3 2.3L13.8 7.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AlertIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M10 2.6l8 14.8H2z" strokeLinejoin="round" />
      <path d="M10 8v3.6" strokeLinecap="round" />
      <circle cx="10" cy="14.2" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function EscalateIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="10" cy="10" r="8.2" />
      <path d="M7.5 12.5l5-5M8 7.5h4.5V12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BeakerIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M8 2.5h4M8.5 2.8v5l-4.3 7.4a1.6 1.6 0 001.4 2.3h8.8a1.6 1.6 0 001.4-2.3l-4.3-7.4v-5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.7 12.5h6.6" strokeLinecap="round" />
    </svg>
  );
}

/** Operon's mark: an orbit around a core — used in the header and the empty states. */
export function LogoMark({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden>
      <defs>
        <linearGradient id="op-mark" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a5b4fc" />
          <stop offset="0.55" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="10.5" stroke="url(#op-mark)" strokeWidth="2.6" />
      <ellipse cx="16" cy="16" rx="14" ry="5.2" transform="rotate(-32 16 16)" stroke="#fff" strokeOpacity=".55" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="3.4" fill="#fff" />
      <circle cx="27.4" cy="9.2" r="1.7" fill="#22d3ee" />
    </svg>
  );
}

export function SparkIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="currentColor" aria-hidden>
      <path d="M10 1.8l1.6 4.6 4.6 1.6-4.6 1.6L10 14.2l-1.6-4.6L3.8 8l4.6-1.6zM15.6 12.6l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" />
    </svg>
  );
}

export function ShieldIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
      <path d="M10 2.2l6.2 2.4v4.7c0 4-2.7 7-6.2 8.5-3.5-1.5-6.2-4.5-6.2-8.5V4.6z" strokeLinejoin="round" />
      <path d="M7.3 10l2 2 3.6-3.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SearchIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
      <circle cx="8.8" cy="8.8" r="5.6" />
      <path d="M13 13l4.2 4.2" strokeLinecap="round" />
    </svg>
  );
}

export function WrenchIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
      <path d="M12.6 3.2a4.2 4.2 0 00-5.1 5.4L3 13.1a1.9 1.9 0 002.7 2.7l4.5-4.5a4.2 4.2 0 005.4-5.1l-2.5 2.5-2.2-.4-.4-2.2z" strokeLinejoin="round" />
    </svg>
  );
}

export function KeyIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
      <circle cx="6.5" cy="13.5" r="3.4" />
      <path d="M9 11l7.5-7.5M14 6l2 2M12 8l1.5 1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M4 10h11M11 5.5l4.5 4.5-4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChatIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
      <path d="M3.5 5.5a2 2 0 012-2h9a2 2 0 012 2v6a2 2 0 01-2 2H9l-3.5 3v-3h0a2 2 0 01-2-2z" strokeLinejoin="round" />
    </svg>
  );
}
