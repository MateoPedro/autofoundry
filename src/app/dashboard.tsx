import Link from "next/link";
import type { AgentRow, AgentsView, CompanyDetail, CompanyEntry, Decision, Metrics } from "@/lib/dashboard/types";
import { webUrl } from "@/lib/url";
import {
  AGENT_LABEL,
  KIND_LABEL,
  buildLineage,
  clip,
  clockTime,
  percent,
  slugFor,
  usdFromCents,
  usdFromMicro,
  type LineageNode,
} from "@/lib/dashboard/view";

type Href = (focus: string) => string;

export type Show = "all" | "active" | "waiting" | "killed";

const SHOWS: { key: Show; label: string; matches: (status: CompanyEntry["status"]) => boolean }[] = [
  { key: "all", label: "All", matches: () => true },
  { key: "active", label: "Active", matches: (s) => s === "active" },
  { key: "waiting", label: "Waiting", matches: (s) => s === "proposed" || s === "spawning" },
  { key: "killed", label: "Killed", matches: (s) => s === "killed" || s === "failed" },
];

export const isShow = (value: string | undefined): value is Show => SHOWS.some((s) => s.key === value);

const STATUS_LABEL: Record<CompanyEntry["status"], string> = {
  spawning: "Spawning",
  proposed: "Waiting",
  active: "Active",
  killed: "Killed",
  failed: "Failed",
};

