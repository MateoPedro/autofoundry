import Link from "next/link";

// Placeholder until the real dashboard (#14) reads get_metrics. It shows no numbers,
// so nobody mistakes sample data for the foundry's live results.
export default function Home() {
  return (
    <main>
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="AutoFoundry home">
          <span className="brand-icon">A</span>AutoFoundry<span className="brand-dot">.</span>
        </Link>
        <span className="mode">
          <span /> Live foundry
        </span>
      </header>
      <section className="intro">
        <p className="eyebrow">THE AUTONOMOUS COMPANY FACTORY</p>
        <h1>
          A company that makes companies.
          <br />
          <span>The dashboard is on its way.</span>
        </h1>
        <p className="subtitle">
          Scout finds demand, Compliance checks it, Creator turns it into a company, and Funder decides which ones get money.
          This page will show their companies, funnels and decisions as they happen.
        </p>
      </section>
      <p className="notice">No companies have been spawned yet. Live numbers will appear here once the agents start working.</p>
      <footer>
        <span>AutoFoundry / Naïve Hackathon</span>
        <span>Built by Mateo & Felix</span>
      </footer>
    </main>
  );
}
