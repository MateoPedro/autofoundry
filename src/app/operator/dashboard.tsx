import Link from "next/link";
import type { AgentRow, AgentsView, CompanyDetail, CompanyEntry, Decision, Metrics } from "@/lib/dashboard/types";
import { webUrl } from "@/lib/url";
import { AGENT_LABEL, KIND_LABEL, clip, clockTime, percent, slugFor, usdFromCents, usdFromMicro } from "@/lib/dashboard/view";

type Href = (focus: string) => string;

export type Show = "all" | "active" | "waiting" | "killed";

const SHOWS: { key: Show; label: string; matches: (status: CompanyEntry["status"]) => boolean }[] = [
  { key: "all", label: "All", matches: () => true },
  { key: "active", label: "Active", matches: (s) => s === "active" },
  { key: "waiting", label: "Waiting", matches: (s) => s === "proposed" || s === "spawning" },
  { key: "killed", label: "Killed", matches: (s) => s === "killed" || s === "failed" },
];

export const isShow = (value: string | undefined): value is Show => SHOWS.some((s) => s.key === value);

// One section shows at a time, picked with the switch at the top of the page.
export type View = "companies" | "agents" | "activity";
const VIEWS: { key: View; label: string }[] = [
  { key: "companies", label: "Companies" },
  { key: "agents", label: "Agents" },
  { key: "activity", label: "Activity" },
];
export const isView = (value: string | undefined): value is View => VIEWS.some((v) => v.key === value);

export function ViewSwitch({ view, viewHref }: { view: View; viewHref: (view: View) => string }) {
  return (
    <nav className="switch" aria-label="Dashboard sections">
      {VIEWS.map((v) => (
        <Link key={v.key} href={viewHref(v.key)} aria-current={v.key === view ? "page" : undefined}>
          {v.label}
        </Link>
      ))}
    </nav>
  );
}

const STATUS_LABEL: Record<CompanyEntry["status"], string> = {
  spawning: "Spawning",
  proposed: "Waiting",
  active: "Active",
  killed: "Killed",
  failed: "Failed",
};

// The card's funnel, in words short enough for five columns.
const STAGES = [
  ["leads", "Leads", "Leads"],
  ["sampled", "Samples", "Sampled"],
  ["contacted", "Sent", "Contacted"],
  ["replied", "Replies", "Replied"],
  ["paid", "Paid", "Paid"],
] as const;

// Everyone sees whether the company runs; only a signed-in operator gets Launch and End.
export function Controls({ operator, running }: { operator: boolean; running: boolean }) {
  return (
    <section className="controls" aria-label="Company switch">
      <span className={`mode${running ? "" : " down"}`}>
        <span /> {running ? "The company is running" : "The company is stopped"}
      </span>
      {operator ? (
        running ? (
          <form method="post" action="/api/control/stop">
            <button type="submit">End: stop every agent</button>
          </form>
        ) : (
          <form method="post" action="/api/control/launch">
            <button type="submit">Launch</button>
          </form>
        )
      ) : (
        <form method="post" action="/api/entry">
          <label>
            Operator password <input type="password" name="password" autoComplete="current-password" required />
          </label>
          <button type="submit">Sign in</button>
        </form>
      )}
    </section>
  );
}

export function Totals({ metrics }: { metrics: Metrics }) {
  const t = metrics.totals;
  const stats = [
    ["Companies", `${t.companies_active} active`, `${t.companies_proposed} waiting, ${t.companies_killed} killed`],
    ["Demand found", `${t.leads} leads`, `${t.clusters_approved} of ${t.clusters} clusters approved`],
    ["Outreach", `${t.replies} replies`, `from ${t.touches} touches`],
    ["Revenue / spend", `${usdFromCents(t.revenue_cents)} / ${usdFromMicro(t.spend_micro_usd)}`, `${t.payments} verified payments`],
  ];
  return (
    <section className="totals" aria-label="Foundry totals">
      {stats.map(([label, figure, sub]) => (
        <div key={label}>
          <p className="label">{label}</p>
          <p className="figure">{figure}</p>
          <p className="sub">{sub}</p>
        </div>
      ))}
    </section>
  );
}

