"use client";

import { useTranslations } from "next-intl";
import { usePublicSolvency } from "../../hooks/useApi";
import { getAccountUrl, truncateHash } from "../../utils/stellar";
import { formatStroops } from "../../../../lib/money/format";

function renderAmount(amount: number, stroops?: string): string {
  if (typeof stroops === "string" && /^-?\d+$/.test(stroops)) {
    return `${formatStroops(BigInt(stroops))} USDC`;
  }
  const scaled = BigInt(Math.round(amount * 10_000_000));
  return `${formatStroops(scaled)} USDC`;
}

export default function PublicSolvencyPage() {
  const t = useTranslations("PublicSolvency");
  const { data, isLoading, isError, refetch } = usePublicSolvency();

  const hasViolation =
    data != null && (!data.totals.holds || data.agents.some((agent) => !agent.holds));

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{t("title")}</h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t("description")}</p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
        >
          {t("refresh")}
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-zinc-500">{t("loading")}</p>
      ) : isError || !data ? (
        <p role="alert" className="text-sm text-red-600">
          {t("error")}
        </p>
      ) : (
        <>
          {hasViolation && (
            <div
              role="alert"
              className="rounded-2xl border border-red-300 bg-red-50 p-5 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            >
              <p className="font-semibold">{t("violationAlertTitle")}</p>
              <p className="mt-1 text-sm">{t("violationAlertDescription")}</p>
            </div>
          )}

          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                {t("networkStatus")}
              </p>
              <p
                className={`mt-2 text-xl font-semibold ${
                  data.totals.holds ? "text-green-600" : "text-red-600"
                }`}
              >
                {data.totals.holds ? t("statusHolds") : t("statusViolated")}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                {t("totalCollateral")}
              </p>
              <p className="mt-2 text-xl font-semibold text-zinc-950 dark:text-zinc-50">
                {renderAmount(data.totals.collateral, data.totals.collateralStroops)}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
              <p className="text-xs uppercase tracking-wide text-zinc-500">{t("totalFloat")}</p>
              <p className="mt-2 text-xl font-semibold text-zinc-950 dark:text-zinc-50">
                {renderAmount(data.totals.float, data.totals.floatStroops)}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                {t("totalMaxAllowed")}
              </p>
              <p className="mt-2 text-xl font-semibold text-zinc-950 dark:text-zinc-50">
                {renderAmount(data.totals.maxAllowed, data.totals.maxAllowedStroops)}
              </p>
            </div>
          </section>

          {data.agents.length === 0 ? (
            <div className="rounded-2xl border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
              {t("empty")}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-zinc-200 dark:border-zinc-800">
              <table className="min-w-full divide-y divide-zinc-200 text-left text-sm dark:divide-zinc-800">
                <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/50">
                  <tr>
                    <th className="px-4 py-3">{t("agentColumn")}</th>
                    <th className="px-4 py-3">{t("collateralColumn")}</th>
                    <th className="px-4 py-3">{t("floatColumn")}</th>
                    <th className="px-4 py-3">{t("maxAllowedColumn")}</th>
                    <th className="px-4 py-3">{t("invariantColumn")}</th>
                    <th className="px-4 py-3">{t("explorerColumn")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {data.agents.map((agent) => (
                    <tr
                      key={agent.agentPublicKey}
                      className={
                        agent.holds
                          ? ""
                          : "bg-red-50/70 dark:bg-red-950/30"
                      }
                    >
                      <td className="px-4 py-3 font-mono text-xs text-zinc-900 dark:text-zinc-100">
                        {truncateHash(agent.agentPublicKey, 6)}
                      </td>
                      <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                        {renderAmount(agent.collateral, agent.collateralStroops)}
                      </td>
                      <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                        {renderAmount(agent.float, agent.floatStroops)}
                      </td>
                      <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                        {renderAmount(agent.maxAllowed, agent.maxAllowedStroops)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            agent.holds
                              ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                              : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                          }`}
                        >
                          {agent.holds ? t("statusHolds") : t("statusViolated")}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={getAccountUrl(agent.agentPublicKey)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-indigo-600 underline hover:text-indigo-500 dark:text-indigo-400"
                        >
                          {t("viewExplorer")}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
