import { render, screen } from "@testing-library/react";
import PublicSolvencyPage from "./page";
import { usePublicSolvency } from "../../hooks/useApi";

const AGENT_1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const AGENT_2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWJX";

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages: Record<string, string> = {
      title: "Public Agent Solvency",
      description:
        "Real-time on-chain solvency verification simulated directly against the agent vault contract.",
      refresh: "Refresh",
      loading: "Simulating on-chain solvency invariants…",
      error: "Could not load solvency verification.",
      empty: "No active agent vaults found.",
      networkStatus: "Network Invariant",
      totalCollateral: "Total Collateral",
      totalFloat: "Total Float",
      totalMaxAllowed: "Max Allowed Float",
      statusHolds: "Invariant Holds",
      statusViolated: "Invariant Violated",
      violationAlertTitle: "Solvency Invariant Violated",
      violationAlertDescription:
        "One or more active agent vaults have outstanding float exceeding their collateral haircut limit.",
      agentColumn: "Agent",
      collateralColumn: "Collateral",
      floatColumn: "Float",
      maxAllowedColumn: "Max Allowed",
      invariantColumn: "Invariant",
      explorerColumn: "Explorer",
      viewExplorer: "View on Explorer",
    };
    return (key: string) => messages[key] ?? key;
  },
}));

jest.mock("../../hooks/useApi", () => ({
  usePublicSolvency: jest.fn(),
}));

describe("PublicSolvencyPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders empty state when there are no active agents", () => {
    jest.mocked(usePublicSolvency).mockReturnValue({
      data: {
        success: true,
        source: "contract-simulation",
        agents: [],
        totals: {
          collateral: 0,
          float: 0,
          maxAllowed: 0,
          collateralStroops: "0",
          floatStroops: "0",
          maxAllowedStroops: "0",
          holds: true,
        },
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    } as unknown as ReturnType<typeof usePublicSolvency>);

    render(<PublicSolvencyPage />);

    expect(screen.getByRole("heading", { name: "Public Agent Solvency" })).toBeInTheDocument();
    expect(screen.getByText("No active agent vaults found.")).toBeInTheDocument();
    expect(screen.getByText("Invariant Holds")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders active agents with float, collateral, invariant holds status, and explorer links", () => {
    jest.mocked(usePublicSolvency).mockReturnValue({
      data: {
        success: true,
        source: "contract-simulation",
        agents: [
          {
            agentPublicKey: AGENT_1,
            collateral: 100,
            float: 50,
            maxAllowed: 80,
            collateralStroops: "1000000000",
            floatStroops: "500000000",
            maxAllowedStroops: "800000000",
            holds: true,
          },
        ],
        totals: {
          collateral: 100,
          float: 50,
          maxAllowed: 80,
          collateralStroops: "1000000000",
          floatStroops: "500000000",
          maxAllowedStroops: "800000000",
          holds: true,
        },
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    } as unknown as ReturnType<typeof usePublicSolvency>);

    render(<PublicSolvencyPage />);

    expect(screen.getAllByText("100.00 USDC").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("50.00 USDC").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("80.00 USDC").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Invariant Holds")).toHaveLength(2);
    const explorerLink = screen.getByRole("link", { name: "View on Explorer" });
    expect(explorerLink).toHaveAttribute(
      "href",
      expect.stringContaining(`/account/${AGENT_1}`),
    );
  });

  it("clearly surfaces a violated invariant alert and row status when an agent violates solvency", () => {
    jest.mocked(usePublicSolvency).mockReturnValue({
      data: {
        success: true,
        source: "contract-simulation",
        agents: [
          {
            agentPublicKey: AGENT_2,
            collateral: 100,
            float: 95,
            maxAllowed: 80,
            collateralStroops: "1000000000",
            floatStroops: "950000000",
            maxAllowedStroops: "800000000",
            holds: false,
          },
        ],
        totals: {
          collateral: 100,
          float: 95,
          maxAllowed: 80,
          collateralStroops: "1000000000",
          floatStroops: "950000000",
          maxAllowedStroops: "800000000",
          holds: false,
        },
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    } as unknown as ReturnType<typeof usePublicSolvency>);

    render(<PublicSolvencyPage />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Solvency Invariant Violated");
    expect(screen.getAllByText("Invariant Violated")).toHaveLength(2);
  });
});