function StatusTag({ status }: { status: CompanyEntry["status"] }) {
  return <span className={`chip status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function CompanyCard({ company: c, metrics, href }: { company: CompanyEntry; metrics: Metrics; href: Href }) {
  const parent = c.parent_id ? slugFor(metrics, c.parent_id) : null;
  return (
    <article className="tile">
      <h3 className="tile-title">
        <i className={`tile-dot status-${c.status}`} aria-hidden />
        {c.slug}
      </h3>
      <p className="tile-text" title={c.offer_summary}>
        {c.offer_summary}
      </p>
      <p className="tile-meta">
        Spawned {clockTime(c.spawned_at)}
        {parent ? `, from ${parent}'s offer` : ""}
        {c.killed_at ? `, killed ${clockTime(c.killed_at)}` : ""}
      </p>
      <StatusTag status={c.status} />
      <dl className="tile-panel">
        <div className="funnel-row">
          <dt>Funnel</dt>
          <dd className="funnel">
            {STAGES.map(([key, label, meaning]) => (
              <span key={key} title={meaning}>
                <b>{c.funnel[key]}</b>
                <small>{label}</small>
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd>
            {usdFromMicro(c.spend_micro_usd)} <small>of {usdFromMicro(c.granted_micro_usd)}</small>
            <span className="tile-revenue">{usdFromCents(c.revenue_cents)} revenue</span>
          </dd>
        </div>
      </dl>
      <Link className="pill" href={href(c.slug)}>
        View company
      </Link>
    </article>
  );
}

export function Companies({ metrics, href, show, showHref }: { metrics: Metrics; href: Href; show: Show; showHref: (show: Show) => string }) {
  const { matches } = SHOWS.find((s) => s.key === show) ?? SHOWS[0];
  const shown = metrics.companies.filter((c) => matches(c.status));
  return (
    <section id="companies" aria-label="Companies">
      {metrics.companies.length === 0 ? (
        <p className="empty">No companies yet. Creator starts one once Compliance approves a cluster and an offer.</p>
      ) : (
        <>
          <nav className="filters" aria-label="Filter companies">
            {SHOWS.map((s) => (
              <Link key={s.key} href={showHref(s.key)} aria-current={s.key === show ? "page" : undefined}>
                {s.label} ({metrics.companies.filter((c) => s.matches(c.status)).length})
              </Link>
            ))}
          </nav>
          {shown.length === 0 ? (
            <p className="empty">No {show} companies.</p>
          ) : (
            <div className="tiles">
              {shown.map((c) => (
                <CompanyCard key={c.id} company={c} metrics={metrics} href={href} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

const AGENT_STATUS: Record<AgentRow["status"], string> = { active: "Active", idle: "Idle", waiting: "Waiting", stopped: "Stopped" };

function AgentMark({ row }: { row: AgentRow }) {
  const mark = row.agents ?? (row.group === "Foundry" ? row.name : row.name.split("-").pop() ?? row.name).charAt(0).toUpperCase();
  const tone = row.group === "Foundry" ? `agent-${row.key}` : row.agents ? `agent-${row.status}` : "agent-company";
  return (
    <i className={`mark ${tone}`} aria-hidden>
      {mark}
    </i>
  );
}

export function Agents({ agents }: { agents: AgentsView }) {
  const groups = [...new Set(agents.rows.map((r) => r.group))];
  return (
    <section aria-label="Agents at work">
      <p className="section-note">{agents.synced_at ? `Spend synced from Naïve ${clockTime(agents.synced_at)}` : "Spend not synced from Naïve yet"}</p>
      {groups.map((group) => (
        <div key={group}>
          {groups.length > 1 ? <h3 className="group-title">{group}</h3> : null}
          <div className="tiles">
            {agents.rows
              .filter((r) => r.group === group)
              .map((r) => (
                <article key={r.key} className={`tile${r.agents ? " muted" : ""}`}>
                  <h3 className="tile-title">
                    <AgentMark row={r} />
                    {r.name}
                  </h3>
                  <p className="tile-text">{r.role}</p>
                  <p className="tile-meta">{r.at ? <time dateTime={r.at}>Last worked {clockTime(r.at)}</time> : "No work recorded yet"}</p>
                  <dl className="tile-panel">
                    <div>
                      <dt>Latest</dt>
                      <dd>{r.latest ?? <span className="none">Nothing recorded yet</span>}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <span className={`state state-${r.status}`}>{AGENT_STATUS[r.status]}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Spent</dt>
                      <dd>{r.spend_micro_usd === null ? "–" : usdFromMicro(r.spend_micro_usd)}</dd>
                    </div>
                  </dl>
                </article>
              ))}
          </div>
        </div>
      ))}
    </section>
  );
}

const TONE: Record<Decision["kind"], string> = { approve: "good", spawn: "good", fund: "good", reject: "bad", kill: "bad", hold: "hold" };

function DecisionTarget({ decision, metrics, href, targets }: { decision: Decision; metrics: Metrics; href: Href; targets: Record<string, string> }) {
  const slug = slugFor(metrics, decision.company_id);
  if (slug) {
    return (
      <Link className="target" href={href(slug)}>
        {slug}
      </Link>
    );
  }
  const [kind, id] = decision.offer_id ? ["offer", decision.offer_id] : ["cluster", decision.cluster_id];
  if (!id) return null;
  const label = targets[id];
  return (
    <span title={id}>
      {kind} <b>{label ? `“${clip(label, 48)}”` : id}</b>
    </span>
  );
}

// The newest few stay in view; the rest fold away so the feed doesn't run the length of the page.
const FEED_SHOWN = 6;

export function DecisionLog({ metrics, href, targets = {} }: { metrics: Metrics; href: Href; targets?: Record<string, string> }) {
  const item = (d: Decision) => (
    <li key={d.id} className={`tone-${TONE[d.kind] ?? "hold"}`}>
      <p>
        <b>{AGENT_LABEL[d.agent] ?? d.agent}</b> {KIND_LABEL[d.kind]?.toLowerCase() ?? d.kind}{" "}
        <DecisionTarget decision={d} metrics={metrics} href={href} targets={targets} />
        {d.amount_micro_usd ? ` with ${usdFromMicro(d.amount_micro_usd)}` : ""}
      </p>
      <q title={d.reason}>{d.reason}</q>
      <time dateTime={d.at}>{clockTime(d.at)}</time>
    </li>
  );
  const older = metrics.decisions.slice(FEED_SHOWN);
  return (
    <section className="card" aria-labelledby="decisions-title">
      <div className="head">
        <h2 id="decisions-title">Decisions while you slept</h2>
        <span>{metrics.decisions.length} most recent</span>
      </div>
      {metrics.decisions.length === 0 ? (
        <p className="empty">No decisions yet. They appear here as soon as an agent approves, spawns, funds, kills or holds.</p>
      ) : (
        <>
          <ol className="feed">{metrics.decisions.slice(0, FEED_SHOWN).map(item)}</ol>
          {older.length ? (
            <details className="feed-older">
              <summary>
                Show {older.length} older {older.length === 1 ? "decision" : "decisions"}
              </summary>
              <ol className="feed">{older.map(item)}</ol>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

export function Pool({ metrics }: { metrics: Metrics }) {
  const p = metrics.policy;
  const t = metrics.totals;
  const granted = percent(p.granted_micro_usd, p.pool_micro_usd);
  const spent = percent(t.spend_micro_usd, p.pool_micro_usd);
  return (
    <section className="card" aria-labelledby="pool-title">
      <div className="head">
        <h2 id="pool-title">VC&apos;s pool</h2>
        <span>Grants and spend</span>
      </div>
      <div className="pool">
        <p className="pool-left">
          {usdFromMicro(p.pool_left_micro_usd)} <small>left to grant</small>
        </p>
        <div className="meter" role="img" aria-label={`${granted}% of the pool granted, ${spent}% spent`}>
          <span className="meter-granted" style={{ width: `${granted}%` }} />
          <span className="meter-spent" style={{ width: `${spent}%` }} />
        </div>
        <dl className="legend">
          <div>
            <dt>
              <i className="dot granted" /> Granted
            </dt>
            <dd>{usdFromMicro(p.granted_micro_usd)}</dd>
          </div>
          <div>
            <dt>
              <i className="dot spent" /> Spent
            </dt>
            <dd>{usdFromMicro(t.spend_micro_usd)}</dd>
          </div>
          <div>
            <dt>
              <i className="dot total" /> Pool
            </dt>
            <dd>{usdFromMicro(p.pool_micro_usd)}</dd>
          </div>
          <div>
            <dt>Revenue</dt>
            <dd>{usdFromCents(t.revenue_cents)}</dd>
          </div>
        </dl>
        <p className="note">
          One grant is {usdFromMicro(p.grant_micro_usd)}. At most {p.max_active} companies run and {p.max_proposed} wait at once.
          {metrics.spend_stale ? " Spend couldn't be refreshed from Naïve on this load, so it may be low." : ""}
        </p>
      </div>
    </section>
  );
}

const TOUCH_LABEL: Record<string, string> = {
  sample_delivered: "Sample built",
  sent: "Message sent",
  failed: "Failed",
  reply_received: "Reply received",
  reply_sent: "Answered",
  delivered: "Product delivered",
};

function LeadLink({ url, label, missing, className }: { url: string | null; label: string; missing: string; className?: string }) {
  const href = webUrl(url);
  if (!href) return <span>{url ?? missing}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {label}
    </a>
  );
}

// A company opens in a panel over the page; the link behind it closes the panel.
export function CompanyPanel({
  detail,
  metrics,
  href,
  closeHref,
}: {
  detail: CompanyDetail;
  metrics: Metrics;
  href: Href;
  closeHref: string;
}) {
  const decisions = metrics.decisions.filter((d) => d.company_id === detail.company.id);
  const parent = detail.company.parent_id ? slugFor(metrics, detail.company.parent_id) : null;
  return (
    <>
      <Link className="scrim" href={closeHref} aria-label="Close" />
      <aside className="panel" aria-label={`Company ${detail.company.slug}`}>
        <div className="panel-top">
          <Link className="panel-close" href={closeHref}>
            Close
          </Link>
        </div>
        <CompanyView detail={detail} sample={false} />
        {parent ? (
          <p className="panel-note">
            Copies the offer of <Link href={href(parent)}>{parent}</Link>.
          </p>
        ) : null}
        {decisions.length ? (
          <section className="panel-section">
            <h3>Decisions</h3>
            <ul className="reasons">
              {decisions.map((d) => (
                <li key={d.id}>
                  <b>
                    {AGENT_LABEL[d.agent] ?? d.agent} {KIND_LABEL[d.kind]?.toLowerCase() ?? d.kind}
                  </b>{" "}
                  {d.reason} <time dateTime={d.at}>{clockTime(d.at)}</time>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </aside>
    </>
  );
}

export function CompanyView({ detail, sample }: { detail: CompanyDetail | null; sample: boolean }) {
  if (!detail) {
    return (
      <section className="card" aria-labelledby="company-title">
        <div className="head">
          <h2 id="company-title">Pick a company</h2>
        </div>
        <p className="empty">{sample ? "The sample only has detail for co-01." : "No company to show yet."}</p>
      </section>
    );
  }
  const { company: c, offer, leads, spend } = detail;
  return (
    <section className="card" aria-labelledby="company-title">
      <div className="head">
        <h2 id="company-title">
          Inside {c.slug} <StatusTag status={c.status} />
        </h2>
        <span>
          Spawned {clockTime(c.spawned_at)}
          {c.killed_at ? `, killed ${clockTime(c.killed_at)}` : ""}
        </span>
      </div>
      <div className="company">
        <div className="offer">
          <dl>
            <div>
              <dt>Buyer</dt>
              <dd>{offer.buyer}</dd>
            </div>
            <div>
              <dt>Free sample</dt>
              <dd>{offer.sample}</dd>
            </div>
            <div>
              <dt>Paid product</dt>
              <dd>
                {offer.product}, {usdFromCents(offer.price_cents)}
              </dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>{offer.channel.replace("_", " ")}</dd>
            </div>
          </dl>
          <h3>First message, as approved</h3>
          <blockquote>{offer.outreach_message}</blockquote>
          {spend.length > 0 ? (
            <>
              <h3>Spend per agent</h3>
              <ul className="spend">
                {spend.map((s) => (
                  <li key={s.agent_name}>
                    <span>{s.agent_name}</span>
                    <span>{usdFromMicro(s.micro_usd)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        <div className="leads">
          {leads.length === 0 ? <p className="empty">No leads assigned yet.</p> : null}
          {leads.map((lead) => (
            <article key={lead.id} className="lead">
              <header>
                <h3>{lead.name}</h3>
                <span className={`chip status-lead-${lead.status}`}>{lead.status}</span>
              </header>
              <p className="lead-links">
                <LeadLink url={lead.url} label="Their site now ↗" missing="No site on file" />
                <LeadLink url={lead.sample_url} label="Our free sample ↗" missing="Sample not built yet" className="strong" />
              </p>
              <ol className="touches">
                {lead.touches.map((t, i) => (
                  <li key={i} className={`touch-${t.kind}`}>
                    <time dateTime={t.at}>{clockTime(t.at)}</time>
                    <p>
                      <b>{TOUCH_LABEL[t.kind] ?? t.kind}</b>
                      <span>{t.channel.replace("_", " ")}</span>
                      {t.agent_name ? <span>{t.agent_name}</span> : null}
                    </p>
                    {t.detail ? <q>{t.detail}</q> : null}
                  </li>
                ))}
                {lead.payments.map((p, i) => (
                  <li key={`p${i}`} className="touch-paid">
                    <time dateTime={p.at}>{clockTime(p.at)}</time>
                    <p>
                      <b>
                        Paid {usdFromCents(p.amount_cents - (p.refunded_cents ?? 0))}
                        {p.livemode === false ? " (test mode)" : ""}
                      </b>
                      <span>{p.source === "stripe" ? "Stripe" : "Naïve checkout"}</span>
                    </p>
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
