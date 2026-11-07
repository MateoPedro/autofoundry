"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { createStudio, fundCompany, money, policy, spawnCompany, stopCompany, type Studio } from "@/lib/studio";

export default function Home() {
  const [studio, setStudio] = useState(createStudio);
  const [theme, setTheme] = useState("");
  const [selectedId, setSelectedId] = useState("briefly");
  const [message, setMessage] = useState("");
  const selected = studio.companies.find((company) => company.id === selectedId);
  const activeCount = studio.companies.filter((company) => company.status === "active").length;
  const spent = studio.companies.reduce((sum, company) => sum + company.spentCents, 0);

  function apply(action: () => Studio, success: string) {
    try { setStudio(action()); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Something went wrong."); }
  }

  function spawn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = crypto.randomUUID();
    try {
      setStudio(spawnCompany(studio, theme, id));
      setSelectedId(id);
      setTheme("");
      setMessage("Demo company created. Its agent roles are ready for integration.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to create company."); }
  }

  return (
    <main>
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="AutoFoundry home"><span className="brand-icon">A</span>AutoFoundry<span className="brand-dot">.</span></Link>
        <span className="mode"><span /> Demo workspace</span>
      </header>
      <section className="intro">
        <p className="eyebrow">THE AUTONOMOUS COMPANY FACTORY</p>
        <h1>One studio.<br /><span>Many possible futures.</span></h1>
        <p className="subtitle">Launch ideas, assemble agent teams, and back the companies worth building.</p>
      </section>
      <section className="stats" aria-label="Studio overview">
        <div><span>Active companies</span><strong>{activeCount}<small> / {policy.maxActiveCompanies}</small></strong></div>
        <div><span>Available capital</span><strong>{money(studio.availableCents)}</strong></div>
        <div><span>Simulated spend</span><strong>{money(spent)}</strong></div>
        <div><span>Portfolio leads</span><strong>{studio.companies.reduce((sum, company) => sum + company.leads, 0)}</strong></div>
      </section>
      <section className="launch-panel">
        <div><p className="eyebrow">BUILD THE NEXT ONE</p><h2>Start with a possibility.</h2><p>Give the studio a market or problem to explore.</p></div>
        <form onSubmit={spawn}>
          <label htmlFor="theme">Company theme</label>
          <div className="input-row"><input id="theme" value={theme} onChange={(event) => setTheme(event.target.value)} placeholder="e.g. tools for independent creators" minLength={2} maxLength={80} required /><button type="submit">Spawn company <span aria-hidden="true">↗</span></button></div>
          <p className="hint">Each company receives {money(policy.initialGrantCents)} in simulated starting capital.</p>
        </form>
      </section>
      <p className="notice" role="status" aria-live="polite">{message || "Sandbox mode: sample metrics and mock agent roles. Refreshing resets this workspace."}</p>
      <div className="portfolio-layout">
        <section className="portfolio">
          <div className="section-heading"><h2>The portfolio</h2><span>{studio.companies.length} companies</span></div>
          <div className="company-grid">{studio.companies.map((company, index) => (
            <article key={company.id} className={`company-card ${selectedId === company.id ? "selected" : ""}`}>
              <div className="card-top"><span className="company-number">{String(studio.companies.length - index).padStart(2, "0")}</span><span className={`status ${company.status}`}>{company.status}</span></div>
              <p className="company-theme">{company.theme}</p><h3>{company.name}</h3><p className="pitch">{company.pitch}</p>
              <dl className="company-metrics"><div><dt>Budget</dt><dd>{money(company.budgetCents)}</dd></div><div><dt>Leads</dt><dd>{company.leads}</dd></div><div><dt>Revenue</dt><dd>{money(company.revenueCents)}</dd></div></dl>
              <div className="card-actions"><button className="text-button" onClick={() => setSelectedId(company.id)} aria-pressed={selectedId === company.id}>View activity <span aria-hidden="true">→</span></button><button className="fund-button" disabled={company.status === "stopped"} onClick={() => apply(() => fundCompany(studio, company.id), `${company.name} received $100 in simulated funding.`)}>Fund +$100</button></div>
            </article>
          ))}</div>
        </section>
        <aside className="activity-panel">
          <p className="eyebrow">INSIDE THE COMPANY</p><h2>{selected?.name ?? "Select a company"}</h2>
          <p className="activity-caption">Company activity · demo events</p>
          <ol className="timeline">{selected?.activity.map((event, index) => <li key={`${index}-${event}`}><span className="timeline-dot" /><span>{event}</span></li>)}</ol>
          {selected?.status === "active" && <button className="stop-button" onClick={() => {
            if (window.confirm(`Stop ${selected.name} and return its unused simulated budget?`)) {
              apply(() => stopCompany(studio, selected.id), `${selected.name} stopped. Unused budget returned to the studio.`);
            }
          }}>Stop company</button>}
          <p className="aside-note">Budget rules cap each company at $500. Stopping returns its unused allocation to the studio.</p>
        </aside>
      </div>
      <footer><span>AutoFoundry / Naïve Hackathon</span><span>Built by Mateo & Felix</span></footer>
    </main>
  );
}
