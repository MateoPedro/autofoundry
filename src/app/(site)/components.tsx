import Link from "next/link";
import type { ReactNode } from "react";
import type { Decision } from "@/lib/dashboard/types";
import type { AgentProfile, LiveSite, SiteAgent, SiteCompany } from "@/lib/site/types";
import { CHANNEL_LABEL, ago, companyNumber, lifespan, money, price, pt, sourceLabel, span } from "@/lib/site/view";
import { Popup } from "./popup";

/* ---------- Small pieces ---------- */

const ICONS: Record<string, ReactNode> = {
  scout: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
    </>
  ),
  compliance: (
    <>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  creator: <path d="M12 3l2 7 7 2-7 2-2 7-2-7-7-2 7-2z" />,
  vc: (
    <>
      <path d="M12 4v16M7 20h10M4 8h16" />
      <path d="M6 8l-3 6a3 3 0 0 0 6 0zM18 8l-3 6a3 3 0 0 0 6 0z" />
    </>
  ),
  feedback: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4h-4" />
    </>
  ),
  outreach: (
    <>
      <path d="M21 3L3 10.5l7 2.5 2.5 7z" />
      <path d="M10 13L21 3" />
    </>
  ),
  closer: (
    <>
      <path d="M4 5h16v11H9.5L4 20z" />
      <path d="M8.5 10.5l2 2 4-4" />
    </>
  ),
};

export function AgentIcon({ k }: { k: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[k] ?? <circle cx="12" cy="12" r="7" />}
      </svg>
    </span>
  );
}

export function Arrow() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

const AGENT_NAME: Record<string, string> = {
  scout: "Scout",
  compliance: "Compliance",
  creator: "Creator",
  vc: "VC",
  feedback: "Feedback",
  outreach: "Outreach",
  closer: "Closer",
};
const agentName = (key: string) => AGENT_NAME[key] ?? key;

export function StatusPill({ c }: { c: SiteCompany }) {
  if (c.status === "killed") return <span className="pill dead">Killed</span>;
  if (c.status === "active") return <span className="pill alive">Funded · {money(c.granted_micro_usd)}</span>;
  if (c.status === "failed") return <span className="pill dead">Failed</span>;
  return <span className="pill wait">Awaiting VC</span>;
}

