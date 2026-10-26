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
  xdr,
} from '@stellar/stellar-sdk';

const OPERATOR = Keypair.random();
const OTHER_ADMIN = Keypair.random().publicKey();
const AGENT = Keypair.random().publicKey();
const OTHER_AGENT = Keypair.random().publicKey();
const BORROWER = Keypair.random().publicKey();

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.ADMIN_WALLETS = `${OPERATOR.publicKey()},${OTHER_ADMIN}`;
process.env.AGENT_WALLETS = `${AGENT},${OTHER_AGENT}`;
process.env.AGENT_OPERATOR_PUBLIC_KEY = OPERATOR.publicKey();
process.env.AGENT_OPERATOR_SECRET = OPERATOR.secret();
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

const mockPrepareTransaction = jest.fn<
  (tx: { toEnvelope: () => xdr.TransactionEnvelope }) => Promise<unknown>
>(async (tx) => {
  const envelope = tx.toEnvelope();
  envelope
    .v1()
    .tx()
    .operations()[0]
    .body()
    .invokeHostFunctionOp()
    .auth([addressAuth(OPERATOR.publicKey()), addressAuth(BORROWER)]);
  return TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
});
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>(
  async () => ({ rows: [], rowCount: 0 }),
);

// Stand-in for simulation: attach the auth entries the registry asks for.
jest.unstable_mockModule('../config/stellar.js', () => ({
  createSorobanRpcServer: () => ({
    getAccount: async (key: string) => new Account(key, '1'),
    getLatestLedger: async () => ({ sequence: 100 }),
    prepareTransaction: mockPrepareTransaction,
  }),
  getStellarNetworkPassphrase: () => Networks.TESTNET,
  getStellarRpcUrl: () => 'http://localhost:8000',
}));

jest.unstable_mockModule('../db/connection.js', () => ({
  query: mockQuery,
}));

const { default: agentRoutes } = await import('../routes/agentRoutes.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { generateJwtToken } = await import('../services/authService.js');
const { scValToNative } = await import('@stellar/stellar-sdk');

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

function decodeVaultInvocation(unsignedTxXdr: string) {
  const tx = TransactionBuilder.fromXDR(unsignedTxXdr, Networks.TESTNET);
  const op = tx.toEnvelope().v1().tx().operations()[0]!.body().invokeHostFunctionOp();
  const contractArgs = op.hostFunction().invokeContract();
  const fnName = contractArgs.functionName().toString();
  const args = contractArgs.args();
  return {
    source: tx.source,
    contractId: Address.fromScAddress(contractArgs.contractAddress()).toString(),
    fnName,
    agentArg: String(scValToNative(args[0]!)),
    amountStroops: BigInt(String(scValToNative(args[1]!))),
  };
}

describe('POST /api/agents/vault/:action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['deposit-collateral', 'deposit_collateral', '100', 1_000_000_000n],
    ['withdraw-collateral', 'withdraw_collateral', '25.5', 255_000_000n],
    ['burn-float', 'burn_float', '12.25', 122_500_000n],
  ])(
    'builds %s (%s) in stroops for the authenticated agent wallet',
    async (routeAction, contractFn, inputAmount, expectedStroops) => {
      const res = await request(buildApp())
        .post(`/api/agents/vault/${routeAction}`)
        .set('Authorization', `Bearer ${generateJwtToken(AGENT)}`)
        .send({ agentPublicKey: AGENT, amount: inputAmount });

      expect(res.status).toBe(200);
      const decoded = decodeVaultInvocation(res.body.unsignedTxXdr);
      expect(decoded.source).toBe(AGENT);
      expect(decoded.contractId).toBe(process.env.AGENT_VAULT_CONTRACT_ID);
      expect(decoded.fnName).toBe(contractFn);
      expect(decoded.agentArg).toBe(AGENT);
      expect(decoded.amountStroops).toBe(expectedStroops);
    },
  );

  it.each(['deposit-collateral', 'withdraw-collateral', 'burn-float'])(
    'returns 403 on %s when an agent specifies another agent wallet',
    async (routeAction) => {
      const res = await request(buildApp())
        .post(`/api/agents/vault/${routeAction}`)
        .set('Authorization', `Bearer ${generateJwtToken(AGENT)}`)
        .send({ agentPublicKey: OTHER_AGENT, amount: '10' });

      expect(res.status).toBe(403);
    },
  );

  it('builds mint-float for a chosen agent signed with the operator wallet', async () => {
    const res = await request(buildApp())
      .post('/api/agents/vault/mint-float')
      .set('Authorization', `Bearer ${generateJwtToken(OPERATOR.publicKey())}`)
      .send({ agentPublicKey: AGENT, amount: '50', amountStroops: '500000000' });

    expect(res.status).toBe(200);
    const decoded = decodeVaultInvocation(res.body.unsignedTxXdr);
    expect(decoded.source).toBe(OPERATOR.publicKey());
    expect(decoded.contractId).toBe(process.env.AGENT_VAULT_CONTRACT_ID);
    expect(decoded.fnName).toBe('mint_float');
    expect(decoded.agentArg).toBe(AGENT);
    expect(decoded.amountStroops).toBe(500_000_000n);
  });

  it.each([
    ['a non-operator admin', OTHER_ADMIN],
    ['an agent', AGENT],
    ['a borrower', BORROWER],
  ])('returns 403 on mint-float for %s', async (_label, caller) => {
    const res = await request(buildApp())
      .post('/api/agents/vault/mint-float')
      .set('Authorization', `Bearer ${generateJwtToken(caller)}`)
      .send({ agentPublicKey: AGENT, amount: '50' });

    expect(res.status).toBe(403);
  });

  it('maps contract SolvencyViolated (#8) to a clear 400 error message', async () => {
    mockPrepareTransaction.mockRejectedValueOnce(
      new Error('Simulation failed: HostError: Error(Contract, #8)'),
    );

    const res = await request(buildApp())
      .post('/api/agents/vault/mint-float')
      .set('Authorization', `Bearer ${generateJwtToken(OPERATOR.publicKey())}`)
      .send({ agentPublicKey: AGENT, amount: '500' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/SolvencyViolated/);
  });

  it('maps contract InsufficientFloat (#7) to a clear 400 error message', async () => {
    mockPrepareTransaction.mockRejectedValueOnce(
      new Error('Simulation failed: HostError: Error(Contract, #7)'),
    );

    const res = await request(buildApp())
      .post('/api/agents/vault/burn-float')
      .set('Authorization', `Bearer ${generateJwtToken(AGENT)}`)
      .send({ agentPublicKey: AGENT, amount: '500' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/InsufficientFloat/);
  });
});

describe('GET /api/agents/dashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns collateral, float, maxFloat, and remaining headroom in stroops from agent_vaults', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_vaults')) {
        return {
          rows: [
            {
              collateral_balance: '1000000000',
              float_balance: '300000000',
              haircut_bps: 8000,
              is_active: true,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('ORDER BY created_at DESC')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{}], rowCount: 1 };
    });

    const res = await request(buildApp())
      .get('/api/agents/dashboard')
      .set('Authorization', `Bearer ${generateJwtToken(AGENT)}`);

    expect(res.status).toBe(200);
    expect(res.body.vault).toEqual({
      collateralStroops: '1000000000',
      floatStroops: '300000000',
      maxFloatStroops: '800000000',
      headroomStroops: '500000000',
      haircutBps: 8000,
      isActive: true,
    });
  });
});
