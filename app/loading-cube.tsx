"use client";

export function LoadingCube({ className = "", label }: { className?: string; label?: string }) {
  return (
    <span
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      className={`loading-cube ${className}`.trim()}
      role={label ? "status" : undefined}
    >
      <span className="assistant-cube-scene" aria-hidden="true">
        <span className="assistant-cube">
          <span className="assistant-cube-face front" />
          <span className="assistant-cube-face back" />
          <span className="assistant-cube-face right" />
          <span className="assistant-cube-face left" />
          <span className="assistant-cube-face top" />
          <span className="assistant-cube-face bottom" />
        </span>
      </span>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
