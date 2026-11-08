import type { Metadata } from "next";
import { money } from "@/lib/site/view";
import { CompanyCard } from "../components";
import { getSite } from "../data";

export const metadata: Metadata = { title: "Portfolio — AutoFoundry" };

export default async function Portfolio() {
  const site = await getSite();
  if (site.source === "error") return <div className="w"><p className="banner-err">{site.message}</p></div>;
  const live = site.companies.filter((c) => c.status !== "killed" && c.status !== "failed");
  // Funded first, newest funding first; then the ones still waiting for VC.
  const sorted = [...live].sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || (b.funded_at ?? b.spawned_at).localeCompare(a.funded_at ?? a.spawned_at));
  const funded = live.filter((c) => c.status === "active");
  const reached = live.reduce((s, c) => s + c.funnel.contacted, 0);

  return (
    <>
      <section className="page-head">
        <div className="w">
          <p className="eyebrow">Portfolio · {live.length} alive</p>
          <h1>
            Still <em>growing.</em>
          </h1>
          <p className="lede">
            {funded.length} funded companies and {live.length - funded.length} waiting for VC&apos;s next pass. Between them they&apos;ve reached {reached} buyers
            for {money(live.reduce((s, c) => s + c.spend_micro_usd, 0))}. Click any company for its offer, its numbers and the agents running it.
          </p>
        </div>
      </section>
      <section className="section">
        <div className="w">
          <div className="cards">
            {sorted.map((c) => (
              <CompanyCard key={c.id} c={c} site={site} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
