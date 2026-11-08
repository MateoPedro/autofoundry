import Link from "next/link";
import { loadDashboard } from "@/lib/server/dashboard";
import { clockTime } from "@/lib/dashboard/view";
import { Agents, Companies, CompanyView, DecisionLog, Funnels, Lineage, Pool, Totals, isShow, type Show } from "./dashboard";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function Home({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const forceSample = first(params.sample) === "1";
  const requested = first(params.show);
  const show: Show = isShow(requested) ? requested : "all";
  const dashboard = await loadDashboard({ focus: first(params.company), sample: forceSample });

  const link = (entries: Record<string, string | undefined>, hash: string) => {
    const query = new URLSearchParams();
    if (forceSample) query.set("sample", "1");
    for (const [key, value] of Object.entries(entries)) if (value) query.set(key, value);
    const qs = query.toString();
    return `/${qs ? `?${qs}` : ""}#${hash}`;
  };
  const showParam = (s: Show) => (s === "all" ? undefined : s);
  const href = (focus: string) => link({ show: showParam(show), company: focus }, "company");
  const showHref = (s: Show) => link({ show: showParam(s), company: first(params.company) }, "companies");

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <Link className="wordmark" href="/" aria-label="AutoFoundry home">
            <span className="brand-icon">A</span>
            <span>
              AutoFoundry<span className="brand-dot">.</span>
            </span>
          </Link>
          {dashboard.source === "live" ? (
            <span className="mode">
              <span /> Live foundry
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
        </div>
      </header>

      <main className="wrap">
        <section className="intro">
          {dashboard.source !== "error" ? <p className="as-of">As of {clockTime(dashboard.metrics.as_of)} PT</p> : null}
          <h1>A company that makes companies.</h1>
          <p>
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
            <Totals metrics={dashboard.metrics} />
            <Companies metrics={dashboard.metrics} href={href} show={show} showHref={showHref} />
            <div className="split">
              <Agents agents={dashboard.agents} />
              <div className="rail">
                <DecisionLog metrics={dashboard.metrics} href={href} targets={dashboard.targets} />
                <Pool metrics={dashboard.metrics} />
              </div>
            </div>
            <Lineage metrics={dashboard.metrics} href={href} focusId={dashboard.focusId} />
            <Funnels metrics={dashboard.metrics} href={href} />
            {dashboard.metrics.companies.length > 0 ? (
              <div id="company">
                <CompanyView detail={dashboard.detail} sample={dashboard.source === "sample"} />
              </div>
            ) : null}
          </>
        )}
      </main>

      <footer className="wrap">
        <span>AutoFoundry / Naïve Hackathon</span>
        <span>Built by Mateo & Felix</span>
      </footer>
    </>
  );
}
