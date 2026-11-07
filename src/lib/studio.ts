export type Company = {
  id: string;
  name: string;
  theme: string;
  pitch: string;
  status: "active" | "stopped";
  budgetCents: number;
  spentCents: number;
  leads: number;
  revenueCents: number;
  activity: string[];
};

export type Studio = { availableCents: number; companies: Company[] };

// Demo policy. Live adapters must enforce these rules on the server.
export const policy = {
  totalBudgetCents: 100_000,
  initialGrantCents: 10_000,
  fundingTrancheCents: 10_000,
  maxCompanyBudgetCents: 50_000,
  maxActiveCompanies: 10,
} as const;

export function createStudio(): Studio {
  return {
    availableCents: 80_000,
    companies: [
      {
        id: "briefly",
        name: "Briefly",
        theme: "Team productivity",
        pitch: "Turn a busy team's updates into one useful daily brief.",
        status: "active",
        budgetCents: 10_000,
        spentCents: 2_000,
        leads: 18,
        revenueCents: 3_900,
        activity: ["Seeded sample company", "Sample landing page drafted", "18 simulated leads recorded"],
      },
      {
        id: "pantry",
        name: "Pantry Pilot",
        theme: "Food & everyday life",
        pitch: "A weekly meal plan built around what is already in your kitchen.",
        status: "active",
        budgetCents: 10_000,
        spentCents: 1_500,
        leads: 7,
        revenueCents: 0,
        activity: ["Seeded sample company", "Sample brand and positioning drafted"],
      },
    ],
  };
}

export function spawnCompany(studio: Studio, theme: string, id: string): Studio {
  const cleanTheme = theme.trim();
  if (cleanTheme.length < 2 || cleanTheme.length > 80) {
    throw new Error("Enter a theme between 2 and 80 characters.");
  }
  if (!id || studio.companies.some((company) => company.id === id)) {
    throw new Error("A company must have a unique ID.");
  }
  if (studio.companies.filter((company) => company.status === "active").length >= policy.maxActiveCompanies) {
    throw new Error("The studio can run up to 10 companies at a time.");
  }
  if (studio.availableCents < policy.initialGrantCents) {
    throw new Error("There is not enough studio budget to spawn a company.");
  }
  const company: Company = {
    id,
    name: `${cleanTheme.slice(0, 24)} Lab ${studio.companies.length + 1}`,
    theme: cleanTheme,
    pitch: `Explore a focused business opportunity in ${cleanTheme.toLowerCase()}.`,
    status: "active",
    budgetCents: policy.initialGrantCents,
    spentCents: 0,
    leads: 0,
    revenueCents: 0,
    activity: ["Demo concept created from your theme", "Mock idea, builder, and growth roles assigned", "$100 in simulated budget allocated"],
  };
  return {
    availableCents: studio.availableCents - policy.initialGrantCents,
    companies: [company, ...studio.companies],
  };
}

export function fundCompany(studio: Studio, id: string, amountCents: number = policy.fundingTrancheCents): Studio {
  const company = findActiveCompany(studio, id);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("Funding must be a positive whole number of cents.");
  }
  if (amountCents > studio.availableCents) throw new Error("The studio has insufficient budget.");
  if (company.budgetCents + amountCents > policy.maxCompanyBudgetCents) {
    throw new Error("This company has reached its $500 budget cap.");
  }
  return {
    availableCents: studio.availableCents - amountCents,
    companies: studio.companies.map((entry) => entry.id === id ? {
      ...entry,
      budgetCents: entry.budgetCents + amountCents,
      activity: [...entry.activity, `${money(amountCents)} in simulated funding approved`],
    } : entry),
  };
}

export function stopCompany(studio: Studio, id: string): Studio {
  const company = findActiveCompany(studio, id);
  const returnedCents = company.budgetCents - company.spentCents;
  return {
    availableCents: studio.availableCents + returnedCents,
    companies: studio.companies.map((entry) => entry.id === id ? {
      ...entry,
      status: "stopped",
      budgetCents: entry.spentCents,
      activity: [...entry.activity, `Company stopped; ${money(returnedCents)} in unused budget returned`],
    } : entry),
  };
}

function findActiveCompany(studio: Studio, id: string): Company {
  const company = studio.companies.find((entry) => entry.id === id);
  if (!company) throw new Error("Company not found.");
  if (company.status === "stopped") throw new Error("This company has already been stopped.");
  return company;
}

export function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(cents / 100);
}
