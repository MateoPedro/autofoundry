import Link from "next/link";
import { pt } from "@/lib/site/view";
import { Ticker } from "./components";
import { getSite } from "./data";
import { NavLinks } from "./nav";
import { PAGES } from "./pages";
import "./site.css";

export const dynamic = "force-dynamic";

export default async function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const site = await getSite();
  const live = site.source !== "error";
  return (
    <div className="site">
      {site.source === "snapshot" ? <div className="snapshot">Snapshot of the foundry database taken {pt(site.as_of, true)} PT, not live</div> : null}
      <header className="nav">
        <div className="w">
          <Link href="/" className="brand" aria-label="AutoFoundry home">
            <span className="brand-mark">A</span>
            AutoFoundry
          </Link>
          <NavLinks />
          <span className="live" title={live ? `As of ${pt(site.as_of, true)} PT` : undefined}>
            <span className={`pulse${live && site.running !== false ? "" : " off"}`} />
            {!live ? "Offline" : site.running === false ? "Paused" : "Running"}
          </span>
        </div>
      </header>
      {live ? <Ticker site={site} /> : null}
      <main>{children}</main>
      <footer className="foot">
        <div className="w">
          <div>
            <p className="big serif">
              Grow, or <em>die</em>.
            </p>
            <small>
              AutoFoundry is a venture firm run by agents on Naïve. Built at the Naïve Autonomous Company Hackathon, Y Combinator, November 2026.
            </small>
          </div>
          <div>
            <h4>The firm</h4>
            <ul>
              {PAGES.map((p) => (
                <li key={p.href}>
                  <Link href={p.href}>{p.label}</Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Operators</h4>
            <ul>
              <li>
                <Link href="/operator">Operator dashboard</Link>
              </li>
              <li>
                <a href="/mcp">Foundry MCP endpoint</a>
              </li>
            </ul>
          </div>
        </div>
      </footer>
    </div>
  );
}
