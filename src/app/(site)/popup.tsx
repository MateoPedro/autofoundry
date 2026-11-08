"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

// A card that opens a pop-up. The card and the pop-up's content are rendered on the server; this only
// opens and closes a native <dialog>. The pop-up's id goes in the URL hash, so /passed#co-04 opens
// co-04 on load and a link can point straight at one.
export function Popup({ id, label, card, className, children }: { id: string; label: string; card: ReactNode; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  const open = useCallback(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    document.documentElement.classList.add("pop-open");
    if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  }, [id]);

  useEffect(() => {
    const fromHash = () => {
      if (decodeURIComponent(location.hash.slice(1)) === id) open();
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [id, open]);

  const onClose = () => {
    document.documentElement.classList.remove("pop-open");
    if (location.hash === `#${id}`) history.replaceState(null, "", location.pathname + location.search);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };

  return (
    <>
      <div role="button" tabIndex={0} aria-haspopup="dialog" aria-label={label} className={className} onClick={open} onKeyDown={onKey}>
        {card}
      </div>
      <dialog
        ref={ref}
        className="pop"
        aria-label={label}
        onClose={onClose}
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
      >
        <div className="pop-inner">
          <button type="button" className="pop-x" aria-label="Close" onClick={() => ref.current?.close()}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          {children}
        </div>
      </dialog>
    </>
  );
}
