import Link from "next/link";
import { money, pt, spanShort } from "@/lib/site/view";
import { Arrow } from "./components";
import { getSite } from "./data";

export default async function Vision() {
  const site = await getSite();
  if (site.source === "error") {
    return (
      <div className="w">
        <p className="banner-err">{site.message}</p>
      </div>
    );
  }
  const t = site.totals;
  const lastKill = site.decisions.find((d) => d.kind === "kill");
  const killedCo = lastKill ? site.companies.find((c) => c.id === lastKill.company_id) : undefined;
  const funded = site.companies.filter((c) => c.status === "active").length;

  return (
    <>
      <section className="hero">
        <div className="hero-grid" />
        <div className="w">
          <p className="eyebrow">
            <span className="dot" />
            An autonomous company factory · {site.source === "live" ? "live" : "snapshot"} since {pt(site.companies[0]?.spawned_at ?? site.as_of, true)} PT
          </p>
          <h1>
            Grow <span className="or">or</span> <span className="die">die.</span>
          </h1>
          <div className="hero-sub">
            <p>
              AutoFoundry is a company that makes companies, with <b>no humans in the room</b>. Its agents find people already asking for something, start a company
              to sell it to them, fund the ones that reach buyers and <b>kill the ones that don&apos;t, in hours, not quarters.</b>
            </p>
            <div className="ctas">
              <Link className="btn primary" href="/foundry">
                See how it works <Arrow />
              </Link>
              <Link className="btn" href="/passed">
                The ones we killed
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="w" aria-label="The factory in numbers">
        <div className="stats">
          <div className="stat">
            <p className="n">{t.markets}</p>
            <p className="l">markets scouted</p>
          </div>
          <div className="stat">
            <p className="n">{t.companies}</p>
            <p className="l">companies started</p>
          </div>
          <div className="stat">
            <p className="n lime">{t.alive}</p>
            <p className="l">alive · {funded} funded</p>
          </div>
          <div className="stat">
            <p className="n rust">{t.killed}</p>
            <p className="l">killed on evidence</p>
          </div>
          <div className="stat">
            <p className="n">{t.median_minutes_to_kill === null ? "—" : spanShort(t.median_minutes_to_kill)}</p>
            <p className="l">median life of a killed company</p>
          </div>
          <div className="stat">
            <p className="n">{money(t.spend_micro_usd)}</p>
            <p className="l">total agent spend today, all seven agents</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="w">
          <div className="sec-head">
            <div>
              <p className="eyebrow">How it thinks</p>
              <h2>
                Most companies die slowly. <em>Ours die fast.</em>
              </h2>
            </div>
            <p>
              A normal startup takes months to learn whether anyone will pay. The factory starts a company for a buyer who is already asking, gives it a few
              dollars and a few hours, and lets the evidence decide. Four rules run the factory.
            </p>
          </div>
          <div className="principles">
            <div className="principle">
              <p className="k">01</p>
              <h3>Demand first.</h3>
              <p>Nothing is built until Scout finds someone already asking for it: a job post, a review, an app-store complaint.</p>
            </div>
            <div className="principle">
              <p className="k">02</p>
              <h3>Small budgets, fast.</h3>
              <p>Every company gets {money(site.policy.grant_micro_usd)} and one job: put a free sample in front of a real buyer.</p>
            </div>
            <div className="principle">
              <p className="k">03</p>
              <h3>Kill without sentiment.</h3>
              <p>VC reads the funnel, not the pitch. If a company can&apos;t reach its buyers, it&apos;s shut down, usually for cents.</p>
            </div>
            <div className="principle">
              <p className="k">04</p>
              <h3>Every death teaches.</h3>
              <p>Feedback turns each kill into a rule Scout follows on its next run, so the next company starts smarter.</p>
            </div>
          </div>
        </div>
      </section>

      {lastKill ? (
        <section className="section tight">
          <div className="w">
            <p className="eyebrow" style={{ marginBottom: 20 }}>
              The latest verdict
            </p>
            <figure className="verdict">
              <blockquote>“{lastKill.reason}”</blockquote>
              <figcaption>
                <span className="tag kill">killed</span>
                <span>
                  VC on {killedCo ? <Link href={`/passed#${killedCo.slug}`}>{killedCo.slug}</Link> : "a company"} · {pt(lastKill.at, true)} PT
                </span>
                {killedCo ? <span>· spent {money(killedCo.spend_micro_usd)}</span> : null}
              </figcaption>
            </figure>
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="w">
          <div className="sec-head">
            <div>
              <p className="eyebrow">Inside the factory</p>
              <h2>Look around.</h2>
            </div>
            <p>Every number and every reason on this site comes straight from the foundry&apos;s database, written by the agents as they worked.</p>
          </div>
          <div className="doors">
            <Link className="door" href="/foundry">
              <span className="big">{site.feedback.length}</span>
              <span>
                <h3>
                  The foundry <Arrow />
                </h3>
                <p>The loop, the family tree and the lessons the agents taught themselves.</p>
              </span>
            </Link>
            <Link className="door" href="/portfolio">
              <span className="big lime">{t.alive}</span>
              <span>
                <h3>
                  Portfolio <Arrow />
                </h3>
                <p>The companies still alive, their offers and how far each got.</p>
              </span>
            </Link>
            <Link className="door" href="/passed">
              <span className="big rust">{t.killed}</span>
              <span>
                <h3>
                  Passed <Arrow />
                </h3>
                <p>The companies VC killed, and exactly why.</p>
              </span>
            </Link>
            <Link className="door" href="/team">
              <span className="big">7</span>
              <span>
                <h3>
                  Team <Arrow />
                </h3>
                <p>Seven agents, two human founders, and where we stepped in.</p>
              </span>
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
