import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentVaultActions } from "./AgentVaultActions";
import AgentDashboardPage from "../../[locale]/agent/dashboard/page";
import { useWallet } from "../providers/WalletProvider";
import { useWalletStore } from "../../stores/useWalletStore";
import { useUserStore } from "../../stores/useUserStore";
import {
  apiFetch,
  clearAgentDashboardCache,
  useAgentDashboard,
} from "../../hooks/useApi";
import { useSSE } from "../../hooks/useSSE";

const AGENT_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OPERATOR_KEY = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWJX";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => {
    const messages: Record<string, string> = {
      title: "Agent Dashboard",
      description: "Monitor your loan origination, earnings, and portfolio performance.",
      forbidden: "You don't have access to this area.",
      loading: "Loading dashboard…",
      error: "Could not load dashboard data.",
      noData: "No dashboard data available.",
      floatUtilization: "Float Utilization",
      totalEarnings: "Total Earnings",
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
      collateralRatio: "Collateral Ratio",
      totalLoans: "Total Loans",
      activeLoans: "Active Loans",
      defaultedLoans: "Defaulted Loans",
      pendingSettlements: "Pending Settlements",
      totalValue: "total value",
      settlementCount: "pending settlements",
      recentTransactions: "Recent Transactions",
      noTransactions: "No recent transactions.",
      autoRefresh: "Auto-refresh",
      refresh: "Refresh Now",
      vaultTitle: "Agent vault actions",
      vaultDescription:
        "Amounts are entered in whole tokens and converted to stroops before signing.",
      vaultMissingInput: "Connect a wallet and enter an amount.",
      vaultSubmitted: "Transaction submitted.",
      vaultFailed: "Transaction failed.",
      vaultDeposit: "Deposit collateral",
      vaultWithdraw: "Withdraw collateral",
      vaultCashOut: "Cash out",
      vaultCashIn: "Record cash in (admin)",
      vaultAgentKey: "Agent public key",
      vaultAmount: "Amount",
      vaultWaiting: "Waiting for wallet…",
      vaultBuild: "Build and sign",
      vaultCollateral: "Vault Collateral",
      vaultFloat: "Issued Float",
      vaultMaxFloat: "Max Allowed Float",
      vaultHeadroom: "Remaining Headroom",
      vaultOperatorCashInTitle: "Operator Cash-In (Mint Float)",
      vaultOperatorCashInDesc:
        "Record a cash-in (mint_float) for a chosen agent, signed with the admin operator wallet.",
      vaultInvalidAmount: "Enter a valid positive amount.",
      vaultSolvencyViolated:
        "Solvency violated: requested amount exceeds the vault's collateral haircut limit (max allowed float).",
      vaultInsufficientFloat:
        "Insufficient float: requested amount exceeds the agent's available float balance.",
    };
    return (key: string) => messages[key] ?? key;
  },
}));

jest.mock("../providers/WalletProvider", () => ({
  useWallet: jest.fn(),
}));

jest.mock("../../hooks/useSSE", () => ({
  useSSE: jest.fn(),
}));

jest.mock("../../hooks/useApi", () => ({
  apiFetch: jest.fn(),
  clearAgentDashboardCache: jest.fn(async () => ({
    success: true,
    message: "cleared",
  })),
  useAgentDashboard: jest.fn(),
}));

