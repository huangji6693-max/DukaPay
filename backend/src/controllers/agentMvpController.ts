import type { Request, Response } from 'express';
import { StrKey } from '@stellar/stellar-sdk';
import { stroopsToAmount, toStroops } from '../money/decimal.js';
import { sorobanService } from '../services/sorobanService.js';
import { cacheService } from '../services/cacheService.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { query } from '../db/connection.js';
import { env } from '../config/env.js';

export const PUBLIC_SOLVENCY_CACHE_KEY = 'agents:solvency:public';
const PUBLIC_SOLVENCY_CACHE_TTL_SECONDS = 30;

function publicKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !StrKey.isValidEd25519PublicKey(value)) {
    throw AppError.badRequest(`${field} must be a valid Stellar public key`);
  }
  return value;
}

function amount(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw AppError.badRequest('amount is required');
  }
  let result: bigint;
  try {
    result = toStroops(String(value));
  } catch {
    throw AppError.badRequest('amount must be a valid positive decimal with up to 7 decimals');
  }
  if (result <= 0n) throw AppError.badRequest('amount must be greater than zero');
  return result;
}

function requireSelf(req: Request, target: string): void {
  if (req.user?.publicKey !== target) {
    throw AppError.forbidden('The wallet must match the authenticated wallet');
  }
}

function requireOperator(req: Request): string {
  const operator = env.AGENT_OPERATOR_PUBLIC_KEY?.trim();
  if (!operator) {
    throw AppError.internal('AGENT_OPERATOR_PUBLIC_KEY is not configured');
  }
  if (req.user?.publicKey !== operator) {
    throw AppError.forbidden('Only the configured agent operator can perform this action');
  }
  return operator;
}

// The registry requires operator auth on `register` so the operator vets each
// agent. Only the operator builds it; the agent then signs the returned XDR.
export const registerAgent = asyncHandler(async (req: Request, res: Response) => {
  requireOperator(req);
  const agent = publicKey(req.body.agentPublicKey, 'agentPublicKey');
  const kycRef = typeof req.body.kycRef === 'string' ? req.body.kycRef.trim() : '';
  const region = typeof req.body.region === 'string' ? req.body.region.trim() : '';
  if (!kycRef || !region || kycRef.length > 32 || region.length > 16) {
    throw AppError.badRequest(
      'kycRef and region are required and must be within their length limits',
    );
  }
  const rawExpiry = req.body.licenseExpiry;
  if (
    (typeof rawExpiry !== 'string' && typeof rawExpiry !== 'number') ||
    !/^[1-9]\d*$/.test(String(rawExpiry))
  ) {
    throw AppError.badRequest('licenseExpiry must be a positive integer timestamp');
  }
  const licenseExpiry = BigInt(rawExpiry);
  if (licenseExpiry <= BigInt(Math.floor(Date.now() / 1000))) {
    throw AppError.badRequest('licenseExpiry must be in the future');
  }
  const result = await sorobanService.buildRegisterAgentTx(
    agent,
    kycRef,
    region,
    amount(req.body.bond),
    licenseExpiry,
  );
  res.json({ success: true, ...result });
});

export const activateAgent = asyncHandler(async (req: Request, res: Response) => {
  const agent = publicKey(req.params.agentPublicKey, 'agentPublicKey');
  const operator = requireOperator(req);
  const result = await sorobanService.buildActivateAgentTx(operator, agent);
  res.json({ success: true, ...result });
});

export const topUpAgentBond = asyncHandler(async (req: Request, res: Response) => {
  const agent = publicKey(req.params.agentPublicKey, 'agentPublicKey');
  const operator = requireOperator(req);
  const result = await sorobanService.buildTopUpBondTx(operator, agent, amount(req.body.amount));
  res.json({ success: true, ...result });
});

export const buildAgentVaultAction = (
  action: 'deposit_collateral' | 'withdraw_collateral' | 'mint_float' | 'burn_float',
) =>
  asyncHandler(async (req: Request, res: Response) => {
    const agent = publicKey(req.body.agentPublicKey ?? req.user?.publicKey, 'agentPublicKey');
    let source: string;
    if (action === 'mint_float') {
      source = requireOperator(req);
    } else {
      requireSelf(req, agent);
      source = agent;
    }
    const result = await sorobanService.buildAgentVaultTx(
      source,
      action,
      agent,
      amount(req.body.amount),
    );
    res.json({ success: true, ...result });
  });

export const getPublicSolvency = asyncHandler(async (_req: Request, res: Response) => {
  const cached = await cacheService.get<Record<string, unknown>>(PUBLIC_SOLVENCY_CACHE_KEY);
  if (cached) {
    res.json(cached);
    return;
  }

  const result = await query(
    `SELECT agent_address, collateral_balance
       FROM agent_vaults
      WHERE is_active = true
      ORDER BY agent_address ASC`,
  );
  const agentAddresses = result.rows.map((row) => String(row.agent_address));
  const simulated =
    agentAddresses.length > 0
      ? await sorobanService.simulateAgentVaultInvariants(agentAddresses)
      : [];
  const invariantByAgent = new Map(simulated.map((entry) => [entry.agentPublicKey, entry]));

  let totalCollateralStroops = 0n;
  let totalFloatStroops = 0n;
  let totalMaxAllowedStroops = 0n;

  const agents = result.rows.map((row) => {
    const agentPublicKey = String(row.agent_address);
    const collateralStroops = BigInt(String(row.collateral_balance ?? 0));
    const invariant = invariantByAgent.get(agentPublicKey);
    const floatStroops = invariant?.floatStroops ?? 0n;
    const maxAllowedStroops = invariant?.maxAllowedStroops ?? 0n;
    const holds = invariant ? invariant.holds : floatStroops <= maxAllowedStroops;

    totalCollateralStroops += collateralStroops;
    totalFloatStroops += floatStroops;
    totalMaxAllowedStroops += maxAllowedStroops;

    return {
      agentPublicKey,
      collateral: stroopsToAmount(collateralStroops),
      float: stroopsToAmount(floatStroops),
      maxAllowed: stroopsToAmount(maxAllowedStroops),
      collateralStroops: collateralStroops.toString(),
      floatStroops: floatStroops.toString(),
      maxAllowedStroops: maxAllowedStroops.toString(),
      holds,
    };
  });

  const payload = {
    success: true,
    source: 'contract-simulation',
    agents,
    totals: {
      collateral: stroopsToAmount(totalCollateralStroops),
      float: stroopsToAmount(totalFloatStroops),
      maxAllowed: stroopsToAmount(totalMaxAllowedStroops),
      collateralStroops: totalCollateralStroops.toString(),
      floatStroops: totalFloatStroops.toString(),
      maxAllowedStroops: totalMaxAllowedStroops.toString(),
      holds: agents.every((agent) => agent.holds) && totalFloatStroops <= totalMaxAllowedStroops,
    },
  };

  await cacheService.set(PUBLIC_SOLVENCY_CACHE_KEY, payload, PUBLIC_SOLVENCY_CACHE_TTL_SECONDS);
  res.json(payload);
});

export const submitAgentTransaction = asyncHandler(async (req: Request, res: Response) => {
  const signedTxXdr = req.body?.signedTxXdr;
  if (typeof signedTxXdr !== 'string' || signedTxXdr.length === 0) {
    throw AppError.badRequest('signedTxXdr is required');
  }
  const result = await sorobanService.submitSignedTx(signedTxXdr);
  res.json({ success: true, ...result });
});
