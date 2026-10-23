export function ScrollingSpinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={`animate-spin text-slate-400 ${className}`}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-25" />
      <path d="M12 3v3M12 18v3M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M3 12h3M18 12h3M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
