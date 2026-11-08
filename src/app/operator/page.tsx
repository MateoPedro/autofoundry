import { cookies } from "next/headers";
import Link from "next/link";
import { loadDashboard } from "@/lib/server/dashboard";
import { gateSecret, isOperator, OPERATOR_COOKIE } from "@/lib/server/gate";
import { clockTime } from "@/lib/dashboard/view";
import { Agents, Companies, CompanyPanel, Controls, DecisionLog, Pool, Totals, ViewSwitch, isShow, isView, type Show, type View } from "./dashboard";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function Home({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const forceSample = first(params.sample) === "1";
  const requested = first(params.show);
  const show: Show = isShow(requested) ? requested : "all";
  const requestedView = first(params.view);
  const view: View = isView(requestedView) ? requestedView : "companies";
  const opened = first(params.company);
  const dashboard = await loadDashboard({ focus: first(params.company), sample: forceSample });
  const operator = isOperator((await cookies()).get(OPERATOR_COOKIE)?.value, gateSecret(process.env));

  const link = (entries: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    if (forceSample) query.set("sample", "1");
    for (const [key, value] of Object.entries(entries)) if (value) query.set(key, value);
    const qs = query.toString();
    return `/operator${qs ? `?${qs}` : ""}`;
  };
  const viewParam = (v: View) => (v === "companies" ? undefined : v);
  const showParam = (s: Show) => (s === "all" ? undefined : s);
  const href = (focus: string) => link({ view: viewParam(view), show: showParam(show), company: focus });
  const closeHref = link({ view: viewParam(view), show: showParam(show) });
  const showHref = (s: Show) => link({ show: showParam(s) });
  const viewHref = (v: View) => link({ view: viewParam(v) });

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
            {dashboard.running !== null ? <Controls operator={operator} running={dashboard.running} /> : null}
            {first(params.entry) === "failed" ? <p className="banner down">{"That password didn't sign you in."}</p> : null}
            {first(params.control) ? (
              <p className={`banner${first(params.ok) === "1" ? "" : " down"}`}>
                {first(params.ok) === "1"
                  ? first(params.control) === "launch"
                    ? "Launched. Every agent has its budget back and Scout runs every 2 hours."
                    : "Ended. Every agent's budget is $0 and the schedules are off."
                  : "Naïve refused part of that. The app's logs and the JSON report from /api/control say which call."}
              </p>
            ) : null}
            <Totals metrics={dashboard.metrics} />
            <ViewSwitch view={view} viewHref={viewHref} />
            {view === "companies" ? <Companies metrics={dashboard.metrics} href={href} show={show} showHref={showHref} /> : null}
            {view === "agents" ? <Agents agents={dashboard.agents} /> : null}
            {view === "activity" ? (
              <div className="activity">
                <DecisionLog metrics={dashboard.metrics} href={href} targets={dashboard.targets} />
                <Pool metrics={dashboard.metrics} />
              </div>
            ) : null}
            {opened && dashboard.detail ? <CompanyPanel detail={dashboard.detail} metrics={dashboard.metrics} href={href} closeHref={closeHref} /> : null}
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
