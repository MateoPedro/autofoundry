import type { Metadata } from "next";
import { money } from "@/lib/site/view";
import { AgentCard } from "../components";
import { getProfiles, getSite } from "../data";
import { FOUNDERS, NEVER, STEPPED_IN } from "../founders";

export const metadata: Metadata = { title: "Team — AutoFoundry" };

export default async function Team() {
  const [site, profiles] = await Promise.all([getSite(), getProfiles()]);
  if (site.source === "error") return <div className="w"><p className="banner-err">{site.message}</p></div>;
  const budget = site.agents.reduce((s, a) => s + a.budget_micro_usd, 0);
  const spent = site.agents.reduce((s, a) => s + (a.spend_micro_usd ?? 0), 0);

  return (
    <>
      <section className="page-head">
        <div className="w">
          <p className="eyebrow">Team</p>
          <h1>
            Seven agents. <em>None of them human.</em>
          </h1>
          <p className="lede">
            Each agent runs on Naïve with one job, a set of tools and a daily budget. Today they&apos;ve spent {money(spent)} of{" "}
            {money(budget, 0)} between them. Click one to read its prompt.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="w">
          <div className="sec-head">
            <div>
              <p className="eyebrow">The agents</p>
              <h2>The crew.</h2>
            </div>
            <p>Seven agents share every company. The foundry gives each company its work, and the agents charge their time to it.</p>
          </div>
          <div className="partners">
            {site.agents.map((a) => (
              <AgentCard key={a.key} a={a} profile={profiles[a.key]} now={site.as_of} />
            ))}
            <div className="agent-sum">
              <div>
                <p className="big">{money(spent)}</p>
                <p>spent today by all seven agents</p>
              </div>
              <dl>
                <div>
                  <dt>Daily budget</dt>
                  <dd>{money(budget, 0)}</dd>
                </div>
                <div>
                  <dt>Companies served</dt>
                  <dd>{site.totals.companies}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{profiles.vc?.model.split("/").pop() ?? "—"}</dd>
                </div>
                <div>
                  <dt>Runs on</dt>
                  <dd>Naïve</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="w">
          <div className="sec-head">
            <div>
              <p className="eyebrow">The founders</p>
              <h2>
                The humans. <em>Mostly hands off.</em>
              </h2>
            </div>
            <p>We built the factory, then tried to stay out of it. This is everything we did after the agents started, so you can judge how much of it ran without us.</p>
          </div>
          <div className="founders">
            {FOUNDERS.map((f) => (
              <div className="founder" key={f.name}>
                <span className="avatar">{f.initial}</span>
                <div>
                  <h3>{f.name}</h3>
                  <p>{f.role}</p>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 48 }}>
            <p className="eyebrow" style={{ marginBottom: 18 }}>
              Where we stepped in
            </p>
            <div className="steps-in">
              {STEPPED_IN.map((s, i) => (
                <div className="step-in" key={s.what}>
                  <span className="i">0{i + 1}</span>
                  <h4>{s.what}</h4>
                  <p>{s.detail}</p>
                </div>
              ))}
            </div>
            <div className="never">
              <h3>What we never did.</h3>
              <p>{NEVER}</p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