const STAGES = [
  ["leads", "Leads"],
  ["sampled", "Sampled"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["paid", "Paid"],
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
  return (
    <section className="card totals" aria-label="Foundry totals">
      <div>
        <p className="label">Companies</p>
        <p className="figure">
          {t.companies_active} <small>active</small>
        </p>
        <p className="sub">
          {t.companies_proposed} waiting, {t.companies_killed} killed
        </p>
      </div>
      <div>
        <p className="label">Demand found</p>
        <p className="figure">
          {t.leads} <small>leads</small>
        </p>
        <p className="sub">
          {t.clusters_approved} of {t.clusters} clusters approved
        </p>
      </div>
      <div>
        <p className="label">Outreach</p>
        <p className="figure">
          {t.replies} <small>replies</small>
        </p>
        <p className="sub">from {t.touches} touches</p>
      </div>
      <div>
        <p className="label">Revenue vs spend</p>
        <p className="figure">
          {usdFromCents(t.revenue_cents)} <small>/ {usdFromMicro(t.spend_micro_usd)}</small>
        </p>
        <p className="sub">{t.payments} verified payments</p>
      </div>
    </section>
  );
}

function StatusTag({ status }: { status: CompanyEntry["status"] }) {
  return <span className={`chip status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function CompanyCard({ company: c, metrics, href }: { company: CompanyEntry; metrics: Metrics; href: Href }) {
  const parent = c.parent_id ? slugFor(metrics, c.parent_id) : null;
  return (
    <article className="co">
      <div className="co-top">
        <Link href={href(c.slug)} className="co-name">
          {c.slug}
        </Link>
        <Link href={href(c.slug)} className="co-open">
          View company
        </Link>
      </div>
      <p className="co-offer">{c.offer_summary}</p>
      <p className="co-meta">
        Spawned {clockTime(c.spawned_at)}
        {parent ? ` from ${parent}'s offer` : ""}
        {c.killed_at ? `, killed ${clockTime(c.killed_at)}` : ""}
      </p>
      <div className="co-mid">
        <StatusTag status={c.status} />
        <p className="co-money">
          Revenue <b>{usdFromCents(c.revenue_cents)}</b> Spent <b>{usdFromMicro(c.spend_micro_usd)}</b> of {usdFromMicro(c.granted_micro_usd)}
        </p>
      </div>
      <dl className="strip">
        {STAGES.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{c.funnel[key]}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export function Companies({ metrics, href, show, showHref }: { metrics: Metrics; href: Href; show: Show; showHref: (show: Show) => string }) {
  const { matches } = SHOWS.find((s) => s.key === show) ?? SHOWS[0];
  const shown = metrics.companies.filter((c) => matches(c.status));
  return (
    <section className="card" id="companies" aria-labelledby="companies-title">
      <div className="head">
        <h2 id="companies-title">Companies</h2>
        <span>Spawned by Creator, funded or killed by VC</span>
      </div>
      {metrics.companies.length === 0 ? (
        <p className="empty">No companies yet. Creator starts one once Compliance approves a cluster and an offer.</p>
      ) : (
        <>
          <nav className="tabs" aria-label="Filter companies">
            {SHOWS.map((s) => (
              <Link key={s.key} href={showHref(s.key)} aria-current={s.key === show ? "page" : undefined}>
                {s.label} ({metrics.companies.filter((c) => s.matches(c.status)).length})
              </Link>
            ))}
          </nav>
          {shown.length === 0 ? (
            <p className="empty">No {show} companies.</p>
          ) : (
            <div className="cos">
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
    <section className="card" aria-labelledby="agents-title">
      <div className="head">
        <h2 id="agents-title">Agents at work</h2>
        <span>{agents.synced_at ? `Spend synced from Naïve ${clockTime(agents.synced_at)}` : "Spend not synced from Naïve yet"}</span>
      </div>
      <div className="table-scroll">
        <table className="agents">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Latest work</th>
              <th scope="col">When</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Spent
              </th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group}>
              <tr className="group">
                <th scope="colgroup" colSpan={5}>
                  {group}
                </th>
              </tr>
              {agents.rows
                .filter((r) => r.group === group)
                .map((r) => (
                  <tr key={r.key} className={r.agents ? "muted" : undefined}>
                    <th scope="row">
                      <div className="agent">
                        <AgentMark row={r} />
                        <span>
                          <b>{r.name}</b>
                          <small>{r.role}</small>
                        </span>
                      </div>
                    </th>
                    <td>{r.latest ?? <span className="none">Nothing recorded yet</span>}</td>
                    <td className="when">{r.at ? <time dateTime={r.at}>{clockTime(r.at)}</time> : "–"}</td>
                    <td>
                      <span className={`state state-${r.status}`}>{AGENT_STATUS[r.status]}</span>
                    </td>
                    <td className="num">{r.spend_micro_usd === null ? "–" : usdFromMicro(r.spend_micro_usd)}</td>
                  </tr>
                ))}
            </tbody>
          ))}
        </table>
      </div>
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
              <summary>Show {older.length} older decisions</summary>
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

function LineageItem({ node, href, focusId }: { node: LineageNode; href: Href; focusId: string | null }) {
  const c = node.company;
  return (
    <li>
      <div className={`node${c.id === focusId ? " focused" : ""}`}>
        <div className="node-top">
          <Link href={href(c.slug)} className="co-name">
            {c.slug}
          </Link>
          <StatusTag status={c.status} />
        </div>
        <p className="co-offer">{c.offer_summary}</p>
        {node.decisions.length > 0 ? (
          <ul className="reasons">
            {node.decisions.map((d) => (
              <li key={d.id}>
                <b>
                  {AGENT_LABEL[d.agent] ?? d.agent} {KIND_LABEL[d.kind]?.toLowerCase() ?? d.kind}
                </b>{" "}
                {d.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p className="reasons none">No logged reason in the recent decisions.</p>
        )}
      </div>
      {node.children.length > 0 ? (
        <ul className="tree">
          {node.children.map((child) => (
            <LineageItem key={child.company.id} node={child} href={href} focusId={focusId} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function Lineage({ metrics, href, focusId }: { metrics: Metrics; href: Href; focusId: string | null }) {
  const roots = buildLineage(metrics.companies, metrics.decisions);
  return (
    <section className="card" aria-labelledby="lineage-title">
      <div className="head">
        <h2 id="lineage-title">Lineage</h2>
        <span>Children sit under the company whose offer they copied</span>
      </div>
      {roots.length === 0 ? (
        <p className="empty">No companies yet. Creator starts one once Compliance approves a cluster and an offer.</p>
      ) : (
        <ul className="tree root">
          {roots.map((node) => (
            <LineageItem key={node.company.id} node={node} href={href} focusId={focusId} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Funnels({ metrics, href }: { metrics: Metrics; href: Href }) {
  if (metrics.companies.length === 0) return null;
  return (
    <section className="card" aria-labelledby="funnels-title">
      <div className="head">
        <h2 id="funnels-title">Funnels</h2>
        <span>From lead to payment, per company</span>
      </div>
      <div className="table-scroll">
        <table className="funnels">
          <thead>
            <tr>
              <th scope="col">Company</th>
              {STAGES.map(([key, label]) => (
                <th scope="col" key={key}>
                  {label}
                </th>
              ))}
              <th scope="col">Spent / granted</th>
              <th scope="col">Revenue</th>
              <th scope="col">Per reply</th>
            </tr>
          </thead>
          <tbody>
            {metrics.companies.map((c) => (
              <tr key={c.id}>
                <th scope="row">
                  <Link href={href(c.slug)} className="co-name">
                    {c.slug}
                  </Link>{" "}
                  <StatusTag status={c.status} />
                </th>
                {STAGES.map(([key]) => (
                  <td key={key}>
                    <span className="cell-num">{c.funnel[key]}</span>
                    <span className="bar" aria-hidden>
                      <span style={{ width: `${percent(c.funnel[key], c.funnel.leads)}%` }} />
                    </span>
                  </td>
                ))}
                <td>
                  {usdFromMicro(c.spend_micro_usd)} / {usdFromMicro(c.granted_micro_usd)}
                </td>
                <td>{usdFromCents(c.revenue_cents)}</td>
                <td>{c.cost_per_reply_micro_usd === null ? "–" : usdFromMicro(c.cost_per_reply_micro_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