export function Funnel({ c }: { c: SiteCompany }) {
  const steps: [string, number][] = [
    ["Leads", c.funnel.leads],
    ["Sampled", c.funnel.sampled],
    ["Reached", c.funnel.contacted],
    ["Replied", c.funnel.replied],
    ["Paid", c.funnel.paid],
  ];
  const top = Math.max(1, c.funnel.leads);
  return (
    <div className={`funnel${c.status === "killed" ? " dead" : ""}`} aria-label="Funnel">
      {steps.map(([label, n]) => (
        <div key={label}>
          <span className="bar">
            <i style={{ height: `${n ? Math.max(8, (n / top) * 100) : 0}%` }} />
          </span>
          <span className="fl">
            <b>{n}</b>
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Meter({ c }: { c: SiteCompany }) {
  const grant = c.granted_micro_usd || 2_500_000;
  return (
    <div className={`meter${c.status === "killed" ? " dead" : ""}`}>
      <div className="meter-row">
        <span>Spent</span>
        <span>
          <b>{money(c.spend_micro_usd)}</b> of {c.granted_micro_usd ? money(c.granted_micro_usd) : "no grant"}
        </span>
      </div>
      <div className="meter-track">
        <i style={{ width: `${Math.min(100, (c.spend_micro_usd / grant) * 100)}%` }} />
      </div>
    </div>
  );
}

/* ---------- Company cards and pop-up ---------- */

export function CompanyCard({ c, site }: { c: SiteCompany; site: LiveSite }) {
  return (
    <Popup
      id={c.slug}
      label={`${c.slug}: ${c.market}`}
      className="co"
      card={
        <>
          <div className="co-top">
            <span className="co-num">
              {companyNumber(c.slug)}
              <small>{c.slug}</small>
            </span>
            <StatusPill c={c} />
          </div>
          <div>
            <h3>{c.market}</h3>
            <p className="sub" style={{ marginTop: 10 }}>
              Sells <b>{c.title.toLowerCase()}</b> for <b>{price(c.price_cents)}</b>
            </p>
          </div>
          <div className="chips">
            <span className="chip">{sourceLabel(c.source)}</span>
            <span className="chip">{CHANNEL_LABEL[c.channel] ?? c.channel}</span>
            <span className="chip">Born {pt(c.spawned_at)}</span>
          </div>
          <div className="co-foot">
            <Funnel c={c} />
            <Meter c={c} />
            <div className="open-hint">
              <span>{c.revenue_cents ? `${price(c.revenue_cents)} revenue` : "No revenue yet"}</span>
              <span>Open →</span>
            </div>
          </div>
        </>
      }
    >
      <CompanyBody c={c} site={site} />
    </Popup>
  );
}

export function GraveCard({ c, site }: { c: SiteCompany; site: LiveSite }) {
  const lived = lifespan(c);
  return (
    <Popup
      id={c.slug}
      label={`${c.slug}: ${c.market}`}
      className="grave"
      card={
        <>
          <div className="grave-top">
            <span className="co-num">
              {companyNumber(c.slug)}
              <small>{c.slug}</small>
            </span>
            <span className="dates">
              {pt(c.spawned_at)} – {c.killed_at ? pt(c.killed_at) : "?"}
              <br />
              <b>lived {lived === null ? "?" : span(lived)}</b>
            </span>
          </div>
          <h3>{c.market}</h3>
          {c.kill_reason ? <blockquote>“{c.kill_reason}”</blockquote> : null}
          <div className="facts">
            <span>
              <b>{money(c.spend_micro_usd)}</b>spent
            </span>
            <span>
              <b>{c.funnel.contacted}</b>buyers reached
            </span>
            <span>
              <b>{c.failed_touches}</b>failed attempts
            </span>
            <span>
              <b>{c.funded_at ? "Yes" : "No"}</b>ever funded
            </span>
          </div>
        </>
      }
    >
      <CompanyBody c={c} site={site} />
    </Popup>
  );
}

const TOUCH: Record<string, string> = {
  sample_delivered: "built a free sample for",
  sent: "messaged",
  failed: "couldn't reach",
  reply_received: "got a reply from",
  reply_sent: "answered",
  delivered: "delivered the product to",
};

type Moment = { at: string; dot: string; text: ReactNode };

function moments(c: SiteCompany): Moment[] {
  const fromDecisions: Moment[] = c.decisions
    .filter((d) => d.kind !== "hold")
    .map((d) => ({
      at: d.at,
      dot: d.kind,
      text: (
        <>
          <b>{agentName(d.agent)}</b> {d.kind === "spawn" ? "started it" : d.kind === "fund" ? `funded it with ${money(d.amount_micro_usd ?? 0)}` : d.kind === "kill" ? "killed it" : d.kind}
          {d.kind !== "kill" ? <>: {d.reason}</> : null}
        </>
      ),
    }));
  const fromTouches: Moment[] = c.touches.map((t) => ({
    at: t.at,
    dot: t.kind,
    text: (
      <>
        <b>{agentName(t.agent)}</b> {TOUCH[t.kind] ?? t.kind} {t.lead ?? "a lead"}
        {t.kind === "failed" && t.detail ? <span className="muted"> ({t.detail})</span> : null}
        {t.kind === "sent" ? <span className="muted"> by {CHANNEL_LABEL[t.channel]?.toLowerCase() ?? t.channel}</span> : null}
      </>
    ),
  }));
  return [...fromDecisions, ...fromTouches].sort((a, b) => a.at.localeCompare(b.at));
}

export function CompanyBody({ c, site }: { c: SiteCompany; site: LiveSite }) {
  const dead = c.status === "killed";
  const lived = lifespan(c);
  const ran = site.agents;
  const involved = ["creator", "vc", ...c.crew.map((m) => m.agent).filter((a) => a !== "creator" && a !== "vc")];
  return (
    <article>
      <header className={`pop-head ${dead ? "dead" : "alive"}`}>
        <div className="top">
          <span className="eyebrow">
            {c.slug} · {sourceLabel(c.source)}
          </span>
          <StatusPill c={c} />
        </div>
        <h2>{c.market}</h2>
        <p className="sub">
          {c.title} for {price(c.price_cents)}. Started {pt(c.spawned_at, true)} PT
          {dead && lived !== null ? `, killed ${span(lived)} later` : ""}.
        </p>
      </header>

      {dead && c.kill_reason ? (
        <section className="pop-sec">
          <h4>Why it died</h4>
          <blockquote className="pop-why">“{c.kill_reason}”</blockquote>
          <p className="who-said">VC · {c.killed_at ? pt(c.killed_at, true) : ""} PT</p>
        </section>
      ) : c.fund_reason ? (
        <section className="pop-sec">
          <h4>Why VC funded it</h4>
          <blockquote className="pop-why fund">“{c.fund_reason}”</blockquote>
          <p className="who-said">VC · {c.funded_at ? pt(c.funded_at, true) : ""} PT</p>
        </section>
      ) : c.spawn_reason ? (
        <section className="pop-sec">
          <h4>Why Creator started it</h4>
          <blockquote className="pop-why fund">“{c.spawn_reason}”</blockquote>
          <p className="who-said">Creator · {pt(c.spawned_at, true)} PT · waiting for VC&apos;s next pass</p>
        </section>
      ) : null}

      <section className="pop-sec">
        <h4>Performance</h4>
        <dl className="kv">
          <div>
            <dt>Spent</dt>
            <dd>{money(c.spend_micro_usd)}</dd>
          </div>
          <div>
            <dt>Granted</dt>
            <dd>{money(c.granted_micro_usd)}</dd>
          </div>
          <div>
            <dt>Buyers reached</dt>
            <dd className={c.funnel.contacted ? "lime" : dead ? "rust" : ""}>
              {c.funnel.contacted}/{c.funnel.leads}
            </dd>
          </div>
          <div>
            <dt>Revenue</dt>
            <dd>{price(c.revenue_cents)}</dd>
          </div>
        </dl>
        <div style={{ marginTop: 20 }}>
          <Funnel c={c} />
        </div>
        {c.failed_touches ? (
          <p className="muted" style={{ marginTop: 14, fontSize: 14 }}>
            {c.failed_touches} outreach attempt{c.failed_touches === 1 ? "" : "s"} failed.
          </p>
        ) : null}
      </section>

      <section className="pop-sec">
        <h4>Who ran it</h4>
        <div className="crew">
          {involved.map((key) => {
            const spent = c.crew.find((m) => m.agent === key);
            const agent = ran.find((a) => a.key === key);
            const did =
              key === "creator"
                ? "Started it and built its samples"
                : key === "vc"
                  ? c.status === "killed"
                    ? c.funded_at
                      ? "Funded it, then killed it"
                      : "Killed it before funding"
                    : c.funded_at
                      ? "Funded it"
                      : "Deciding whether to fund it"
                  : (agent?.role ?? "");
            return (
              <div className="crew-m" key={key}>
                <AgentIcon k={key} />
                <div>
                  <b>{agentName(key)}</b>
                  <span>
                    {did}
                    {spent ? ` · ${money(spent.micro_usd)} over ${spent.sessions} session${spent.sessions === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="pop-sec">
        <h4>The offer</h4>
        <dl className="offer">
          <dt>Buyer</dt>
          <dd>{c.buyer}</dd>
          <dt>Free sample</dt>
          <dd>{c.sample}</dd>
          <dt>Product</dt>
          <dd>
            {c.product} <b>{price(c.price_cents)}</b>
          </dd>
          <dt>Delivery</dt>
          <dd>{c.delivery}</dd>
          <dt>Channel</dt>
          <dd>{CHANNEL_LABEL[c.channel] ?? c.channel}</dd>
        </dl>
        <div className="msg">{c.outreach_message}</div>
        {c.sample_url ? (
          <a className="sample-link" href={c.sample_url} target="_blank" rel="noreferrer">
            Open a free sample it built <Arrow />
          </a>
        ) : null}
      </section>

      {c.leads.length ? (
        <section className="pop-sec">
          <h4>Its buyers</h4>
          <div className="leads">
            {c.leads.map((l) => (
              <div className="lead" key={l.name}>
                <span>
                  {l.name} <span className="muted">· {l.status}</span>
                </span>
                {l.sample_url ? (
                  <a href={l.sample_url} target="_blank" rel="noreferrer">
                    sample →
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="pop-sec">
        <h4>Timeline (PT)</h4>
        <div className="timeline">
          {moments(c).map((m, i) => (
            <div className="tl" key={i}>
              <time>{pt(m.at)}</time>
              <span className={`d ${m.dot}`} />
              <p>{m.text}</p>
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}

/* ---------- Agents ---------- */

export function AgentCard({ a, profile, now }: { a: SiteAgent; profile?: AgentProfile; now: string }) {
  return (
    <Popup
      id={`agent-${a.key}`}
      label={`${a.name}, ${a.role}`}
      className="agent"
      card={
        <>
          <span className="status">
            <span className={`pulse${a.active ? "" : " off"}`} />
            {a.active ? "working" : "idle"}
          </span>
          <AgentIcon k={a.key} />
          <div>
            <h3>{a.name}</h3>
            <p className="role">{a.role}</p>
          </div>
          <p className="work">
            {a.work}
            <small>{a.work_label}</small>
          </p>
          <div className="latest">
            {a.at ? <time>{ago(a.at, now)}</time> : null}
            {a.latest ?? "Nothing yet"}
          </div>
        </>
      }
    >
      <AgentBody a={a} profile={profile} now={now} />
    </Popup>
  );
}

export function AgentBody({ a, profile, now }: { a: SiteAgent; profile?: AgentProfile; now: string }) {
  return (
    <article>
      <header className="pop-head alive">
        <div className="top">
          <AgentIcon k={a.key} />
          <span className="pill">
            <span className={`pulse${a.active ? "" : " off"}`} />
            {a.active ? "working" : "idle"}
          </span>
        </div>
        <h2>{a.name}</h2>
        <p className="sub">{profile?.description || a.role}</p>
      </header>
      <section className="pop-sec">
        <h4>At work</h4>
        <dl className="kv">
          <div>
            <dt>{a.work_label}</dt>
            <dd className="lime">{a.work}</dd>
          </div>
          <div>
            <dt>Spent today</dt>
            <dd>{a.spend_micro_usd === null ? "—" : money(a.spend_micro_usd)}</dd>
          </div>
          <div>
            <dt>Daily budget</dt>
            <dd>{money(a.budget_micro_usd, 0)}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd style={{ fontSize: 18, fontFamily: "var(--mono)", paddingTop: 6 }}>{profile?.model.split("/").pop() ?? "—"}</dd>
          </div>
        </dl>
        {a.latest ? (
          <p style={{ marginTop: 18, color: "var(--body)" }}>
            Latest: {a.latest} <span className="muted">· {a.at ? ago(a.at, now) : ""}</span>
          </p>
        ) : null}
      </section>
      {profile?.tools.length ? (
        <section className="pop-sec">
          <h4>Tools it may call</h4>
          <div className="tools">
            {profile.tools.map((t) => (
              <span className="chip" key={t}>
                {t}
              </span>
            ))}
          </div>
        </section>
      ) : null}
      {profile?.prompt ? (
        <section className="pop-sec">
          <h4>Its prompt, as deployed</h4>
          <pre className="prompt">{profile.prompt}</pre>
        </section>
      ) : null}
    </article>
  );
}

/* ---------- Decisions ---------- */

export function targetOf(d: Decision, site: LiveSite): { text: string; href: string | null } {
  if (d.company_id) {
    const c = site.companies.find((x) => x.id === d.company_id);
    if (c) return { text: c.slug, href: `${c.status === "killed" ? "/passed" : "/portfolio"}#${c.slug}` };
  }
  const id = d.offer_id ?? d.cluster_id;
  return { text: id ? (site.labels[id] ?? "a market") : "the pool", href: null };
}

const VERB: Record<Decision["kind"], string> = { approve: "approved", reject: "rejected", spawn: "started", fund: "funded", kill: "killed", hold: "held" };

export function Ticker({ site }: { site: LiveSite }) {
  const items = site.decisions.filter((d) => d.kind !== "hold" && d.kind !== "approve").slice(0, 16);
  if (!items.length) return null;
  const row = items.map((d) => {
    const t = targetOf(d, site);
    const label = t.text.length > 48 ? `${t.text.slice(0, 47)}…` : t.text;
    return (
      <span className="ticker-item" key={d.id}>
        <span className={`tag ${d.kind}`}>{VERB[d.kind]}</span>
        {t.href ? (
          <a href={t.href}>
            <b>{label}</b>
          </a>
        ) : (
          <b>{label}</b>
        )}
        <span>
          by {agentName(d.agent)} · {pt(d.at)}
        </span>
      </span>
    );
  });
  return (
    <div className="ticker" aria-label="Latest decisions">
      <div className="ticker-track">
        {row}
        <span aria-hidden="true" style={{ display: "contents" }}>
          {row}
        </span>
      </div>
    </div>
  );
}

export function DecisionLog({ site, limit = 30, kinds }: { site: LiveSite; limit?: number; kinds?: Decision["kind"][] }) {
  const rows = site.decisions.filter((d) => (kinds ? kinds.includes(d.kind) : d.kind !== "hold")).slice(0, limit);
  return (
    <div className="log">
      {rows.map((d) => {
        const t = targetOf(d, site);
        return (
          <div className="log-row" key={d.id}>
            <time>{pt(d.at)} PT</time>
            <span className="who">
              <span className={`tag ${d.kind}`}>{VERB[d.kind]}</span>
            </span>
            <p>
              <b>{agentName(d.agent)}</b> {VERB[d.kind]}{" "}
              {t.href ? (
                <Link href={t.href}>
                  <b className="lime">{t.text}</b>
                </Link>
              ) : (
                <b>{t.text}</b>
              )}
              {d.amount_micro_usd ? ` with ${money(d.amount_micro_usd)}` : ""}. <span>{d.reason}</span>
            </p>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Lineage ---------- */

export function Lineage({ site }: { site: LiveSite }) {
  const cos = site.companies;
  if (!cos.length) return null;
  const t0 = Math.min(...cos.map((c) => Date.parse(c.spawned_at)));
  const t1 = Math.max(Date.parse(site.as_of), ...cos.map((c) => Date.parse(c.killed_at ?? c.spawned_at)));
  const width = Math.max(1, t1 - t0);
  const x = (iso: string) => ((Date.parse(iso) - t0) / width) * 100;
  const ticks: number[] = [];
  const hour = 3_600_000;
  for (let t = Math.ceil(t0 / hour) * hour; t <= t1; t += hour) ticks.push(t);
  return (
    <div className="lineage">
      <div className="lin-root">
        <span className="brand-mark">A</span> AutoFoundry
        <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
          · parent of {cos.length}
        </span>
      </div>
      <div className="lin-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${((t - t0) / width) * 100}%` }}>
            {pt(new Date(t).toISOString())}
          </span>
        ))}
      </div>
      <div className="lin-rows">
        {cos.map((c) => {
          const end = c.killed_at ?? site.as_of;
          const kind = c.status === "killed" ? "dead" : c.status === "active" ? "alive" : "wait";
          return (
            <Popup
              key={c.id}
              id={c.slug}
              label={`${c.slug}: ${c.market}`}
              className="lin-row"
              card={
                <>
                  <span className="lin-label">
                    <b>{c.slug}</b>
                    <span>{c.market}</span>
                  </span>
                  <span className="lin-track">
                    <span className={`lin-bar ${kind}`} style={{ left: `${x(c.spawned_at)}%`, width: `${Math.max(0.6, x(end) - x(c.spawned_at))}%` }} />
                    {c.funded_at ? <span className="lin-fund" style={{ left: `${x(c.funded_at)}%` }} title="funded" /> : null}
                  </span>
                </>
              }
            >
              <CompanyBody c={c} site={site} />
            </Popup>
          );
        })}
      </div>
      <div className="legend">
        <span>
          <i style={{ background: "var(--lime)" }} /> alive
        </span>
        <span>
          <i style={{ background: "var(--rust)" }} /> killed
        </span>
        <span>
          <i style={{ background: "var(--amber)" }} /> waiting for VC
        </span>
        <span>
          <i style={{ background: "var(--ink)", width: 2, height: 14 }} /> funded
        </span>
        <span>Times PT · click a row for the story</span>
      </div>
    </div>
  );
}

/* ---------- Feedback ---------- */

function marked(body: string): ReactNode[] {
  return body.split(/(\bKILL\b|\bFUND\b|→)/).map((part, i) =>
    part === "KILL" ? (
      <mark key={i}>KILL</mark>
    ) : part === "FUND" ? (
      <mark key={i} className="fund">
        FUND
      </mark>
    ) : part === "→" ? (
      <span key={i} className="arrow">
        →
      </span>
    ) : (
      part
    ),
  );
}

export function FeedbackNotes({ site }: { site: LiveSite }) {
  const notes = [...site.feedback].reverse();
  return (
    <div className="notes">
      {notes.map((n) => (
        <div className={`note${n.kind === "summary" ? " summary" : ""}`} key={n.id}>
          <div className="meta">
            <span>{n.kind === "summary" ? "Summary Scout reads first" : "Lesson"}</span>
            <span>{pt(n.created_at)} PT</span>
          </div>
          <p>{marked(n.body)}</p>
        </div>
      ))}
    </div>
  );
}

export function ChannelMix({ site }: { site: LiveSite }) {
  const rows = site.channels.filter((r) => r.email + r.form > 0);
  return (
    <div className="mix">
      {rows.map((r) => {
        const total = r.email + r.form;
        return (
          <div className="mix-row" key={r.at}>
            <span>{pt(r.at)}</span>
            <span className="mix-bar" aria-label={`${r.email} email, ${r.form} contact form`}>
              <i className="e" style={{ width: `${(r.email / total) * 100}%` }} />
              <i className="f" style={{ width: `${(r.form / total) * 100}%` }} />
            </span>
            <b>
              {r.form}/{total} form
            </b>
          </div>
        );
      })}
    </div>
  );
}
