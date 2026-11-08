import type { Metadata } from "next";
import { ChannelMix, DecisionLog, FeedbackNotes, Lineage } from "../components";
import { getSite } from "../data";

export const metadata: Metadata = { title: "The foundry — AutoFoundry" };

export default async function Foundry() {
  const site = await getSite();
  if (site.source === "error") return <div className="w"><p className="banner-err">{site.message}</p></div>;
  const t = site.totals;
  const funded = site.companies.filter((c) => c.funded_at).length;
  const firstForm = site.channels.find((r) => r.form > 0 && r.form >= r.email);
  const latest = [...site.channels].reverse().find((r) => r.email + r.form > 0);

  const steps = [
    { k: "01", name: "Scout", does: "Searches job posts, maps, reviews and app stores for people asking for help.", n: t.markets, unit: "markets found" },
    { k: "02", name: "Compliance", does: "Screens each market: real buyer, real pain, legal to sell.", n: t.markets_approved, unit: `approved · ${t.markets_rejected} rejected` },
    { k: "03", name: "Creator", does: "Writes an offer, a price and a free sample for each buyer.", n: t.companies, unit: "companies started" },
    { k: "04", name: "VC", does: "Funds companies that can reach buyers. Kills the rest.", n: funded, unit: `funded · ${t.killed} killed` },
    { k: "05", name: "Outreach", does: "Sends each buyer their free sample, by email or contact form.", n: t.samples, unit: `samples · ${t.messages_sent} messages sent` },
    { k: "06", name: "Feedback", does: "Reads every fund and kill and writes Scout a lesson.", n: site.feedback.length, unit: "lessons written" },
  ];

  return (
    <>
      <section className="page-head">
        <div className="w">
          <p className="eyebrow">The foundry</p>
          <h1>
            A company that <em>makes</em> companies.
          </h1>
          <p className="lede">
            One parent and seven agents, running a loop every two hours. Each pass finds new demand, starts companies for it, funds or kills
            the ones already running, and writes down what it learned.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="w">
          <div className="sec-head">
            <div>
              <p className="eyebrow">The loop</p>
              <h2>Six agents, one cycle.</h2>
            </div>
            <p>No step waits for a person. Each agent reads what the last one wrote to the foundry&apos;s database and writes its own decision back, with a reason.</p>
          </div>
          <div className="loop">
            {steps.map((s) => (
              <div className="step" key={s.k}>
                <p className="k">{s.k}</p>
                <h3>{s.name}</h3>
                <p>{s.does}</p>
                <p className="n">
                  {s.n}
                  <small>{s.unit}</small>
                </p>
              </div>
            ))}
          </div>
          <div className="loop-back">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M20 12a8 8 0 1 1-2.4-5.7" />
              <path d="M20 4v4h-4" />
            </svg>
            Feedback&apos;s lessons go back to Scout before its next search, so every cycle starts from what the last one learned.
          </div>
        </div>
      </section>

      <section className="section">
        <div className="w">
          <div className="sec-head">
            <div>
              <p className="eyebrow">Lineage</p>
              <h2>
                {t.companies} children. <em>{t.killed} buried.</em>
              </h2>
            </div>
            <p>
              Every company AutoFoundry has started, from birth to now or to the moment VC killed it. The white tick is when VC funded it. Click any row
              to read its story.
            </p>
          </div>
          <Lineage site={site} />
        </div>
      </section>

      <section className="section">
        <div className="w">
          <div className="sec-head">
            <div>
              <p className="eyebrow">The feedback loop</p>
              <h2>
                It learns from <em>its own deaths.</em>
              </h2>
            </div>
            <p>
              Scout keeps no memory between runs. So after every VC pass, the Feedback agent reads what was funded and killed and writes Scout a short
              lesson, and Scout reads them before it searches again.
            </p>
          </div>
          <div className="fb">
            <div className="panel">
              <h3>What Feedback told Scout</h3>
              <p>Newest first. The green one is the summary Scout reads before every search.</p>
              <FeedbackNotes site={site} />
            </div>
            <div className="panel">
              <h3>What Scout did next</h3>
              <p>New leads by the hour Scout found their market: green can be emailed, red only has a contact form.</p>
              <ChannelMix site={site} />
              <div className="callout">
                Contact forms kept failing: phone-required fields, appointment-only forms, job portals. {t.failed_touches} outreach attempts failed and VC
                killed every company that relied on them.
                {firstForm && latest ? (
                  <>
                    {" "}
                    Scout&apos;s leads went from <b>{firstForm.form} of {firstForm.email + firstForm.form} form-only</b> in the {new Date(firstForm.at).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric" })} run to{" "}
                    <b>{latest.form} of {latest.email + latest.form}</b> in the latest.
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="w">
          <div className="sec-head">
            <div>
              <p className="eyebrow">Decision log</p>
              <h2>Every call, with its reason.</h2>
            </div>
            <p>Every company started, funded or killed and every market rejected, newest first, with the reason the agent wrote. Routine approvals and holds are left out.</p>
          </div>
          <DecisionLog site={site} limit={40} kinds={["spawn", "fund", "kill", "reject"]} />
        </div>
      </section>
    </>
  );
}
