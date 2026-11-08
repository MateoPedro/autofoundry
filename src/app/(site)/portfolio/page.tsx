import type { Metadata } from "next";
import Link from "next/link";
import { money, span } from "@/lib/site/view";
import { CompanyCard, GraveCard } from "../components";
import { getSite } from "../data";

export const metadata: Metadata = { title: "Portfolio — AutoFoundry" };

export default async function Portfolio({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const site = await getSite();
  if (site.source === "error") return <div className="w"><p className="banner-err">{site.message}</p></div>;
  const killedView = (await searchParams).view === "killed";
  const live = site.companies.filter((c) => c.status !== "killed" && c.status !== "failed");
  // Funded first, newest funding first; then the ones still waiting for VC.
  const sorted = [...live].sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || (b.funded_at ?? b.spawned_at).localeCompare(a.funded_at ?? a.spawned_at));
  const funded = live.filter((c) => c.status === "active");
  const reached = live.reduce((s, c) => s + c.funnel.contacted, 0);
  const dead = site.companies.filter((c) => c.status === "killed").sort((a, b) => (b.killed_at ?? "").localeCompare(a.killed_at ?? ""));
  const t = site.totals;
  const neverFunded = dead.filter((c) => !c.funded_at).length;

  return (
    <>
      <section className="page-head">
        <div className="w">
          <p className="eyebrow">
            <span className="n">003/</span>Portfolio · {killedView ? `${dead.length} killed` : `${live.length} alive`}
          </p>
          {killedView ? (
            <>
              <h1>
                We kill our <em>darlings.</em>
              </h1>
              <p className="lede">
                Every company here was started by Creator and killed by VC, on evidence, with no human in the loop. Together they cost{" "}
                {money(t.killed_spend_micro_usd)}; half were dead within {t.median_minutes_to_kill === null ? "—" : span(t.median_minutes_to_kill)}.{" "}
                {neverFunded ? `${neverFunded} never got a cent, because VC saw they couldn't reach a buyer before funding them.` : ""}
              </p>
            </>
          ) : (
            <>
              <h1>
                Still <em>growing.</em>
              </h1>
              <p className="lede">
                {funded.length} funded companies and {live.length - funded.length} waiting for VC&apos;s next pass. Between them they&apos;ve reached {reached} buyers
                for {money(live.reduce((s, c) => s + c.spend_micro_usd, 0))}. Click any company for its offer, its numbers and the agents running it.
              </p>
            </>
          )}
          <nav className="toggle" aria-label="Companies">
            <Link href="/portfolio" aria-current={killedView ? undefined : "page"}>
              Alive <b>{live.length}</b>
            </Link>
            <Link href="/portfolio?view=killed" aria-current={killedView ? "page" : undefined}>
              Killed <b>{dead.length}</b>
            </Link>
          </nav>
        </div>
      </section>
      <section className="section">
        <div className="w">
          {killedView ? (
            <div className="graves">
              {dead.map((c) => (
                <GraveCard key={c.id} c={c} site={site} />
              ))}
            </div>
          ) : (
            <div className="cards">
              {sorted.map((c) => (
                <CompanyCard key={c.id} c={c} site={site} />
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
