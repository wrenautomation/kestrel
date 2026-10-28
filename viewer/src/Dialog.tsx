import { type ReactNode, useEffect, useRef } from "react";

/** A modal panel on the native <dialog>: Escape and a click outside close it. */
export function Dialog({
  className,
  onClose,
  children,
}: {
  className: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    d.showModal();
    d.querySelector<HTMLElement>("input, textarea")?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {children}
    </dialog>
  );
}
