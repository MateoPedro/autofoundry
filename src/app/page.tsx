import Link from "next/link";
import { loadDashboard } from "@/lib/server/dashboard";
import { clockTime } from "@/lib/dashboard/view";
import { CompanyView, DecisionLog, Funnels, Lineage, Pool, Stats } from "./dashboard";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function Home({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const forceSample = first(params.sample) === "1";
  const dashboard = await loadDashboard({ focus: first(params.company), sample: forceSample });
  const href = (focus: string) => `/?${forceSample ? "sample=1&" : ""}company=${encodeURIComponent(focus)}#company`;

  return (
    <main>
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="AutoFoundry home">
          <span className="brand-icon">A</span>AutoFoundry<span className="brand-dot">.</span>
        </Link>
        {dashboard.source === "live" ? (
          <span className="mode">
            <span /> Live foundry · {clockTime(dashboard.metrics.as_of)} PT
          </span>
        ) : dashboard.source === "sample" ? (
          <span className="mode sample">
            <span /> Sample data
          </span>
        ) : (
          <span className="mode down">
            <span /> Foundry unreachable
          </span>
        )}
      </header>

      <section className="intro">
        <p className="eyebrow">THE AUTONOMOUS COMPANY FACTORY</p>
        <h1>A company that makes companies.</h1>
        <p className="subtitle">
          Scout finds demand, Compliance checks it, Creator turns it into a company, and VC decides which ones get money. Everything
          below was decided by those agents.
        </p>
      </section>

      {dashboard.source === "error" ? (
        <p className="banner down">{dashboard.message}</p>
      ) : (
        <>
          {dashboard.source === "sample" ? (
            <p className="banner sample">
              <b>Sample data.</b> These are the made-up numbers from the foundry contract, shown because{" "}
              {forceSample ? "this page was opened with ?sample=1" : "this server has no foundry database"}. None of it is real.
            </p>
          ) : null}
          <Stats metrics={dashboard.metrics} />
          <div className="hero">
            <DecisionLog metrics={dashboard.metrics} href={href} />
            <Pool metrics={dashboard.metrics} />
          </div>
          <Lineage metrics={dashboard.metrics} href={href} focusId={dashboard.focusId} />
          <Funnels metrics={dashboard.metrics} href={href} />
          <div id="company">
            <CompanyView detail={dashboard.detail} sample={dashboard.source === "sample"} />
          </div>
        </>
      )}

      <footer>
        <span>AutoFoundry / Naïve Hackathon</span>
        <span>Built by Mateo & Felix</span>
      </footer>
    </main>
  );
}
