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
