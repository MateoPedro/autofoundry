import type { Metadata } from "next";
import { money, span } from "@/lib/site/view";
import { GraveCard } from "../components";
import { getSite } from "../data";

export const metadata: Metadata = { title: "Passed — AutoFoundry" };

export default async function Passed() {
  const site = await getSite();
  if (site.source === "error") return <div className="w"><p className="banner-err">{site.message}</p></div>;
  const dead = site.companies.filter((c) => c.status === "killed").sort((a, b) => (b.killed_at ?? "").localeCompare(a.killed_at ?? ""));
  const t = site.totals;
  const neverFunded = dead.filter((c) => !c.funded_at).length;

  return (
    <>
      <section className="page-head">
        <div className="w">
          <p className="eyebrow">Passed · {dead.length} companies</p>
          <h1>
            We kill our <em className="rust">darlings.</em>
          </h1>
          <p className="lede">
            Every company here was started by Creator and killed by VC, on evidence, with no human in the loop. Together they cost{" "}
            {money(t.killed_spend_micro_usd)}; half were dead within {t.median_minutes_to_kill === null ? "—" : span(t.median_minutes_to_kill)}.{" "}
            {neverFunded ? `${neverFunded} never got a cent, because VC saw they couldn't reach a buyer before funding them.` : ""}
          </p>
        </div>
      </section>
      <section className="section">
        <div className="w">
          <div className="graves">
            {dead.map((c) => (
              <GraveCard key={c.id} c={c} site={site} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
