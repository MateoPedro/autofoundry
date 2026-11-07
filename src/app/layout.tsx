import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoFoundry — Autonomous company factory",
  description: "An autonomous company factory and accelerator. Built for the Naïve hackathon.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
