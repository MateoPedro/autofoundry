"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PAGES } from "./pages";

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="nav-links" aria-label="Site">
      {PAGES.map((p) => (
        <Link key={p.href} href={p.href} aria-current={path === p.href ? "page" : undefined}>
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
