"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useWallet } from "../providers/WalletProvider";
import { useWalletStore, selectWalletAddress } from "../../stores/useWalletStore";
import { useUserStore, selectUser } from "../../stores/useUserStore";
import {
  apiFetch,
  clearAgentDashboardCache,
  type AgentVaultSummary,
} from "../../hooks/useApi";
import { formatStroops, parseAmount } from "../../../../lib/money/format";

export type VaultAction =
  | "deposit-collateral"
  | "withdraw-collateral"
  | "burn-float"
  | "mint-float";

const ZERO_STROOPS = BigInt(0);

function renderStroopBalance(stroops: string | undefined): string {
  if (!stroops || !/^-?\d+$/.test(stroops)) {
    return `${formatStroops(ZERO_STROOPS)} USDC`;
  }
  return `${formatStroops(BigInt(stroops))} USDC`;
}

export function formatVaultContractError(
  error: unknown,
  t: (key: string) => string,
): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/SolvencyViolated|Contract,\s*#8\b/i.test(raw)) {
    return t("vaultSolvencyViolated");
  }
  if (/InsufficientFloat|Contract,\s*#7\b/i.test(raw)) {
    return t("vaultInsufficientFloat");
  }
  return raw || t("vaultFailed");
}

export interface AgentVaultActionsProps {
  vault?: AgentVaultSummary;
  onActionSuccess?: () => void | Promise<unknown>;
  mode?: "all" | "operator";
}

export function AgentVaultActions({
  vault,
  onActionSuccess,
  mode = "all",
}: AgentVaultActionsProps) {
  const address = useWalletStore(selectWalletAddress);
  const user = useUserStore(selectUser);
  const t = useTranslations("AgentDashboard");
  const { signTransaction } = useWallet();
  const isOperatorOnly = mode === "operator";
  const [action, setAction] = useState<VaultAction>(
    isOperatorOnly ? "mint-float" : "deposit-collateral",
  );
  const [amount, setAmount] = useState("");
  const [agentPublicKey, setAgentPublicKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveAction: VaultAction = isOperatorOnly ? "mint-float" : action;

  async function submit() {
    const target =
      effectiveAction === "mint-float"
        ? agentPublicKey.trim()
        : agentPublicKey.trim() || address;
    if (!target || !amount.trim()) {
      setMessage(t("vaultMissingInput"));
      return;
    }

    let stroops: bigint;
    try {
      stroops = parseAmount(amount);
    } catch {
      setMessage(t("vaultInvalidAmount"));
      return;
    }
    if (stroops <= ZERO_STROOPS) {
      setMessage(t("vaultInvalidAmount"));
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const built = await apiFetch<{ unsignedTxXdr: string }>(
        `/agents/vault/${effectiveAction}`,
        {
          method: "POST",
          body: JSON.stringify({
            agentPublicKey: target,
            amount: amount.trim(),
            amountStroops: stroops.toString(),
          }),
        },
      );
      const signedTxXdr = await signTransaction(built.unsignedTxXdr);
      await apiFetch("/agents/submit", {
        method: "POST",
        body: JSON.stringify({ signedTxXdr }),
      });
      await clearAgentDashboardCache().catch(() => {});
      await onActionSuccess?.();
      setMessage(t("vaultSubmitted"));
      setAmount("");
    } catch (error) {
      setMessage(formatVaultContractError(error, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          {isOperatorOnly ? t("vaultOperatorCashInTitle") : t("vaultTitle")}
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          {isOperatorOnly ? t("vaultOperatorCashInDesc") : t("vaultDescription")}
        </p>
      </div>

      {vault && !isOperatorOnly && (
        <div
          aria-label="Agent vault balances"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              {t("vaultCollateral")}
            </p>
            <p className="mt-1 text-lg font-semibold text-zinc-950 dark:text-zinc-50">
              {renderStroopBalance(vault.collateralStroops)}
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              {t("vaultFloat")}
            </p>
            <p className="mt-1 text-lg font-semibold text-zinc-950 dark:text-zinc-50">
              {renderStroopBalance(vault.floatStroops)}
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              {t("vaultMaxFloat")}
            </p>
            <p className="mt-1 text-lg font-semibold text-zinc-950 dark:text-zinc-50">
              {renderStroopBalance(vault.maxFloatStroops)}
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              {t("vaultHeadroom")}
            </p>
            <p className="mt-1 text-lg font-semibold text-green-600 dark:text-green-400">
              {renderStroopBalance(vault.headroomStroops)}
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {!isOperatorOnly && (
          <select
            aria-label="Vault action"
            value={action}
            onChange={(event) => setAction(event.target.value as VaultAction)}
            className="rounded border p-2 dark:bg-zinc-900"
          >
            <option value="deposit-collateral">{t("vaultDeposit")}</option>
            <option value="withdraw-collateral">{t("vaultWithdraw")}</option>
            <option value="burn-float">{t("vaultCashOut")}</option>
            {user?.role === "admin" && (
              <option value="mint-float">{t("vaultCashIn")}</option>
            )}
          </select>
        )}
        <input
          aria-label={t("vaultAgentKey")}
          value={agentPublicKey}
          onChange={(event) => setAgentPublicKey(event.target.value)}
          placeholder={
            effectiveAction === "mint-float"
              ? t("vaultAgentKey")
              : address ?? t("vaultAgentKey")
          }
          className="rounded border p-2 dark:bg-zinc-900"
        />
        <input
          aria-label={t("vaultAmount")}
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder={t("vaultAmount")}
          className="rounded border p-2 dark:bg-zinc-900"
        />
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {busy ? t("vaultWaiting") : t("vaultBuild")}
      </button>
      {message && (
        <p role="status" className="text-sm text-zinc-500">
          {message}
        </p>
      )}
    </section>
  );
}