describe("AgentVaultActions & AgentDashboardPage", () => {
  const mockSignTransaction = jest.fn(async (xdr: string) => `signed:${xdr}`);

  beforeEach(() => {
    jest.clearAllMocks();
    useWalletStore.setState({
      address: AGENT_KEY,
      isConnected: true,
    } as unknown as Parameters<typeof useWalletStore.setState>[0]);
    useUserStore.setState({
      user: {
        id: "agent-1",
        email: "agent@example.com",
        kycVerified: true,
        role: "agent",
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
    jest.mocked(useWallet).mockReturnValue({
      signTransaction: mockSignTransaction,
    } as unknown as ReturnType<typeof useWallet>);
  });

  it("displays collateral, float, max float, and remaining headroom formatted from stroops", () => {
    render(
      <AgentVaultActions
        vault={{
          collateralStroops: "1000000000",
          floatStroops: "300000000",
          maxFloatStroops: "800000000",
          headroomStroops: "500000000",
          haircutBps: 8000,
          isActive: true,
        }}
      />,
    );

    expect(screen.getByText("100.00 USDC")).toBeInTheDocument();
    expect(screen.getByText("30.00 USDC")).toBeInTheDocument();
    expect(screen.getByText("80.00 USDC")).toBeInTheDocument();
    expect(screen.getByText("50.00 USDC")).toBeInTheDocument();
  });

  it("submits deposit-collateral in stroops, signs the XDR, and triggers refresh", async () => {
    const onActionSuccess = jest.fn();
    jest
      .mocked(apiFetch)
      .mockResolvedValueOnce({ unsignedTxXdr: "unsigned-deposit-xdr" })
      .mockResolvedValueOnce({ success: true, txHash: "tx-1" });

    render(<AgentVaultActions onActionSuccess={onActionSuccess} />);

    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "25.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build and sign" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Transaction submitted.");
    });
    expect(apiFetch).toHaveBeenCalledWith("/agents/vault/deposit-collateral", {
      method: "POST",
      body: JSON.stringify({
        agentPublicKey: AGENT_KEY,
        amount: "25.5",
        amountStroops: "255000000",
      }),
    });
    expect(mockSignTransaction).toHaveBeenCalledWith("unsigned-deposit-xdr");
    expect(apiFetch).toHaveBeenCalledWith("/agents/submit", {
      method: "POST",
      body: JSON.stringify({ signedTxXdr: "signed:unsigned-deposit-xdr" }),
    });
    expect(clearAgentDashboardCache).toHaveBeenCalled();
    expect(onActionSuccess).toHaveBeenCalled();
  });

  it("records an operator cash-in (mint-float) for a chosen agent signed with the admin wallet", async () => {
    useWalletStore.setState({
      address: OPERATOR_KEY,
      isConnected: true,
    } as unknown as Parameters<typeof useWalletStore.setState>[0]);
    useUserStore.setState({
      user: {
        id: "admin-1",
        email: "admin@example.com",
        kycVerified: true,
        role: "admin",
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
    jest
      .mocked(apiFetch)
      .mockResolvedValueOnce({ unsignedTxXdr: "unsigned-mint-xdr" })
      .mockResolvedValueOnce({ success: true, txHash: "tx-mint" });

    render(<AgentVaultActions mode="operator" />);

    fireEvent.change(screen.getByLabelText("Agent public key"), {
      target: { value: AGENT_KEY },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "40" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build and sign" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Transaction submitted.");
    });
    expect(apiFetch).toHaveBeenCalledWith("/agents/vault/mint-float", {
      method: "POST",
      body: JSON.stringify({
        agentPublicKey: AGENT_KEY,
        amount: "40",
        amountStroops: "400000000",
      }),
    });
    expect(mockSignTransaction).toHaveBeenCalledWith("unsigned-mint-xdr");
  });

  it("maps SolvencyViolated and InsufficientFloat contract errors to clear messages without a frontend pre-check", async () => {
    jest
      .mocked(apiFetch)
      .mockRejectedValueOnce(new Error("SolvencyViolated: exceeds limit"));

    render(
      <AgentVaultActions
        vault={{
          collateralStroops: "1000000000",
          floatStroops: "300000000",
          maxFloatStroops: "800000000",
          headroomStroops: "500000000",
          haircutBps: 8000,
          isActive: true,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Vault action"), {
      target: { value: "withdraw-collateral" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build and sign" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Solvency violated: requested amount exceeds the vault's collateral haircut limit (max allowed float).",
      );
    });

    jest
      .mocked(apiFetch)
      .mockRejectedValueOnce(new Error("HostError: Error(Contract, #7)"));

    fireEvent.change(screen.getByLabelText("Vault action"), {
      target: { value: "burn-float" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build and sign" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Insufficient float: requested amount exceeds the agent's available float balance.",
      );
    });
  });

  it("refreshes the agent dashboard when a vault event arrives over the SSE stream", async () => {
    const refetch = jest.fn();
    jest.mocked(useAgentDashboard).mockReturnValue({
      data: {
        agentPublicKey: AGENT_KEY,
        vault: {
          collateralStroops: "1000000000",
          floatStroops: "300000000",
          maxFloatStroops: "800000000",
          headroomStroops: "500000000",
          haircutBps: 8000,
          isActive: true,
        },
        floatUtilization: { totalFloat: 30, allocated: 10, utilizationPct: 33.33 },
        earnings: { daily: 1, weekly: 5, monthly: 20, total: 100 },
        borrowerPortfolio: {
          totalLoans: 2,
          activeLoans: 2,
          defaultedLoans: 0,
          totalOutstanding: 10,
          byStatus: { active: 2, defaulted: 0 },
        },
        pendingSettlements: { count: 0, totalValue: 0 },
        collateralRatio: { totalCollateral: 100, totalDebt: 30, ratio: 3.3333 },
        recentTransactions: [],
      },
      isLoading: false,
      isError: false,
      refetch,
    } as unknown as ReturnType<typeof useAgentDashboard>);

    render(<AgentDashboardPage />);

    const sseOptions = jest.mocked(useSSE).mock.calls[0]?.[0];
    expect(sseOptions).toBeDefined();
    sseOptions?.onMessage({ eventType: "FloatMinted" });

    await waitFor(() => {
      expect(clearAgentDashboardCache).toHaveBeenCalled();
      expect(refetch).toHaveBeenCalled();
    });
  });
});
