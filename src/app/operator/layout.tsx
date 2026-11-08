import type { Metadata } from "next";
import "./operator.css";

export const metadata: Metadata = { title: "AutoFoundry — Operator" };

export default function OperatorLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="operator">{children}</div>;
}
