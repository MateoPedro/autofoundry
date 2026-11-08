import Link from "next/link";
import type { CompanyDetail, CompanyEntry, Decision, Metrics } from "@/lib/dashboard/types";
import { webUrl } from "@/lib/url";
import {
  AGENT_LABEL,
  KIND_LABEL,
  buildLineage,
  clockTime,
  percent,
  slugFor,
  usdFromCents,
  usdFromMicro,
  type LineageNode,
} from "@/lib/dashboard/view";

type Href = (focus: string) => string;

export function Stats({ metrics }: { metrics: Metrics }) {
  const t = metrics.totals;
  return (
    <section className="stats" aria-label="Foundry totals">
      <div>
        <span>Companies</span>
        <strong>
          {t.companies_active}
          <small> active</small>
        </strong>
        <em>
          {t.companies_proposed} waiting · {t.companies_killed} killed
        </em>
      </div>
      <div>
        <span>Demand found</span>
        <strong>
          {t.leads}
          <small> leads</small>
        </strong>
        <em>
          {t.clusters_approved} of {t.clusters} clusters approved
        </em>
      </div>
      <div>
        <span>Outreach</span>
        <strong>
          {t.replies}
          <small> replies</small>
        </strong>
        <em>from {t.touches} touches</em>
      </div>
      <div>
        <span>Revenue vs spend</span>
        <strong>
          {usdFromCents(t.revenue_cents)}
          <small> / {usdFromMicro(t.spend_micro_usd)}</small>
        </strong>
        <em>{t.payments} verified payments</em>
      </div>
    </section>
  );
}

function DecisionTarget({ decision, metrics, href }: { decision: Decision; metrics: Metrics; href: Href }) {
  const slug = slugFor(metrics, decision.company_id);
  if (slug) {
    return (
      <Link className="chip" href={href(slug)}>
        {slug}
      </Link>
    );
  }
  const other = decision.cluster_id ?? decision.offer_id;
  return other ? <span className="chip muted">{other}</span> : null;
}

