/**
 * Agent MVP (#775): the registry needs operator auth on `register`, so only the
 * configured operator may build a registration, and the backend signs only the
 * operator's own auth entry in the returned XDR.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import {
  Account,
  Address,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

const OPERATOR = Keypair.random();
const OTHER_ADMIN = Keypair.random().publicKey();
const AGENT = Keypair.random().publicKey();
const BORROWER = Keypair.random().publicKey();

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.ADMIN_WALLETS = `${OPERATOR.publicKey()},${OTHER_ADMIN}`;
process.env.AGENT_WALLETS = AGENT;
process.env.AGENT_OPERATOR_PUBLIC_KEY = OPERATOR.publicKey();
process.env.AGENT_OPERATOR_SECRET = OPERATOR.secret();
process.env.SCORE_RECONCILIATION_SOURCE_SECRET = OPERATOR.secret();
process.env.AGENT_REGISTRY_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
process.env.AGENT_VAULT_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 8));

function addressAuth(publicKey: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(publicKey).toScAddress(),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(
            process.env.AGENT_REGISTRY_CONTRACT_ID as string,
          ).toScAddress(),
          functionName: 'register',
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();
const mockQuery = jest.fn<() => Promise<{ rows: unknown[]; rowCount: number }>>(async () => ({
  rows: [],
  rowCount: 0,
}));

// Stand-in for simulation: attach the auth entries the registry asks for.
jest.unstable_mockModule('../config/stellar.js', () => ({
  createSorobanRpcServer: () => ({
    getAccount: async (key: string) => new Account(key, '1'),
    getLatestLedger: async () => ({ sequence: 100 }),
    simulateTransaction: mockSimulateTransaction,
    prepareTransaction: async (tx: { toEnvelope: () => xdr.TransactionEnvelope }) => {
      const envelope = tx.toEnvelope();
      envelope
        .v1()
        .tx()
        .operations()[0]
        .body()
        .invokeHostFunctionOp()
        .auth([addressAuth(OPERATOR.publicKey()), addressAuth(BORROWER)]);
      return TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
    },
  }),
  getStellarNetworkPassphrase: () => Networks.TESTNET,
  getStellarRpcUrl: () => 'http://localhost:8000',
}));

jest.unstable_mockModule('../db/connection.js', () => ({
  query: mockQuery,
}));

const { default: agentRoutes } = await import('../routes/agentRoutes.js');
const { PUBLIC_SOLVENCY_CACHE_KEY } = await import('../controllers/agentMvpController.js');
const { cacheService } = await import('../services/cacheService.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { generateJwtToken } = await import('../services/authService.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentRoutes);
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    errorHandler(err, req, res, next);
  });
  return app;
}

const body = {
  agentPublicKey: AGENT,
  kycRef: 'KYC1',
  region: 'LAGOS',
  bond: '100',
  licenseExpiry: String(Math.floor(Date.now() / 1000) + 86_400),
};

function register(caller: string) {
  return request(buildApp())
    .post('/api/agents/register')
    .set('Authorization', `Bearer ${generateJwtToken(caller)}`)
    .send(body);
}

describe('POST /api/agents/register', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['the agent registering itself', AGENT],
    ['a borrower', BORROWER],
    ['an admin that is not the operator', OTHER_ADMIN],
  ])('returns 403 for %s', async (_label, caller) => {
    const res = await register(caller);
    expect(res.status).toBe(403);
  });

  it('signs only the operator auth entry for the operator', async () => {
    const res = await register(OPERATOR.publicKey());
    expect(res.status).toBe(200);

    const tx = TransactionBuilder.fromXDR(res.body.unsignedTxXdr, Networks.TESTNET);
    const auth = tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().auth();
    const signature = (entry: xdr.SorobanAuthorizationEntry) =>
      entry.credentials().address().signature().switch();

    expect(signature(auth[0])).not.toBe(xdr.ScValType.scvVoid());
    expect(signature(auth[1])).toBe(xdr.ScValType.scvVoid());
  });
});

function buildInvariantsRetval(
  entries: Array<{ agent: string; holds: boolean; float: bigint; maxAllowed: bigint }>,
): xdr.ScVal {
  return xdr.ScVal.scvVec(
    entries.map((entry) =>
      xdr.ScVal.scvVec([
        nativeToScVal(Address.fromString(entry.agent), { type: 'address' }),
        xdr.ScVal.scvBool(entry.holds),
        nativeToScVal(entry.float, { type: 'i128' }),
        nativeToScVal(entry.maxAllowed, { type: 'i128' }),
      ]),
    ),
  );
}

describe('GET /api/agents/solvency', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await cacheService.delete(PUBLIC_SOLVENCY_CACHE_KEY);
  });

  it('returns empty agents and holds=true when there are no active agents', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(buildApp()).get('/api/agents/solvency');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      source: 'contract-simulation',
      agents: [],
      totals: {
        collateral: 0,
        float: 0,
        maxAllowed: 0,
        holds: true,
      },
    });
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it('simulates check_invariants on agent_vault and reports holds=true when invariant holds', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_address: AGENT, collateral_balance: '1000000000' }],
      rowCount: 1,
    });
    mockSimulateTransaction.mockResolvedValueOnce({
      result: {
        retval: buildInvariantsRetval([
          {
            agent: AGENT,
            holds: true,
            float: 500_000_000n,
            maxAllowed: 800_000_000n,
          },
        ]),
      },
    });

    const res = await request(buildApp()).get('/api/agents/solvency');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      source: 'contract-simulation',
      agents: [
        {
          agentPublicKey: AGENT,
          collateral: 100,
          float: 50,
          maxAllowed: 80,
          holds: true,
        },
      ],
      totals: {
        collateral: 100,
        float: 50,
        maxAllowed: 80,
        holds: true,
      },
    });
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports holds=false on the agent and network totals when an invariant is violated', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_address: AGENT, collateral_balance: '1000000000' }],
      rowCount: 1,
    });
    mockSimulateTransaction.mockResolvedValueOnce({
      result: {
        retval: buildInvariantsRetval([
          {
            agent: AGENT,
            holds: false,
            float: 900_000_000n,
            maxAllowed: 800_000_000n,
          },
        ]),
      },
    });

    const res = await request(buildApp()).get('/api/agents/solvency');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      source: 'contract-simulation',
      agents: [
        {
          agentPublicKey: AGENT,
          collateral: 100,
          float: 90,
          maxAllowed: 80,
          holds: false,
        },
      ],
      totals: {
        collateral: 100,
        float: 90,
        maxAllowed: 80,
        holds: false,
      },
    });
  });
});
