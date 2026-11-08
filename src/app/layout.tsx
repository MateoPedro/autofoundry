import type { Metadata } from "next";
import { Geist_Mono, Inter, Inter_Tight } from "next/font/google";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const display = Inter_Tight({ subsets: ["latin"], weight: ["300", "400"], variable: "--font-display" });
const mono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "AutoFoundry — Grow or die",
  description: "An autonomous company factory run by agents. They find demand, start companies, fund what works and kill what doesn't.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