export function DecisionLog({ metrics, href }: { metrics: Metrics; href: Href }) {
  return (
    <section className="decisions" aria-labelledby="decisions-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">DECISIONS WHILE YOU SLEPT</p>
          <h2 id="decisions-title">Every call Compliance, Creator and VC made</h2>
        </div>
        <span>{metrics.decisions.length} most recent</span>
      </div>
      {metrics.decisions.length === 0 ? (
        <p className="empty">No decisions yet. They appear here as soon as an agent approves, spawns, funds, kills or holds.</p>
      ) : (
        <ol className="log">
          {metrics.decisions.map((d) => (
            <li key={d.id}>
              <time dateTime={d.at}>{clockTime(d.at)}</time>
              <span className={`agent agent-${d.agent}`}>{AGENT_LABEL[d.agent] ?? d.agent}</span>
              <span className={`kind kind-${d.kind}`}>{KIND_LABEL[d.kind] ?? d.kind}</span>
              <DecisionTarget decision={d} metrics={metrics} href={href} />
              {d.amount_micro_usd ? <span className="amount">{usdFromMicro(d.amount_micro_usd)}</span> : null}
              <q>{d.reason}</q>
            </li>
          ))}
        </ol>
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
    <aside className="pool" aria-labelledby="pool-title">
      <p className="eyebrow">VC&apos;S POOL</p>
      <h2 id="pool-title">{usdFromMicro(p.pool_left_micro_usd)} left</h2>
      <div className="meter" role="img" aria-label={`${granted}% of the pool granted, ${spent}% spent`}>
        <span className="meter-granted" style={{ width: `${granted}%` }} />
        <span className="meter-spent" style={{ width: `${spent}%` }} />
      </div>
      <dl className="pool-rows">
        <div>
          <dt>Pool</dt>
          <dd>{usdFromMicro(p.pool_micro_usd)}</dd>
        </div>
        <div>
          <dt>
            <i className="swatch granted" /> Granted
          </dt>
          <dd>{usdFromMicro(p.granted_micro_usd)}</dd>
        </div>
        <div>
          <dt>
            <i className="swatch spent" /> Spent
          </dt>
          <dd>{usdFromMicro(t.spend_micro_usd)}</dd>
        </div>
        <div>
          <dt>Revenue</dt>
          <dd>{usdFromCents(t.revenue_cents)}</dd>
        </div>
      </dl>
      <p className="aside-note">
        One grant is {usdFromMicro(p.grant_micro_usd)}. At most {p.max_active} companies run and {p.max_proposed} wait at once.
        {metrics.spend_stale ? " Spend couldn't be refreshed from Naïve on this load, so it may be low." : ""}
      </p>
    </aside>
  );
}

function StatusTag({ status }: { status: CompanyEntry["status"] }) {
  return <span className={`status status-${status}`}>{status}</span>;
}

function LineageItem({ node, href, focusId }: { node: LineageNode; href: Href; focusId: string | null }) {
  const c = node.company;
  return (
    <li>
      <div className={`node${c.id === focusId ? " focused" : ""}`}>
        <div className="node-top">
          <Link href={href(c.slug)} className="node-slug">
            {c.slug}
          </Link>
          <StatusTag status={c.status} />
        </div>
        <p className="node-offer">{c.offer_summary}</p>
        {node.decisions.length > 0 ? (
          <ul className="node-reasons">
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
          <p className="node-reasons none">No logged reason in the recent decisions.</p>
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
    <section aria-labelledby="lineage-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">LINEAGE</p>
          <h2 id="lineage-title">Every company, and why it was spawned, funded or killed</h2>
        </div>
        <span>Children sit under the company whose offer they copied</span>
      </div>
      {roots.length === 0 ? (
        <p className="empty">No companies yet. Creator spawns one once Compliance approves a cluster and an offer.</p>
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

const STAGES = ["leads", "sampled", "contacted", "replied", "paid"] as const;

export function Funnels({ metrics, href }: { metrics: Metrics; href: Href }) {
  if (metrics.companies.length === 0) return null;
  return (
    <section aria-labelledby="funnels-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">FUNNELS</p>
          <h2 id="funnels-title">From lead to payment, per company</h2>
        </div>
      </div>
      <div className="table-scroll">
        <table className="funnels">
          <thead>
            <tr>
              <th scope="col">Company</th>
              {STAGES.map((s) => (
                <th scope="col" key={s}>
                  {s}
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
                  <Link href={href(c.slug)}>{c.slug}</Link> <StatusTag status={c.status} />
                </th>
                {STAGES.map((s) => (
                  <td key={s}>
                    <span className="cell-num">{c.funnel[s]}</span>
                    <span className="bar" aria-hidden>
                      <span style={{ width: `${percent(c.funnel[s], c.funnel.leads)}%` }} />
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
      <section aria-labelledby="company-title">
        <p className="eyebrow">ONE COMPANY</p>
        <h2 id="company-title">Pick a company</h2>
        <p className="empty">{sample ? "The sample only has detail for co-01." : "No company to show yet."}</p>
      </section>
    );
  }
  const { company: c, offer, leads, spend } = detail;
  return (
    <section className="company" aria-labelledby="company-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ONE COMPANY</p>
          <h2 id="company-title">
            {c.slug} <StatusTag status={c.status} />
          </h2>
        </div>
        <span>
          Spawned {clockTime(c.spawned_at)}
          {c.killed_at ? ` · killed ${clockTime(c.killed_at)}` : ""}
        </span>
      </div>
      <div className="company-grid">
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
          <p className="label">First message, as approved</p>
          <blockquote>{offer.outreach_message}</blockquote>
          {spend.length > 0 ? (
            <>
              <p className="label">Spend per agent</p>
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
                <span className={`status status-lead-${lead.status}`}>{lead.status}</span>
              </header>
              <p className="lead-links">
                <LeadLink url={lead.url} label="Their site now ↗" missing="No site on file" />
                <LeadLink url={lead.sample_url} label="Our free sample ↗" missing="Sample not built yet" className="strong" />
              </p>
              <ol className="touches">
                {lead.touches.map((t, i) => (
                  <li key={i} className={`touch touch-${t.kind}`}>
                    <time dateTime={t.at}>{clockTime(t.at)}</time>
                    <b>{TOUCH_LABEL[t.kind] ?? t.kind}</b>
                    <span>
                      {t.channel.replace("_", " ")}
                      {t.agent_name ? ` · ${t.agent_name}` : ""}
                    </span>
                    {t.detail ? <q>{t.detail}</q> : null}
                  </li>
                ))}
                {lead.payments.map((p, i) => (
                  <li key={`p${i}`} className="touch touch-paid">
                    <time dateTime={p.at}>{clockTime(p.at)}</time>
                    <b>
                      Paid {usdFromCents(p.amount_cents - (p.refunded_cents ?? 0))}
                      {p.livemode === false ? " (test mode)" : ""}
                    </b>
                    <span>{p.source === "stripe" ? "Stripe" : "Naïve checkout"}</span>
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
